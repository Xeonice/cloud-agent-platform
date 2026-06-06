## ADDED Requirements

### Requirement: Derived capacity metrics are exact projections of semaphore state

The orchestrator SHALL expose runtime capacity metrics that are EXACT, point-in-time projections of the in-memory `ConcurrencySemaphore` state — never sampled, estimated, or cached. The derived capacity set SHALL include: the configured slot ceiling (`maxConcurrentTasks`, equivalently `MAX_CONCURRENT_TASKS`), the active running-task count (`runningCount`), the number of free slots (`maxConcurrentTasks - runningCount`), and the queue depth (`queuedCount`). These values SHALL be read from the live semaphore at request time so the reported `active + free` always equals the ceiling and `free` is never reported as negative. Because the semaphore is the single source of truth for admission, the derived metrics endpoint SHALL NOT maintain a parallel counter that could drift from the semaphore; if a derived figure cannot be read from the semaphore it SHALL be reported as such rather than fabricated.

The console prototype surfaces these as the capacity readouts on the workspace launcher and dashboard (e.g. `RUNNERS 7/10`, `QUEUE`, free-slot pills, the 4 metric tiles 活跃 / 待处理 / 空闲槽位). Those readouts are the product surface for this requirement; the values they show SHALL be the live derived figures defined here, replacing the prototype's hardcoded mock numbers.

#### Scenario: Active, free, and queue counts are read live from the semaphore

- **WHEN** the metrics endpoint is queried while the semaphore holds N running tasks, a ceiling of M slots, and Q queued tasks
- **THEN** it reports `active = N`, `ceiling = M`, `free = M - N`, and `queueDepth = Q` read from the live semaphore at request time
- **AND** `active + free` equals `ceiling` and `free` is never negative

#### Scenario: Derived counts change immediately as slots are taken and freed

- **WHEN** a task is admitted to a running slot (or a running task reaches a terminal state and frees its slot) between two metrics requests
- **THEN** the second response reflects the new `active`/`free`/`queueDepth` without lag, because the figures are projected from the semaphore rather than from a periodically sampled snapshot

#### Scenario: Derived metrics never drift from admission state

- **WHEN** the metrics endpoint computes the capacity figures
- **THEN** it derives them solely from the `ConcurrencySemaphore` (`runningCount`, `queuedCount`, `maxConcurrentTasks`) and maintains no independent counter that could disagree with actual admission decisions

### Requirement: Slot occupancy table enumerates the running set and the queue

The orchestrator SHALL expose a slot occupancy table that enumerates, per slot, whether it is occupied and by which task. The table SHALL be derived from `ConcurrencySemaphore.snapshotRunning()` and `snapshotQueue()`: it SHALL list exactly `maxConcurrentTasks` slots, each marked `busy` (carrying the occupying `taskId`) or `idle` (free), and SHALL additionally report the queued task ids in FIFO order so the console can render the backlog distinctly from free slots. The number of `busy` entries SHALL equal the derived `active` count and the number of `idle` entries SHALL equal the derived `free` count, so the table and the scalar capacity metrics are internally consistent. The table SHALL NOT invent slot identities beyond the configured ceiling.

The prototype's `SlotMeter` (the 10-segment busy/warn/idle meter) and the free-slot pills render this table; the segments SHALL map to real slot occupancy, not to a static decorative count.

#### Scenario: Occupancy table lists ceiling-many slots with real occupants

- **WHEN** the slot table is requested while the semaphore reports a ceiling of M with running task ids `[t1, t2]`
- **THEN** the table contains exactly M slot entries, two of them `busy` carrying `t1` and `t2`, and the remaining `M - 2` entries `idle`

#### Scenario: Queue backlog is enumerated separately from free slots

- **WHEN** the semaphore is at capacity with a non-empty FIFO backlog
- **THEN** every slot entry is `busy`, the `idle` count is zero, and the queued task ids are reported separately in FIFO order rather than being shown as free slots

#### Scenario: Table and scalar metrics agree

- **WHEN** both the slot occupancy table and the scalar capacity metrics are read from the same request
- **THEN** the count of `busy` slots equals `active`, the count of `idle` slots equals `free`, and the queued id list length equals `queueDepth`

### Requirement: Real CPU and memory are sampled per sandbox container with a bounded cadence

The orchestrator SHALL report real CPU and memory utilization for the running task sandbox containers, obtained by SAMPLING the container runtime (e.g. `docker stats` / the equivalent stats API, or direct cgroup readings such as `cpu.stat` and `memory.current`/`memory.max`) rather than by deriving them from semaphore bookkeeping. Sampled metrics SHALL be tagged as sampled and carry the timestamp (and/or age) of the most recent sample, and SHALL be collected on a bounded, configurable cadence rather than spawning a fresh `docker stats` invocation per metrics request, so that the metrics endpoint cannot be used to amplify load on the host runtime. Memory utilization SHALL be expressed against the cgroup limit when a limit is set; CPU utilization SHALL be expressed as a percentage derived from the delta between two cgroup/stats readings. When no sandbox containers are running, the sampled CPU/memory set SHALL report empty/zero with a clear "no active containers" indication rather than a stale prior reading.

The dashboard's `ResourceMeter` (CPU / 内存 progress meters, including the `warn` variant) consumes these sampled figures; the prototype's hardcoded `CPU 42% / 内存 64%` are replaced by the live sampled values.

#### Scenario: CPU/memory are sampled from the container runtime, not the semaphore

- **WHEN** the metrics endpoint reports CPU and memory for a running sandbox
- **THEN** the figures originate from a container-runtime/cgroup sample (e.g. `docker stats` or `cpu.stat`/`memory.current`) and are flagged as sampled with the sample timestamp/age, distinct from the exact semaphore-derived capacity figures

#### Scenario: Sampling cadence is bounded and decoupled from request rate

- **WHEN** the metrics endpoint is queried many times within one sampling interval
- **THEN** every response is served from the most recent background sample within the configured cadence, and no new `docker stats`/cgroup sweep is triggered per request

#### Scenario: Memory is reported against the cgroup limit

- **WHEN** a sandbox container has a memory cgroup limit configured
- **THEN** memory utilization is reported as usage against that limit (and as a percentage), rather than as raw host memory

#### Scenario: No running containers yields an explicit empty reading

- **WHEN** the metrics endpoint samples while no sandbox containers are running
- **THEN** the sampled CPU/memory set is reported as empty/zero with a "no active containers" indication and does not echo a stale prior sample

### Requirement: Aggregation endpoint composes derived and sampled metrics for the dashboard

The orchestrator SHALL expose a single `/metrics` aggregation endpoint that the console dashboard and workspace launcher consume in one round trip. The response SHALL compose (a) the exact semaphore-derived capacity block (ceiling, active, free, queueDepth, slot occupancy table, queued ids) and (b) the sampled resource block (per-container and/or aggregate CPU and memory) with its sample timestamp/age, and SHALL clearly distinguish derived figures (always current and exact) from sampled figures (cadence-bounded, possibly slightly stale). A failure or staleness in the sampled block (e.g. the container runtime is unreachable) SHALL degrade only the sampled portion — the endpoint SHALL still return the exact derived capacity block rather than failing the whole response, and SHALL mark the sampled block unavailable/stale so the console can show capacity even when host sampling is down.

This endpoint is the data source behind the dashboard's `ops-status-bar` metric tiles, the Agent capacity aside (`SlotMeter` + free-slot pills), and the `ResourceMeter`; with this endpoint live the console reads real capacity and resource data instead of mock metrics.

#### Scenario: Single response composes both metric kinds with provenance

- **WHEN** the dashboard fetches `/metrics`
- **THEN** the response contains both the derived capacity block and the sampled resource block in one payload, with each figure (or block) labeled as derived (exact, live) or sampled (with timestamp/age)

#### Scenario: Sampling outage degrades only the sampled block

- **WHEN** `/metrics` is requested while the container runtime stats source is unreachable or the latest sample is stale beyond a threshold
- **THEN** the endpoint still returns the exact semaphore-derived capacity block and marks the sampled CPU/memory block as unavailable/stale rather than returning an error for the whole endpoint

#### Scenario: Dashboard consumes one aggregation round trip

- **WHEN** the console renders capacity tiles, the slot meter, and the CPU/memory meters
- **THEN** all of those values are populated from a single `/metrics` response rather than from several disparate endpoints

### Requirement: Metrics endpoints are auth-gated to allowlisted sessions

Every metrics endpoint (the `/metrics` aggregation endpoint and any derived-capacity or sampled-resource sub-routes) SHALL require a valid, non-expired operator session resolving to an allowlisted GitHub identity, identical to the session validation applied to other protected REST endpoints. The orchestrator SHALL reject a missing, malformed, expired, revoked, or non-allowlisted session with HTTP 401 and SHALL NOT return any capacity, occupancy, or resource data. Metrics — including running task ids in the slot table, queue depth, and host CPU/memory — are operational data about a host-root execution plane and MUST NOT be exposed to an unauthenticated caller. Only the unauthenticated health check (and the OAuth initiation/callback endpoints) are exempt; the metrics endpoints are NOT exempt.

#### Scenario: Authenticated allowlisted session reads metrics

- **WHEN** a request to `/metrics` carries a session token resolving to a non-expired session for an allowlisted user
- **THEN** the orchestrator returns the composed metrics payload

#### Scenario: Unauthenticated metrics request is rejected with 401

- **WHEN** a request to any metrics endpoint omits the session credential or presents one that is missing, malformed, expired, revoked, or non-allowlisted
- **THEN** the orchestrator responds 401 and returns no capacity, slot-occupancy, or CPU/memory data

#### Scenario: Slot occupancy task ids are not leaked to anonymous callers

- **WHEN** an anonymous caller attempts to read the slot occupancy table or queue depth
- **THEN** the orchestrator denies the request before any running/queued task ids are serialized into the response

### Requirement: Runner-minutes accounting is reported when derivable

The orchestrator SHOULD report a runner-minutes (compute-minutes) accounting figure in the metrics payload, derived from observed task execution time: the sum, over tasks within a reporting window, of each task's running duration (from the running-slot admission timestamp to its terminal-state timestamp), with in-flight running tasks counted up to the present instant. When this figure can be derived from persisted task timestamps or live lifecycle state it SHALL be reported and labeled as derived accounting (not a sampled host metric); when it cannot yet be derived (insufficient persisted timing data) the field SHALL be reported as unavailable rather than fabricated. Runner-minutes SHALL NOT be presented as an exact billing figure unless the underlying timestamps support it; it is an operational accounting estimate over the reporting window.

The prototype's `Runner 分钟` / `Runner-minutes` metric tile is the product surface for this figure.

#### Scenario: Runner-minutes derived from task running durations

- **WHEN** the metrics window contains tasks with recorded running-slot admission and terminal timestamps
- **THEN** the endpoint reports runner-minutes as the summed running durations over the window, counting still-running tasks up to the present instant, labeled as derived accounting

#### Scenario: Runner-minutes reported unavailable when timing data is insufficient

- **WHEN** the running durations cannot be derived because the required task timestamps are not persisted
- **THEN** the runner-minutes field is reported as unavailable rather than as a fabricated or zero-implying-exact value
