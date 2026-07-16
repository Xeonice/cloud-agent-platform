## Why

The packaged `cap-api` currently invokes Git for authenticated remote-ref
resolution without shipping Git, then misclassifies the local spawn failure as
a forge TLS/network outage. At the same time, imported repositories retain a
verified default branch but offer no supported refresh after GitHub, Gitee, or
GitLab changes it, so an otherwise correct non-`main` branch can become stale.

## What Changes

- Ship and attest the required Git executable in the final API image, failing
  startup and release-image verification clearly when the packaged dependency
  is unavailable.
- Preserve local command-start failures as a distinct, non-retryable platform
  dependency cause instead of mapping them to authentication, network, or TLS;
  add the secret-free `repo_platform_dependency_unavailable` import error and
  `provisioning_platform_dependency_unavailable` task failure with
  `repair_deployment` guidance.
- Keep one forge-neutral branch policy: explicit task branch, verified persisted
  repository default, then symbolic HEAD authenticated as the current
  task/request account for a legacy null value. Never hard-code either `main`
  or `master`, and reuse the immutable resolved snapshot for provisioning,
  recovery, and pull/merge-request base.
- Add a Console/Internal authenticated refresh operation for an existing
  repository default branch. Refresh preserves the Repo identity, updates only
  after verification with the authenticated requesting account's exact-host
  credential, and retains the last verified value on failure; task creation
  does not contact the forge on every request.
- Expose refresh controls and typed failure guidance in the Console, while
  projecting the new task failure through direct task responses and nested
  schedule-run responses, plus refreshed repository values, across existing
  Public V1, MCP, OpenAPI, and API Playground reads. No Public V1 or MCP
  repository-write operation is added.
- Add an additive Prisma migration that widens the existing Task and admission
  work failure-code CHECK constraints; existing rows require no backfill.
- Correct the stale Forge-port specification that still mentions the removed
  `resolveBaseBranch` HTTP operation, and add GitHub `trunk`, GitLab `develop`,
  and Gitee `master` cross-surface regression coverage.

## Capabilities

### New Capabilities

- None. The change hardens existing repository, task, delivery, deployment, and
  public-surface capabilities.

### Modified Capabilities

- `repo-and-task-management`: Distinguish platform dependency failures and
  strengthen the shared no-fabricated-default branch and snapshot policy.
- `multi-forge-repo-import`: Add requesting-account-authenticated
  default-branch refresh and a local dependency import failure distinct from
  forge network failure.
- `github-repository-import`: Make an already imported GitHub repository
  refreshable from current server-verified `default_branch` metadata.
- `task-result-delivery`: Remove stale independent base-branch resolution from
  the Forge port and require the shared task branch snapshot for delivery.
- `frontend-console`: Add repository refresh controls and actionable platform
  dependency failure presentation on task and schedule-run views without
  client-side branch guessing.
- `public-v1-api`: Project the provisioning failure through existing task and
  nested schedule-run responses, and refreshed arbitrary default branches
  through repository reads.
- `mcp-server`: Preserve the same canonical Task/Schedule/Repo behavior in
  matching MCP tools without adding a repository refresh tool.
- `audit-history`: Record a safe platform dependency cause separately from
  forge authentication, network, and TLS failures.
- `release-and-versioning`: Require Git in the built API runtime image and run a
  container-level dependency smoke before publishing and during release checks.

## Impact

Affected areas include the API Dockerfile and release workflow, API startup
preflight, remote-ref command/probe classification, canonical task failure and
repo-import contracts, Prisma failure-code CHECK constraints, task admission
retry policy, repository reconciliation and Console controllers, repository
UI/query invalidation, task delivery branch selection, audit projections,
Public V1/MCP/OpenAPI/Playground task and schedule conformance, and generated
private-repository plus packaged-image verification. Existing request fields and
operation/tool ids remain stable, but the closed TaskFailure discriminator gains
a server output variant; strict older clients therefore require a matched
upgrade rather than being promised compatibility with the new value.
