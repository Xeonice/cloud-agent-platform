## Context

CAP resolves a repository's effective checkout branch in the API process before
the provider materializes the workspace. Picker imports persist a validated
forge API default branch; URL imports and legacy null rows use an authenticated
requesting-account `git ls-remote --symref HEAD` probe. Task admission then
snapshots the resolved branch so provisioning, recovery, and delivery share one
immutable decision.

The final API image does not currently include Git even though the production
remote-ref adapter spawns it. A missing executable becomes `spawn_failed`, which
the probe collapses into `network_unavailable`; task failure presentation then
claims a TLS/network problem. Separately, a non-null persisted branch is trusted
indefinitely. Reconciliation can update a verified remote rename, but the
Console prevents an already imported repository from being refreshed.

The correction crosses container packaging, startup, forge/repository services,
task contracts and retry policy, Console UI, public projections, delivery, and
release verification. Credential values must remain in the existing
exact-host, temporary, secret-write channel and must never appear in URL,
argv/environment, logs, audit data, or retained configuration.

## Goals / Non-Goals

**Goals:**

- Make every shipped API artifact contain and attest the Git executable required
  by production remote-ref resolution.
- Distinguish a local platform dependency failure from forge authentication,
  access, network, TLS, and remote-ref failures at every safe boundary.
- Preserve one provider-neutral branch decision and one immutable task snapshot
  across create, recovery, workspace checkout, and PR/MR delivery.
- Give an authenticated operator an explicit way to refresh the verified
  default branch of an existing repository without creating a duplicate row.
- Keep Console REST, Public V1, MCP, OpenAPI, and API Playground projections
  aligned while repository refresh remains an internal administration write.
- Detect regressions with generated repositories and real built-image smokes,
  not incident-host or branch-name hardcoding.

**Non-Goals:**

- Changing the existing exact-host Git credential transport or Gitee token
  username convention.
- Querying a forge or symbolic HEAD for every task whose repository already has
  a verified non-null default branch.
- Adding Public V1 or MCP repository import/refresh writes.
- Solving Gitee Enterprise API-base discovery or nested-namespace PR addressing.
- Reworking BoxLite disk capacity, Git transfer deadlines, or agent runtime
  (`gcode`, Codex, Claude Code) setup.

## Decisions

### 1. Git is an explicit API runtime dependency with two attestations

The final `cap-api` image will install Git with the existing minimal Debian
package step. A reusable preflight will execute a bounded `git --version`
command with sanitized environment and no repository credential. API startup
will run this preflight before the application begins serving traffic, and
the release image job will execute the same requirement inside the actually
built image before publication. The release-tail verifier will also check the
published image.

This is preferable to relying only on a Dockerfile text assertion: the built
artifact, platform, package stage, permissions, and executable lookup are what
production consumes. Replacing Git with forge REST APIs or a JavaScript Git
implementation was rejected because URL imports and self-hosted forges require
Git Smart HTTP behavior, symbolic HEAD, existing credential isolation, and
consistent semantics across providers.

### 2. Local process startup has a distinct, non-retryable failure class

`RemoteRefsCommandRunnerError('spawn_failed')` will remain distinguishable from
an exited Git process. The probe will map it to a new local
`platform_dependency_unavailable` reason rather than `network_unavailable`.
That reason will map to:

- Console/Internal repository import error
  `repo_platform_dependency_unavailable`, returned as HTTP 503;
- canonical task failure `provisioning_platform_dependency_unavailable` with
  action `repair_deployment`;
- a structured, secret-free audit cause and an operator log containing only the
  dependency name/reason, never command arguments, config paths, stderr, or
  tokens.

Admission will treat this failure as non-retryable: retrying the same task
cannot install a missing binary. Remote timeouts, DNS/TLS failures, 401/403, and
missing refs retain their existing classifications and retry policies. Unknown
local setup/cleanup failures continue to fail closed without leaking details.

An additive public failure variant was chosen over reusing
`provisioning_unknown` because the latter tells the operator to retry and hides
the verified deployment defect. The new action points to deployment repair or
upgrade instead.

### 3. Refresh is explicit and verifies the clone default through symbolic HEAD

The Console/Internal API will add
`POST /repos/:repoId/refresh-default-branch`. It accepts no branch value. The
controller supplies the authenticated account id; the service resolves that
account's exact-host forge credential and runs the bounded symbolic-HEAD probe
against the stored normalized clone URL. A successful result validates the
branch, updates only `Repo.defaultBranch` on the existing row, and returns the
canonical Repo response. A failed probe leaves the last verified value and Repo
identity unchanged and returns the stable typed import error.

The potentially 15-second remote probe SHALL NOT run inside a database
transaction. The service first reads an immutable repository identity snapshot,
probes with the requesting account's credential, then performs a short
conditional update fenced by the Repo id plus unchanged forge/git source and
re-reads the canonical row. A deleted or concurrently re-identified row fails
without recreation; concurrent refreshes of the same identity remain
last-verified-write-wins.

Symbolic HEAD is the refresh source for all three forges because it represents
the branch that authenticated Git clone will actually select and does not
depend on optional/self-host-specific forge API bases. Initial GitHub and picker
imports continue to use the server-authenticated forge API candidate and their
stable provider identities; idempotent re-import remains allowed to reconcile
verified metadata.

Automatic task-time refresh was rejected because it would add forge latency and
availability to every durable acceptance. Existing accepted tasks also keep
their immutable resolved snapshot after a Repo refresh; only future unsnapshotted
tasks consume the new persisted default.

### 4. Branch policy remains shared and forbids every conventional-name guess

The canonical order remains:

1. an existing admission snapshot during recovery/delivery;
2. explicit caller `Task.branch` for a new decision;
3. validated persisted `Repo.defaultBranch`;
4. symbolic HEAD authenticated with the current task/request account only when
   the persisted value is null;
5. a typed ref/dependency/auth/network failure, never a name fallback.

Production branch-planning regression scans will reject hard-coded `main` and
`master` literals in fallback decisions. Tests will deliberately use GitHub
`trunk`, GitLab `develop`, and Gitee `master` so no single fixture value can
become an implicit policy. PR/MR delivery will continue to receive
`TaskBranchResolver.resolvedBranch`; the Forge port will not regain a separate
`resolveBaseBranch` method.

### 5. Public behavior is additive; refresh stays internal

The shared Task failure union and action enum will gain the platform-dependency
variant. Existing task create/list/get/stop operations and every schedule
operation whose response nests `ScheduleLatestRun` or `ScheduleRunResponse`
(`schedules.list/create/get/update/pause/resume/dispatch/runs`) and their
matching MCP tools will project it through the canonical schema. Existing repo
list/get operations and tools will naturally return the refreshed nullable
`defaultBranch`. OpenAPI and API Playground will derive all affected outputs
from the registry.

There will be no Public V1 operation or MCP tool for refresh/import. This keeps
the current repository administration boundary and avoids treating
`repos:read` as a write scope. Console query invalidation will refresh imported
repository panels and both task-create surfaces after a successful refresh.
Console task detail and schedule latest-run/history views will share the same
deployment-repair presentation for the direct or nested TaskFailure variant.

### 6. Failure-code CHECK constraints require migration, but no data backfill

`Repo.defaultBranch` and the task/admission failure-code columns already have
the required physical shape, so repository rows and existing failure values do
not need rewriting. However, `tasks_failure_code_check` and
`task_admission_work_cause_code_check` are closed allowlists. An additive Prisma
migration will drop and recreate both constraints with
`provisioning_platform_dependency_unavailable` while retaining every existing
value. Fresh and upgrade migration tests will prove old rows remain unchanged
and both Task settlement and admission work can persist the new code. The
loopback-Postgres suite will run as an explicit CI job; a deterministic workflow
contract test will keep that job and its guarded command wired into the local
`workflow-gates` verifier.

The JSON shape is extended, but `TaskFailureSchema` is a closed discriminator.
A strict N-1 client cannot parse the new server value and the N release cannot
make that old binary degrade safely. Compatibility fixtures will instead prove
that the current reader still accepts legacy payloads and that all current
REST/MCP/OpenAPI/Playground projections agree. API and Web must therefore be
deployed as a matched version, and strict external clients must update before
they consume tasks or schedule runs that can carry the new variant.

## Risks / Trade-offs

- **[API image grows because Git is installed]** → Use the distribution package
  with `--no-install-recommends`, clean package indexes, and measure the final
  layer in the normal release build.
- **[Fail-fast startup makes a previously limping custom source deployment stop]**
  → Emit a clear secret-free dependency message and document Git as required;
  the alternative is serving requests that are guaranteed to fail deceptively.
- **[Remote default changes between refresh and task acceptance]** → Treat the
  successful refresh as a verified snapshot in time; task snapshots remain
  immutable and the operator can refresh again.
- **[Concurrent refreshes observe different remote states]** → Every writer must
  authenticate and validate; last verified write wins while accepted task
  snapshots are never rewritten.
- **[Strict older clients reject the new public enum value]** → Declare the
  compatibility boundary honestly, deploy matched API/Web images, update every
  direct and nested schedule projection, and verify only the achievable
  direction: current readers accepting previous payloads.
- **[Branch-literal mutation guard flags examples or unrelated release branches]**
  → Scope the scan to production forge/import/task/workspace planning code and
  strip comments; tests and documentation may still use concrete names.
- **[Refresh appears to update all repository metadata]** → Name the endpoint and
  UI action specifically for default-branch refresh; description, visibility,
  API base, and clone URL remain outside this operation.

## Migration Plan

1. Add contracts, typed mappings, the two-CHECK Prisma migration, and
   current-reader legacy fixtures first so every current surface and database
   writer understands the new safe failure.
2. Add the Git package, startup preflight, command-runner classification, and
   built-image negative/positive smokes. The API must not publish or boot when
   the dependency gate fails.
3. Add the internal refresh service/controller and Console action, then complete
   cross-forge and cross-surface stories.
4. Correct the main specifications and release the matched API/Web images.
5. Apply the additive constraint migration, then deploy matched API/Web images;
   no data backfill or bulk repository refresh is required. Operators refresh
   only repositories whose remote default changed.

Before rolling back to an API that predates the discriminator, admission is
drained and any Task/admission rows containing the new code are normalized to
the existing `provisioning_unknown` value. The previous matched API/Web images
can then be restored; the widened CHECK constraints and refreshed branch values
are safe to leave in place. This avoids claiming that the old binary can parse
the new closed-union member.

## Open Questions

None. API-startup failure, the internal-only refresh boundary, symbolic HEAD as
the refresh authority, and the additive public failure code are fixed decisions
for this change.
