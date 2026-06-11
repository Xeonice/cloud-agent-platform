# resource-metrics Spec Delta — console-design-pixel-merge

## MODIFIED Requirements

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
