## Context

CAP already emits structured application logs, persists lifecycle audit events, and has an opt-in Loki/Grafana stack. Durable admission also persists a safe stage, attempt, and terminal cause. Those layers describe lifecycle truth, but they do not preserve the provider-operation facts needed to explain a failure after workspace materialization. In the current BoxLite path, runtime setup can construct an error containing an exit code and scrubbed output, the provider then replaces it with a generic stage error, Guardrails logs only `provider details redacted`, and a subsequent cleanup rejection can replace the primary failure entirely.

The production incident motivating this change occurred while admission-v2 was gated off. Therefore the design cannot depend exclusively on `TaskAdmissionWork`: diagnostics must work for both the legacy synchronous path and the durable worker, while leaving `TaskAdmissionWork` as the sole durable admission authority. Public task responses must also remain intentionally small and safe; deeper evidence needs a separate authorization and response contract.

The affected trust boundaries are the runtime setup planner, sandbox-core provider port, BoxLite REST/native protocol adapter, Guardrails/admission orchestration, API persistence, structured logger, metrics, Public V1/MCP registry, and Console. Setup commands may embed encoded credentials and prompts, so logging their text or generic error payloads is not an acceptable solution.

## Goals / Non-Goals

**Goals:**

- Preserve enough secret-free causal evidence to distinguish provider transport, protocol, timeout, command exit, indeterminate settlement, cancellation, and cleanup failures.
- Correlate one task provisioning attempt across Guardrails, provider boundaries, BoxLite native operations, structured logs, database records, metrics, REST, MCP, and Console.
- Keep primary provisioning failure truth even when cleanup also fails.
- Make native terminal states lossless: `failed` or `killed` without an exit code can never become a successful exit.
- Keep diagnostic event cardinality and storage bounded and make replay/restart writes idempotent.
- Support both legacy and durable admission without creating a second admission authority.
- Expose a canonical owner-scoped diagnostic read through Public V1 and MCP under a new explicit scope, with administrator cross-owner access only through the authenticated Console/internal path.
- Prove secret safety and failure classification with deterministic fault injection rather than repository-specific hardcoding.

**Non-Goals:**

- Logging or persisting raw commands, argv, stdout/stderr, provider request/response bodies, endpoints, connection URLs, credentials, prompts, environment dumps, temporary secret paths, or lease tokens.
- Adding raw operational-log query through Public V1 or MCP.
- Expanding the ordinary Task response or its existing provisioning summary into a diagnostic bag.
- Replacing lifecycle audit, `TaskAdmissionWork`, `SandboxRun`, or the admission-v2 rollout/attestation process.
- Emitting an event for every BoxLite poll tick, output frame, or terminal byte.
- Introducing a full OpenTelemetry deployment or requiring Loki/Grafana for historical task diagnosis.
- Giving the legacy path a second automatic sandbox-ownership/reconciliation model; fenced orphan recovery remains an admission-v2 responsibility.

## Decisions

### 1. Diagnostics use a strict provider-neutral envelope, not raw errors

Define a versioned discriminated `ProvisioningDiagnosticEvent` contract in the provider-neutral sandbox boundary. Common fields are bounded and allowlisted: `schemaVersion`, `eventId`, `attemptId`, `taskId`, `attempt`, `admissionMode`, canonical provisioning `stage`, closed CAP provider family, CAP-generated `operationId`, enum `operation`, enum `phase`/`outcome`, observation time, and optional duration. Operation-specific variants may add only safe numeric or enum facts such as timeout milliseconds, HTTP status or status class, native execution status, nullable numeric exit code, retryability, enum command kind, and a stable safe cause code. Raw provider resource/execution ids never enter the diagnostic envelope; existing internal ownership records retain them where cleanup requires them.

No variant has `message`, arbitrary `metadata`, error serialization, command text, output, body, URL, header, credential path, prompt, or environment fields. Human-readable copy is derived from the stable codes at the read/UI boundary. Runtime setup commands gain an explicit allowlisted `kind` and ordinal; callers never infer a kind by parsing shell text.

Providers emit a validated envelope before an error is reduced for the public provider boundary. Unknown or invalid adapter values become `provider_protocol_error` or `settlement_unknown`; they are never interpolated. The logger and persistence adapter accept only a successfully parsed envelope, giving schema validation and Pino redaction complementary roles.

Alternative considered: log the scrubbed exception message. Scrubbing is not a stable contract, messages can contain provider bodies or encoded setup material, and it still cannot support deterministic API/MCP projection.

### 2. One attempt summary plus bounded immutable event detail is the historical source

Add a non-public task-level diagnostic schema/version expectation plus task-owned `TaskProvisioningDiagnosticAttempt` and `TaskProvisioningDiagnosticEvent` persistence. The expectation is written with new tasks so reads can distinguish accepted work that has not started an attempt from historical tasks that predate diagnostics. An attempt summary records the stable UUID attempt identity, task, admission mode, numeric attempt, closed provider family, current stage/state, coverage, primary safe cause, cleanup evidence, and start/finish timestamps. Event rows are versioned, ordered by an attempt-local sequence, deduplicated by a stable event key, and immutable while retained; normal recorder writes are append-only. The attempt summary and a fixed-schema task compaction summary are mutable projections; retained event rows are the detailed causal history.

Each logical operation emits at most a start event and one terminal event (`succeeded`, `failed`, `timed_out`, `cancelled`, `degraded`, or `indeterminate`). Poll ticks and attach frames are folded into the terminal summary. Strict per-attempt event and per-task detailed-attempt ceilings prevent repeated lease expiry from creating unbounded storage. Once the task ceiling is reached, one database transaction first advances a fixed-schema compaction summary with the compacted attempt-number range, bounded counts by closed primary/cleanup outcome, and an honest truncation count, then deletes event and detailed-attempt rows only for the oldest fully terminal, cleanup-settled attempts. It never compacts the active/latest or cleanup-pending attempt. A task-level monotonic next-attempt counter preserves numbering after detail is removed. This controlled compaction is the only event-detail deletion apart from task retention/deletion, and every read after compaction reports partial coverage plus the overflow summary.

Diagnostic persistence is not an admission authority. Major-boundary writes are awaited so terminal evidence is normally durable before cleanup, but a diagnostic-store failure is reported through a safe structured error and metric and does not change the controlled provisioning result. `TaskAdmissionWork` and Task lifecycle compare-and-swap rules remain authoritative.

Coverage is fail-closed. A task with the diagnostic expectation but no processing attempt yet returns `coverage = not_started` together with its canonical accepted/queued admission state. A task predating the marker returns `coverage = unavailable`. An interrupted attempt, a sequence gap, a persistence failure, a terminal Task with an unterminated or cleanup-pending attempt, a compaction/truncation marker, or a version the reader cannot fully interpret returns `coverage = partial`. Only an explicit terminal completeness marker written after the recorder verifies its durable operation invariants and cleanup is `not_required`, `succeeded`, or terminal-policy `failed` returns `coverage = complete`; absence of known gaps is never treated as proof. If initial attempt persistence fails, later writes may upsert only a partial attempt, and provisioning still follows its existing authority.

Alternative considered: rely only on Loki. Loki is opt-in, container logs rotate, and collection cannot restore data already discarded before logging.

### 3. Guardrails owns attempt identity for both admission modes

Guardrails creates a stable attempt context when an actual processing attempt wins running capacity and before it crosses provider selection or another external provider boundary. Accepted/unclaimed and capacity-queued durable work remains represented by `TaskAdmissionWork` plus the task-level diagnostic expectation and does not fabricate an attempt. Queue polling and promotion under the same durable work lineage open exactly one diagnostic attempt only when running provider processing begins; an expired open running/provider claim opens the next attempt, while terminal recovery continues the existing attempt and marks missing historical evidence partial rather than manufacturing completeness. Durable admission uses the claimed attempt number but never exposes its lease token; legacy admission opens an attempt when its running-capacity winner begins processing. The context carries `attemptId`, safe attempt number, admission mode, and diagnostic emitter through `SandboxProvisionContext`.

The existing async-local log context is extended so background admission and every provider callback inherit `taskId`, `attemptId`, stage, and operation id even when there is no HTTP request. `reqId` remains optional correlation for legacy HTTP creation and is not treated as the attempt identity.

Cancellation, lost lease, supersession, restart recovery, and retry each produce explicit safe outcomes. A durable retry receives a new attempt identity; replayed writes within the same claim reuse event keys. Legacy support provides diagnosis during the current rollout but does not make legacy provisioning restart-recoverable.

Alternative considered: let each provider generate unrelated ids. That prevents API, provider, and cleanup records from forming one deterministic task timeline.

### 4. Primary failure and cleanup failure are separate results

Provider orchestration classifies and durably records the primary causal fact before entering cleanup. Physical provider delete/confirm failures are secondary safe outcomes and must not replace it. Cleanup authority failures (`beforeSandboxCleanup`/`afterSandboxCleanup`, ownership-store compare-and-swap, lease, or database acknowledgement) remain orchestration coordination errors: they preserve recovery/lease semantics and may control worker settlement, while the already-recorded primary causal fact remains unchanged.

BoxLite internal partial-create cleanup and provider-center/router fallback teardown form one cleanup lineage. Each physical retry has its own bounded cleanup-attempt identity, but replay reuses that identity and emits no duplicate terminal event. The router must stop silently swallowing fallback cleanup failure and instead record the next safe cleanup attempt while preserving the primary cause.

`SandboxRun` remains the sole physical ownership and cleanup authority for durable admission. No parallel cleanup state machine is added: canonical pending is derived from authoritative `status = deleting`, success from confirmed `removed`/absence, and failed only after the configured reconciliation terminal policy atomically sets `status = failed` and relinquishes ownership. A single physical delete failure updates only cleanup-attempt evidence and leaves the run deleting. The durable work lease and concurrency slot remain owned until confirmed removal or that atomic terminal-policy transition; the Task lifecycle may already be terminal. Add only evidence such as cleanup attempt count, last safe outcome/cause, and observation time for diagnosis and metrics. Legacy diagnostics retain a CAP-generated correlation identity and cleanup evidence, not a raw provider resource id or a second automatic recovery authority; after its bounded best-effort teardown disposition it may release only its process-local slot.

Alternative considered: throw an aggregate raw error. It changes public classification, risks serializing provider details, and still allows callers to accidentally prefer cleanup over the original cause.

### 5. BoxLite native execution has explicit settlement semantics

Separate BoxLite-native status from numeric exit code inside the native parser. A protocol status of `failed` or `killed` is a proven failure even when `exit_code` is absent; diagnostics record `outcome = failed`, `exitCode = null`, and a missing-exit anomaly, never `0`. Before adapting to the existing provider-neutral command result whose exit code remains numeric, the client throws a typed settlement failure rather than widening every provider contract or fabricating `0`/`1`. `timeout`/`timed_out` remains a timeout. A malformed response or deadline without terminal proof is `settlement_unknown`/protocol failure. Attach uses an explicit success/degraded/timed-out result rather than overloading `null` as both no output and transport failure.

Instrument sandbox create/start/inspect, native exec start, bounded poll settlement, attach, workspace materialization, runtime preflight/setup commands, delete, and delete confirmation. Diagnostics correlate those operations only with CAP-generated attempt, event, and operation ids; native execution and sandbox ids remain confined to existing internal ownership/protocol state when required for execution or cleanup. Attach remains supplemental: if polling proves success, an attach error produces a degraded attach event without failing the command; if neither channel proves settlement, the result is indeterminate.

BoxLite request bodies and response text are never diagnostic fields. Safe classification uses transport rejection kind, HTTP status, parser outcome, deadline, native status, and numeric exit code before the existing provider redaction boundary.

Alternative considered: map every missing exit code to `1`. That avoids false success but destroys the distinction between a proven non-zero exit and an indeterminate provider settlement.

### 6. Structured logs mirror the canonical event but the database answers history

Every validated event is emitted as structured JSON with a fixed event name and the same safe fields used by persistence. Logger calls use object fields rather than interpolated messages. Task/attempt/operation correlation is therefore available to Docker/Loki filters, while task history remains queryable when aggregation is disabled or logs have rotated.

Pino redaction is expanded as defense in depth for command/argv, stdout/stderr/output, prompt, body, response, URL/endpoint, headers, environment, credential/secret paths, and provider error objects. Whole errors and configuration objects remain forbidden. A secret-canary suite scans serialized logs as well as persistence and every read surface.

Lifecycle audit remains the durable product timeline of stages and safe terminal causes. It may carry the stable attempt/diagnostic id for navigation, but per-operation diagnostic events are not duplicated into `audit_events`.

### 7. A separate scoped contract serves Public V1, MCP, and Console

Register `tasks.provisioningDiagnostics` as `GET /v1/tasks/{id}/provisioning-diagnostics` with explicit `ownerPolicy = required`, an `owner_required` boundary error, and required operation scope `tasks:diagnostics`. This is a new owner-aware boundary rather than the current optional-owner Task read policy: Public V1/MCP query by authenticated account id, return non-enumerating not-found for another owner, and reject identity-less or `ownerUserId = null` tasks. Its canonical response contains task id, coverage, current safe admission state, bounded attempt summaries, and keyset-paginated diagnostic events. The maximum page size is 200. Ordinary `tasks.create/list/get/stop` responses do not change.

Map the same registry operation to MCP `get_task_provisioning_diagnostics`. The tool advertises the same task id, limit, and cursor input; enforces the same owner and scope before service invocation; and returns the exact canonical structured content plus a direct JSON serialization of that same response as compatibility text. No summarized or transport-only text shape is allowed, so the sidecar requires no protocol difference. OpenAPI and API Playground derive the new operation and strict schemas from the registry.

Add `tasks:diagnostics` to the shared grantable scope vocabulary. Existing scoped API keys and MCP tokens do not receive it implicitly. A principal carrying a scope set must explicitly carry it; existing session principals with no explicit scope set retain allow-all scope compatibility but still must supply an owner identity. The identity-less legacy token therefore fails `owner_required` despite passing the scope helper. Public V1/MCP never grant an administrator exception. The Console route is session-only and rechecks the live User row (`allowed = true`, current `role = admin`) before any cross-owner read rather than trusting a stale session snapshot.

The registry/controller/read surface is protected by a separate deployment capability gate. It may be discoverable during an additive rollout, but returns retryable `task_provisioning_diagnostics_unavailable` until every API/MCP/Web role advertises compatible contracts. New scope grants remain disabled until the gate opens, avoiding mixed-version credentials that older scope parsers reject.

Alternative considered: add provider fields to `get_task`. That grants infrastructure evidence to every `tasks:read` credential, expands all nested Task projections, and makes safe task reads harder to keep stable.

### 8. Metrics are low-cardinality projections, not another event store

Extend resource/operational metrics with counters and histograms labeled only by closed provider family, canonical stage, enum operation, outcome, and retryable flag. Include stage/operation duration, attempts, retries, terminal safe causes, cleanup failures, and settlement anomalies. Gauges expose active attempts, oldest active age, cleanup-pending runs, and reconciler-confirmed orphans from durable database state.

Task ids, attempt ids, sandbox ids, execution ids, repository ids/URLs, and user ids are forbidden metric labels. The task diagnostics endpoint, not metrics, provides per-task evidence.

Alternative considered: emit a metric label per task or native execution. That creates unbounded cardinality and duplicates the queryable ledger.

### 9. Verification is a fault matrix plus cross-surface and secret gates

Provider conformance runs for AIO, cloud-http, and BoxLite. Scripted BoxLite responses and clocks inject: create/start rejection, HTTP transport failure, malformed payload, non-zero exit, `failed`/`killed` without exit code, attach constructor/error/close degradation, poll timeout, missing settlement, cancellation, runtime setup failure, internal delete failure, router fallback failure, and delete-confirmation failure. Assertions cover event version/order/deduplication, primary-versus-cleanup preservation, physical-versus-coordination cleanup errors, coverage completeness, correct controlled outcome, and absence of raw material.

API integration covers legacy and admission-v2 attempts, retry/restart/replay, request disconnect, authorization, keyset pagination, empty historical coverage, metrics, and cleanup/orphan projection. Public-surface fixtures prove registry, REST, MCP, OpenAPI, and Playground parity. A gated real BoxLite story includes a slow private Gitee repository but does not hardcode that repository into production logic.

The secret-canary gate injects recognizable tokens, credential URLs, prompts, paths, command fragments, provider bodies, stdout, and stderr, then asserts absence across stdout capture, database rows, audit, REST, MCP, OpenAPI examples, Playground mocks, and metrics.

## Risks / Trade-offs

- **[A diagnostic schema still leaks an unexpected field]** → Use strict discriminated schemas, reject unknown keys, permit only bounded CAP-generated correlation ids, keep human messages derived, and run cross-layer secret canaries.
- **[Awaited diagnostic writes add latency or couple provisioning to Postgres]** → Limit writes to operation boundaries, use short bounded persistence calls, never make diagnostics an admission authority, and surface write failures through safe logs/metrics.
- **[Event volume grows with long native polls]** → Persist only start plus one terminal/degraded summary per logical operation and enforce an attempt-local event ceiling.
- **[Mixed versions disagree on the new scope or operation]** → Ship additive schema/registry readers first, keep diagnostic writers and credential grants gated until all roles report capability, and retain ordinary task operations unchanged.
- **[Provider-native ids disclose infrastructure or payload data]** → Keep raw native ids only in existing internal ownership records; diagnostics/logs/Public V1/MCP use CAP-generated attempt/operation correlation ids.
- **[Legacy diagnostics imply legacy recovery is safe]** → Mark admission mode and cleanup coverage explicitly; automatic exact-owner orphan reconciliation remains available only with admission-v2 ownership.
- **[A diagnostic write fails and later reads overstate completeness]** → Write a task-level expectation, default uncertain evidence to partial, require an explicit terminal completeness marker, and never infer complete from missing gap evidence.
- **[Attach degradation is mistaken for command failure]** → Treat poll settlement as authoritative when proven and report attach as a separate degraded operation.
- **[Metrics become high-cardinality]** → Enforce label allowlists in contracts/tests and ban all task/resource/execution identities from labels.

## Migration Plan

1. Ship the additive task-level expectation, diagnostic tables/indexes, versioned strict contracts, readers that return honest not-started/partial/unavailable coverage, and scope/registry definitions while diagnostic writes, reads, and grants remain closed by a deployment capability gate.
2. Deploy sandbox-core, BoxLite, Guardrails/admission, logger, metrics, API, MCP, and Web support to every role. Run migration compatibility, provider conformance, public wire compatibility, and secret-canary gates.
3. Enable diagnostic writes for legacy and durable admission. Verify a successful task, each representative injected failure, a cleanup failure, and a request disconnect; confirm bounded rows, structured correlation, and zero secret-canary matches.
4. Open the gated `tasks.provisioningDiagnostics` read and then enable `tasks:diagnostics` in API-key/MCP-token grant UIs only after every API/MCP/Web role advertises the matching registry and scope-parser capability.
5. Independently complete the existing admission-v2 attestation/cutover. Confirm durable SandboxRun ownership, cleanup reconciliation, orphan gauges, and task diagnostics across restart.

Rollback first closes diagnostic reads, writes, and scope grants, while leaving additive tables and fail-closed readers in place. Existing diagnostics-scoped credentials are revoked before rolling back to a version whose scope parser does not recognize them. Ordinary Task/Public V1/MCP operations continue unchanged. Additive rows remain until a later cleanup release; no destructive down migration is part of emergency rollback.

## Open Questions

None blocking. The implementation may choose separate typed columns or a strictly validated serialized union for operation-specific facts, provided arbitrary diagnostic bags remain impossible and the database migration preserves the same public-safe contract.
