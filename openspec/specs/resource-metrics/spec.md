# resource-metrics Specification

## Purpose
TBD - created by archiving change rebuild-console-tanstack-start. Update Purpose after archive.
## Requirements
### Requirement: Derived capacity metrics are exact projections of semaphore state

The orchestrator SHALL expose runtime capacity metrics that are EXACT, point-in-time projections of the in-memory `ConcurrencySemaphore` state — never sampled, estimated, or cached. The derived capacity set SHALL include: the configured slot ceiling (`maxConcurrentTasks` — the live, runtime-configurable ceiling read from the semaphore at request time; its persisted source is defined in `guardrails`, and env `MAX_CONCURRENT_TASKS` is only a first-boot seed, no longer an equivalent name for this figure), the active running-task count (`runningCount`), the number of free slots (`maxConcurrentTasks - runningCount`), and the queue depth (`queuedCount`). These values SHALL be read from the live semaphore at request time so that, whenever `active <= ceiling`, the reported `active + free` equals the ceiling; `free` SHALL never be reported as negative. Because the ceiling is runtime-mutable with shrink-without-eviction semantics, a TRANSITIONAL OVERAGE state (`active > ceiling`, occurring after the ceiling is lowered below the current running count) SHALL be reported honestly rather than masked: `ceiling` reports the new lowered value, `active` reports the real running count (which MAY temporarily exceed `ceiling`), and `free` clamps to 0; the `active + free === ceiling` identity is suspended during overage and resumes once running tasks release down to the ceiling. Because the semaphore is the single source of truth for admission, the derived metrics endpoint SHALL NOT maintain a parallel counter that could drift from the semaphore; if a derived figure cannot be read from the semaphore it SHALL be reported as such rather than fabricated.

The console prototype surfaces these as the capacity readouts on the workspace launcher and dashboard (e.g. `RUNNERS 7/10`, `QUEUE`, free-slot pills, the 4 metric tiles 活跃 / 待处理 / 空闲槽位). Those readouts are the product surface for this requirement; the values they show SHALL be the live derived figures defined here, replacing the prototype's hardcoded mock numbers.

#### Scenario: Active, free, and queue counts are read live from the semaphore

- **WHEN** the metrics endpoint is queried while the semaphore holds N running tasks, a ceiling of M slots (with N ≤ M), and Q queued tasks
- **THEN** it reports `active = N`, `ceiling = M`, `free = M - N`, and `queueDepth = Q` read from the live semaphore at request time
- **AND** `active + free` equals `ceiling` and `free` is never negative

#### Scenario: Derived counts change immediately as slots are taken and freed

- **WHEN** a task is admitted to a running slot (or a running task reaches a terminal state and frees its slot) between two metrics requests
- **THEN** the second response reflects the new `active`/`free`/`queueDepth` without lag, because the figures are projected from the semaphore rather than from a periodically sampled snapshot

#### Scenario: Derived metrics never drift from admission state

- **WHEN** the metrics endpoint computes the capacity figures
- **THEN** it derives them solely from the `ConcurrencySemaphore` (`runningCount`, `queuedCount`, `maxConcurrentTasks`) and maintains no independent counter that could disagree with actual admission decisions

#### Scenario: A runtime ceiling change is visible on the next metrics read

- **WHEN** the slot ceiling is changed at runtime through the settings surface between two metrics requests
- **THEN** the second response reports the new `ceiling` value read live from the semaphore, with no restart and no cached stale ceiling

#### Scenario: Shrink overage reports real active and clamped free

- **WHEN** the ceiling is lowered to M while N > M tasks are running and the metrics endpoint is queried before convergence
- **THEN** it reports `ceiling = M`, `active = N` (the real running count, exceeding the ceiling), and `free = 0` (clamped, never negative)
- **AND** once running tasks release down to at most M, subsequent reads satisfy `active + free === ceiling` again

### Requirement: Slot occupancy table enumerates the running set and the queue

The orchestrator SHALL expose a slot occupancy table that enumerates, per slot, whether it is occupied and by which task. The table SHALL be derived from `ConcurrencySemaphore.snapshotRunning()` and `snapshotQueue()`: it SHALL list exactly `maxConcurrentTasks` slots, each marked `busy` (carrying the occupying `taskId`) or `idle` (free), and SHALL additionally report the queued task ids in FIFO order so the console can render the backlog distinctly from free slots. Whenever `active <= ceiling`, the number of `busy` entries SHALL equal the derived `active` count and the number of `idle` entries SHALL equal the derived `free` count, so the table and the scalar capacity metrics are internally consistent. During the TRANSITIONAL OVERAGE state (running count above a freshly lowered ceiling), the table SHALL still list exactly `maxConcurrentTasks` slots — all `busy`, zero `idle` — and the surplus running task ids that no longer fit SHALL be omitted from the slot table (the queued id list remains complete); the `busy === active` identity is suspended during overage rather than the table growing beyond the ceiling. The table SHALL NOT invent slot identities beyond the configured ceiling.

The prototype's `SlotMeter` (the 10-segment busy/warn/idle meter) and the free-slot pills render this table; the segments SHALL map to real slot occupancy, not to a static decorative count.

#### Scenario: Occupancy table lists ceiling-many slots with real occupants

- **WHEN** the slot table is requested while the semaphore reports a ceiling of M with running task ids `[t1, t2]`
- **THEN** the table contains exactly M slot entries, two of them `busy` carrying `t1` and `t2`, and the remaining `M - 2` entries `idle`

#### Scenario: Queue backlog is enumerated separately from free slots

- **WHEN** the semaphore is at capacity with a non-empty FIFO backlog
- **THEN** every slot entry is `busy`, the `idle` count is zero, and the queued task ids are reported separately in FIFO order rather than being shown as free slots

#### Scenario: Table and scalar metrics agree

- **WHEN** both the slot occupancy table and the scalar capacity metrics are read from the same request while `active <= ceiling`
- **THEN** the count of `busy` slots equals `active`, the count of `idle` slots equals `free`, and the queued id list length equals `queueDepth`

#### Scenario: Shrink overage keeps the table at ceiling width

- **WHEN** the slot table is requested while the ceiling was lowered to M and N > M tasks are still running
- **THEN** the table contains exactly M slot entries, all `busy`, with zero `idle` entries, and the N − M surplus running task ids are omitted from the slot table rather than rendered as extra slots

### Requirement: Real CPU and memory are sampled per sandbox container with a bounded cadence

The orchestrator SHALL report real CPU and memory utilization for the running task sandbox containers, obtained by SAMPLING the container runtime (e.g. `docker stats` / the equivalent stats API, or direct cgroup readings such as `cpu.stat` and `memory.current`/`memory.max`) rather than by deriving them from semaphore bookkeeping. Sampled metrics SHALL be tagged as sampled and carry the timestamp (and/or age) of the most recent sample, and SHALL be collected on a bounded, configurable cadence rather than spawning a fresh `docker stats` invocation per metrics request, so that the metrics endpoint cannot be used to amplify load on the host runtime. Memory utilization SHALL be expressed against the cgroup limit when a limit is set; CPU utilization SHALL be expressed as a percentage derived from the delta between two cgroup/stats readings. When no sandbox containers are running, the sampled CPU/memory set SHALL report empty/zero with a clear "no active containers" indication rather than a stale prior reading.

For a per-task reading the orchestrator SHALL report codex's OWN process-subtree utilization (the launched `codex` process plus its descendants — shells, tools, MCP servers) as the PRIMARY figure, because the container aggregate is dominated by the AIO sandbox's own resident services (HTTP server, tmux, node) and misrepresents codex's usage — memory especially. The codex-process reading SHALL be sampled FROM INSIDE the sandbox (the orchestrator cannot see per-process usage from an external `docker stats`), via the existing `POST /v1/shell/exec` channel; its CPU percent SHALL be derived from the delta of two per-process readings (a single reading reports 0 until a baseline exists). The container aggregate SHALL be retained as an always-on baseline and as the FALLBACK when the in-sandbox reading is unavailable (sandbox unreachable / exec timed out). Every per-task reading SHALL be tagged with a `scope` indicating whether it is the codex `process` reading or the `container` aggregate, so a container aggregate is never silently presented as the process's usage.

The sampler SHALL be RESILIENT to a transient single-container read miss: when a task is still in the running set but its reading (process or container) could not be obtained on a given tick, the orchestrator SHALL carry forward that task's most recent prior reading (tagged stale) for a bounded number of consecutive ticks rather than dropping the task from the rebuilt snapshot. A task SHALL be dropped from the sampled set only when it actually leaves the running set or stays unreadable past that bound — so a transient `docker stats` timeout / momentary read failure can NEVER cause a still-running task to be reported as not-sampled. (Previously the snapshot was rebuilt each tick from only the containers read that tick, so a single skipped container — masked for a sole task by the all-fail-throws-keep-prior path but exposed with multiple concurrent tasks — flipped a live task to not-running.)

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

#### Scenario: Per-task reading is codex's own process subtree, not the whole container

- **WHEN** a per-task reading is taken for a running task whose sandbox is reachable
- **THEN** the primary CPU/memory figure is codex's process subtree (the `codex` process plus its descendants) sampled from inside the sandbox, tagged `scope: process`, rather than the container aggregate dominated by the sandbox's resident services

#### Scenario: Container aggregate is the fallback when the in-sandbox reading is unavailable

- **WHEN** the in-sandbox codex-process reading cannot be obtained (sandbox unreachable / exec timed out) for a running task
- **THEN** the orchestrator reports the container-aggregate reading tagged `scope: container` rather than reporting the task as not-sampled

#### Scenario: A transient single-container read miss does not drop a running task

- **WHEN** a task is still in the running set but its container/process could not be read on a given tick while other tasks were read successfully
- **THEN** the orchestrator carries forward that task's most recent prior reading (tagged stale) for up to the configured bound, so the task remains sampled rather than being reported not-running
- **AND** the task is dropped from the sampled set only once it leaves the running set or stays unreadable past the bound

### Requirement: Aggregation endpoint composes derived and sampled metrics for the dashboard

The orchestrator SHALL expose a single `/metrics` aggregation endpoint that the console dashboard and workspace launcher consume in one round trip. The response SHALL compose (a) the exact semaphore-derived capacity block (ceiling, active, free, queueDepth, slot occupancy table, queued ids) and (b) the sampled resource block (per-container and/or aggregate CPU and memory) with its sample timestamp/age, and SHALL clearly distinguish derived figures (always current and exact) from sampled figures (cadence-bounded, possibly slightly stale). A failure or staleness in the sampled block (e.g. the container runtime is unreachable) SHALL degrade only the sampled portion — the endpoint SHALL still return the exact derived capacity block rather than failing the whole response, and SHALL mark the sampled block unavailable/stale so the console can show capacity even when host sampling is down.

The sampled resource block SHALL ADDITIONALLY carry a per-task process-scope section folded from the sampler's existing in-memory per-task process samples: for each task in the current sampled set, the LATEST process-scope frame (codex's process-subtree CPU and memory) keyed by `taskId`, tagged with the SAME `scope` discriminator used by the per-task read (`process`, falling back to `container` when the in-sandbox reading is unavailable) and carrying its sample timestamp/age and stale flag. Percentages (`cpuPercent`, and `memoryPercent` against the cgroup limit) SHALL be computed SERVER-SIDE so the console performs no metric arithmetic. The section SHALL expose the latest frame ONLY — no history or time series. It SHALL be sourced from the SAME sampler snapshot that backs the rest of `/metrics` (no additional sampling pass per request) and SHALL honor the established honesty and carry-forward semantics: a still-running task that missed a sampling tick surfaces its carried-forward (possibly stale) reading; a task that is not running, or that has genuinely left the sampled set past the carry-forward bound, is omitted from the section (or explicitly marked not-sampled) and is NEVER given fabricated zeros. This is an ADDITIVE payload extension of the existing metrics capability: existing fields are unchanged (the response shape only gains fields), NO new endpoint family is introduced, and NO new capability flag is minted. With this section in place, the console SHALL be able to render per-runner CPU/MEM for all running tasks from ONE `/metrics` poll instead of fanning out N `GET /tasks/:taskId/metrics` calls.

The orchestrator SHALL ALSO expose a PER-TASK resource read (`GET /tasks/:taskId/metrics`, or an equivalent `?taskId=` filter) that returns that single task's sampled CPU/memory sourced from the SAME sampler snapshot that backs `/metrics` (no additional sampling pass). The per-task read SHALL return codex's OWN process-subtree CPU/memory as the PRIMARY figure tagged `scope: process`, with the container aggregate carried as background/context and used as the fallback (`scope: container`) when the in-sandbox process reading is unavailable. The per-task read SHALL return the explicit not-running/not-sampled state ONLY when the task has no live sampled container — i.e. it is not `running`, or it has genuinely left the sampled set — and SHALL NOT report not-running for a still-running task merely because of a transient single-tick read miss (such a task surfaces its carried-forward, possibly-stale, sampled reading instead). The per-task read SHALL NOT return an error or fabricated zeros for a not-running task; it returns the explicit state so the console can show "未运行/未采样" honestly. This read is REAL-TIME ONLY — it reflects the latest snapshot and does NOT imply any persisted resource history. The per-task read SHALL be auth-gated identically to `/metrics` (see the auth requirement): a missing/expired/non-allowlisted session SHALL be rejected 401 with no resource data.

This endpoint is the data source behind the dashboard's capacity-modern pool panel (the pool-hero, the numbered slot grid, the pool-lane, and the per-runner resource rows) and the workspace launcher's capacity readouts; with the per-task process section folded in, the per-runner resource rows render from this single response. The per-task read remains the data source behind the session-detail page's per-task CPU/memory readout.

#### Scenario: Single response composes both metric kinds with provenance

- **WHEN** the dashboard fetches `/metrics`
- **THEN** the response contains both the derived capacity block and the sampled resource block in one payload, with each figure (or block) labeled as derived (exact, live) or sampled (with timestamp/age)

#### Scenario: Sampling outage degrades only the sampled block

- **WHEN** `/metrics` is requested while the container runtime stats source is unreachable or the latest sample is stale beyond a threshold
- **THEN** the endpoint still returns the exact semaphore-derived capacity block and marks the sampled CPU/memory block as unavailable/stale rather than returning an error for the whole endpoint

#### Scenario: Dashboard consumes one aggregation round trip

- **WHEN** the console renders capacity figures, the slot grid, and the per-runner resource rows
- **THEN** all of those values are populated from a single `/metrics` response rather than from several disparate endpoints

#### Scenario: Per-task process samples ride the aggregate payload

- **WHEN** `/metrics` is fetched while tasks `t1` and `t2` are running and their in-sandbox process readings are available
- **THEN** the response's per-task process-scope section contains entries keyed by `t1` and `t2`, each carrying the latest process-subtree CPU and memory with server-computed `cpuPercent`/`memoryPercent`, tagged `scope: process`, with its sample timestamp/age — sourced from the same sampler snapshot, with no extra sampling pass triggered by the request

#### Scenario: Per-task section carries the latest frame only

- **WHEN** the per-task process-scope section is returned
- **THEN** each task carries exactly one frame (the most recent sample) and no history/time-series structure appears in the payload

#### Scenario: Container fallback applies inside the aggregate section

- **WHEN** a running task's in-sandbox process reading could not be obtained while its container aggregate is available
- **THEN** that task's entry in the per-task section carries the container-aggregate figure tagged `scope: container`, rather than the task being dropped from the section or zero-filled

#### Scenario: Transient miss carries forward inside the aggregate section

- **WHEN** a still-running task missed the latest sampling tick (read timeout / momentary failure) within the carry-forward bound
- **THEN** its entry in the per-task section surfaces the carried-forward prior reading flagged stale, rather than disappearing or flipping to not-sampled

#### Scenario: Non-running tasks are never fabricated into the aggregate section

- **WHEN** a task is not `running`, or has genuinely left the sampled set past the carry-forward bound
- **THEN** the per-task section omits it (or marks it explicitly not-sampled) and never reports zero CPU/memory values for it

#### Scenario: Extension is additive with no new capability flag

- **WHEN** the extended `/metrics` contract is compared against the prior contract
- **THEN** every previously existing field is unchanged in name, type, and semantics (fields are only added), no new endpoint family exists for pool/runner data, and no new capability flag is introduced — the existing metrics capability covers the extended payload

#### Scenario: One poll replaces the per-task fan-out

- **WHEN** the console needs per-runner CPU/MEM for all N currently running tasks
- **THEN** a single `/metrics` response contains the equivalent per-task data (same snapshot, same scope semantics) that N separate `GET /tasks/:taskId/metrics` calls would return, and the per-task endpoint itself remains available and unchanged

#### Scenario: Per-task read returns codex's process figure with a scope, container as background

- **WHEN** an allowlisted operator requests the per-task metrics read for a `running` task whose sandbox is reachable
- **THEN** the orchestrator returns codex's process-subtree CPU/memory tagged `scope: process` as the primary figure, with the container aggregate carried as background context, sourced from the latest sampler snapshot

#### Scenario: Per-task read falls back to the container scope when the process reading is unavailable

- **WHEN** the per-task read is requested for a running task whose in-sandbox process reading could not be obtained
- **THEN** the orchestrator returns the container-aggregate figure tagged `scope: container` rather than not-running

#### Scenario: A still-running task is not reported not-running on a transient miss

- **WHEN** the per-task read is requested for a running task that missed a single sampling tick (read timeout / momentary failure) but is still in the running set
- **THEN** the orchestrator returns its carried-forward (possibly stale) sampled reading rather than the not-running state

#### Scenario: Per-task read returns an explicit not-running state for a task with no live container

- **WHEN** the per-task metrics read is requested for a task that is not `running` (or that has genuinely left the sampled set beyond the carry-forward bound)
- **THEN** the orchestrator returns an explicit not-running/not-sampled state rather than an error or fabricated zeros

#### Scenario: Per-task read is auth-gated like the aggregation endpoint

- **WHEN** the per-task metrics read is requested without a valid allowlisted session
- **THEN** the orchestrator responds 401 and returns no per-task resource data

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

### Requirement: Provisioning diagnostics expose honest low-cardinality operational metrics

The session-authenticated aggregate metrics response SHALL add a provisioning
diagnostics block sourced from the same validated safe events and durable
ownership state used by provisioning diagnostics. The block SHALL report
bounded aggregates for attempt and stage duration, terminal outcomes, retries,
cleanup outcomes and failures, oldest active-attempt age, provider-owned orphan
or cleanup-pending sandbox count, and native execution settlement anomalies.
Settlement anomaly categories SHALL distinguish at least terminal failure or
kill without an exit code, invalid poll settlement, poll timeout or transport
failure, and non-fatal attach degradation.

Metric dimensions SHALL come only from closed, low-cardinality vocabularies such
as provider family, provisioning stage, operation kind, outcome, safe cause,
cleanup disposition, and settlement-anomaly kind. Metrics SHALL NOT be labeled
or keyed by task id, attempt id, logical operation id, sandbox id, native
execution id, repository, branch, account, URL, endpoint, request or filesystem
path, command kind, error text, or any credential-bearing value. Duration data
SHALL use bounded aggregate buckets or count/sum/max summaries rather than
retaining an unbounded per-operation time series.

Process-window counters SHALL expose the instant from which they were observed;
durable current gauges, including active attempts and orphan or cleanup-pending
runs, SHALL be rehydrated or reconciled after restart. An unavailable or stale
provisioning-metrics source SHALL mark only this additive block degraded and
SHALL NOT fail or rewrite the existing capacity, occupancy, runner-minutes, or
resource-sampling blocks.

#### Scenario: Stage settlement updates bounded aggregates

- **WHEN** one provisioning stage succeeds and another fails after measurable execution time
- **THEN** the metrics block increments their allowlisted outcome counts and duration aggregates
- **AND** it stores no per-task, per-attempt, per-operation, or raw diagnostic series

#### Scenario: A retry is measured without an attempt label

- **WHEN** a retryable provisioning failure schedules and begins another attempt
- **THEN** the retry aggregate increments once under bounded stage, provider-family, and safe-cause dimensions
- **AND** the attempt number and attempt id are not metric labels

#### Scenario: Cleanup failure and orphan state remain visible

- **WHEN** a primary provisioning failure is followed by an unconfirmed cleanup and reconciliation observes the provider-owned sandbox still present
- **THEN** cleanup-failure and cleanup-pending or orphan aggregates reflect that state independently from the primary failure aggregate
- **AND** successful later reconciliation removes the current orphan gauge without erasing the historical cleanup outcome count

#### Scenario: Missing exit and attach degradation are measured separately

- **WHEN** one native execution terminalizes as failed without an exit code and another loses attach while poll settlement succeeds
- **THEN** the settlement-anomaly metrics count the missing-exit failure and attach degradation in distinct bounded categories
- **AND** the attach anomaly does not increment the authoritative execution-failure outcome for the successfully polled execution

#### Scenario: Restart provenance is honest

- **WHEN** the API process restarts after counters have accumulated while durable active or orphan state still exists
- **THEN** resettable counters expose a new observation start time and durable gauges are rebuilt from reconciled state
- **AND** the response does not present reset counters as lifetime totals or report durable orphan state as zero merely because memory was cleared

#### Scenario: Metrics contain no diagnostic payload or identifier labels

- **WHEN** command text, prompt material, provider output, a request body, a filesystem path, and a credential canary are present in underlying failures
- **THEN** the serialized metrics response contains none of those values and no task, attempt, operation, sandbox, execution, repository, or account identifier
- **AND** only strict safe enum labels and bounded numeric aggregates are returned

#### Scenario: Provisioning metric degradation is isolated

- **WHEN** provisioning metric hydration or reconciliation is unavailable or stale
- **THEN** the provisioning diagnostics block reports its degraded status and freshness honestly
- **AND** the existing exact capacity and occupancy data plus sampled resource data retain their established availability semantics

