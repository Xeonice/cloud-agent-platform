import { readFile } from 'node:fs/promises';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Docker from 'dockerode';
import type {
  ContainerResourceSample,
  SampledResources,
  SampledResourceStatus,
} from '@cap/contracts';

/**
 * Background CPU/memory sampler for `cap-aio-<taskId>` sandbox containers
 * (be-metrics, task 5.3).
 *
 * The orchestrator provisions one sibling container named `cap-aio-<taskId>` per
 * running task. This service samples those containers' CPU% and memory usage on
 * a BOUNDED cadence (~5s, configurable) and caches the last snapshot tagged with
 * `sampledAt`, so `/metrics` serves the cache and NEVER blocks a request on a
 * live `docker stats` / cgroup read (decoupling sampling cost from request rate).
 *
 * Source preference (per design D2): cgroup v2 file reads
 * (`/sys/fs/cgroup/.../cpu.stat`, `memory.current`, `memory.max`) are CHEAP and
 * preferred where the container cgroups are visible to this process; the
 * portable fallback reads the Docker API directly via dockerode
 * (`container.stats({ stream: false })`) over the mounted socket. We do NOT
 * shell out to the `docker` CLI: the slim api runtime image ships no `docker`
 * binary, so `exec('docker stats …')` would ENOENT — but dockerode is already a
 * dependency and the daemon socket is the same one the sandbox provider uses.
 *
 * CPU% has two honest sources, never conflated:
 *  - cgroup readings carry a CUMULATIVE `cpuUsageUsec`; CPU% is derived from the
 *    DELTA between two consecutive readings (a single reading cannot yield a
 *    rate, so a container's first tick reports 0% until a baseline exists);
 *  - the Docker API path computes the instantaneous rate from the snapshot's
 *    `cpu_stats` vs `precpu_stats` (the daemon populates `precpu_stats` on a
 *    `stream:false` read), so its readings carry a pre-computed `cpuPercent`
 *    directly and bypass the cgroup delta math.
 * A reading carries exactly ONE of the two (`cpuUsageUsec` XOR `cpuPercent`).
 *
 * Memory utilization is always expressed against the cgroup LIMIT, not raw host
 * memory.
 *
 * Honesty about emptiness (task 5.3): when ZERO containers are running the
 * snapshot is an explicit empty/zero "no active containers" reading
 * (`hasActiveContainers: false`, empty `containers`, zero aggregates) — NOT a
 * stale echo of a prior non-empty sample.
 *
 * Live sampling needs running containers + a reachable docker socket / cgroup
 * fs, so it is ENVIRONMENT-GATED: the sampling loop is started by the metrics
 * module only when the runtime is plausibly present, and the pure
 * snapshot-building / aggregation / parsing helpers are unit-tested in isolation.
 */

/** Container name prefix for the per-task sandbox sibling containers. */
export const AIO_CONTAINER_PREFIX = 'cap-aio-';

/**
 * A single resource reading for one container at one instant.
 *
 * CPU is carried as EITHER a cumulative cgroup counter (`cpuUsageUsec`, requiring
 * a delta against the prior tick) OR an already-computed rate (`cpuPercent`, from
 * `docker stats`). Exactly one is set; the build layer picks the right path.
 */
export interface ContainerReading {
  readonly taskId: string;
  /** Cumulative CPU time in microseconds (cgroup `usage_usec`); requires a delta. */
  readonly cpuUsageUsec: number | null;
  /** Pre-computed CPU rate percent (`docker stats`); used directly when set. */
  readonly cpuPercent: number | null;
  /** Instant the reading was taken (epoch millis). */
  readonly readAtMs: number;
  /** Current memory usage in bytes (`memory.current`). */
  readonly memoryBytes: number;
  /** Memory cgroup limit in bytes (`memory.max`), or `null` when unlimited. */
  readonly memoryLimitBytes: number | null;
}

export interface ResourceSamplerOptions {
  /** Sampling cadence in ms (bounded). Defaults to ~5s. */
  readonly cadenceMs?: number;
  /**
   * Staleness threshold in ms: a cached sample older than this is reported with
   * `status: 'stale'`. Defaults to 3× the cadence.
   */
  readonly staleAfterMs?: number;
}

/** Default sampling cadence (~5s) per design D2. */
export const DEFAULT_CADENCE_MS = 5_000;

/**
 * Computes per-container CPU% from two readings and aggregates a sampled
 * resources block (PURE — unit-testable, tasks 5.3 / 5.6).
 *
 * CPU% per container:
 *  - if the reading carries a pre-computed `cpuPercent` (docker-stats source),
 *    use it directly;
 *  - else derive `(Δcpu_usec / Δwall_usec) * 100` from the cumulative cgroup
 *    counter vs the `previous` reading. A container with no prior baseline (just
 *    appeared) reports 0% for this tick rather than a fabricated rate;
 *    `Δwall <= 0` (duplicate timestamp / clock skew) likewise yields 0.
 *
 * Memory%: `memoryBytes / memoryLimitBytes * 100`, or `null` when the cgroup
 * limit is unlimited (`memory.max` == "max").
 *
 * When `current` is empty the result is the explicit "no active containers"
 * reading: empty `containers`, zero aggregates, `hasActiveContainers: false`.
 * Freshness (`status`/`ageMs` relative to a later `now`) is re-applied by the
 * caller; this pure builder always stamps `sampledAt = sampledAtMs`, `ageMs: 0`.
 */
export function buildSampledResources(
  current: readonly ContainerReading[],
  previous: ReadonlyMap<string, ContainerReading>,
  sampledAtMs: number,
): SampledResources {
  if (current.length === 0) {
    // Explicit empty reading — never a stale prior sample.
    return {
      status: 'available',
      sampledAt: new Date(sampledAtMs),
      ageMs: 0,
      hasActiveContainers: false,
      containers: [],
      aggregateCpuPercent: 0,
      aggregateMemoryBytes: 0,
    };
  }

  const containers: ContainerResourceSample[] = [];
  let aggregateCpuPercent = 0;
  let aggregateMemoryBytes = 0;

  for (const reading of current) {
    const cpuPercent = computeCpuPercent(previous.get(reading.taskId), reading);
    const memoryPercent =
      reading.memoryLimitBytes !== null && reading.memoryLimitBytes > 0
        ? (reading.memoryBytes / reading.memoryLimitBytes) * 100
        : null;

    containers.push({
      taskId: reading.taskId,
      cpuPercent,
      memoryBytes: reading.memoryBytes,
      memoryLimitBytes: reading.memoryLimitBytes,
      memoryPercent,
    });

    aggregateCpuPercent += cpuPercent;
    aggregateMemoryBytes += reading.memoryBytes;
  }

  return {
    status: 'available',
    sampledAt: new Date(sampledAtMs),
    ageMs: 0,
    hasActiveContainers: true,
    containers,
    aggregateCpuPercent,
    aggregateMemoryBytes,
  };
}

/** Per-container CPU%: pre-computed rate, else cgroup delta, else 0 (no baseline). */
function computeCpuPercent(
  prior: ContainerReading | undefined,
  current: ContainerReading,
): number {
  // docker-stats source: rate already computed by docker.
  if (current.cpuPercent !== null) {
    return Math.max(0, current.cpuPercent);
  }
  // cgroup source: needs a cumulative counter AND a prior baseline.
  if (current.cpuUsageUsec === null || !prior || prior.cpuUsageUsec === null) {
    return 0;
  }
  const deltaCpuUsec = current.cpuUsageUsec - prior.cpuUsageUsec;
  const deltaWallUsec = (current.readAtMs - prior.readAtMs) * 1_000;
  if (deltaWallUsec <= 0 || deltaCpuUsec <= 0) return 0;
  return (deltaCpuUsec / deltaWallUsec) * 100;
}

/**
 * Returns the freshness `status` for a cached non-empty sample given its age and
 * the staleness threshold (PURE — task 5.5 staleness gating). Within the
 * threshold → `available`; beyond it → `stale`. `unavailable` is owned by the
 * sampler (source unreachable / never sampled), not this helper.
 */
export function freshnessStatus(
  ageMs: number,
  staleAfterMs: number,
): Extract<SampledResourceStatus, 'available' | 'stale'> {
  return ageMs > staleAfterMs ? 'stale' : 'available';
}

@Injectable()
export class ResourceSamplerService implements OnModuleDestroy {
  private readonly logger = new Logger(ResourceSamplerService.name);

  private readonly cadenceMs: number;
  private readonly staleAfterMs: number;

  /** Last cached snapshot, or `null` until the first sample completes. */
  private lastSnapshot: SampledResources | null = null;
  /** Readings from the previous tick, for the cgroup CPU-delta computation. */
  private previousReadings = new Map<string, ContainerReading>();
  /** The active sampling timer, when the loop is running. */
  private timer: NodeJS.Timeout | null = null;
  /** True once the runtime source has proven unreachable, to mark unavailable. */
  private sourceUnavailable = false;

  /**
   * Docker API client over the default daemon socket — the SAME socket the
   * sandbox provider uses. The portable fallback reads container stats through
   * this (dockerode) instead of shelling out to a `docker` CLI the slim runtime
   * image does not ship.
   */
  private readonly docker = new Docker();

  /** True while a sampling tick is in flight, to skip overlapping ticks. */
  private sampling = false;

  /**
   * Supplies the task ids whose `cap-aio-<taskId>` containers are currently
   * running. Injected (set by the metrics module) so the sampler reads the LIVE
   * running set from the semaphore rather than owning a parallel list.
   */
  private runningTaskIds: () => string[] = () => [];

  constructor(options: ResourceSamplerOptions = {}) {
    this.cadenceMs = options.cadenceMs ?? DEFAULT_CADENCE_MS;
    this.staleAfterMs = options.staleAfterMs ?? this.cadenceMs * 3;
  }

  /** Wire the live running-task-id source (the semaphore's running snapshot). */
  setRunningTaskIdSource(source: () => string[]): void {
    this.runningTaskIds = source;
  }

  /**
   * Starts the bounded sampling loop. Idempotent. The first tick fires after one
   * cadence interval; until then `currentSnapshot()` reports the never-sampled
   * (`unavailable`) reading. The interval is `unref`-ed so it never keeps the
   * process alive.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.cadenceMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Returns the cached snapshot tagged with its live freshness relative to `now`
   * (task 5.5). The cache is NEVER recomputed here, so serving `/metrics` never
   * blocks on a live sample.
   *
   * Freshness resolution:
   *  - never sampled yet → `unavailable` empty reading (nothing to serve; not a
   *    fabricated zero-as-exact);
   *  - a cached empty "no active containers" reading is always `available` (its
   *    emptiness is exact and current, not a stale measurement);
   *  - source proven unreachable on the latest tick → `stale` (we still return
   *    the prior derived numbers but flag them as not fresh);
   *  - otherwise re-stamp `ageMs` against `now` and downgrade to `stale` past the
   *    threshold.
   */
  currentSnapshot(now: number = Date.now()): SampledResources {
    const snapshot = this.lastSnapshot;
    if (snapshot === null || snapshot.sampledAt === null) {
      return this.unavailableReading();
    }

    const ageMs = Math.max(0, now - snapshot.sampledAt.getTime());

    // An exact "no active containers" reading stays available — its emptiness is
    // a current fact, not a stale measurement.
    if (!snapshot.hasActiveContainers) {
      return { ...snapshot, status: 'available', ageMs };
    }

    const status: SampledResourceStatus = this.sourceUnavailable
      ? 'stale'
      : freshnessStatus(ageMs, this.staleAfterMs);
    return { ...snapshot, status, ageMs };
  }

  /** The explicit unavailable reading: no usable sample / source unreachable. */
  private unavailableReading(): SampledResources {
    return {
      status: 'unavailable',
      sampledAt: null,
      ageMs: null,
      hasActiveContainers: false,
      containers: [],
      aggregateCpuPercent: 0,
      aggregateMemoryBytes: 0,
    };
  }

  /**
   * Performs ONE sampling pass: reads the live running task ids, samples each
   * `cap-aio-<taskId>` container (cgroup preferred, docker-stats fallback), and
   * caches the resulting snapshot. Skips the runtime entirely when zero
   * containers run, caching the explicit empty reading. A sampling outage marks
   * the source unavailable but never throws into the loop.
   */
  async sampleOnce(now: number = Date.now()): Promise<void> {
    // Reentrancy guard: the fixed-cadence interval fires regardless of whether
    // the prior tick finished. A slow daemon read must not let two ticks overlap
    // and race on previousReadings/lastSnapshot (the later-resolving tick would
    // clobber the baseline with a stale one). Skip a tick while one is in flight.
    if (this.sampling) return;
    this.sampling = true;
    try {
      const taskIds = this.runningTaskIds();

      if (taskIds.length === 0) {
        // No containers — cache the explicit empty reading, not a stale sample.
        this.lastSnapshot = buildSampledResources([], new Map(), now);
        this.previousReadings = new Map();
        this.sourceUnavailable = false;
        return;
      }

      let readings: ContainerReading[];
      try {
        readings = await this.readContainers(taskIds, now);
        this.sourceUnavailable = false;
      } catch (err) {
        // Outage: degrade ONLY the sampled block. Keep the prior cache (it will
        // be re-stamped stale via `sourceUnavailable`) and flag the source down.
        this.sourceUnavailable = true;
        this.logger.warn(
          `resource sampling failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }

      this.lastSnapshot = buildSampledResources(
        readings,
        this.previousReadings,
        now,
      );
      this.previousReadings = new Map(readings.map((r) => [r.taskId, r]));
    } finally {
      this.sampling = false;
    }
  }

  /**
   * Reads each running container, preferring cheap cgroup v2 file reads and
   * falling back to the Docker API (dockerode) over the socket when the cgroup
   * fs is not visible to this process. A container that cannot be read by EITHER
   * source is skipped (it may have just exited); only a wholesale failure
   * (nothing readable) throws, so the block degrades rather than silently
   * reporting "no containers".
   */
  private async readContainers(
    taskIds: readonly string[],
    now: number,
  ): Promise<ContainerReading[]> {
    const readings: ContainerReading[] = [];
    let dockerStats: Map<string, DockerStatLine> | null = null;
    let dockerStatsFetched = false;

    for (const taskId of taskIds) {
      const cgroup = await this.readCgroup(taskId, now).catch(() => null);
      if (cgroup) {
        readings.push(cgroup);
        continue;
      }
      // cgroup not visible — lazily fetch the Docker API fallback once.
      if (!dockerStatsFetched) {
        dockerStatsFetched = true;
        dockerStats = await this.readDockerStats(taskIds);
      }
      const stat = dockerStats?.get(taskId);
      if (stat) {
        readings.push({
          taskId,
          cpuUsageUsec: null,
          cpuPercent: stat.cpuPercent,
          readAtMs: now,
          memoryBytes: stat.memoryBytes,
          memoryLimitBytes: stat.memoryLimitBytes,
        });
      }
      // else: skip — not readable by either source (likely just exited).
    }

    if (taskIds.length > 0 && readings.length === 0) {
      throw new Error('no running container was readable via cgroup or docker stats');
    }
    return readings;
  }

  /**
   * Reads one container's cgroup v2 stats from the host cgroup fs at the
   * well-known docker scope path. Requires the cgroup fs to be visible to this
   * process; when it is not (or the path is absent), the caller falls back to
   * `docker stats`.
   *
   * cgroup v2 layout: `cpu.stat` carries `usage_usec <n>`; `memory.current` a raw
   * byte count; `memory.max` a byte count or the literal `max` (unlimited).
   */
  private async readCgroup(taskId: string, now: number): Promise<ContainerReading> {
    const id = await this.resolveContainerId(taskId);
    const base = `/sys/fs/cgroup/system.slice/docker-${id}.scope`;

    const [cpuStat, memCurrent, memMax] = await Promise.all([
      readFile(`${base}/cpu.stat`, 'utf8'),
      readFile(`${base}/memory.current`, 'utf8'),
      readFile(`${base}/memory.max`, 'utf8'),
    ]);

    const cpuUsageUsec = parseCpuUsageUsec(cpuStat);
    const memoryBytes = Number.parseInt(memCurrent.trim(), 10);
    const memoryLimitBytes = parseMemoryMax(memMax);

    if (Number.isNaN(cpuUsageUsec) || Number.isNaN(memoryBytes)) {
      throw new Error(`unparseable cgroup stats for ${taskId}`);
    }

    return {
      taskId,
      cpuUsageUsec,
      cpuPercent: null,
      readAtMs: now,
      memoryBytes,
      memoryLimitBytes,
    };
  }

  /** Resolves the full docker container id for `cap-aio-<taskId>` via the API. */
  private async resolveContainerId(taskId: string): Promise<string> {
    const name = `${AIO_CONTAINER_PREFIX}${taskId}`;
    const info = await this.withTimeout(
      this.docker.getContainer(name).inspect(),
      this.cadenceMs,
    );
    const id = info.Id;
    if (!id) throw new Error(`container ${name} not found`);
    return id;
  }

  /**
   * Portable fallback: read each running `cap-aio-*` container's stats through
   * the Docker API (dockerode) over the socket — NOT the `docker` CLI (absent
   * from the slim image). Each container is sampled INDEPENDENTLY via
   * `Promise.allSettled`, so one container exiting between the running-set
   * snapshot and the stats call (a 404) drops only that entry instead of failing
   * the whole tick (the CLI's batched `docker stats a b c` fails wholesale when
   * any one name is gone). The daemon populates `precpu_stats` on a `stream:false`
   * read, so `dockerStatsToLine` derives the CPU rate from the single snapshot.
   */
  private async readDockerStats(
    taskIds: readonly string[],
  ): Promise<Map<string, DockerStatLine>> {
    const out = new Map<string, DockerStatLine>();
    const results = await Promise.allSettled(
      taskIds.map(async (taskId) => {
        const name = `${AIO_CONTAINER_PREFIX}${taskId}`;
        const stats = await this.withTimeout(
          this.docker.getContainer(name).stats({ stream: false }),
          this.cadenceMs,
        );
        return { taskId, line: dockerStatsToLine(stats) };
      }),
    );
    for (const result of results) {
      // A rejected entry (e.g. 404 — the container exited mid-tick, or a timeout
      // on a wedged read) is skipped; it surfaces as a missing reading, not a
      // whole-tick outage.
      if (result.status === 'fulfilled' && result.value.line) {
        out.set(result.value.taskId, result.value.line);
      }
    }
    return out;
  }

  /**
   * Reject if `promise` does not settle within `ms`, bounding a wedged Docker
   * socket read so a single hung call cannot stall the whole sampling tick. The
   * timer is cleared on settle so it never keeps the process alive.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`docker request timed out after ${ms}ms`));
      }, ms);
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }
}

/** A container's resource line: a pre-computed CPU rate + memory used/limit. */
export interface DockerStatLine {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly memoryLimitBytes: number | null;
}

/**
 * Reduces a Docker API stats snapshot (dockerode `container.stats({stream:false})`)
 * to a {@link DockerStatLine} (PURE — unit-testable).
 *
 * CPU%: the daemon populates `precpu_stats` on a `stream:false` read, so the
 * instantaneous rate is `(Δcontainer_cpu / Δsystem_cpu) * onlineCpus * 100`
 * (docker's own formula). A missing baseline or non-positive delta yields 0%
 * rather than a fabricated spike.
 *
 * Memory: matches `docker stats` (calculateMemUsageUnixNoCache) — subtract the
 * reclaimable page cache, preferring cgroup v1's `total_inactive_file` (the
 * hierarchical total) then cgroup v2's `inactive_file`, and ONLY when it is
 * below `usage` (else report raw `usage`, as the CLI does). A cgroup v1 payload
 * carries BOTH keys, so a nullish `inactive_file ?? total_inactive_file` would
 * wrongly pick the leaf value — the field order + the `< usage` guard mirror the
 * CLI exactly. The cgroup `limit` is carried as the limit (it reports host total
 * when no per-container limit is set, exactly as `docker stats` displays it).
 *
 * Returns null when the payload lacks the cpu/memory blocks (nothing to read).
 */
export function dockerStatsToLine(
  stats: Docker.ContainerStats,
): DockerStatLine | null {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  const mem = stats.memory_stats;
  if (!cpu || !mem) return null;

  const cpuDelta =
    (cpu.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const onlineCpus = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1;
  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0
      ? (cpuDelta / systemDelta) * onlineCpus * 100
      : 0;

  const usage = mem.usage ?? 0;
  // dockerode's type over-promises these as always-present numbers; real
  // payloads omit one depending on the cgroup version, so view them as optional.
  const memStats = mem.stats as
    | { total_inactive_file?: number; inactive_file?: number }
    | undefined;
  const totalInactive = memStats?.total_inactive_file;
  const inactive = memStats?.inactive_file;
  let memoryBytes: number;
  if (typeof totalInactive === 'number' && totalInactive < usage) {
    memoryBytes = usage - totalInactive; // cgroup v1 hierarchical total
  } else if (typeof inactive === 'number' && inactive < usage) {
    memoryBytes = usage - inactive; // cgroup v2
  } else {
    memoryBytes = usage; // cache ≥ usage (or absent) → raw usage, as the CLI does
  }
  const limit = mem.limit ?? 0;

  return {
    cpuPercent: Math.max(0, cpuPercent),
    memoryBytes,
    memoryLimitBytes: limit > 0 ? limit : null,
  };
}

/** Parses `usage_usec <n>` out of a cgroup v2 `cpu.stat` blob. */
export function parseCpuUsageUsec(cpuStat: string): number {
  for (const line of cpuStat.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === 'usage_usec') return Number.parseInt(value, 10);
  }
  return Number.NaN;
}

/** Parses a cgroup v2 `memory.max` value: a byte count, or `max` (unlimited → null). */
export function parseMemoryMax(memMax: string): number | null {
  const trimmed = memMax.trim();
  if (trimmed === 'max') return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isNaN(value) ? null : value;
}
