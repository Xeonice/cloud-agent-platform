## MODIFIED Requirements

### Requirement: Aggregation endpoint composes derived and sampled metrics for the dashboard

The orchestrator SHALL expose a single `/metrics` aggregation endpoint that the console dashboard and workspace launcher consume in one round trip. The response SHALL compose (a) the exact semaphore-derived capacity block (ceiling, active, free, queueDepth, slot occupancy table, queued ids) and (b) the sampled resource block (per-container and/or aggregate CPU and memory) with its sample timestamp/age, and SHALL clearly distinguish derived figures (always current and exact) from sampled figures (cadence-bounded, possibly slightly stale). A failure or staleness in the sampled block (e.g. the container runtime is unreachable) SHALL degrade only the sampled portion — the endpoint SHALL still return the exact derived capacity block rather than failing the whole response, and SHALL mark the sampled block unavailable/stale so the console can show capacity even when host sampling is down.

The orchestrator SHALL ALSO expose a PER-TASK resource read (`GET /tasks/:taskId/metrics`, or an equivalent `?taskId=` filter) that returns that single task's sampled CPU/memory — the `cap-aio-<taskId>` container's sample (CPU percent, memory bytes, memory limit, memory percent) sourced from the SAME sampler snapshot that backs `/metrics` (no additional sampling pass). When the task has no live sampled container (it is not `running`, or the latest snapshot has no entry for it yet), the per-task read SHALL return an explicit not-running/not-sampled state rather than an error or fabricated zeros, so the console can show "未运行/未采样" honestly. This read is REAL-TIME ONLY — it reflects the latest snapshot and does NOT imply any persisted resource history. The per-task read SHALL be auth-gated identically to `/metrics` (see the auth requirement): a missing/expired/non-allowlisted session SHALL be rejected 401 with no resource data.

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

#### Scenario: Per-task read returns a running task's own CPU and memory

- **WHEN** an allowlisted operator requests the per-task metrics read for a `running` task
- **THEN** the orchestrator returns that task's sampled CPU percent and memory (bytes/limit/percent) for its `cap-aio-<taskId>` container, sourced from the latest sampler snapshot

#### Scenario: Per-task read returns an explicit not-running state for a task with no live container

- **WHEN** the per-task metrics read is requested for a task that is not `running` (or whose container is not yet in the latest snapshot)
- **THEN** the orchestrator returns an explicit not-running/not-sampled state rather than an error or fabricated zeros

#### Scenario: Per-task read is auth-gated like the aggregation endpoint

- **WHEN** the per-task metrics read is requested without a valid allowlisted session
- **THEN** the orchestrator responds 401 and returns no per-task resource data
