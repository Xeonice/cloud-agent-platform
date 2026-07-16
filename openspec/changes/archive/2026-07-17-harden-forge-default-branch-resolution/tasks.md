<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks may run in parallel.
     Shared integration seams are deferred to their dependent tracks. -->

## 1. Track: contracts-and-failure-semantics (depends: none)

- [x] 1.1 Extend canonical repository-import and Task failure contracts with `repo_platform_dependency_unavailable`, `provisioning_platform_dependency_unavailable`, and the `repair_deployment` action; cover every direct and schedule-nested current-reader variant exhaustively, preserve current-reader acceptance of legacy payloads, and encode the matched-upgrade requirement for strict N-1 clients.
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"
- [x] 1.2 Add an additive Prisma migration that drops and recreates `tasks_failure_code_check` and `task_admission_work_cause_code_check` with the new platform-dependency value, retaining every old value; extend the gated loopback-Postgres fresh/upgrade suite to prove old rows remain unchanged, both columns accept the new code, and rollback normalizes only that value to `provisioning_unknown`; wire the suite into CI and register its shell-free workflow contract test in the fixed `workflow-gates` test set.
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes"]
  - surfaces: ["contracts", "ci", "developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.3 Map missing local executables and other control-plane prerequisites through task failure persistence, presentation, admission terminal policy, schedule projection, and audit history as non-retryable platform dependency failures without changing the retry policy for genuine remote network/TLS failures.
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "audit-history/provisioning-history-records-structured-stages-and-safe-causes"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-public-errors"
- [x] 1.4 Normalize repository-refresh platform dependency failure to HTTP 503 and task-provisioning failure to the canonical structured variant, ensuring raw spawn paths, command output, credentials, and provider diagnostics never cross REST, MCP, schedule, audit, or log boundaries.
  - requirements: ["multi-forge-repo-import/url-import-validates-owner-access-and-persists-the-real-default-branch", "repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "observability/secret-redaction-in-logs"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-public-errors"

## 2. Track: api-git-runtime (depends: none)

- [x] 2.1 Install `git` in the final production `cap-api` runtime image and add a reusable, bounded, sanitized `git --version` startup preflight that fails readiness/startup with a platform-dependency reason when the executable is absent; cover the preflight behavior in the API suite while Track 6 attests the built image contents.
  - requirements: ["release-and-versioning/a-github-release-triggered-workflow-publishes-a-matched-versioned-image-set-to-ghcr", "repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes"]
  - surfaces: ["developer-workflow", "ci", "contracts"]
  - verify: "api-mcp"
- [x] 2.2 Preserve spawn failure identity through the shared Git process runner and remote-refs probe so `ENOENT`/missing executable becomes `platform_dependency_unavailable`, while an exited Git process continues through auth/access/ref/TLS/network classification.
  - requirements: ["multi-forge-repo-import/url-import-validates-owner-access-and-persists-the-real-default-branch", "repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.3 Add runner, preflight, and probe tests for missing executable, bounded output, abort/timeout, non-zero exit, auth, access, ref, TLS, and network outcomes, including a secret canary proving sanitization in errors and logs.
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "observability/secret-redaction-in-logs"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 3. Track: repo-refresh-and-branch-policy (depends: contracts-and-failure-semantics, api-git-runtime)

- [x] 3.1 Add the authenticated Internal Console route `POST /repos/:repoId/refresh-default-branch`: read an immutable Repo identity snapshot, resolve only the requesting account's exact-host credential, probe symbolic HEAD outside any database transaction without accepting a client branch, then conditionally update only `Repo.defaultBranch` in a short id/forge/git-source-fenced write; preserve the same Repo id and perform no write on failure or identity drift.
  - requirements: ["multi-forge-repo-import/existing-repository-default-branch-refresh-is-owner-authenticated-and-non-destructive", "multi-forge-repo-import/url-import-validates-owner-access-and-persists-the-real-default-branch"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.2 Make GitHub picker import and duplicate re-import reconcile the server-authoritative authenticated API `default_branch`, and apply the same requesting-account credential invariant to Gitee/GitLab URL imports without creating duplicate Repo rows or trusting stale client metadata.
  - requirements: ["github-repository-import/import-a-selected-github-repository-into-the-platform", "github-repository-import/de-duplicate-imports-against-already-imported-repositories", "multi-forge-repo-import/existing-repository-default-branch-refresh-is-owner-authenticated-and-non-destructive"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.3 Keep `TaskBranchResolver` as the only production branch authority—explicit task branch, then persisted verified Repo default, then symbolic HEAD authenticated with the current task/request account only for legacy null—and reuse the immutable resolved snapshot for checkout, recovery, push, and pull-request base without any `main`/`master` fallback or per-task remote refresh.
  - requirements: ["repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults", "task-result-delivery/a-single-forge-port-abstracts-github-gitee-and-gitlab", "task-result-delivery/forge-http-calls-the-operator-s-connected-forge-directly-and-is-not-ssrf-gated", "task-result-delivery/openchangerequest-and-findexistingchangerequest-map-per-forge-and-are-idempotent"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.4 Add service/integration fixtures for GitHub `trunk`, GitLab `develop`, Gitee `master`, explicit branch precedence, legacy-null backfill, changed symbolic HEAD, stale snapshots, missing refs, exact-host credentials, rejection of credential borrowing from another account, identity-fenced concurrent refresh, and failed-refresh rollback; add a production-code guard against fabricated `main`/`master` defaults.
  - requirements: ["repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults", "multi-forge-repo-import/existing-repository-default-branch-refresh-is-owner-authenticated-and-non-destructive", "github-repository-import/de-duplicate-imports-against-already-imported-repositories"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 3.5 Prove API authorization and routing boundaries: refresh/import remain authenticated requesting-account-scoped Internal Console operations, `repos:read` cannot mutate, and the API route inventory exposes no Public V1 repository write or Forge port branch-resolution method; Track 5 owns the cross-transport registry inventory proof.
  - requirements: ["multi-forge-repo-import/existing-repository-default-branch-refresh-is-owner-authenticated-and-non-destructive", "task-result-delivery/a-single-forge-port-abstracts-github-gitee-and-gitlab", "api-mcp-development-parity/transport-bindings-are-exhaustive"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "api-mcp"

## 4. Track: console-refresh-and-failure-ux (depends: contracts-and-failure-semantics, repo-refresh-and-branch-policy)

- [x] 4.1 Add the typed Console API client mutation and query-cache policy for repository default-branch refresh, including the stable refresh failure variants and task `repair_deployment` presentation without exposing raw diagnostics.
  - requirements: ["frontend-console/console-refreshes-verified-repository-default-branches", "repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [x] 4.2 Expose a refresh action for already-imported GitHub, Gitee, and GitLab repository rows/candidates; disable duplicate submission, wait for the verified server response, invalidate repository and task-create caches on success, and retain the old branch without optimistic overwrite on failure.
  - requirements: ["frontend-console/console-refreshes-verified-repository-default-branches", "github-repository-import/de-duplicate-imports-against-already-imported-repositories"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [x] 4.3 Keep both task-creation entry points bound to the refreshed verified `defaultBranch`, omit branch for legacy null, and render platform dependency failures with the deployment-repair action on task detail plus schedule latest-run/history surfaces while preserving all existing auth/network/ref guidance.
  - requirements: ["frontend-console/console-task-creation-uses-verified-branches-and-durable-acceptance", "frontend-console/console-refreshes-verified-repository-default-branches"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [x] 4.4 Add web tests for provider-specific nonstandard branches, refresh success/failure, unchanged Repo identity, cache invalidation, duplicate-click fencing, modal/full-page task form parity, legacy null omission, direct and schedule-nested deployment-repair rendering, and absence of client-side `main`/`master` guesses.
  - requirements: ["frontend-console/console-refreshes-verified-repository-default-branches", "frontend-console/console-task-creation-uses-verified-branches-and-durable-acceptance"]
  - surfaces: ["contracts", "ci"]
  - verify: "openapi-playground"

## 5. Track: public-v1-mcp-projections (depends: contracts-and-failure-semantics, repo-refresh-and-branch-policy)

- [x] 5.1 Update canonical schemas and capability-registry metadata for the fourteen affected existing operations: `tasks.create/list/get/stop`, `repos.list/get`, and `schedules.list/create/get/update/pause/resume/dispatch/runs`; project arbitrary refreshed branches plus direct/nested platform-dependency failures while preserving every REST operation id, MCP tool id, scope, and declared protocol difference.
  - requirements: ["public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely", "mcp-server/mcp-preserves-canonical-forge-branch-and-platform-dependency-truth", "api-mcp-development-parity/canonical-public-capability-registry"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"
- [x] 5.2 Add shared real-service conformance stories proving Public V1 and MCP return the same GitHub `trunk`/GitLab `develop`/Gitee `master` repository state and the same safe non-retryable platform-dependency failure across direct task responses and all eight schedule operations that nest `taskFailure`, without adding a repository write surface.
  - requirements: ["public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely", "mcp-server/mcp-preserves-canonical-forge-branch-and-platform-dependency-truth", "api-mcp-development-parity/rest-and-mcp-adapters-pass-shared-behavioral-conformance"]
  - surfaces: ["public-v1", "mcp", "contracts"]
  - verify: "public-surface-fast"
- [x] 5.3 Regenerate/verify OpenAPI and API Playground schemas, descriptions, examples, and non-2xx rendering for all fourteen affected operations, including arbitrary branch strings and the direct or schedule-nested platform-dependency failure/action.
  - requirements: ["public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely", "mcp-server/mcp-preserves-canonical-forge-branch-and-platform-dependency-truth"]
  - surfaces: ["openapi", "playground", "public-v1", "contracts"]
  - verify: "openapi-playground"
- [x] 5.4 Run exhaustive registry/transport inventory and compatibility fixtures, proving full field parity, current-reader acceptance of legacy payloads, an explicit matched-upgrade boundary for strict N-1 readers of the new closed discriminator, all four existing `tasks.create` protocol differences, and zero drift toward a Public V1 or MCP repository-refresh operation.
  - requirements: ["api-mcp-development-parity/public-errors-have-exhaustive-transport-mappings", "api-mcp-development-parity/transport-bindings-are-exhaustive", "mcp-server/mcp-preserves-canonical-forge-branch-and-platform-dependency-truth"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground"]
  - verify: "public-surface-full"

## 6. Track: release-image-gates (depends: api-git-runtime, contracts-and-failure-semantics)

- [x] 6.1 Add a deterministic built-image smoke script that runs the production `cap-api` image, executes `git --version`, exercises the same startup preflight, and includes a negative fixture proving a runtime image without Git is rejected before serving traffic; add its shell-free command/exit/sanitization contract test to the fixed `workflow-gates` test set.
  - requirements: ["release-and-versioning/a-github-release-triggered-workflow-publishes-a-matched-versioned-image-set-to-ghcr"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.2 Gate the release workflow on the smoke result for the exact locally built `cap-api` image before any image push or release completion, while leaving the matched-version checks for Web, AIO sandbox, BoxLite sandbox, and image assets intact; extend the workflow contract fixture so `workflow-gates` proves ordering and exact-tag wiring while CI executes the real container smoke.
  - requirements: ["release-and-versioning/a-github-release-triggered-workflow-publishes-a-matched-versioned-image-set-to-ghcr", "release-and-versioning/release-tail-is-scriptized-and-verifies-all-three-images"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.3 Extend `scripts/release.sh` and release tests to verify Git availability in the published `cap-api` tag, fail with actionable output when the prerequisite is absent, preserve all existing immutable-tag, version, asset, and multi-image verification, and register the deterministic release-script contract tests in the fixed `workflow-gates` test set.
  - requirements: ["release-and-versioning/release-tail-is-scriptized-and-verifies-all-three-images"]
  - surfaces: ["developer-workflow", "ci", "docs"]
  - verify: "workflow-gates"

## 7. Track: integration-and-validation (depends: console-refresh-and-failure-ux, public-v1-mcp-projections, release-image-gates)

- [x] 7.1 Add an infrastructure-free generated private Git remote whose symbolic HEAD can move between nonstandard branches; prove refresh keeps the Repo id, a failed refresh preserves the old branch, an existing task keeps its immutable snapshot/PR base, and a subsequent task uses the new verified branch.
  - requirements: ["multi-forge-repo-import/existing-repository-default-branch-refresh-is-owner-authenticated-and-non-destructive", "repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults", "task-result-delivery/openchangerequest-and-findexistingchangerequest-map-per-forge-and-are-idempotent"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 7.2 Run a unique secret-canary story across import, refresh, remote refs, task provisioning, recovery, delivery, Public V1, MCP, audit, startup, and application logs; fail if the credential appears in URL, argv, env, response, persisted detail, or retained output.
  - requirements: ["multi-forge-repo-import/existing-repository-default-branch-refresh-is-owner-authenticated-and-non-destructive", "audit-history/provisioning-history-records-structured-stages-and-safe-causes", "observability/secret-redaction-in-logs"]
  - surfaces: ["contracts", "public-v1", "mcp", "ci"]
  - verify: "api-public-errors"
- [x] 7.3 Run strict OpenSpec validation, propose/apply metadata validation, contracts/API/web/public-surface suites, compatibility fixtures, production fallback scans, and `git diff --check`; repair every failure before rollout.
  - requirements: ["api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally", "repo-and-task-management/repository-and-task-branches-resolve-without-fabricated-defaults"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground", "openspec", "ci", "developer-workflow"]
  - verify: "public-surface-full"
- [x] 7.4 Validate the change sidecar and task metadata in propose/apply/verify phases, including the declared Internal-only refresh boundary, all fourteen existing Public V1/MCP operation mappings, all protocol differences, and the declared closed-discriminator wire-compatibility risk.
  - requirements: ["api-mcp-development-parity/canonical-public-capability-registry", "api-mcp-development-parity/transport-bindings-are-exhaustive"]
  - surfaces: ["openspec", "developer-workflow", "public-v1", "mcp"]
  - verify: "openspec-metadata"
- [ ] 7.5 Run the deterministic image/release workflow contract gate locally, then require the release CI job to pass the real built-`cap-api` and published-tag Git smoke before rollout evidence is accepted.
  - requirements: ["release-and-versioning/a-github-release-triggered-workflow-publishes-a-matched-versioned-image-set-to-ghcr", "release-and-versioning/release-tail-is-scriptized-and-verifies-all-three-images"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "workflow-gates"
- [ ] 7.6 Run the deterministic migration workflow contract gate locally, then require the CI loopback-Postgres fresh/upgrade/rollback job to pass before database compatibility evidence is accepted.
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes"]
  - surfaces: ["contracts", "ci", "developer-workflow"]
  - verify: "workflow-gates"
