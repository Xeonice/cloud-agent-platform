import { z } from 'zod';

/**
 * Runtime metrics contract (resource-metrics spec).
 *
 * The orchestrator exposes a single `/metrics` aggregation endpoint composing
 * two strictly distinguished metric kinds:
 *
 *  1. A DERIVED capacity block — exact, point-in-time projections of the live
 *     `ConcurrencySemaphore` state ({@link CapacityMetricsSchema} +
 *     {@link SlotEntrySchema}). These are always current and exact; they are read
 *     from the semaphore at request time and never sampled or cached.
 *
 *  2. A SAMPLED resource block — CPU/memory utilization
 *     ({@link SampledResourcesSchema}) obtained by sampling the container runtime
 *     (cgroup reads / `docker stats`) on a bounded cadence. These are
 *     cadence-bounded and possibly slightly stale; each carries a `sampledAt`
 *     timestamp and an availability flag so a sampling outage degrades ONLY this
 *     block while the derived capacity block is still returned.
 *
 * The console renders these as the dashboard capacity tiles, the `SlotMeter`,
 * the free-slot pills, and the `ResourceMeter`, replacing the prototype's
 * hardcoded mock numbers (e.g. `RUNNERS 7/10`, `CPU 42% / 内存 64%`).
 */

// ---------------------------------------------------------------------------
// Derived capacity block (exact, semaphore-projected)
// ---------------------------------------------------------------------------

/**
 * The exact, point-in-time capacity figures projected directly from the live
 * `ConcurrencySemaphore`. By construction `active + free === ceiling` and `free`
 * is never negative, because all four values are derived from the same live
 * semaphore reading at request time rather than from any parallel counter that
 * could drift from actual admission decisions.
 */
export const CapacityMetricsSchema = z.object({
  /** Configured slot ceiling (`maxConcurrentTasks` / `MAX_CONCURRENT_TASKS`). */
  ceiling: z.number().int().nonnegative(),
  /** Active running-task count (`runningCount`). */
  active: z.number().int().nonnegative(),
  /** Free slots (`ceiling - active`); never negative. */
  free: z.number().int().nonnegative(),
  /** Queue depth (`queuedCount`) — tasks held queued awaiting a free slot. */
  queueDepth: z.number().int().nonnegative(),
});
export type CapacityMetrics = z.infer<typeof CapacityMetricsSchema>;

/**
 * A single slot in the occupancy table. `busy` slots carry the occupying
 * `taskId`; `idle` slots carry `null`. The table lists exactly `ceiling`-many
 * entries (`slot` 0-indexed), never inventing slot identities beyond the
 * configured ceiling.
 */
export const SlotEntrySchema = z.object({
  /** 0-indexed slot position within the configured ceiling. */
  slot: z.number().int().nonnegative(),
  /** Whether this slot is occupied. */
  busy: z.boolean(),
  /** The occupying task id when `busy`, else `null`. */
  taskId: z.string().nullable(),
});
export type SlotEntry = z.infer<typeof SlotEntrySchema>;

/**
 * The slot occupancy table, derived from `snapshotRunning()` / `snapshotQueue()`.
 *
 * `slots` enumerates exactly `ceiling`-many entries; the count of `busy` slots
 * equals {@link CapacityMetricsSchema.active}, the count of `idle` slots equals
 * `free`. `queuedTaskIds` lists the backlog in FIFO order, reported separately
 * from free slots; its length equals {@link CapacityMetricsSchema.queueDepth}.
 */
export const SlotOccupancySchema = z.object({
  /** Exactly `ceiling`-many slot entries, each busy(taskId) or idle(null). */
  slots: z.array(SlotEntrySchema),
  /** Queued task ids in FIFO order, distinct from free slots. */
  queuedTaskIds: z.array(z.string()),
});
export type SlotOccupancy = z.infer<typeof SlotOccupancySchema>;

/**
 * Runner-minutes (compute-minutes) accounting derived from observed task
 * running durations over the reporting window (admission→terminal timestamp,
 * in-flight tasks counted up to now). Labeled as DERIVED accounting, not a
 * sampled host metric.
 *
 * `available` is `false` and `minutes` is `null` when the figure cannot be
 * derived (insufficient persisted timing data) — never fabricated or reported
 * as a zero that implies an exact value. This is an operational accounting
 * estimate over the window, not an exact billing figure.
 */
export const RunnerMinutesSchema = z.object({
  /** Whether the figure could be derived from the available timing data. */
  available: z.boolean(),
  /** Summed running minutes over the window, or `null` when unavailable. */
  minutes: z.number().nonnegative().nullable(),
});
export type RunnerMinutes = z.infer<typeof RunnerMinutesSchema>;

// ---------------------------------------------------------------------------
// Sampled resource block (cadence-bounded, possibly stale)
// ---------------------------------------------------------------------------

/**
 * Availability of the sampled resource block:
 *  - `available`: a fresh sample within the configured cadence.
 *  - `stale`: the latest sample is older than the staleness threshold.
 *  - `unavailable`: the container-runtime stats source is unreachable / no
 *    usable sample exists. A sampling outage marks this `unavailable` rather
 *    than failing the whole `/metrics` response.
 */
export const SampledResourceStatusSchema = z.enum([
  'available',
  'stale',
  'unavailable',
]);
export type SampledResourceStatus = z.infer<typeof SampledResourceStatusSchema>;

/**
 * Sampled CPU/memory utilization for a single sandbox container.
 *
 * `cpuPercent` is derived from the delta between two cgroup/stats readings.
 * `memoryBytes` is the current usage and `memoryLimitBytes` the cgroup limit
 * when one is set (so memory utilization is expressed against the limit, not
 * raw host memory); `memoryPercent` is usage against that limit.
 */
export const ContainerResourceSampleSchema = z.object({
  /** The sampled task's id (the `cap-aio-<taskId>` container). */
  taskId: z.string(),
  /** CPU utilization percent, from the delta of two readings. */
  cpuPercent: z.number().nonnegative(),
  /** Current memory usage in bytes (`memory.current`). */
  memoryBytes: z.number().nonnegative(),
  /** Memory cgroup limit in bytes (`memory.max`), or `null` when unlimited. */
  memoryLimitBytes: z.number().nonnegative().nullable(),
  /** Memory usage as a percent of the cgroup limit, or `null` when unlimited. */
  memoryPercent: z.number().nonnegative().nullable(),
});
export type ContainerResourceSample = z.infer<
  typeof ContainerResourceSampleSchema
>;

/**
 * Which reading a per-task sample represents: codex's OWN process subtree
 * (`process`, the PRIMARY scope — the launched `codex` process plus its
 * descendants, sampled in-sandbox) or the whole-container aggregate
 * (`container`, the FALLBACK when the in-sandbox process reading is
 * unavailable). Shared by the `/metrics` per-task section and the per-task
 * read (`GET /tasks/:taskId/metrics`) so both surfaces speak the same scope
 * language.
 */
export const TaskResourceScopeSchema = z.enum(['process', 'container']);
export type TaskResourceScope = z.infer<typeof TaskResourceScopeSchema>;

/**
 * One task's LATEST resource frame inside the `/metrics` per-task section
 * (console-design-pixel-merge): the pool panel's per-runner CPU/MEM rows
 * render from this, so ONE `/metrics` poll replaces an N-request
 * `GET /tasks/:taskId/metrics` fan-out.
 *
 * Latest frame ONLY — no history or time-series structure. `sample` carries
 * SERVER-computed `cpuPercent`/`memoryPercent` (the console performs no
 * metric arithmetic). `scope` is the same discriminator the per-task read
 * uses: `process` (codex's own subtree, primary), falling back to
 * `container` when the in-sandbox reading is unavailable. `stale` is the
 * honest freshness flag: true for a carried-forward frame (the task missed
 * the latest sampling tick) or when the whole sampled block is degraded —
 * never replaced by fabricated zeros.
 */
export const TaskMetricsSampleSchema = z.object({
  /** Scope of `sample`: codex `process` (primary) or the `container` fallback. */
  scope: TaskResourceScopeSchema,
  /** The latest frame, with server-computed `cpuPercent`/`memoryPercent`. */
  sample: ContainerResourceSampleSchema,
  /** Time this frame was freshly sampled. */
  sampledAt: z.coerce.date(),
  /** Frame age in milliseconds (grows past the cadence when carried forward). */
  ageMs: z.number().int().nonnegative(),
  /** True when carried forward past the latest tick or the block is degraded. */
  stale: z.boolean(),
});
export type TaskMetricsSample = z.infer<typeof TaskMetricsSampleSchema>;

/**
 * The sampled resource block: per-container samples plus an aggregate, tagged
 * with the most-recent `sampledAt` time and an availability `status`.
 *
 * When no sandbox containers are running, `containers` is empty and the
 * aggregate figures are zero with `status: 'unavailable'`-or-`'available'`
 * accompanied by an explicit "no active containers" reading rather than echoing
 * a stale prior sample.
 */
export const SampledResourcesSchema = z.object({
  /** Block availability: fresh, stale-beyond-threshold, or source unreachable. */
  status: SampledResourceStatusSchema,
  /** Time the most recent sample was taken, or `null` when no sample exists. */
  sampledAt: z.coerce.date().nullable(),
  /** Age of the most recent sample in milliseconds, or `null` when none exists. */
  ageMs: z.number().int().nonnegative().nullable(),
  /** Whether any sandbox container was running at sample time. */
  hasActiveContainers: z.boolean(),
  /** Per-container CPU/memory samples (empty when no containers run). */
  containers: z.array(ContainerResourceSampleSchema),
  /** Aggregate CPU percent across sampled containers (0 when none). */
  aggregateCpuPercent: z.number().nonnegative(),
  /** Aggregate memory usage in bytes across sampled containers (0 when none). */
  aggregateMemoryBytes: z.number().nonnegative(),
  /**
   * Per-task process-scope section, keyed by `taskId`: each running task's
   * LATEST frame (see {@link TaskMetricsSampleSchema}). STRICTLY ADDITIVE
   * extension (console-design-pixel-merge): every prior field is unchanged in
   * name/type/semantics, no new endpoint family, no new capability flag. A
   * task that is not running, or that has genuinely left the sampled set past
   * the carry-forward bound, is simply ABSENT — never given fabricated zeros.
   * Declared optional ONLY so the sampler's internal snapshot builders (which
   * run before the fold) stay valid; the served `/metrics` response always
   * carries it.
   */
  taskSamples: z.record(z.string(), TaskMetricsSampleSchema).optional(),
});
export type SampledResources = z.infer<typeof SampledResourcesSchema>;

// ---------------------------------------------------------------------------
// Aggregation response
// ---------------------------------------------------------------------------

/**
 * Response body for the session-gated `GET /metrics` aggregation endpoint.
 *
 * Composes the exact derived capacity block (`capacity`, `occupancy`,
 * `runnerMinutes`) with the cadence-bounded sampled resource block
 * (`resources`) in one round trip. The derived block is always present and
 * exact; the sampled block self-describes its freshness via
 * {@link SampledResourcesSchema.status}, so the console can render live capacity
 * even when host sampling is degraded.
 */
export const MetricsResponseSchema = z.object({
  /** Exact, semaphore-derived scalar capacity figures. */
  capacity: CapacityMetricsSchema,
  /** Exact, semaphore-derived slot occupancy table + FIFO queue. */
  occupancy: SlotOccupancySchema,
  /** Derived runner-minutes accounting over the reporting window. */
  runnerMinutes: RunnerMinutesSchema,
  /** Cadence-bounded sampled CPU/memory block with freshness/availability. */
  resources: SampledResourcesSchema,
});
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;

// ---------------------------------------------------------------------------
// Per-task resource read (GET /tasks/:taskId/metrics)
// ---------------------------------------------------------------------------

/**
 * Response body for the per-task resource read (`GET /tasks/:taskId/metrics`).
 *
 * REAL-TIME ONLY: it reflects the latest sampler snapshot, NOT any persisted
 * history. A discriminated union over `state`:
 *  - `sampled`: the task has a live reading in the latest snapshot. `sample` is
 *    the PRIMARY figure and `scope` says what it represents:
 *      - `scope: 'process'` — codex's OWN process-subtree CPU/memory (the launched
 *        `codex` process plus its descendants), sampled in-sandbox; the container
 *        aggregate is ALSO carried in `container` as background context. This is
 *        the normal per-task reading (the container aggregate is dominated by the
 *        sandbox's resident services and misrepresents codex, esp. memory).
 *      - `scope: 'container'` — the FALLBACK when the in-sandbox process reading is
 *        unavailable (sandbox unreachable / exec timed out): `sample` is the
 *        container aggregate and `container` is null (it would duplicate `sample`).
 *    `sampledAt`/`ageMs` carry freshness; a carried-forward reading on a missed
 *    tick simply shows a larger `ageMs` rather than flipping to not-running.
 *  - `not-running`: the task has no live sampled reading (it is not `running`, or
 *    it has genuinely left the sampled set beyond the carry-forward bound). NOT an
 *    error and NOT fabricated zeros — the console renders "未运行/未采样".
 *
 * The endpoint is auth-gated identically to `/metrics` (enabled account session;
 * 401 otherwise) — a per-task figure is still host-execution operational data.
 *
 * The `scope` discriminator is {@link TaskResourceScopeSchema}, declared with
 * the sampled block above and SHARED with the `/metrics` per-task section.
 */
export const TaskResourceResponseSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('sampled'),
    /** Which reading `sample` represents: codex `process` (primary) or the `container` fallback. */
    scope: TaskResourceScopeSchema,
    /** The PRIMARY reading — codex's process subtree when `scope==='process'`, else the container aggregate. */
    sample: ContainerResourceSampleSchema,
    /** Background container-aggregate reading when `scope==='process'`; null when `scope==='container'` (it would duplicate `sample`). */
    container: ContainerResourceSampleSchema.nullable(),
    /** Time the most recent sample was taken. */
    sampledAt: z.coerce.date().nullable(),
    /** Age of the most recent sample in milliseconds (larger when carried forward). */
    ageMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    state: z.literal('not-running'),
  }),
]);
export type TaskResourceResponse = z.infer<typeof TaskResourceResponseSchema>;
