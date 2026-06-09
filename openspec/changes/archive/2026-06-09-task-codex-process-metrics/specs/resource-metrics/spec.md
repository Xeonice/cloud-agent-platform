## MODIFIED Requirements

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

The orchestrator SHALL ALSO expose a PER-TASK resource read (`GET /tasks/:taskId/metrics`, or an equivalent `?taskId=` filter) that returns that single task's sampled CPU/memory sourced from the SAME sampler snapshot that backs `/metrics` (no additional sampling pass). The per-task read SHALL return codex's OWN process-subtree CPU/memory as the PRIMARY figure tagged `scope: process`, with the container aggregate carried as background/context and used as the fallback (`scope: container`) when the in-sandbox process reading is unavailable. The per-task read SHALL return the explicit not-running/not-sampled state ONLY when the task has no live sampled container — i.e. it is not `running`, or it has genuinely left the sampled set — and SHALL NOT report not-running for a still-running task merely because of a transient single-tick read miss (such a task surfaces its carried-forward, possibly-stale, sampled reading instead). The per-task read SHALL NOT return an error or fabricated zeros for a not-running task; it returns the explicit state so the console can show "未运行/未采样" honestly. This read is REAL-TIME ONLY — it reflects the latest snapshot and does NOT imply any persisted resource history. The per-task read SHALL be auth-gated identically to `/metrics` (see the auth requirement): a missing/expired/non-allowlisted session SHALL be rejected 401 with no resource data.

This endpoint is the data source behind the dashboard's `ops-status-bar` metric tiles, the Agent capacity aside (`SlotMeter` + free-slot pills), and the `ResourceMeter`; with this endpoint live the console reads real capacity and resource data instead of mock metrics. The per-task read is the data source behind the session-detail page's per-task CPU/memory readout.

#### Scenario: Single response composes both metric kinds with provenance

- **WHEN** the dashboard fetches `/metrics`
- **THEN** the response contains both the derived capacity block and the sampled resource block in one payload, with each figure (or block) labeled as derived (exact, live) or sampled (with timestamp/age)

#### Scenario: Sampling outage degrades only the sampled block

- **WHEN** `/metrics` is requested while the container runtime stats source is unreachable or the latest sample is stale beyond a threshold
- **THEN** the endpoint still returns the exact semaphore-derived capacity block and marks the sampled CPU/memory block as unavailable/stale rather than returning an error for the whole endpoint

#### Scenario: Dashboard consumes one aggregation round trip

- **WHEN** the console renders capacity tiles, the slot meter, and the CPU/memory meters
- **THEN** all of those values are populated from a single `/metrics` response rather than from several disparate endpoints

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
