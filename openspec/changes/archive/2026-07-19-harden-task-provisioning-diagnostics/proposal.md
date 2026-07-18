## Why

Task provisioning currently leaves enough evidence to reconstruct a broad timeline, but provider and BoxLite failures are deliberately collapsed before a safe causal record is logged or persisted. The recent `vibe-zlyan` incident proved that this gap can make a completed clone followed by runtime setup and cleanup failure permanently indistinguishable from several different transport, command, or settlement faults.

## What Changes

- Introduce a strict, versioned, provider-neutral provisioning diagnostic event model, a task-level coverage marker, and a bounded task-owned attempt ledger that works in both legacy and durable admission modes and honestly distinguishes not-yet-started, partial, complete, and unavailable evidence.
- Preserve a primary provisioning failure independently from any secondary cleanup failure, and make every diagnostic event idempotent, correlated, secret-free, and queryable after container log rotation.
- Instrument shared Guardrails/provider boundaries plus AIO, cloud-http, and BoxLite adapters; for BoxLite, cover sandbox creation, native execution start/poll/attach/settlement, workspace/runtime setup, provider-internal cleanup, router fallback cleanup, and absence confirmation without recording commands, output, request bodies, credentials, prompts, provider endpoints, or raw provider resource/execution identifiers.
- Treat terminal BoxLite `failed`/`killed` states without an exit code as unresolved failures rather than success, while recording non-fatal attach degradation separately when polling proves the final settlement.
- Mirror the validated diagnostic envelope to structured stdout and add low-cardinality provisioning, settlement-anomaly, cleanup-failure, active-age, and orphan metrics.
- Add a deployment-gated, owner-required `tasks:diagnostics` Public V1 operation and matching MCP tool over one canonical, paginated, secret-free response; identity-less principals and cross-owner callers fail closed, while ordinary Task responses remain unchanged.
- Add a session-authenticated Console diagnostic view with owner access and administrator cross-owner access, plus explicit empty/degraded states for legacy evidence that predates the ledger.
- Add fault-injection, restart, request-disconnect, slow-private-repository, cleanup-failure, cross-surface parity, and secret-canary verification.

## Capabilities

### New Capabilities

- `task-provisioning-diagnostics`: Defines provisioning attempt identity, bounded immutable safe event detail with explicit compaction evidence, primary/cleanup outcome preservation, diagnostic retention, authorization, and canonical query semantics.

### Modified Capabilities

- `sandbox-provider-port`: Carries a correlated diagnostic emitter through provider-neutral provisioning and requires safe operation outcomes without raw provider data.
- `boxlite-sandbox-provider`: Makes native execution settlement lossless, observes the BoxLite operation lifecycle, and reports cleanup independently from the primary failure.
- `guardrails`: Creates and settles one diagnostic attempt for both legacy and durable admission while preserving restart, fencing, cancellation, and reconciliation semantics.
- `observability`: Emits provisioning diagnostic events with stable task/attempt/operation correlation and expands redaction requirements for commands, output, prompts, provider bodies, and credential paths.
- `resource-metrics`: Adds bounded, low-cardinality provisioning-stage, outcome, retry, cleanup, orphan, and settlement-anomaly metrics.
- `api-key-auth`: Adds the `tasks:diagnostics` scope without granting it implicitly to existing scoped machine credentials.
- `public-v1-api`: Adds the owner-scoped `tasks.provisioningDiagnostics` operation and canonical paginated response without widening ordinary Task responses.
- `mcp-server`: Adds `get_task_provisioning_diagnostics` with the same scope, owner policy, schema, pagination, and safe evidence as Public V1.
- `frontend-console`: Renders the safe attempt timeline and cleanup outcome for an authorized task while keeping raw provider diagnostics inaccessible.

## Impact

Affected areas include sandbox-core provider contracts and conformance, AIO/cloud-http adapters, BoxLite REST/native execution handling, provider-center fallback cleanup, host runtime setup descriptors, guardrails and admission orchestration, Prisma migrations and task-owned diagnostic persistence, structured logging and metrics, shared scopes/contracts/registry, Public V1 and MCP bindings, OpenAPI and API Playground generation, Console task detail UI, observability documentation, and provider/integration test fixtures. The change is additive at public boundaries and remains capability-gated during mixed deployment; existing task operations and previously minted scoped credentials retain their current permissions, and no raw diagnostic payload or provider-native identifier becomes public.
