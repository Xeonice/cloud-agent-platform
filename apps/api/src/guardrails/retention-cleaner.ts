import { Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import Docker from 'dockerode';
import { statfs } from 'node:fs/promises';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Retention cleaner for settled, RETAINED sandbox containers
 * (session-sandbox-retention, Track 5).
 *
 * With `AutoRemove:false` + stop-only teardown, a finished task's
 * `cap-aio-<taskId>` container is KEPT (stopped) so its codex rollout is
 * readable for history replay. This periodic sweep is the ONLY path that deletes
 * those kept containers, under two policies:
 *
 *  - Policy 1 (age): remove a STOPPED `cap-aio-*` container whose time-since-stop
 *    exceeds the retention window. The window reuses the operator-facing
 *    `retention` setting (7/30/90/180 days; default 30). It is stored per
 *    account, so the cleaner — which has no operator context — takes the MAX
 *    across accounts, never reaping earlier than any operator's configured window.
 *
 *  - Policy 2 (disk high-water-mark): when host free disk falls below a floor,
 *    evict the OLDEST-stopped containers FIRST until free disk recovers — even
 *    ones younger than the window — so a full disk never wedges the host.
 *
 * It NEVER touches a RUNNING container: it lists only non-running ones, and
 * removes with `force:false` so a container that races back to running is
 * refused by the daemon (NOT killed) rather than reaped. Modeled on
 * `CodexDeviceLoginService`'s unref'd `setInterval` sweeper.
 *
 * Single-instance assumption: one orchestrator per docker host (the same
 * assumption the startup orphan-reap relies on), so there is NO distributed
 * lock — only an in-process re-entrancy guard so a slow sweep never overlaps the
 * next tick.
 */
@Injectable()
export class RetentionCleaner implements OnModuleDestroy {
  private readonly logger = new Logger(RetentionCleaner.name);
  private docker = new Docker();
  private sweeper?: ReturnType<typeof setInterval>;
  /** In-process re-entrancy guard (no distributed lock — single instance). */
  private sweeping = false;

  /** Container name prefix for per-task sandboxes (`cap-aio-<taskId>`). */
  private static readonly CONTAINER_PREFIX = 'cap-aio-';
  /** Sweep cadence. Retention is a daily-scale policy; 6h is ample. */
  private static readonly SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /**
   * Default retention window when no account has saved one — mirrors the
   * settings default (`DEFAULT_RETENTION_DAYS` in `settings-logic.ts`). Kept
   * local so the cleaner stays a near-leaf module.
   */
  private static readonly DEFAULT_RETENTION_DAYS = 30;
  private static readonly DEFAULT_DISK_FLOOR_GB = 10;

  /** Filesystem path probed for free space (the docker data root in prod). */
  private diskPath: string;
  /** Evict oldest-stopped sandboxes once free disk falls below this. */
  private diskFloorBytes: number;

  constructor(@Optional() private readonly prisma?: PrismaService) {
    this.diskPath = process.env.CAP_SANDBOX_DISK_PATH || '/';
    const floorGb = Number(process.env.CAP_SANDBOX_DISK_FLOOR_GB);
    this.diskFloorBytes =
      (Number.isFinite(floorGb) && floorGb > 0
        ? floorGb
        : RetentionCleaner.DEFAULT_DISK_FLOOR_GB) *
      1024 ** 3;
    this.sweeper = setInterval(
      () => void this.sweep(),
      RetentionCleaner.SWEEP_INTERVAL_MS,
    );
    this.sweeper.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /**
   * One sweep: age eviction first, then disk-pressure eviction over the
   * survivors. Re-entrancy-guarded + best-effort (a docker/fs hiccup is logged,
   * never thrown) so a wedged tick can never stall or overlap the next.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const days = await this.resolveRetentionDays();
      const candidates = await this.listStoppedSandboxes(); // oldest-stop first
      const removed = await this.evictAged(candidates, days);
      const survivors = candidates.filter((c) => !removed.has(c.id));
      await this.evictForDiskPressure(survivors);
    } catch (err) {
      this.logger.warn(
        `retention sweep failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Resolve the retention window in days: the MAX `retention` across all account
   * settings (so no operator's history is reaped earlier than they configured),
   * or the default when there are no rows / no database.
   */
  private async resolveRetentionDays(): Promise<number> {
    if (!this.prisma) return RetentionCleaner.DEFAULT_RETENTION_DAYS;
    try {
      const rows = await this.prisma.accountSettings.findMany({
        select: { retention: true },
      });
      const days = rows
        .map((r) => r.retention)
        .filter((d): d is number => typeof d === 'number' && d > 0);
      return days.length
        ? Math.max(...days)
        : RetentionCleaner.DEFAULT_RETENTION_DAYS;
    } catch {
      return RetentionCleaner.DEFAULT_RETENTION_DAYS;
    }
  }

  /** List non-running `cap-aio-*` containers, sorted oldest-stop first. */
  private async listStoppedSandboxes(): Promise<StoppedSandbox[]> {
    const list = await this.docker.listContainers({
      all: true,
      filters: {
        name: [RetentionCleaner.CONTAINER_PREFIX],
        status: ['exited', 'created', 'dead'],
      },
    });
    const out: StoppedSandbox[] = [];
    for (const info of list) {
      // Defensive: never consider a RUNNING container even if a filter let one
      // through — Policy invariant is "stopped only".
      if (info.State === 'running') continue;
      out.push({
        id: info.Id,
        name: info.Names?.[0]?.replace(/^\//, '') ?? info.Id,
        finishedAtMs: await this.finishedAtMs(info.Id),
      });
    }
    out.sort((a, b) => a.finishedAtMs - b.finishedAtMs);
    return out;
  }

  /** Time-since-stop (ms epoch) from `State.FinishedAt`, falling back to Created. */
  private async finishedAtMs(id: string): Promise<number> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      const finished = info?.State?.FinishedAt;
      const t = finished ? Date.parse(finished) : NaN;
      if (Number.isFinite(t) && t > 0) return t;
      const created = info?.Created ? Date.parse(info.Created) : NaN;
      return Number.isFinite(created) && created > 0 ? created : 0;
    } catch {
      // Un-inspectable stopped orphan → treat as very old (eligible to reclaim).
      return 0;
    }
  }

  /** Policy 1: remove every candidate stopped longer than the window. */
  private async evictAged(
    candidates: StoppedSandbox[],
    days: number,
  ): Promise<Set<string>> {
    const removed = new Set<string>();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const c of candidates) {
      if (c.finishedAtMs <= cutoff) {
        await this.removeStopped(c);
        removed.add(c.id);
      }
    }
    if (removed.size > 0) {
      this.logger.log(
        `retention: removed ${removed.size} sandbox container(s) past the ${days}-day window`,
      );
    }
    return removed;
  }

  /**
   * Policy 2: while free disk is below the floor, evict oldest-stopped survivors
   * first until it recovers (or no candidates remain).
   */
  private async evictForDiskPressure(
    survivors: StoppedSandbox[],
  ): Promise<void> {
    let free = await this.getFreeDiskBytes();
    if (free === null || free >= this.diskFloorBytes) return;
    let evicted = 0;
    for (const c of survivors) {
      if (free !== null && free >= this.diskFloorBytes) break;
      await this.removeStopped(c);
      evicted += 1;
      const measured = await this.getFreeDiskBytes();
      if (measured !== null) free = measured;
    }
    if (evicted > 0) {
      this.logger.warn(
        `retention: free disk below floor — evicted ${evicted} oldest stopped sandbox(es) to reclaim space`,
      );
    }
  }

  /**
   * Force-`false` remove: a stopped container is deleted; a container that raced
   * back to RUNNING is REFUSED by the daemon (not killed) and the error is
   * swallowed — the "never reap a running container" invariant holds even under
   * a race. Deliberately diverges from the device-login sweeper's `force:true`.
   */
  private async removeStopped(c: StoppedSandbox): Promise<void> {
    await this.docker
      .getContainer(c.id)
      .remove({ force: false })
      .catch(() => undefined);
  }

  /** Free bytes on {@link diskPath}, or null when it cannot be measured. */
  async getFreeDiskBytes(): Promise<number | null> {
    try {
      const st = await statfs(this.diskPath);
      return st.bavail * st.bsize;
    } catch {
      return null;
    }
  }
}

/** A non-running sandbox candidate for retention eviction. */
interface StoppedSandbox {
  id: string;
  name: string;
  /** Epoch ms the container stopped (oldest-first sort key). */
  finishedAtMs: number;
}
