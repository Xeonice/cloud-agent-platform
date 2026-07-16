<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-and-persistence (depends: none)

- [x] 1.1 Extend sandbox-environment create/read contracts and persistence with a dedicated optional `resources.diskSizeGb`, central positive/bounded validation, legacy-null compatibility, and proof that the field is not accepted as a guest image parameter.
  - requirements: ["sandbox-environments/sandbox-environments-carry-validated-provisioning-resource-limits"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [x] 1.2 Add the canonical optional provisioning summary, stable stage/state enums, structured provisioning failure variants/actions, and repo/task response projections; cover old null rows and every existing runtime failure variant through the production schemas.
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"
- [x] 1.3 Add `TaskAdmissionWork` persistence with unique `taskId`, state, attempt, availability, lease, safe stage/cause, timestamps, and immutable resolved branch/resource snapshots, plus an additive migration and generated Prisma client.
  - requirements: ["repo-and-task-management/task-creation-durably-accepts-before-provisioning", "guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 1.4 Add fresh-migration and upgrade fixtures proving one admission row per task, nullable compatibility for historical tasks/environments/repos, lease indexes/constraints, and no credential/raw diagnostic column in the new durable records.
  - requirements: ["repo-and-task-management/task-creation-durably-accepts-before-provisioning", "repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "sandbox-environments/sandbox-environments-carry-validated-provisioning-resource-limits"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 2. Track: provider-port-and-secret-channel (depends: contracts-and-persistence)

- [x] 2.1 Extend the provider-neutral environment/provision context with immutable resource snapshots, caller branch intent versus resolved branch, workspace deadline, typed stage/cause results, cancellation, and provider capability enforcement without importing BoxLite types into orchestration.
  - requirements: ["sandbox-provider-port/provision-context-carries-resolved-resources-and-deterministic-workspace-intent", "sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.2 Introduce the typed exact-host Git credential descriptor and redacted sandbox secret-write/delete port, making command and ordinary exec types reject secret-bearing fields while preserving an in-memory provider-only secret boundary.
  - requirements: ["sandbox-provider-port/provision-context-carries-resolved-resources-and-deterministic-workspace-intent", "task-result-delivery/cloneauthheader-supplies-one-token-bearing-header-for-the-in-sandbox-clone-and-push"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.3 Refactor shared clone/push helpers into bounded stages that reference only a mode-0600 temporary exact-host Git config path, preserve full selected-branch history, isolate different-host submodules, and clean the config in every success/failure/timeout/cancellation path.
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures", "task-result-delivery/cloneauthheader-supplies-one-token-bearing-header-for-the-in-sandbox-clone-and-push"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.4 Expand provider conformance with real production helpers and a unique secret canary to cover exact-host scoping, cross-host submodules, no secret in argv/env/exec/log/run metadata, idempotent cleanup, cancellation, and structured capacity/timeout/auth/TLS/network/ref/unknown results.
  - requirements: ["sandbox-provider-port/provision-context-carries-resolved-resources-and-deterministic-workspace-intent", "sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures", "observability/secret-redaction-in-logs"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 3. Track: boxlite-resources-and-workspace (depends: provider-port-and-secret-channel)

- [x] 3.1 Add validated `BOXLITE_DISK_SIZE_GB` and `BOXLITE_GIT_CLONE_TIMEOUT_MS` configuration with documented precedence/bounds and keep the existing short `BOXLITE_TIMEOUT_MS` scoped to native control-plane requests.
  - requirements: ["boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline", "sandbox-environments/sandbox-environments-carry-validated-provisioning-resource-limits"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.2 Extend native BoxLite create/fake/client parsing to carry `disk_size_gb`, propagate the same resolved value to validation probes and task sandboxes, and fail provider eligibility when an explicit resource cannot be enforced.
  - requirements: ["boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline", "sandbox-provider-port/provision-context-carries-resolved-resources-and-deterministic-workspace-intent"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.3 Implement BoxLite's redacted secret writer over a non-argv input/file channel, staged Git materialization with the independent deadline, exact-host config, resolved branch checkout, typed errors, cancellation fencing, and `finally` cleanup before retention.
  - requirements: ["boxlite-sandbox-provider/boxlite-git-credentials-are-ephemeral-and-exact-host-scoped", "boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline", "sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.4 Add BoxLite unit/adapter tests for native create bodies, legacy fallback snapshots, invalid config, a clone longer than the control-plane timeout, disk exhaustion after successful refs, missing `master`/`main`, different-host submodules, retries, cancellation, and retained-secret absence.
  - requirements: ["boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline", "boxlite-sandbox-provider/boxlite-git-credentials-are-ephemeral-and-exact-host-scoped"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 4. Track: owner-aware-repo-and-branch (depends: contracts-and-persistence)

- [x] 4.1 Pass the authenticated account id through generic URL/Gitee/GitLab Console import, reuse the exact-host forge registry/owner credential resolver, and keep repo writes absent from Public V1, MCP, and `repos:read` scope.
  - requirements: ["multi-forge-repo-import/url-import-validates-owner-access-and-persists-the-real-default-branch"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.2 Implement a bounded credential-safe remote refs/symbolic-HEAD probe with stable auth/access/network/default-branch failures, no credential-bearing URL/argv/env/log value, and no Repo write on failure.
  - requirements: ["multi-forge-repo-import/url-import-validates-owner-access-and-persists-the-real-default-branch", "observability/secret-redaction-in-logs"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.3 Persist picker-provided and URL-probed default branches, reconcile duplicate imports without erasing verified metadata, and add owner-isolation tests for private Gitee/GitLab/GitHub plus a repository whose only default is `master`.
  - requirements: ["multi-forge-repo-import/url-import-validates-owner-access-and-persists-the-real-default-branch", "repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.4 Add a shared branch resolver implementing explicit task branch → persisted repo default → owner-authenticated legacy HEAD → typed failure, snapshot the result without rewriting nullable `Task.branch`, and reuse it for clone/recovery/delivery base intent.
  - requirements: ["repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.5 Remove every production `main` fallback from generic forge import/task planning and add regression searches plus service tests for explicit branch precedence, safe legacy backfill, missing-ref failure, and no cross-owner credential lookup.
  - requirements: ["repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults", "multi-forge-repo-import/url-import-validates-owner-access-and-persists-the-real-default-branch"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 5. Track: durable-admission-worker (depends: contracts-and-persistence, provider-port-and-secret-channel, owner-aware-repo-and-branch)

- [x] 5.1 Refactor canonical task acceptance so Console, V1, MCP, and schedules commit the prepared Task, unique admission work, immutable branch/resource inputs, and idempotent creation-audit identity atomically, then return without calling provider code.
  - requirements: ["repo-and-task-management/task-creation-durably-accepts-before-provisioning", "public-v1-api/versioned-additive-v1-surface-delegating-to-existing-services", "mcp-server/mcp-tools-delegate-to-existing-services-with-per-tool-scope-gates"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"
- [x] 5.2 Implement the admission worker's database claim/renew/release loop, local wake-up plus polling floor, bounded retry schedule, safe stage persistence, terminal classification, and cleanup of exhausted/superseded work without swallowing admission failures.
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "audit-history/provisioning-history-records-structured-stages-and-safe-causes"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.3 Fence each external boundary with task status/version and lease ownership, integrate provider idempotency/readoption, and make pending/running stop, duplicate worker, timeout, and post-provision supersession release exactly one slot and at most one sandbox.
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "repo-and-task-management/task-creation-durably-accepts-before-provisioning"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.4 Insert accepted/expired-lease recovery into bootstrap without regressing running-task re-adoption, persisted ceiling load, queued FIFO re-offer, schedule provenance, or legacy pending-task handling.
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "guardrails/startup-recovery-reclaims-orphaned-tasks-and-re-offers-queued-tasks", "repo-and-task-management/task-creation-durably-accepts-before-provisioning"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.5 Make V1 idempotency commit its winner's admission work in the same transaction, return exact replays without current provisioning work, and reject mismatched/raced bodies without creating a second work item.
  - requirements: ["public-v1-api/idempotent-v1-task-creation", "repo-and-task-management/task-creation-durably-accepts-before-provisioning"]
  - surfaces: ["public-v1", "contracts"]
  - verify: "api-v1"
- [x] 5.6 Persist/project provisioning progress and classified terminal failures through create/list/get/stop/audit paths while redacting raw Git/provider diagnostics and keeping audit progress best-effort relative to the durable work state.
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "audit-history/provisioning-history-records-structured-stages-and-safe-causes"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-public-errors"
- [x] 5.7 Add crash-matrix integration tests at pre-commit, post-commit/pre-wake, active lease, post-sandbox/pre-complete, retry, and cancellation boundaries, proving one Task/work item, at most one sandbox/slot, eventual recovery, stable audit detail, and no fixed sleeps.
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "repo-and-task-management/task-creation-durably-accepts-before-provisioning", "audit-history/provisioning-history-records-structured-stages-and-safe-causes"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 6. Track: console-provisioning-ux (depends: durable-admission-worker, owner-aware-repo-and-branch)

- [x] 6.1 Remove the `main` fallback from both Console task forms and shared request builders, preselect only persisted verified `defaultBranch`, and preserve omission for legacy null branches.
  - requirements: ["frontend-console/console-task-creation-uses-verified-branches-and-durable-acceptance", "repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [x] 6.2 Make the shared mutation end its creating state and navigate/invalidate immediately on the committed task response while preserving double-submit prevention and recovering the returned task id if route navigation is interrupted.
  - requirements: ["frontend-console/console-task-creation-uses-verified-branches-and-durable-acceptance", "repo-and-task-management/task-creation-durably-accepts-before-provisioning"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [x] 6.3 Render canonical provisioning stages, resolved branch, retry state, and actionable capacity/timeout/auth/TLS-network/ref/unknown failures on task/session views without parsing logs or exposing provider internals.
  - requirements: ["frontend-console/console-task-creation-uses-verified-branches-and-durable-acceptance", "repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [x] 6.4 Update URL import UX to send the authenticated internal request, wait for the access/default-branch probe, display safe classified failures, and add only verified repos to the picker.
  - requirements: ["frontend-console/console-task-creation-uses-verified-branches-and-durable-acceptance", "multi-forge-repo-import/url-import-validates-owner-access-and-persists-the-real-default-branch"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [x] 6.5 Add web tests for modal and full-page parity, `master` preselection, null-branch omission, immediate navigation while provisioning is held open, polling progression, each structured failure rendering, and no indefinitely creating state.
  - requirements: ["frontend-console/console-task-creation-uses-verified-branches-and-durable-acceptance"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"

## 7. Track: public-v1-mcp-projections (depends: durable-admission-worker)

- [x] 7.1 Update canonical registry metadata and response schemas for `tasks.create/list/get/stop` and `repos.list/get`, preserving exact existing operation/tool ids and declaring immediate acceptance plus additive safe provisioning/default-branch behavior.
  - requirements: ["public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely", "api-mcp-development-parity/canonical-public-capability-registry"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"
- [x] 7.2 Wire Public V1 task creation and exact idempotent replay to the durable acceptance seam, then add real-service latency tests that hold provider provisioning unresolved and prove the HTTP response returns first.
  - requirements: ["public-v1-api/versioned-additive-v1-surface-delegating-to-existing-services", "public-v1-api/idempotent-v1-task-creation"]
  - surfaces: ["public-v1"]
  - verify: "api-v1"
- [x] 7.3 Make MCP `create_task` use the same real durable seam and prove with a non-fake provisioning barrier that it returns canonical structured/text handle content before provisioning, while matching task/repo read projections and retaining declared REST-only idempotency behavior.
  - requirements: ["mcp-server/mcp-tools-delegate-to-existing-services-with-per-tool-scope-gates", "api-mcp-development-parity/rest-and-mcp-adapters-pass-shared-behavioral-conformance", "public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely"]
  - surfaces: ["mcp", "public-v1", "contracts"]
  - verify: "api-mcp"
- [x] 7.4 Extend REST/MCP conformance fixtures for initial response timing, create/list/get/stop failure round trips, repo `master` reads, legacy null projections, owner/scope denial, secret absence, and exact operation-to-tool inventory symmetry.
  - requirements: ["api-mcp-development-parity/rest-and-mcp-adapters-pass-shared-behavioral-conformance", "api-mcp-development-parity/transport-bindings-are-exhaustive", "public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely"]
  - surfaces: ["public-v1", "mcp", "contracts"]
  - verify: "public-surface-fast"
- [x] 7.5 Regenerate/verify OpenAPI descriptions and schemas plus API Playground catalog/rendering for the six affected operations, including optional/null semantics, stable provisioning failure variants, immediate-create guidance, samples that parse through canonical schemas, and faithful non-2xx bodies.
  - requirements: ["public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely", "public-v1-api/openapi-spec-generated-from-the-zod-contracts"]
  - surfaces: ["openapi", "playground", "public-v1", "contracts"]
  - verify: "openapi-playground"

## 8. Track: integration-and-rollout (depends: boxlite-resources-and-workspace, console-provisioning-ux, public-v1-mcp-projections)

- [x] 8.1 Update release/quick-deploy environment templates, validation, and operator docs with BoxLite disk/clone-timeout defaults, precedence, host-capacity versus concurrency preflight, admission-v2 capability gate, staged rollout, drain-first rollback, and safe diagnostics.
  - requirements: ["boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline", "guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable"]
  - surfaces: ["docs", "developer-workflow"]
  - verify: "docs"
- [x] 8.2 Add an infrastructure-free generated private-repo fixture and controlled transfer barrier that exceeds the old 120-second boundary without fixed sleeps, uses a non-`main` symbolic HEAD, exercises branch/full-history/submodule policy, and validates capacity/timeout classification through production helpers.
  - requirements: ["boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline", "repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults", "sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 8.3 Add a gated disposable local/native BoxLite story that requests the resolved disk, records pre/post free space and stage timings, clones/checks out the generated large private fixture, verifies full selected-branch history, cancels/retries safely, and leaves zero probe boxes or credential files.
  - requirements: ["boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline", "boxlite-sandbox-provider/boxlite-git-credentials-are-ephemeral-and-exact-host-scoped"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 8.4 Add a full same-owner/repo/environment story that creates through Console REST, Public V1, and MCP against a controllable real admission worker, proves each returns before clone settlement, observes identical stages/failures, and proves import probe plus task clone share the exact credential resolver.
  - requirements: ["repo-and-task-management/task-creation-durably-accepts-before-provisioning", "public-v1-api/versioned-additive-v1-surface-delegating-to-existing-services", "mcp-server/mcp-tools-delegate-to-existing-services-with-per-tool-scope-gates", "multi-forge-repo-import/url-import-validates-owner-access-and-persists-the-real-default-branch"]
  - surfaces: ["contracts", "public-v1", "mcp", "ci"]
  - verify: "public-surface-full"
- [x] 8.5 Run a unique secret-canary story across import, refs, clone, submodules, push, failure, timeout, retry, cancellation, logs, audit, task responses, run metadata, and retained sandbox inspection; fail if the canary appears anywhere outside the redacted in-memory secret channel.
  - requirements: ["boxlite-sandbox-provider/boxlite-git-credentials-are-ephemeral-and-exact-host-scoped", "task-result-delivery/cloneauthheader-supplies-one-token-bearing-header-for-the-in-sandbox-clone-and-push", "audit-history/provisioning-history-records-structured-stages-and-safe-causes", "observability/secret-redaction-in-logs"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 8.6 Run strict OpenSpec validation, propose/apply metadata validation, contract/API/web/provider suites, `pnpm test:public-surface`, fresh `pnpm verify:public-surface`, generated compatibility fixtures, migration tests, and `git diff --check`; repair every failure before rollout.
  - requirements: ["api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally", "api-mcp-development-parity/rest-and-mcp-adapters-pass-shared-behavioral-conformance", "guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground", "openspec", "ci"]
  - verify: "public-surface-full"
- [x] 8.7 Validate the change sidecar/task metadata and compatibility fixture in propose/apply/verify phases, including the declared Internal-only repo-import/environment exclusions and all six existing Public V1-to-MCP mappings.
  - requirements: ["api-mcp-development-parity/canonical-public-capability-registry", "api-mcp-development-parity/transport-bindings-are-exhaustive"]
  - surfaces: ["openspec", "developer-workflow", "public-v1", "mcp"]
  - verify: "openspec-metadata"
