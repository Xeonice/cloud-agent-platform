<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-and-database (depends: none)

- [x] 1.1 Extend the canonical task-create and task-response contracts with the optional requested `model`, including trim/2048-UTF-8-byte/control-character validation, nullable read semantics, and direct/V1/schedule contract tests that call the production schemas.
  - requirements: ["repo-and-task-management/tasks-durably-carry-the-requested-runtime-model", "public-v1-api/v1-only-contract-schemas-are-additive"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"
- [x] 1.2 Add catalog query/response schemas, managed/deployment environment union, source/completeness and account-discovered/CLI-version-verified evidence enums, safe model items, preflight errors, and model setup/rejection TaskFailure schemas without a static id enum.
  - requirements: ["runtime-model-catalog/catalog-responses-are-stable-ordered-honest-and-non-secret", "public-v1-api/public-v1-returns-stable-model-domain-failures"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"
- [x] 1.3 Add schedule-run `retrying` status plus nullable `errorCode`, `retryAt`, and retry-attempt metadata to latest-run/list contracts and mapping types while retaining existing safe text and backward compatibility.
  - requirements: ["scheduled-tasks/pre-task-schedule-failures-are-structured-and-exactly-once"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"
- [x] 1.4 Add nullable Prisma `Task.model`, non-secret immutable execution-environment snapshot, and TaskScheduleRun error/retry/internal template-snapshot fields plus a forward migration; verify fresh migration and historical null-row reads.
  - requirements: ["repo-and-task-management/tasks-durably-carry-the-requested-runtime-model", "scheduled-tasks/each-schedule-occurrence-is-recorded-exactly-once"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 1.5 Add contract fixtures using `Buffer.byteLength` boundaries that prove punctuation/ARN-like model ids round-trip while empty, over-2048-byte, control-character, and null-byte values fail through the real schema rather than test-only validation logic.
  - requirements: ["runtime-model-catalog/explicit-task-models-are-validated-against-a-current-catalog"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [x] 1.6 Define the default-closed `task-model-selection-v1` deployment capability, role-reporting/readiness contract, and safe N-worker gate result shared by API, admission, scheduler, and runtime packages without treating nullable schema support or an N-only gate as protection from N-1 unknown-field stripping.
  - requirements: ["runtime-model-catalog/explicit-model-selection-is-fenced-from-legacy-workers"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"

## 2. Track: catalog-core (depends: contracts-and-database)

- [x] 2.1 Create the transport-neutral runtime-model catalog and taskless probe lifecycle ports, domain result/error types, and service module with adapters selected by runtime and execution-ready credential mode.
  - requirements: ["runtime-model-catalog/model-catalogs-resolve-in-the-task-owner-s-effective-execution-context", "runtime-model-catalog/catalog-probes-are-bounded-taskless-resources"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 2.2 Extend the shared task environment resolver so omitted, null, and UUID contexts resolve the exact provider digest/checksum, validated metadata, and CLI version used by catalog and provisioning; represent deployment fallback with null managed id and fail explicit selection closed if immutable identity is unavailable.
  - requirements: ["runtime-model-catalog/catalog-validation-and-task-launch-share-one-immutable-environment-snapshot"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 2.3 Implement deterministic normalization, safe response projection, catalog revision generation, and secret/raw-diagnostic redaction over adapter results.
  - requirements: ["runtime-model-catalog/catalog-responses-are-stable-ordered-honest-and-non-secret"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 2.4 Implement bounded cache/coalescing keyed by owner/credential/runtime/exact environment/CLI, plus global/per-owner probe quotas and a fair bounded queue; prohibit mutable-tag keys, stale validation, cross-owner reuse, and single-owner capacity starvation.
  - requirements: ["runtime-model-catalog/catalog-caching-is-isolated-by-every-availability-boundary", "runtime-model-catalog/catalog-probes-are-bounded-taskless-resources"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 2.5 Add the shared explicit-model preflight operation that short-circuits when `model` is omitted and otherwise resolves/validates a catalog before write transactions.
  - requirements: ["runtime-model-catalog/explicit-task-models-are-validated-against-a-current-catalog"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 2.6 Unit-test the production catalog service with adapter fakes for three-state managed/deployment environment responses, deterministic revisions/order, cache invalidation/isolation, unavailable selectors, catalog outage, secret redaction, and no-adapter/unready-credential fail-closed behavior.
  - requirements: ["runtime-model-catalog/model-catalogs-resolve-in-the-task-owner-s-effective-execution-context", "runtime-model-catalog/catalog-responses-are-stable-ordered-honest-and-non-secret", "runtime-model-catalog/catalog-caching-is-isolated-by-every-availability-boundary"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"

## 3. Track: task-creation-seam (depends: catalog-core)

- [x] 3.1 Persist/project `Task.model` plus its non-secret immutable environment snapshot through task creation and recovery; keep model in canonical create/get/list/stop/pagination/schedule provenance while keeping internal snapshot details out of public secrets.
  - requirements: ["repo-and-task-management/tasks-durably-carry-the-requested-runtime-model", "runtime-model-catalog/catalog-validation-and-task-launch-share-one-immutable-environment-snapshot"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 3.2 Introduce a prepared-task-create value used by Console, MCP, V1-new-key, and internal admission so external catalog/environment/credential work completes before the pure task-row write and admission continues only after commit.
  - requirements: ["runtime-model-catalog/explicit-task-models-are-validated-against-a-current-catalog", "repo-and-task-management/tasks-durably-carry-the-requested-runtime-model"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 3.3 Refactor V1 idempotency into side-effect-free key/body lookup → missing-key external preflight → transaction race recheck/write, and add bounded same-key winner lookup before returning a preflight error so historical/concurrently committed exact replays bypass current catalog state.
  - requirements: ["public-v1-api/public-v1-task-and-schedule-contracts-carry-requested-models"]
  - surfaces: ["public-v1"]
  - verify: "api-v1"
- [x] 3.4 Extend `ProvisionLookup`, terminal context resolution, sandbox/integration contexts, host harness, and every launch call site with required model intent plus persisted immutable environment snapshot, pinning AIO/BoxLite provisioning and recovery to the cataloged provider identity.
  - requirements: ["runtime-model-catalog/catalog-validation-and-task-launch-share-one-immutable-environment-snapshot", "repo-and-task-management/tasks-durably-carry-the-requested-runtime-model"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.5 Write explicit model material through the existing bounded base64/file setup mechanism at a fixed task-local path, omit it only for a successfully resolved null, and fail closed on lookup, propagation, missing/empty/unreadable material, cleanup, or checksum errors.
  - requirements: ["agent-runtime/explicit-model-material-fails-closed-before-launch", "agent-runtime/omitted-and-recovered-models-preserve-deterministic-runtime-behavior"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.6 Extend task failure/audit projection with `runtime_model_setup_failed` and evidence-gated `runtime_model_rejected`; accept only structured or pinned stable model-rejection evidence, retain requested intent, redact diagnostics, and preserve existing auth/network/quota/generic classifiers.
  - requirements: ["agent-runtime/runtime-model-launch-rejection-is-a-structured-task-failure", "agent-runtime/explicit-model-material-fails-closed-before-launch"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-public-errors"
- [x] 3.7 Add real-seam tests covering create → database → response/recovery → provision lookup → every launch context, including old null rows, lookup error, missing file, re-adopted fresh launch, structured failures, and no Task/task-owned execution sandbox after preflight failure.
  - requirements: ["repo-and-task-management/tasks-durably-carry-the-requested-runtime-model", "agent-runtime/explicit-model-material-fails-closed-before-launch", "runtime-model-catalog/explicit-task-models-are-validated-against-a-current-catalog"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 3.8 Make model-aware admission/runtime workers honor or fail closed on every persisted explicit selector and immutable snapshot even when the write gate is closed, and expose the role capability needed to fence N-1 claimers before enablement.
  - requirements: ["runtime-model-catalog/explicit-model-selection-is-fenced-from-legacy-workers", "agent-runtime/explicit-model-material-fails-closed-before-launch"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 4. Track: codex-model-support (depends: task-creation-seam)

- [x] 4.1 Extend the bounded Codex App Server client and pinned protocol fixture with production `model/list` pagination/metadata plus any trustworthy structured model-rejection evidence supported by the pin, and safe malformed/timeout/oversize behavior.
  - requirements: ["runtime-model-catalog/runtime-adapters-discover-only-models-supported-by-the-effective-cli-path", "agent-runtime/runtime-model-launch-rejection-is-a-structured-task-failure"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 4.2 Implement the taskless Codex probe for the exact resolved AIO/BoxLite/custom identity with owner credentials, labels, fair owner/global capacity, bounded queue/timeout/cancel, guaranteed teardown, orphan reconciliation, and no mutable-tag/default/API-host fallback.
  - requirements: ["runtime-model-catalog/catalog-probes-are-bounded-taskless-resources", "runtime-model-catalog/catalog-validation-and-task-launch-share-one-immutable-environment-snapshot"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 4.3 Implement the Codex-compatible provider catalog adapter by reusing the existing SSRF/redirect/timeout/body-size protected discovery client with only server-resolved owner credentials and runtime compatibility filtering.
  - requirements: ["runtime-model-catalog/runtime-adapters-discover-only-models-supported-by-the-effective-cli-path", "runtime-model-catalog/model-catalogs-resolve-in-the-task-owner-s-effective-execution-context"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 4.4 Update Codex interactive and headless fresh-launch builders to read explicit model material and pass exactly one quoted `--model` argument; preserve byte-identical omitted-model and unchanged resume behavior.
  - requirements: ["agent-runtime/agentruntime-owns-validated-per-task-model-launch-policy", "agent-runtime/omitted-and-recovered-models-preserve-deterministic-runtime-behavior", "agent-runtime/explicit-model-material-fails-closed-before-launch"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.5 Test official App Server and compatible-provider adapters through production clients, including owner isolation, pin/fixture drift, pagination, policy/default handling, SSRF/redirect bounds, cache metadata, and probe success/failure/cancel/orphan cleanup with no leaked provider resources.
  - requirements: ["runtime-model-catalog/runtime-adapters-discover-only-models-supported-by-the-effective-cli-path", "runtime-model-catalog/catalog-probes-are-bounded-taskless-resources", "runtime-model-catalog/catalog-caching-is-isolated-by-every-availability-boundary"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 4.6 Test Codex launch at the real process/tmux boundary for both modes, omission/override, punctuation/injection, resume, structured model rejection when supported, and proof that auth/network/quota/generic non-zero exits are not misclassified.
  - requirements: ["agent-runtime/agentruntime-owns-validated-per-task-model-launch-policy", "agent-runtime/omitted-and-recovered-models-preserve-deterministic-runtime-behavior", "agent-runtime/runtime-model-launch-rejection-is-a-structured-task-failure"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 5. Track: claude-model-support (depends: task-creation-seam)

- [x] 5.1 Change the supported Claude subscription credential port to require an explicit authenticated owner id before Task creation and the persisted owner id during provisioning, removing process-global `findFirst` fallback with two-owner/missing-owner tests.
  - requirements: ["agent-runtime/model-validation-and-launch-use-the-same-task-owned-credential-context"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 5.2 Add a provenance-bearing Claude selector manifest tied to CLI artifact checksum, include only selectors with gated reference-subscription launch evidence for every unique packaged CLI artifact, label them `cli-version-verified`/`supported-subset`, and fail pin/fixture drift.
  - requirements: ["runtime-model-catalog/runtime-adapters-discover-only-models-supported-by-the-effective-cli-path", "runtime-model-catalog/catalog-responses-are-stable-ordered-honest-and-non-secret"]
  - surfaces: ["public-v1", "mcp", "developer-workflow"]
  - verify: "task-model-evidence"
- [x] 5.3 Keep stored-but-unimplemented Claude API-key/gateway modes catalog/runtime-unready and ensure an inert stored `defaultModel` is not advertised as effective; add regression tests without adding a new gateway execution path.
  - requirements: ["runtime-model-catalog/runtime-adapters-discover-only-models-supported-by-the-effective-cli-path", "agent-runtime/model-validation-and-launch-use-the-same-task-owned-credential-context"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 5.4 Update Claude Code interactive and headless fresh-launch builders to require explicit model material and pass exactly one quoted `--model` argument; preserve byte-identical omission, fail closed on material errors, and leave resume unchanged.
  - requirements: ["agent-runtime/agentruntime-owns-validated-per-task-model-launch-policy", "agent-runtime/omitted-and-recovered-models-preserve-deterministic-runtime-behavior", "agent-runtime/explicit-model-material-fails-closed-before-launch"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.5 Iterate every manifest selector through production compatibility fixtures/gated launch evidence, and test evidence/policy labels, owner isolation, pin drift, unsupported modes, precedence, argv/setup safety, actual-model separation, and accurate failure classification.
  - requirements: ["runtime-model-catalog/runtime-adapters-discover-only-models-supported-by-the-effective-cli-path", "agent-runtime/model-validation-and-launch-use-the-same-task-owned-credential-context", "agent-runtime/agentruntime-owns-validated-per-task-model-launch-policy", "agent-runtime/runtime-observation-records-actual-model-without-rewriting-intent", "agent-runtime/runtime-model-launch-rejection-is-a-structured-task-failure", "agent-runtime/explicit-model-material-fails-closed-before-launch"]
  - surfaces: ["public-v1", "mcp", "developer-workflow"]
  - verify: "task-model-evidence"

## 6. Track: public-v1-and-mcp (depends: codex-model-support, claude-model-support)

- [x] 6.1 Add `POST /v1/runtime-models/query` to `PUBLIC_V1_OPERATIONS`, wire its real controller to the shared service with `tasks:write` and principal-derived owner, and update manifest/controller reflection from 17 to 18 operations.
  - requirements: ["public-v1-api/public-v1-exposes-the-contextual-runtime-model-catalog", "public-v1-api/versioned-additive-v1-surface-delegating-to-existing-services"]
  - surfaces: ["contracts", "public-v1", "openapi", "playground"]
  - verify: "api-v1"
- [x] 6.2 Register catalog/task/schedule schemas and real 422/429/503 responses in OpenAPI, including strict owner-field rejection, per-principal catalog throttling, safe capacity data, and no static model enum.
  - requirements: ["public-v1-api/public-v1-returns-stable-model-domain-failures", "api-playground/playground-failures-remain-faithful-to-the-public-api"]
  - surfaces: ["contracts", "public-v1", "openapi"]
  - verify: "openapi-playground"
- [x] 6.3 Map `list_runtime_models` from the manifest into MCP, raising mapped inventory from 16 to 17 tools while preserving SSE as the only explicit REST-only operation.
  - requirements: ["mcp-server/mcp-exposes-the-same-runtime-model-catalog-as-public-v1", "mcp-server/mcp-tools-delegate-to-existing-services-with-per-tool-scope-gates"]
  - surfaces: ["contracts", "mcp"]
  - verify: "api-mcp"
- [x] 6.4 Make MCP catalog, `create_task`, and schedule inputs use or structurally verify canonical schemas so SDK stripping cannot drop `model`, then route MCP writes through the shared model preflight/pure write/admission seam and return canonical structured/text content.
  - requirements: ["mcp-server/mcp-task-and-schedule-tools-preserve-the-requested-model", "mcp-server/mcp-tools-delegate-to-existing-services-with-per-tool-scope-gates"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 6.5 Implement separate REST/MCP mappings for synchronous model errors, but return canonical Schedule/latestRun after a manual dispatch persists terminal-failed or retrying state; expose only stable safe data and no Nest/provider/CLI internals.
  - requirements: ["public-v1-api/public-v1-returns-stable-model-domain-failures", "mcp-server/mcp-maps-model-domain-failures-to-structured-protocol-errors"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "public-surface-fast"
- [x] 6.6 Add V1 tests for model round-trip, replay/races, scope isolation, three-state environment output, mutable-tag retarget with persisted digest, immutable-identity fail-closed, no discovery in transactions, and 200 dispatch retry/terminal outcomes.
  - requirements: ["public-v1-api/public-v1-task-and-schedule-contracts-carry-requested-models", "public-v1-api/public-v1-exposes-the-contextual-runtime-model-catalog", "public-v1-api/public-v1-returns-stable-model-domain-failures"]
  - surfaces: ["public-v1"]
  - verify: "api-v1"
- [x] 6.7 Add MCP parity/integration tests for catalog/model-aware writes, shared preflight, scope/owner denial, owner-fair capacity errors, synchronous errors versus dispatch retry output, inventories, and every pre-existing canonical task field.
  - requirements: ["mcp-server/mcp-exposes-the-same-runtime-model-catalog-as-public-v1", "mcp-server/mcp-task-and-schedule-tools-preserve-the-requested-model", "mcp-server/mcp-maps-model-domain-failures-to-structured-protocol-errors"]
  - surfaces: ["contracts", "mcp"]
  - verify: "api-mcp"
- [x] 6.8 Apply the server gate consistently to model-aware N V1, MCP, Console REST, and catalog paths so closed-gate explicit writes/manual dispatch fail before persistence while omitted-model creates remain unchanged; keep model contracts/tools unpublished until the maintenance cutover and test that UI availability is not the safety boundary.
  - requirements: ["runtime-model-catalog/explicit-model-selection-is-fenced-from-legacy-workers", "public-v1-api/public-v1-returns-stable-model-domain-failures", "mcp-server/mcp-maps-model-domain-failures-to-structured-protocol-errors", "scheduled-tasks/every-schedule-fire-revalidates-an-explicit-model-before-task-creation"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground"]
  - verify: "public-surface-full"

## 7. Track: scheduled-task-models (depends: codex-model-support, claude-model-support)

- [x] 7.1 Persist and return `taskTemplate.model` on schedule create/update/read, and run explicit-model preflight before the schedule write transaction so failed updates leave existing schedule state unchanged.
  - requirements: ["scheduled-tasks/schedule-templates-persist-requested-runtime-models", "runtime-model-catalog/explicit-task-models-are-validated-against-a-current-catalog"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 7.2 Prepare every due/manual/recovered-not-yet-created occurrence outside Prisma, then let the version/lease transaction consume only prepared data and create/update one unique run plus at most one Task on success.
  - requirements: ["scheduled-tasks/schedule-fire-creates-a-headless-task-through-the-existing-admission-path", "scheduled-tasks/each-schedule-occurrence-is-recorded-exactly-once"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 7.3 Make unavailable models terminally claim/advance one failed occurrence, while catalog outages persist/update one `retrying` occurrence with bounded jittered retry metadata and immutable normalized template snapshot, no Task, and no automatic cadence advance until success or exhaustion.
  - requirements: ["scheduled-tasks/every-schedule-fire-revalidates-an-explicit-model-before-task-creation", "scheduled-tasks/pre-task-schedule-failures-are-structured-and-exactly-once", "scheduled-tasks/scheduler-claims-due-work-durably-and-recovers-interrupted-fires"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 7.4 Preserve null as follow-current-default intent, preserve an already-created Task's model during recovery, keep retrying occurrences on their captured template across edits, and suppress automatic retry while paused without recataloging or late substitution.
  - requirements: ["scheduled-tasks/schedule-updates-affect-future-fires-only", "scheduled-tasks/schedule-templates-persist-requested-runtime-models", "agent-runtime/omitted-and-recovered-models-preserve-deterministic-runtime-behavior"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 7.5 Add schedule tests for create/update, permanent disappearance, transient recovery/exhaustion, edit/pause/resume during retry, manual dispatch returning persisted latestRun, no Task/task-owned execution sandbox, headless propagation, retry/error fields, and existing-task recovery.
  - requirements: ["scheduled-tasks/schedule-templates-persist-requested-runtime-models", "scheduled-tasks/every-schedule-fire-revalidates-an-explicit-model-before-task-creation", "scheduled-tasks/pre-task-schedule-failures-are-structured-and-exactly-once"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 7.6 Add multi-worker/lease/restart tests proving duplicate external preflight may occur but one occurrence row/at-most-one Task wins, retry resumes the same row, terminal failure never becomes a late Task, and discovery never runs inside claim/write transactions.
  - requirements: ["scheduled-tasks/each-schedule-occurrence-is-recorded-exactly-once", "scheduled-tasks/scheduler-claims-due-work-durably-and-recovers-interrupted-fires", "runtime-model-catalog/catalog-caching-is-isolated-by-every-availability-boundary"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 7.7 Gate explicit-model schedule create/update and due/manual occurrence acceptance, leaving due work unclaimed and cadence unchanged while closed, while allowing capable workers to drain already accepted Task/occurrence state safely.
  - requirements: ["scheduled-tasks/every-schedule-fire-revalidates-an-explicit-model-before-task-creation", "runtime-model-catalog/explicit-model-selection-is-fenced-from-legacy-workers"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"

## 8. Track: console-and-playground (depends: public-v1-and-mcp, scheduled-task-models)

- [x] 8.1 Add the shared web API client/query for the V1 runtime-model catalog with runtime plus omitted/null/UUID environment semantics and non-secret loading/error state.
  - requirements: ["frontend-console/task-creation-uses-the-effective-runtime-model-catalog", "public-v1-api/public-v1-exposes-the-contextual-runtime-model-catalog"]
  - surfaces: ["public-v1"]
  - verify: "openapi-playground"
- [x] 8.2 Add one catalog-backed model selector to the shared task form used by immediate and recurring modes, with a runtime-default omitted option and honest ready/empty/supported-subset/unavailable states.
  - requirements: ["frontend-console/task-creation-uses-the-effective-runtime-model-catalog"]
  - surfaces: ["public-v1"]
  - verify: "openapi-playground"
- [x] 8.3 Refresh model choices when runtime/environment or catalog revision changes, retain only still-valid selections, notify on clearing stale selections, and preserve unrelated form state after server 422/503 errors.
  - requirements: ["frontend-console/context-changes-cannot-silently-submit-a-stale-model"]
  - surfaces: ["public-v1"]
  - verify: "openapi-playground"
- [x] 8.4 Include explicit model in one-off and recurring payload builders; display requested versus actual model on task/history surfaces and permanent-failed versus retrying catalog state/next retry on schedule surfaces.
  - requirements: ["frontend-console/task-views-distinguish-requested-and-actual-models", "frontend-console/schedule-views-expose-model-preflight-and-retry-state", "repo-and-task-management/requested-and-runtime-reported-models-remain-distinct-facts"]
  - surfaces: ["public-v1"]
  - verify: "openapi-playground"
- [x] 8.5 Add the manifest-driven runtime-model operation to API Playground real execution and verify task/schedule model schemas, scopes, and 422/429/503 response display without hardcoded ids.
  - requirements: ["api-playground/api-playground-exposes-model-aware-public-operations-from-the-manifest", "api-playground/playground-failures-remain-faithful-to-the-public-api"]
  - surfaces: ["contracts", "public-v1", "openapi", "playground"]
  - verify: "openapi-playground"
- [x] 8.6 Add component/query tests for runtime/environment switching, default omission, stale revision, constrained catalog messaging, retry/error recovery, shared immediate/recurring payloads, requested-versus-actual display, keyboard access, and no static fallback list.
  - requirements: ["frontend-console/task-creation-uses-the-effective-runtime-model-catalog", "frontend-console/context-changes-cannot-silently-submit-a-stale-model", "frontend-console/task-views-distinguish-requested-and-actual-models", "frontend-console/schedule-views-expose-model-preflight-and-retry-state"]
  - surfaces: ["public-v1"]
  - verify: "openapi-playground"

## 9. Track: cross-surface-verification (depends: console-and-playground)

- [x] 9.1 Add one generated schema-parity suite that compares canonical task fields across Console, V1 minus `repoId`, MCP advertised and callback inputs, and schedule templates, explicitly covering runtime, skills, guardrails, environment, delivery, model, and future fields.
  - requirements: ["repo-and-task-management/tasks-durably-carry-the-requested-runtime-model", "public-v1-api/v1-only-contract-schemas-are-additive", "mcp-server/mcp-task-and-schedule-tools-preserve-the-requested-model"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "public-surface-fast"
- [x] 9.2 Add database-backed cross-surface scenarios that submit one all-fields fixture through Console REST, Public V1, MCP, and schedule create/update/fire/recovery and compare persisted Task plus create/get/list/structured outputs.
  - requirements: ["repo-and-task-management/tasks-durably-carry-the-requested-runtime-model", "mcp-server/mcp-task-and-schedule-tools-preserve-the-requested-model", "scheduled-tasks/schedule-templates-persist-requested-runtime-models"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 9.3 Add security/failure scenarios proving owner isolation, one-argv safety, no lookup/material default fallback, redaction, mutable-tag retarget cannot change launch identity, and preflight creates no Task/task-owned execution sandbox or unintended schedule mutation.
  - requirements: ["runtime-model-catalog/catalog-responses-are-stable-ordered-honest-and-non-secret", "runtime-model-catalog/catalog-validation-and-task-launch-share-one-immutable-environment-snapshot", "agent-runtime/explicit-model-material-fails-closed-before-launch"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 9.4 Run deterministic AIO and BoxLite image smokes for Codex/Claude catalog capability, taskless probe teardown, fresh interactive/headless launch, omitted behavior, and CLI-pin fixture compatibility without hardcoding current model names in product logic or mirrored tests.
  - requirements: ["runtime-model-catalog/runtime-adapters-discover-only-models-supported-by-the-effective-cli-path", "runtime-model-catalog/catalog-probes-are-bounded-taskless-resources", "agent-runtime/agentruntime-owns-validated-per-task-model-launch-policy", "agent-runtime/omitted-and-recovered-models-preserve-deterministic-runtime-behavior"]
  - surfaces: ["contracts", "developer-workflow"]
  - verify: "api-mcp"
- [x] 9.5 Run gated real-credential E2E for catalog → create → launch → transcript, covering every Claude manifest selector once per unique CLI checksum plus representative AIO/BoxLite seams, and assert requested versus actual model/evidence without claiming unverified owner entitlement.
  - requirements: ["runtime-model-catalog/runtime-adapters-discover-only-models-supported-by-the-effective-cli-path", "repo-and-task-management/tasks-durably-carry-the-requested-runtime-model", "repo-and-task-management/requested-and-runtime-reported-models-remain-distinct-facts", "agent-runtime/runtime-observation-records-actual-model-without-rewriting-intent"]
  - surfaces: ["public-v1", "developer-workflow"]
  - verify: "task-model-evidence"
- [x] 9.6 Add an N/N-1 compatibility harness and upgrade/rollback runbook: send direct and nested model payloads to isolated N-1 REST/MCP writers to expose unknown-field stripping, then require a mandatory write-maintenance cutover that closes ingress/MCP before publishing model contracts, removes every N-1 writer/claimer, and verifies all N roles before reopening; block rollback until explicit Tasks/retrying occurrences are drained and explicit schedules are paused.
  - requirements: ["runtime-model-catalog/explicit-model-selection-is-fenced-from-legacy-workers"]
  - surfaces: ["public-v1", "mcp", "developer-workflow", "docs"]
  - verify: "public-surface-full"
- [x] 9.7 Run all affected contract, API, MCP, scheduler, sandbox/runtime, web, migration, and root verification suites; regenerate/check OpenAPI artifacts and finish with `openspec validate add-task-model-selection --strict` and a clean review of unrelated worktree files.
  - requirements: ["runtime-model-catalog/explicit-model-selection-is-fenced-from-legacy-workers", "public-v1-api/versioned-additive-v1-surface-delegating-to-existing-services", "mcp-server/mcp-tools-delegate-to-existing-services-with-per-tool-scope-gates", "api-playground/api-playground-exposes-model-aware-public-operations-from-the-manifest"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground", "openspec", "developer-workflow", "ci"]
  - verify: "public-surface-full"
