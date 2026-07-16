# Research brief: harden forge default-branch resolution

## Incident evidence

The production investigation separated Git authentication, remote reachability,
control-plane tooling, and full sandbox clone behavior instead of treating every
failure as a clone timeout.

| Probe | Result |
| --- | --- |
| Target Gitee Git Smart HTTP without credentials | The endpoint answered HTTP 401 immediately, proving DNS and network reachability. |
| Target Gitee Git Smart HTTP with the stored owner token | The current exact-host Basic `x-access-token:<PAT>` credential path answered HTTP 200 with a Git upload-pack advertisement. The token and URL are therefore not the cause of the current failure. |
| `cap-api` container remote-ref command | Spawning `git` failed with `env: 'git': No such file or directory` and exit 127. The final API image installs OpenSSL and CA certificates but not Git. |
| Task failure projection | The local spawn failure was reduced to `network_unavailable`, then persisted and presented as `provisioning_tls_network_failed`, falsely directing the operator toward DNS, proxy, TLS, or forge-token remediation. |
| Historical full clone | A separate earlier probe proved a 5 GiB BoxLite disk and a 900-second Git deadline could clone the large repository successfully. That storage/timeout correction is already shipped and is not the present regression. |

The `gcode` runtime dependency is also unrelated to repository access: CAP
materializes the workspace before it configures and launches the selected agent
runtime. It cannot compensate for a missing control-plane Git executable.

## Current branch and import behavior

The production branch algorithm already avoids a provider-specific `main`
fallback:

1. New task preparation chooses an explicit caller branch when present.
2. Otherwise it uses the persisted, validated `Repo.defaultBranch`.
3. Only a legacy repository with a null default uses an exact-host
   `git ls-remote --symref HEAD` probe authenticated as the current task/request
   account.
4. The resolved branch is snapshotted for provisioning, recovery, and PR base
   selection; delivery does not independently ask a forge for another base.

GitHub picker imports parse the authenticated GitHub API `default_branch` and
server-side re-list the selected repository before persistence. A browser value
of `main` cannot override a server result such as `master` or `trunk`. The
generic GitHub/Gitee/GitLab picker implementations likewise validate the forge
API default branch, while URL imports use symbolic HEAD.

Targeted existing tests passed during research:

- 28 API tests covering the shared resolver, GitHub verified import, all three
  forge picker mappings, owner-isolated legacy HEAD probes, snapshots, and
  missing-ref behavior;
- 11 Web tests covering persisted `master` selection and null-branch omission.

## Confirmed gaps

### Packaged control-plane dependency

The API runtime image does not contain a binary required by production
`RemoteRefsProbe`. The release workflow builds and publishes that image without
executing the required command inside the built artifact. There is no startup
or packaged-image attestation that would fail before an operator creates a task.

The command runner distinguishes `spawn_failed` internally, but the probe maps
that reason to network failure. As a result, both Console imports and tasks can
surface a remote/TLS diagnosis for a local packaging defect.

### Stale persisted default branches

`Repo.defaultBranch` is intentionally trusted during task creation so creating a
task does not make a new forge request. This keeps durable acceptance bounded
and avoids coupling every task to GitHub/Gitee/GitLab availability.

The backend reconciliation path already supports a verified default-branch
rename on an idempotent re-import. However, the Console renders an imported
candidate as a disabled `已导入` label, so an operator has no supported way to
refresh a repository after its remote default changes. A non-null stored branch
can therefore remain stale until an out-of-band import request occurs.

### Specification drift

The `task-result-delivery` main specification still claims that the Forge port
contains an HTTP `resolveBaseBranch` operation. The production port deliberately
removed it and a regression policy forbids restoring independent base-branch
resolution. Checkout and PR base both use the shared task branch snapshot.

## Capability anchors

This change should modify existing capabilities rather than add a broad new
umbrella capability:

- `repo-and-task-management`: canonical branch precedence, immutable snapshot,
  and a safe platform-dependency provisioning failure;
- `multi-forge-repo-import`: owner-authenticated URL probing, idempotent verified
  refresh, and typed import errors;
- `github-repository-import`: server-authoritative GitHub metadata and refresh
  of an existing import;
- `task-result-delivery`: Forge-port correction and shared PR-base snapshot;
- `frontend-console`: explicit refresh interaction and actionable dependency
  failure presentation;
- `public-v1-api` and `mcp-server`: canonical Task/Repo output parity without a
  new public repository-write surface;
- `audit-history`: distinguish local platform dependency from remote network or
  TLS failure without retaining raw diagnostics;
- `release-and-versioning`: package Git in `cap-api` and test the built/published
  runtime artifact.

Existing API/MCP development-parity and OpenAPI/Playground derivation
requirements remain verification baselines; they do not need a second semantic
branch implementation.

## Recommended correction

1. Install Git in the final `cap-api` runtime image and add a reusable,
   side-effect-free executable attestation. Run it at API startup before serving
   task/repository traffic and inside the built release image before publication.
2. Preserve `spawn_failed`/`ENOENT` as a local platform-dependency reason. Map it
   to a stable, secret-free repository import error and an additive provisioning
   task failure with operator guidance to repair or upgrade the deployment. It
   must be non-retryable by the admission worker and must never be called a TLS
   or network failure.
3. Keep the canonical branch precedence and forbid both `main` and `master`
   literals as fallback policy in production branch planning. Add GitHub
   `trunk`, GitLab `develop`, and Gitee `master` regression stories rather than
   replacing one guessed branch name with another.
4. Add an authenticated Console/Internal refresh operation for an existing Repo.
   It uses the requesting account's exact-host credential and the bounded
   symbolic-HEAD probe, updates `defaultBranch` only after verification, retains
   the Repo identity, and leaves the last verified value untouched on failure.
   Task creation continues to trust the persisted value and does not contact the
   forge on every request.
5. Make the Console expose that refresh for imported GitHub, Gitee, and GitLab
   repositories, invalidate repository/task-create caches after success, and
   render typed errors without parsing raw Git output.
6. Remove `resolveBaseBranch` from the stale Forge-port specification and require
   checkout and PR delivery to consume the same immutable resolved-branch
   snapshot.
7. Project the additive task failure and refreshed repository value through the
   existing Console REST, Public V1, MCP, OpenAPI, and Playground read paths,
   including schedule responses that embed `TaskFailure`. Repository refresh
   itself remains Console/Internal-only.
8. Widen the closed Task/admission failure-code database CHECK constraints with
   an additive migration. Existing rows need no backfill, but the new code
   cannot be persisted safely without that constraint migration.

## Surface decision

- Public V1 changes four task operations, two repository reads, and eight
  schedule operations whose outputs nest `TaskFailure`. It gains no import or
  refresh write operation.
- MCP changes the fourteen matching task/repository/schedule tools through their
  shared canonical responses and likewise gains no repository write tool.
- OpenAPI and API Playground derive the TaskFailure, nested schedule, and
  affected repository descriptions from the public registry.
- Console/Internal owns executable preflight, repository refresh, packaged-image
  behavior, operational diagnostics, and the refresh UI.

## Verification strategy

1. Command-runner tests inject an `ENOENT`/spawn failure and prove it maps to the
   local dependency reason, never auth/network/TLS, without exposing argv,
   credential config, stderr, or token material.
2. A real built `cap-api` image must execute `git --version`; a negative fixture
   without Git must fail the startup/image gate before API traffic is served.
3. Forge-neutral tests cover GitHub `trunk`, GitLab `develop`, and Gitee
   `master`, explicit-branch precedence, null legacy HEAD resolution, immutable
   recovery/PR snapshots, and a mutation guard against hard-coded `main` or
   `master` fallbacks.
4. Refresh tests change a generated remote symbolic HEAD, call the authenticated
   refresh seam, verify the same Repo id now exposes the new branch, and prove a
   failed probe preserves the old verified branch.
5. Console REST, Public V1, and MCP create/read stories use the same GitHub
   non-`main` branch and round-trip the same safe platform-dependency failure in
   direct task and nested schedule-run responses. OpenAPI/Playground and the
   fourteen operation/tool inventory tests remain derived from the canonical
   registry. Compatibility fixtures prove current readers accept legacy
   payloads and record that strict N-1 readers require a matched upgrade for the
   new closed discriminator.
   Console tests prove task detail plus schedule latest-run/history render the
   same deployment-repair action instead of silently filtering it through the
   existing credential-only badge.
6. A gated deployment smoke verifies the published image, performs an
   authenticated branch refresh, creates a task without an explicit branch,
   observes the resolved branch, and cleans up the task/sandbox without printing
   credentials.

## Non-goals

- Do not change the current exact-host temporary Git credential transport or put
  tokens in clone URLs, argv, environment variables, logs, or audit data.
- Do not add a GitHub/Gitee/GitLab-specific default-name fallback.
- Do not query the forge or remote HEAD for every task whose repository already
  has a verified non-null default branch.
- Do not add Public V1 or MCP repository import/refresh writes.
- Do not solve self-hosted Gitee API-base discovery or nested-namespace PR API
  addressing in this change; Git clone and symbolic-HEAD refresh keep the full
  configured URL and are independent of those API concerns.
- Do not reopen the already corrected BoxLite disk-size or workspace-timeout
  work.
