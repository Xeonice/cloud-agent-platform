import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
} from '@nestjs/common';
import { statfs } from 'node:fs/promises';
import { createConfiguredSandboxRetentionStore } from '@cap/sandbox';
import { PrismaService } from '../prisma/prisma.service';
import {
  SANDBOX_RETENTION_STORE,
  type RetainedSandbox,
  type SandboxRetentionStore,
} from './sandbox-retention-store';

/**
 * Retention cleaner for settled, retained sandbox artifacts.
 *
 * Providers may retain stopped/parked artifacts so transcripts and recovery
 * metadata remain readable after task settlement. This periodic sweep is the
 * API-side policy driver; the concrete artifact listing/removal lives behind the
 * sandbox retention store supplied by `@cap/sandbox`.
 *
 *  - Policy 1 (age): remove a stopped retained sandbox artifact whose
 *    time-since-stop exceeds the retention window. The window reuses the operator-facing
 *    `retention` setting (7/30/90/180 days; default 30). It is stored per
 *    account, so the cleaner — which has no operator context — takes the MAX
 *    across accounts, never reaping earlier than any operator's configured window.
 *
 *  - Policy 2 (disk high-water-mark): when host free disk falls below a floor,
 *    evict the OLDEST-stopped containers FIRST until free disk recovers — even
 *    ones younger than the window — so a full disk never wedges the host.
 *
 * It trusts the retention store to return only cleanup-safe stopped artifacts.
 * Provider-specific running-artifact safety checks belong to the owning provider
 * package or sandbox harness, not this API policy loop.
 *
 * Single-instance assumption: one orchestrator per docker host (the same
 * assumption the startup orphan-reap relies on), so there is NO distributed
 * lock — only an in-process re-entrancy guard so a slow sweep never overlaps the
 * next tick.
 */
@Injectable()
export class RetentionCleaner implements OnModuleDestroy {
  private readonly logger = new Logger(RetentionCleaner.name);
  private readonly retentionStore: SandboxRetentionStore;
  private sweeper?: ReturnType<typeof setInterval>;
  /** In-process re-entrancy guard (no distributed lock — single instance). */
  private sweeping = false;

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

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional()
    @Inject(SANDBOX_RETENTION_STORE)
    retentionStore?: SandboxRetentionStore,
  ) {
    this.retentionStore = retentionStore ?? createConfiguredSandboxRetentionStore();
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
      const candidates = await this.retentionStore.listStoppedSandboxes(); // oldest-stop first
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

  /** Policy 1: remove every candidate stopped longer than the window. */
  private async evictAged(
    candidates: RetainedSandbox[],
    days: number,
  ): Promise<Set<string>> {
    const removed = new Set<string>();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const c of candidates) {
      if (c.finishedAtMs <= cutoff) {
        await this.retentionStore.removeStopped(c);
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
    survivors: RetainedSandbox[],
  ): Promise<void> {
    let free = await this.getFreeDiskBytes();
    if (free === null || free >= this.diskFloorBytes) return;
    let evicted = 0;
    for (const c of survivors) {
      if (free !== null && free >= this.diskFloorBytes) break;
      await this.retentionStore.removeStopped(c);
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
