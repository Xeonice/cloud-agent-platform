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

/**
 * Per-task tracking of the latest codex-process subtree sample (the per-task
 * PRIMARY reading), with the last-FRESH-sample time (so `ageMs` grows on a
 * carried-forward tick) and a consecutive-miss counter for bounded carry-forward.
 */
interface ProcessSampleState {
  sample: ContainerResourceSample;
  freshAtMs: number;
  misses: number;
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
 * Max consecutive ticks a still-running task's reading is carried forward when a
 * sample could not be obtained that tick, before it is dropped to not-sampled
 * (task-codex-process-metrics D2). A single transient `docker stats`/exec miss
 * therefore never flips a live task to not-running; a container that genuinely
 * vanished degrades to not-sampled after this bound (it also leaves the running
 * set on real termination, which drops it immediately).
 */
export const CARRY_FORWARD_MAX = 3;

/**
 * In-sandbox shell that sums codex's OWN process subtree CPU + memory (method A,
 * per the spike): find the `codex` PID, recursively collect it + descendants via
 * `/proc/<pid>/task/<pid>/children`, sum utime+stime (CLK_TCK ticks) and VmRSS
 * (kB). The `${s##*) }` strip handles a `comm` containing spaces/parens so the
 * positional utime(12)/stime(13) AFTER the comm are read correctly. Prints
 * `OK <ticks> <rssKB> <clkTck>`, or `NONE` when codex is not yet running.
 */
export const CODEX_PROC_PROBE =
  'walk(){ echo $1; for c in $(cat /proc/$1/task/$1/children 2>/dev/null); do walk $c; done; }; ' +
  'P=$(pgrep -x codex 2>/dev/null|head -1); [ -z "$P" ] && echo NONE && exit 0; ' +
  'CK=$(getconf CLK_TCK); T=0; R=0; ' +
  'for p in $(walk $P 2>/dev/null|sort -un); do ' +
  's=$(cat /proc/$p/stat 2>/dev/null) || continue; aft=${s##*) }; set -- $aft; ' +
  'T=$((T + ${12:-0} + ${13:-0})); ' +
  'v=$(awk "/^VmRSS:/{print \\$2}" /proc/$p/status 2>/dev/null); R=$((R + ${v:-0})); ' +
  'done; echo "OK $T $R $CK"';

/** A parsed codex process-subtree probe reading: cumulative CPU seconds + RSS bytes. */
export interface ProcProbeReading {
  /** Cumulative CPU time (utime+stime) of the codex subtree, in seconds. */
  readonly cpuSeconds: number;
  /** Resident memory of the codex subtree, in bytes. */
  readonly memoryBytes: number;
}

/**
 * Parse the {@link CODEX_PROC_PROBE} stdout (`OK <ticks> <rssKB> <clkTck>` or
 * `NONE`) into a {@link ProcProbeReading} (PURE — unit-testable). Returns null for
 * `NONE` (codex not running yet) or any unparseable/zero-clk output.
 */
export function parseProcProbe(output: string): ProcProbeReading | null {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse()
    .find((l) => l === 'NONE' || l.startsWith('OK '));
  if (!line || line === 'NONE') return null;
  const [, ticksRaw, rssRaw, clkRaw] = line.split(/\s+/);
  const ticks = Number.parseInt(ticksRaw, 10);
  const rssKB = Number.parseInt(rssRaw, 10);
  const clk = Number.parseInt(clkRaw, 10);
  if (!Number.isFinite(ticks) || !Number.isFinite(rssKB) || !(clk > 0)) return null;
  return { cpuSeconds: ticks / clk, memoryBytes: rssKB * 1024 };
}

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

  /**
   * Supplies a running task's sandbox base URL (`http://cap-aio-<id>:8080`) so the
   * sampler can `POST /v1/shell/exec` to read codex's own process subtree from
   * INSIDE the sandbox (D7). Injected by the metrics module from the guardrails
   * per-task `SandboxConnection`. A task with no connection yields `undefined` →
   * no process reading → the per-task read falls back to the container scope.
   */
  private taskBaseUrl: (taskId: string) => string | undefined = () => undefined;

  /** Consecutive container-read misses per task, for bounded carry-forward (D2). */
  private containerMisses = new Map<string, number>();

  /** Last codex-process sample per task (the per-task primary reading). */
  private processSamples = new Map<string, ProcessSampleState>();
  /** Prior codex-process CPU reading per task, for the CPU-delta computation. */
  private previousProcessCpu = new Map<string, { cpuSeconds: number; atMs: number }>();

  constructor(options: ResourceSamplerOptions = {}) {
    this.cadenceMs = options.cadenceMs ?? DEFAULT_CADENCE_MS;
    this.staleAfterMs = options.staleAfterMs ?? this.cadenceMs * 3;
  }

  /** Wire the live running-task-id source (the semaphore's running snapshot). */
  setRunningTaskIdSource(source: () => string[]): void {
    this.runningTaskIds = source;
  }

  /** Wire the per-task sandbox base-URL source (the guardrails connection map). */
  setTaskBaseUrlSource(source: (taskId: string) => string | undefined): void {
    this.taskBaseUrl = source;
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
   * The per-task reading for `GET /tasks/:taskId/metrics` (task-codex-process-metrics):
   * codex's OWN process subtree as the PRIMARY figure (`scope: 'process'`) with the
   * container aggregate as background; when no process reading is available, the
   * container aggregate is the FALLBACK (`scope: 'container'`); when neither exists
   * (task not running, or gone past the carry-forward bound) → `null` (not-running).
   * A carried-forward reading surfaces a larger `ageMs` rather than flipping to
   * not-running. Real-time only — reads the latest cached state, never samples here.
   */
  taskReading(
    taskId: string,
    now: number = Date.now(),
  ): {
    scope: 'process' | 'container';
    sample: ContainerResourceSample;
    container: ContainerResourceSample | null;
    sampledAt: Date | null;
    ageMs: number | null;
  } | null {
    const snapshot = this.currentSnapshot(now);
    const containerSample =
      snapshot.containers.find((c) => c.taskId === taskId) ?? null;

    const proc = this.processSamples.get(taskId);
    if (proc) {
      return {
        scope: 'process',
        sample: proc.sample,
        container: containerSample,
        sampledAt: new Date(proc.freshAtMs),
        ageMs: Math.max(0, now - proc.freshAtMs),
      };
    }
    if (containerSample) {
      return {
        scope: 'container',
        sample: containerSample,
        container: null,
        sampledAt: snapshot.sampledAt,
        ageMs: snapshot.ageMs,
      };
    }
    return null;
  }

  /**
   * Sample each running task's codex process subtree from inside its sandbox
   * (best-effort, independent per task via `allSettled` so one slow/unreachable
   * sandbox never stalls the others). A miss carries forward (bounded) / falls
   * back to the container scope.
   */
  private async sampleProcesses(
    taskIds: readonly string[],
    now: number,
  ): Promise<void> {
    await Promise.allSettled(
      taskIds.map((taskId) => this.sampleOneProcess(taskId, now)),
    );
  }

  /** Sample one task's codex subtree; on any miss, carry forward (bounded). */
  private async sampleOneProcess(taskId: string, now: number): Promise<void> {
    const baseUrl = this.taskBaseUrl(taskId);
    if (!baseUrl) {
      this.markProcessMiss(taskId);
      return;
    }
    let reading: ProcProbeReading | null;
    try {
      reading = await this.execProcProbe(baseUrl);
    } catch {
      this.markProcessMiss(taskId);
      return;
    }
    if (!reading) {
      // `NONE` (codex not yet running) or unparseable → a miss: carry a prior
      // process sample forward if we had one, else simply no process reading
      // (the per-task read falls back to the container scope).
      this.markProcessMiss(taskId);
      return;
    }

    // CPU% from the delta of two cumulative readings (0 until a baseline exists).
    const prev = this.previousProcessCpu.get(taskId);
    let cpuPercent = 0;
    if (prev) {
      const dWallSec = (now - prev.atMs) / 1000;
      const dCpuSec = reading.cpuSeconds - prev.cpuSeconds;
      if (dWallSec > 0 && dCpuSec > 0) cpuPercent = (dCpuSec / dWallSec) * 100;
    }
    this.previousProcessCpu.set(taskId, { cpuSeconds: reading.cpuSeconds, atMs: now });

    // Express codex memory against the CONTAINER cgroup limit (same denominator the
    // container reading uses), so the process % is comparable to the container %.
    const limit = this.previousReadings.get(taskId)?.memoryLimitBytes ?? null;
    const sample: ContainerResourceSample = {
      taskId,
      cpuPercent,
      memoryBytes: reading.memoryBytes,
      memoryLimitBytes: limit,
      memoryPercent:
        limit !== null && limit > 0 ? (reading.memoryBytes / limit) * 100 : null,
    };
    this.processSamples.set(taskId, { sample, freshAtMs: now, misses: 0 });
  }

  /**
   * Record a codex-process read miss for a task: carry the prior process sample
   * forward up to {@link CARRY_FORWARD_MAX} consecutive misses, then drop it (the
   * per-task read falls back to the container scope). A no-op for a task that never
   * had a process sample (e.g. codex not started yet).
   */
  private markProcessMiss(taskId: string): void {
    const st = this.processSamples.get(taskId);
    if (!st) return;
    if (st.misses + 1 > CARRY_FORWARD_MAX) {
      this.processSamples.delete(taskId);
      this.previousProcessCpu.delete(taskId);
      return;
    }
    this.processSamples.set(taskId, { ...st, misses: st.misses + 1 });
  }

  /**
   * `POST <baseUrl>/v1/shell/exec` the {@link CODEX_PROC_PROBE}, bounded by the
   * sample cadence, and parse codex's subtree reading from the AIO response (the
   * live server NESTS the result under `data`). Returns null on a non-2xx, an
   * unparseable body, or a `NONE` (codex not running yet).
   */
  private async execProcProbe(baseUrl: string): Promise<ProcProbeReading | null> {
    const res = await fetch(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: CODEX_PROC_PROBE }),
      signal: AbortSignal.timeout(this.cadenceMs),
    });
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    const top = raw ?? {};
    const d = ((top.data as Record<string, unknown>) ?? top) as Record<string, unknown>;
    const output =
      (typeof d.output === 'string' && d.output) ||
      (typeof d.stdout === 'string' && d.stdout) ||
      '';
    return parseProcProbe(output);
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
      // Forget per-task state for tasks that left the running set (real exits).
      this.pruneStale(new Set(taskIds));

      if (taskIds.length === 0) {
        // No containers — cache the explicit empty reading, not a stale sample.
        this.lastSnapshot = buildSampledResources([], new Map(), now);
        this.previousReadings = new Map();
        this.sourceUnavailable = false;
        return;
      }

      // --- container readings (aggregate block + per-task background) ----------
      let fresh: ContainerReading[];
      try {
        fresh = await this.readContainers(taskIds, now);
        this.sourceUnavailable = false;
      } catch (err) {
        // Whole-tick container outage: flag the source down (currentSnapshot will
        // mark the block stale). Carry-forward below still presents prior readings
        // for up to CARRY_FORWARD_MAX ticks instead of dropping every task at once.
        this.sourceUnavailable = true;
        this.logger.warn(
          `resource sampling failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        fresh = [];
      }
      // Carry forward a still-running task missing from this tick's fresh readings
      // (bounded) so a transient single-container miss never drops it (D2 / P1).
      const effective = this.carryForwardContainers(taskIds, fresh);
      if (effective.length === 0) {
        // Running tasks exist (taskIds non-empty) but NOTHING is readable this tick
        // — an outage, or carry-forward exhausted. Flag the source down and KEEP the
        // prior cache (currentSnapshot → 'stale', or 'unavailable' if never sampled).
        // Do NOT cache an empty 'available' reading: that would falsely mean "no
        // containers running" while the semaphore says tasks ARE running.
        this.sourceUnavailable = true;
      } else {
        this.lastSnapshot = buildSampledResources(effective, this.previousReadings, now);
        this.previousReadings = new Map(effective.map((r) => [r.taskId, r]));
      }

      // --- codex process subtree readings (per-task PRIMARY), in-sandbox -------
      // Best-effort per task; failures carry forward / fall back to container.
      await this.sampleProcesses(taskIds, now);
    } finally {
      this.sampling = false;
    }
  }

  /**
   * Forget per-task carry-forward / CPU-baseline state for tasks that are no
   * longer in the running set, so a terminated task is immediately not-sampled
   * (it does not linger via carry-forward).
   */
  private pruneStale(live: ReadonlySet<string>): void {
    for (const id of [...this.containerMisses.keys()]) if (!live.has(id)) this.containerMisses.delete(id);
    for (const id of [...this.processSamples.keys()]) if (!live.has(id)) this.processSamples.delete(id);
    for (const id of [...this.previousProcessCpu.keys()]) if (!live.has(id)) this.previousProcessCpu.delete(id);
  }

  /**
   * Returns the effective container readings for this tick: each running task's
   * fresh reading when present, else its most recent prior reading carried forward
   * for up to {@link CARRY_FORWARD_MAX} consecutive misses, else dropped. A single
   * transient `docker stats` timeout therefore cannot flip a live task to
   * not-sampled (the bug that surfaced with concurrent sandboxes).
   */
  private carryForwardContainers(
    taskIds: readonly string[],
    fresh: readonly ContainerReading[],
  ): ContainerReading[] {
    const freshById = new Map(fresh.map((r) => [r.taskId, r]));
    const out: ContainerReading[] = [];
    const nextMisses = new Map<string, number>();
    for (const taskId of taskIds) {
      const f = freshById.get(taskId);
      if (f) {
        out.push(f);
        nextMisses.set(taskId, 0);
        continue;
      }
      const prior = this.previousReadings.get(taskId);
      const misses = (this.containerMisses.get(taskId) ?? 0) + 1;
      if (prior && misses <= CARRY_FORWARD_MAX) {
        out.push(prior);
        nextMisses.set(taskId, misses);
      }
      // else: no prior or past the bound → dropped (genuinely not-sampled).
    }
    this.containerMisses = nextMisses;
    return out;
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
