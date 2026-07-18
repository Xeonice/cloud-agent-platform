<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-ledger (depends: none)

- [x] 1.1 Define versioned strict shared contracts for the task diagnostic expectation, `not_started`/`partial`/`complete`/`unavailable` coverage, diagnostic attempt identity/state, stage and operation enums, safe cause/outcome variants, allowlisted runtime `commandKind`, primary and cleanup summaries, CAP-generated correlation ids, task/attempt bounds, typed compaction summary, and the canonical paginated query response; add exhaustive schema tests that reject every forbidden raw or unknown field.
  - requirements: ["task-provisioning-diagnostics/every-task-provisioning-attempt-has-a-stable-durable-identity", "task-provisioning-diagnostics/provisioning-event-detail-is-immutable-bounded-and-safe-by-construction", "task-provisioning-diagnostics/diagnostic-persistence-contains-no-raw-provider-or-secret-material"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [x] 1.2 Add the non-public Task diagnostic-version expectation and monotonic next-attempt counter, additive Prisma models/indexes for task-owned attempts/events plus a fixed-schema compaction summary, and `SandboxRun` cleanup evidence fields while retaining its existing status as the sole cleanup authority; enforce task-local ordering/ceilings, event version/idempotency/sequence, bounded safe values, primary-versus-cleanup separation, controlled old-detail deletion, and cascade ownership without an arbitrary diagnostic JSON bag.
  - requirements: ["task-provisioning-diagnostics/every-task-provisioning-attempt-has-a-stable-durable-identity", "task-provisioning-diagnostics/primary-provisioning-and-cleanup-outcomes-remain-independent", "task-provisioning-diagnostics/diagnostic-evidence-outlives-ephemeral-operational-logs-without-replacing-audit"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 1.3 Add fresh, upgrade, compatibility, task-delete, controlled-compaction, and rollback migration coverage proving old tasks remain unchanged, new tasks carry the expectation marker/counter, diagnostic rows cannot violate version/attempt/event constraints, a compaction summary is durable before old terminal detail is deleted, old tasks read unavailable, missing expected writes read partial, and rollback never copies a diagnostic value into public Task or audit prose; run the actual API migration suite rather than only its workflow-definition guard.
  - requirements: ["task-provisioning-diagnostics/every-task-provisioning-attempt-has-a-stable-durable-identity", "task-provisioning-diagnostics/diagnostic-evidence-outlives-ephemeral-operational-logs-without-replacing-audit"]
  - surfaces: ["contracts", "ci", "developer-workflow"]
  - verify: "api-mcp"
- [x] 1.4 Implement the diagnostic attempt/event recorder, controlled compactor, and read projector with atomic monotonic attempt numbering, immutable versioned/idempotent event keys, per-attempt and per-task detail ceilings, transactional typed overflow summary before deletion of only oldest cleanup-settled detail, stable keyset pagination, explicit not-started/partial/complete/unavailable rules, no completeness marker while cleanup is pending, safe partial upsert after write failure, and persistence-failure reporting that never becomes admission authority.
  - requirements: ["task-provisioning-diagnostics/provisioning-event-detail-is-immutable-bounded-and-safe-by-construction", "task-provisioning-diagnostics/diagnostic-evidence-outlives-ephemeral-operational-logs-without-replacing-audit", "task-provisioning-diagnostics/authorized-callers-query-one-canonical-paginated-diagnostic-projection"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 2. Track: provider-diagnostic-port (depends: contracts-ledger)

- [x] 2.1 Extend sandbox-core with the provider-neutral attempt context and validated diagnostic emitter, inject task/attempt/event identities without importing persistence/logging into providers, and provide an explicit non-persisting observer for taskless environment validation and health probes.
  - requirements: ["sandbox-provider-port/task-provisioning-context-carries-a-provider-neutral-diagnostic-emitter", "task-provisioning-diagnostics/provisioning-event-detail-is-immutable-bounded-and-safe-by-construction"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.2 Add allowlisted command descriptors to host runtime setup/preflight plans and classify exit, timeout, transport, protocol, cancellation, and indeterminate settlement before provider redaction without parsing or logging command text, output, prompts, paths, bodies, or raw errors.
  - requirements: ["sandbox-provider-port/task-provisioning-context-carries-a-provider-neutral-diagnostic-emitter", "task-provisioning-diagnostics/diagnostic-persistence-contains-no-raw-provider-or-secret-material", "observability/provisioning-diagnostic-logs-exclude-payload-and-provider-private-data"]
  - surfaces: ["contracts"]
  - verify: "api-public-errors"
- [x] 2.3 Introduce a provider-neutral primary/secondary cleanup result seam so physical cleanup failure or indeterminate deletion can never replace the primary operation; preserve provider fencing/idempotency, emit bounded per-attempt evidence, and prove a failed/unconfirmed physical attempt leaves durable canonical cleanup pending until authoritative removal or terminal-policy settlement.
  - requirements: ["sandbox-provider-port/provider-cleanup-reports-a-secondary-outcome-without-replacing-the-primary-failure", "task-provisioning-diagnostics/primary-provisioning-and-cleanup-outcomes-remain-independent"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.4 Expand sandbox provider conformance and staged-workspace tests with deterministic start/terminal event bounds, replay deduplication, timeout/cancellation, primary-plus-cleanup failure, credential-cleanup failure, taskless probe behavior, and a raw-provider/secret canary.
  - requirements: ["sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures", "task-provisioning-diagnostics/diagnostic-persistence-contains-no-raw-provider-or-secret-material"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 2.5 Integrate AIO and cloud-http with the shared Guardrails outer-boundary diagnostics plus provider-specific execution/cleanup facts where available, prove both families pass the same conformance and primary/cleanup invariants as BoxLite, and run `pnpm test:sandbox` explicitly so no eligible provider remains uninstrumented.
  - requirements: ["sandbox-provider-port/task-provisioning-context-carries-a-provider-neutral-diagnostic-emitter", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "task-provisioning-diagnostics/diagnostic-persistence-contains-no-raw-provider-or-secret-material"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 3. Track: boxlite-native-settlement (depends: provider-diagnostic-port)

- [x] 3.1 Refactor native execution parsing to model provider terminal status separately from nullable exit code: affirmative completed/zero succeeds; failed or killed without an exit code is a proven failed diagnostic with `exitCode = null` and a missing-exit anomaly, then raises a typed settlement failure before the existing numeric provider-neutral result; only absent terminal proof is indeterminate, and malformed/poll-transport/poll-deadline outcomes stay distinct rather than defaulting to zero.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "boxlite-sandbox-provider/boxlite-native-operations-emit-bounded-correlated-diagnostics"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.2 Instrument BoxLite create/start/inspect, exec-start/poll/attach/settlement, workspace/preflight/runtime setup, delete, and absence confirmation with one bounded start/terminal lifecycle and CAP-generated attempt/operation correlation; never emit raw provider resource/execution ids, poll ticks, frames, request paths/bodies, commands, output, prompts, or native prose.
  - requirements: ["boxlite-sandbox-provider/boxlite-native-operations-emit-bounded-correlated-diagnostics", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope", "observability/provisioning-diagnostic-logs-exclude-payload-and-provider-private-data"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.3 Replace attach's overloaded nullable result with an explicit success/degraded/timed-out union: constructor/error/early-close becomes a degraded event, proven poll settlement remains authoritative, and command completion does not wait a second full attach timeout once settlement is known.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "boxlite-sandbox-provider/boxlite-native-operations-emit-bounded-correlated-diagnostics"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.4 Persist the classified primary fact before cleanup, treat BoxLite internal cleanup and provider-center/router fallback as idempotent attempts in one cleanup lineage with replay-stable and retry-incremented cleanup identities, record physical delete/confirmation separately without replacing primary or settling durable authority, and preserve ownership/lease/database cleanup-authority failures as orchestration coordination outcomes.
  - requirements: ["boxlite-sandbox-provider/boxlite-cleanup-preserves-and-follows-the-primary-provisioning-outcome", "task-provisioning-diagnostics/primary-provisioning-and-cleanup-outcomes-remain-independent"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.5 Extend `boxlite-client`, `boxlite-provider`, and provider-center suites for completed/zero, non-zero, failed/killed missing-exit, malformed terminal response, poll 5xx/network/timeout, attach degradation/hang, cancellation, runtime setup failure, internal plus fallback delete/confirm failure, cleanup replay/retry identities, physical-versus-coordination cleanup, durable pending authority, primary preservation, event bounds, and secret absence; run `pnpm test:sandbox` explicitly.
  - requirements: ["boxlite-sandbox-provider/boxlite-native-operations-emit-bounded-correlated-diagnostics", "boxlite-sandbox-provider/boxlite-cleanup-preserves-and-follows-the-primary-provisioning-outcome", "boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 4. Track: admission-diagnostic-orchestration (depends: contracts-ledger, provider-diagnostic-port, boxlite-native-settlement)

- [x] 4.1 Add the deployment-gated diagnostic recorder to Guardrails and create a stable attempt only after running capacity is won and before provider selection/boundary in both legacy and durable modes; preserve accepted/queued `not_started` coverage without fabricating an attempt, and bind `taskId`, `attemptId`, safe attempt number, stage, and operation into async log context without exposing lease tokens.
  - requirements: ["guardrails/guardrails-owns-diagnostic-attempt-lifecycle-across-every-admission-mode", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope", "task-provisioning-diagnostics/every-task-provisioning-attempt-has-a-stable-durable-identity"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.2 Route provider/workspace/runtime progress and classified terminal outcomes through the shared recorder for legacy and admission-v2, preserving existing Task/admission/audit authority and ensuring diagnostic-write failure cannot rewrite or block the controlled lifecycle result.
  - requirements: ["guardrails/guardrails-owns-diagnostic-attempt-lifecycle-across-every-admission-mode", "sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures", "task-provisioning-diagnostics/diagnostic-evidence-outlives-ephemeral-operational-logs-without-replacing-audit"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.3 Align durable claims and diagnostic attempts: capacity queue/promotion does not increment attempts, same-claim replay is idempotent, an expired running-lease re-claim closes the old attempt as interrupted/indeterminate and creates the next number, terminal recovery continues existing or partial evidence, a retry creates a new attempt, task-level detail stays bounded, and proven SandboxRun ownership is readopted without merging histories.
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "task-provisioning-diagnostics/every-task-provisioning-attempt-has-a-stable-durable-identity", "task-provisioning-diagnostics/provisioning-event-detail-is-immutable-bounded-and-safe-by-construction"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.4 Retain `SandboxRun.status` as the fenced cleanup authority, derive pending/success/failed only from deleting/confirmed removal/atomic terminal-policy relinquishment, persist only cleanup-attempt/last-safe-outcome evidence, keep every nonterminal physical failure deleting, retain durable lease/slot until authoritative settlement, preserve coordination errors for recovery, derive confirmed orphan state, and let legacy release only its process-local slot without creating a second automatic delete authority.
  - requirements: ["guardrails/guardrails-carry-selected-provider-context-through-the-task-lifecycle", "guardrails/teardown-is-provider-specific-and-idempotent", "task-provisioning-diagnostics/primary-provisioning-and-cleanup-outcomes-remain-independent"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.5 Add Guardrails/admission integration stories for unclaimed acceptance, queue wait/promotion, legacy request disconnect, durable restart/expired lease/terminal recovery, same-claim replay, retry, diagnostic-write failure, cancellation/supersession, physical and coordination cleanup failures, durable pending-slot retention, terminal-policy release, legacy process-slot release, reconciliation, one slot/one sandbox ownership, cleanup-aware completeness coverage, and no event/audit duplication.
  - requirements: ["guardrails/guardrails-owns-diagnostic-attempt-lifecycle-across-every-admission-mode", "guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "guardrails/teardown-is-provider-specific-and-idempotent"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 5. Track: public-v1-mcp-diagnostics (depends: contracts-ledger, admission-diagnostic-orchestration)

- [x] 5.1 Add `tasks:diagnostics` to the shared grantable scope vocabulary, API-key and MCP-token contracts/services, and authorization tests; preserve existing no-scope session allow-all scope behavior while proving old scoped credentials gain no implicit access and identity-less legacy principals still fail the independent owner-required boundary.
  - requirements: ["api-key-auth/authorization-scopes-gate-scoped-operations", "task-provisioning-diagnostics/authorized-callers-query-one-canonical-paginated-diagnostic-projection"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"
- [x] 5.2 Register deployment-gated `tasks.provisioningDiagnostics` at `GET /v1/tasks/:id/provisioning-diagnostics` with `ownerPolicy = required`, `owner_required` and retryable `task_provisioning_diagnostics_unavailable`, canonical task id/limit/cursor schemas, explicit scope semantics, account-id ownership query, non-enumerating cross-owner/ownerless denial, and no Public V1 administrator exception.
  - requirements: ["public-v1-api/versioned-additive-v1-surface-delegating-to-existing-services", "public-v1-api/public-v1-exposes-scoped-provisioning-diagnostics-without-widening-task", "task-provisioning-diagnostics/authorized-callers-query-one-canonical-paginated-diagnostic-projection", "api-mcp-development-parity/canonical-public-capability-registry"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-v1"
- [x] 5.3 Map the gated registry operation to `get_task_provisioning_diagnostics`, enforce the same required-owner/scope/query/pagination/unavailable contract before service invocation, and return canonical structured content plus its direct JSON serialization as compatibility text with no summarized or transport-only protocol difference.
  - requirements: ["mcp-server/mcp-exposes-scoped-task-provisioning-diagnostics", "public-v1-api/public-v1-exposes-scoped-provisioning-diagnostics-without-widening-task", "api-mcp-development-parity/transport-bindings-are-exhaustive"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 5.4 Add a session-only Internal Console diagnostics controller over the same query service, allowing owners and live-DB-verified `allowed` administrators (including ownerless historical tasks) while denying stale-role, disabled, non-owner, machine, legacy-token, and unauthenticated principals; do not add an administrator exception to Public V1/MCP.
  - requirements: ["task-provisioning-diagnostics/authorized-callers-query-one-canonical-paginated-diagnostic-projection", "frontend-console/console-renders-owner-and-administrator-provisioning-diagnostics-safely"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.5 Add real-service REST/MCP conformance for gated unavailable, 200 pagination, not-started/partial/complete/unavailable coverage, primary-plus-cleanup records, 403 missing scope, owner-required identity-less denial, ownerless/cross-owner non-enumeration, malformed cursor/limit, exact structured/text field/order parity, and ordinary Task response non-expansion.
  - requirements: ["public-v1-api/public-v1-exposes-scoped-provisioning-diagnostics-without-widening-task", "mcp-server/mcp-exposes-scoped-task-provisioning-diagnostics", "api-mcp-development-parity/rest-and-mcp-adapters-pass-shared-behavioral-conformance"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "public-surface-fast"
- [x] 5.6 Regenerate and verify OpenAPI plus API Playground operation catalog, required owner/scope, capability-gated unavailable error, pagination, strict versioned response union, not-started/partial/unavailable and primary/cleanup examples, non-2xx bodies, and the exact new operation/tool inventory with no independently maintained schema.
  - requirements: ["public-v1-api/public-v1-exposes-scoped-provisioning-diagnostics-without-widening-task", "mcp-server/mcp-exposes-scoped-task-provisioning-diagnostics", "api-mcp-development-parity/transport-bindings-are-exhaustive"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground"]
  - verify: "openapi-playground"

## 6. Track: observability-and-metrics (depends: contracts-ledger, admission-diagnostic-orchestration)

- [x] 6.1 Mirror each validated versioned diagnostic event to Pino as fixed structured fields with shared CAP event/task/attempt/operation correlation, safe duration/outcome/cause data, no raw provider identifiers or free-form error interpolation, and bind durable background worker logs to the task attempt context.
  - requirements: ["observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope", "task-provisioning-diagnostics/provisioning-event-detail-is-immutable-bounded-and-safe-by-construction"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 6.2 Expand logger defense-in-depth redaction and rejection tests for command/argv, stdout/stderr/output, prompt, bodies/responses, URL/endpoint, headers, environment, credential/secret path, raw provider resource/execution ids, provider error/cause/stack, encoded values, and Buffer variants while preserving only CAP-generated bounded correlation fields.
  - requirements: ["observability/provisioning-diagnostic-logs-exclude-payload-and-provider-private-data", "task-provisioning-diagnostics/diagnostic-persistence-contains-no-raw-provider-or-secret-material"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-public-errors"
- [x] 6.3 Add the provisioning diagnostics metrics block with closed provider-family plus low-cardinality stage/operation/outcome/cause/retry/cleanup/anomaly aggregates, bounded duration summaries, counter `observedSince`, and durable active-age/cleanup-pending/orphan gauges; forbid every task/attempt/operation/provider-id/resource/execution/repository/account identifier label.
  - requirements: ["resource-metrics/provisioning-diagnostics-expose-honest-low-cardinality-operational-metrics", "task-provisioning-diagnostics/primary-provisioning-and-cleanup-outcomes-remain-independent"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 6.4 Add metrics tests for success/failure/retry duration, missing-exit versus attach-degraded buckets, cleanup failure and later reconciliation, restart counter provenance, durable gauge hydration, unavailable/stale source isolation, exact label allowlists, and zero secret/identifier leakage.
  - requirements: ["resource-metrics/provisioning-diagnostics-expose-honest-low-cardinality-operational-metrics", "observability/provisioning-diagnostic-logs-exclude-payload-and-provider-private-data"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 7. Track: console-diagnostics (depends: public-v1-mcp-diagnostics)

- [x] 7.1 Add the typed Console API/query seam and task-detail diagnostics route/panel over the canonical response, with session-only owner/live-verified-admin server authorization, bounded cursor loading, stable query keys, and no diagnostic values copied into ordinary Task, transcript, terminal, or schedule caches.
  - requirements: ["frontend-console/console-renders-owner-and-administrator-provisioning-diagnostics-safely", "task-provisioning-diagnostics/authorized-callers-query-one-canonical-paginated-diagnostic-projection"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [x] 7.2 Render attempt-grouped safe stage/operation/timing/outcome evidence, distinguish primary from cleanup state, and provide honest loading, denied, partial, unavailable legacy, truncated, and reconciliation-pending states without parsing audit prose or displaying/caching raw provider material.
  - requirements: ["frontend-console/console-renders-owner-and-administrator-provisioning-diagnostics-safely", "task-provisioning-diagnostics/primary-provisioning-and-cleanup-outcomes-remain-independent"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [x] 7.3 Add explicit unchecked `tasks:diagnostics` permission controls and warning copy to API-key and MCP-token settings, preserving existing defaults; cover owner/admin/non-owner behavior, pagination order, primary/cleanup presentation, unavailable evidence, secret-canary absence from DOM/cache/toasts/copy, and responsive task-detail rendering.
  - requirements: ["frontend-console/console-renders-owner-and-administrator-provisioning-diagnostics-safely", "api-key-auth/authorization-scopes-gate-scoped-operations"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"

## 8. Track: integration-and-rollout (depends: boxlite-native-settlement, admission-diagnostic-orchestration, public-v1-mcp-diagnostics, observability-and-metrics, console-diagnostics)

- [x] 8.1 Add a deterministic AIO/cloud-http/BoxLite provider fault matrix covering create/start/inspect rejection, runtime command non-zero, failed/killed missing-exit, malformed/lost poll settlement, attach degradation/hang, timeout, cancellation, primary plus internal/router delete/confirm failure, cleanup coordination error, replay-versus-new-cleanup identity, durable pending-slot retention and terminal-policy release, same-claim replay, queue promotion, expired-lease readoption, retry, and later reconciliation.
  - requirements: ["boxlite-sandbox-provider/boxlite-native-operations-emit-bounded-correlated-diagnostics", "guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "task-provisioning-diagnostics/primary-provisioning-and-cleanup-outcomes-remain-independent"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 8.2 Extend the private-Git secret-canary story with raw, URL-encoded, base64, and Buffer variants across command/argv/cwd/prompt/stdout/stderr/error/cause/stack/body/WS reason/token URL/header/temp path and raw provider ids, then scan stdout, diagnostic DB, audit, SandboxRun diagnostic fields, REST, MCP structured/text, OpenAPI examples, Playground fixtures, metrics, Console DOM/cache/toasts/copy, and prove only existing internal ownership columns may retain a required raw provider id.
  - requirements: ["task-provisioning-diagnostics/diagnostic-persistence-contains-no-raw-provider-or-secret-material", "observability/provisioning-diagnostic-logs-exclude-payload-and-provider-private-data", "public-v1-api/public-v1-exposes-scoped-provisioning-diagnostics-without-widening-task", "mcp-server/mcp-exposes-scoped-task-provisioning-diagnostics"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground", "ci"]
  - verify: "public-surface-full"
- [x] 8.3 Add legacy and admission-v2 stories for unclaimed/queued work, create-request disconnect, API restart, diagnostic-write failure, log rotation, interrupted/new/terminal-recovery attempts, successful readoption, transactional task-attempt compaction with monotonic numbering, cleanup-pending partial coverage, schema-version compatibility, cross-surface reads, and honest not-started/partial/complete/unavailable coverage, proving the ledger survives independently without changing admission-v2 authority.
  - requirements: ["guardrails/guardrails-owns-diagnostic-attempt-lifecycle-across-every-admission-mode", "task-provisioning-diagnostics/diagnostic-evidence-outlives-ephemeral-operational-logs-without-replacing-audit", "task-provisioning-diagnostics/authorized-callers-query-one-canonical-paginated-diagnostic-projection"]
  - surfaces: ["contracts", "public-v1", "mcp", "ci"]
  - verify: "public-surface-full"
- [x] 8.4 Extend the gated native BoxLite story with a generated slow private repository and controlled runtime-setup failures, proving bounded operation evidence, reliable settlement, separate cleanup, zero leaked credentials, zero unowned leftover boxes after durable reconciliation, and no repository-specific production branch.
  - requirements: ["boxlite-sandbox-provider/boxlite-native-operations-emit-bounded-correlated-diagnostics", "boxlite-sandbox-provider/boxlite-cleanup-preserves-and-follows-the-primary-provisioning-outcome", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 8.5 Document the versioned diagnostic/coverage vocabulary, safe/forbidden fields, required owner and scope semantics, identity-less/ownerless behavior, direct MCP JSON parity, metrics interpretation, deployment capability gate, staged deployment, admission-v2 independence, operator investigation flow, credential-grant timing, and gate-first rollback/revocation for diagnostics-scoped credentials.
  - requirements: ["task-provisioning-diagnostics/authorized-callers-query-one-canonical-paginated-diagnostic-projection", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope", "resource-metrics/provisioning-diagnostics-expose-honest-low-cardinality-operational-metrics"]
  - surfaces: ["docs", "developer-workflow"]
  - verify: "docs"
- [x] 8.6 Run strict OpenSpec validation, propose/apply metadata validation, the actual migration suite, contracts/API/web suites, explicit `pnpm test:sandbox` for sandbox-core/AIO/cloud-http/BoxLite/provider-center, gated native BoxLite E2E, focused/fresh public-surface gates, compatibility fixtures, production forbidden-field scans, and `git diff --check`; record every command result and repair every failure before opening diagnostic reads, writes, or credential grants.
  - requirements: ["api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally", "task-provisioning-diagnostics/diagnostic-persistence-contains-no-raw-provider-or-secret-material", "public-v1-api/public-v1-exposes-scoped-provisioning-diagnostics-without-widening-task", "mcp-server/mcp-exposes-scoped-task-provisioning-diagnostics"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground", "openspec", "ci", "developer-workflow"]
  - verify: "public-surface-full"
- [x] 8.7 Validate `surface-impact.json`, task metadata, new operation/tool inventory, zero protocol differences, cross-track semantic coupling, wire-compatibility fixtures, and propose/apply/verify phase transitions before archive.
  - requirements: ["api-mcp-development-parity/canonical-public-capability-registry", "api-mcp-development-parity/transport-bindings-are-exhaustive", "task-provisioning-diagnostics/authorized-callers-query-one-canonical-paginated-diagnostic-projection"]
  - surfaces: ["openspec", "developer-workflow", "public-v1", "mcp"]
  - verify: "openspec-metadata"
