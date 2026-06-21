# task-result-delivery Specification

## Purpose
TBD - created by archiving change add-multi-forge-task-delivery. Update Purpose after archive.
## Requirements
### Requirement: A single Forge port abstracts GitHub, Gitee, and GitLab
The system SHALL expose a single `Forge` port (a `FORGE` DI token + a `ForgeRegistry` resolver) with
concrete `GithubForge`, `GiteeForge`, and `GitlabForge` implementations selected solely by the resolved
`ForgeTarget.kind` + `apiBaseUrl`. The port SHALL provide `cloneAuthHeader` (synchronous, pure) plus the
HTTP operations `resolveBaseBranch`, `findExistingChangeRequest`, `openChangeRequest`, and `listRepos`,
each an ordinary platform-process `fetch` against the operator's connected forge. The port SHALL NOT
define a git push operation (git push is a sandbox concern — the working tree lives there). The repo
identifier SHALL be a discriminated union (`owner-repo` for github/gitee, `project` for gitlab) so a
GitLab project id can never reach a github/gitee call path.

#### Scenario: The forge impl is chosen by kind, not by call site
- **WHEN** push-back or the import picker resolves a `ForgeTarget` for a repo
- **THEN** the registry returns the matching forge impl and all forge HTTP routes through it with the target's `apiBaseUrl`

### Requirement: Forge HTTP calls the operator's connected forge directly and is not SSRF-gated
The system SHALL perform every forge HTTP call (`resolveBaseBranch`, `findExistingChangeRequest`,
`openChangeRequest`, `listRepos`) as a platform-process `fetch` to the operator's connected forge API
with the decrypted credential. Because the target is the operator's OWN connected forge (not an arbitrary
URL), these calls SHALL NOT pass through `assertSafeProviderUrl`, and that guard SHALL remain unchanged
and scoped to the compatible-provider gateway. The system SHALL NOT route forge HTTP through the sandbox
or build a fallback for the platform being unable to reach a self-hosted forge (a deployer network
concern); an unreachable forge SHALL surface as a fail-open audited skip.

#### Scenario: A self-hosted forge on a private network is called directly
- **WHEN** a task targets a registered self-hosted forge whose apiBase resolves to a private IP
- **THEN** the platform calls it with a plain native fetch (no SSRF rejection of the private IP) and, if it cannot route to it, the delivery fails-open with an audited skip

### Requirement: cloneAuthHeader supplies one token-bearing header for the in-sandbox clone and push
The system SHALL use `forge.cloneAuthHeader(target)` as the `git -c http.extraHeader` value for BOTH the
in-sandbox clone and the in-sandbox push, and the token SHALL NOT appear in any clone/push URL,
environment, or persisted git config. For github and gitee it SHALL be
`Authorization: Basic base64('x-access-token:'+token)`; for a gitlab PAT it SHALL be
`Authorization: Basic base64('oauth2:'+token)`.

#### Scenario: Push reuses the clone auth discipline
- **WHEN** the platform pushes the task branch from inside the sandbox
- **THEN** the token rides only `git -c http.extraHeader` (never the URL) and is never persisted into the retained container

### Requirement: openChangeRequest and findExistingChangeRequest map per forge and are idempotent
For github/gitee the system SHALL `POST {apiBase}/repos/{owner}/{repo}/pulls` with `{head,base,title,body}`
and map the response to `number`/`html_url`; for gitlab it SHALL `POST {apiBase}/projects/{id}/merge_requests`
with `{source_branch,target_branch,title,description}` and map `iid`/`web_url`. Before opening, the system
SHALL look for an existing open change request on the head/source branch — github via
`?state=open&head={owner}:{b}`, gitlab via `?state=opened&source_branch={b}` (literal `opened`), gitee by
listing `?state=open` then client-side filtering `head.ref===b` — and SHALL reuse it (or treat a 422
"already exists" on create) as an idempotent success rather than an error.

#### Scenario: GitLab MR uses its own shape
- **WHEN** delivering to a gitlab repo
- **THEN** the MR is created at `/merge_requests` with `source_branch`/`target_branch`, listed with `state=opened`, and the result reads `iid`/`web_url`

#### Scenario: Re-delivering the same task reuses the open CR
- **WHEN** a task is re-run and an open change request already exists for `cap/task-<taskId>`
- **THEN** the existing change request is reused and no duplicate is created

### Requirement: Forge detection is layered
The system SHALL resolve a repo to a forge by: (1) the explicit nullable `Repo.forge` column when set;
else (2) public-host inference from the `gitSource` hostname; else (3) an operator-configured
`ForgeConnection` (self-hosted host → kind + apiBaseUrl + cached gitlab project id); else (4) return null
and SKIP push-back. The self-hosted `apiBaseUrl` is derived per kind (`/api/v3` GitHub Enterprise,
`/api/v4` GitLab, `/api/v5` Gitee).

#### Scenario: An unresolved forge skips push-back
- **WHEN** a repo has no explicit forge, a non-public host, and no `ForgeConnection`
- **THEN** push-back is skipped with a logged reason and the task settles normally

### Requirement: Delivery is opt-in and defaults to no-op
The system SHALL accept an optional `deliver` parameter on task creation with values `none|branch|pr`,
default `none` when omitted, persist it, and echo it on every task read path (MCP, `/v1`, console). When
`deliver` is `none` the system SHALL perform no commit, branch, push, or change request, and SHALL behave
byte-identically to the pre-change lifecycle.

#### Scenario: Default delivery is a no-op
- **WHEN** a task is created without `deliver`
- **THEN** no push-back code path runs and behavior matches today exactly

### Requirement: Push-back runs only on success, before teardown, by the platform
The system SHALL attempt push-back inside `guardrails.onTerminal` AFTER transcript capture and BEFORE
sandbox teardown, ONLY when the task's final status is `completed` AND `deliver != 'none'`. The git
commit + branch + push SHALL run INSIDE the sandbox over the exec channel (the working tree + `.git` are
there) with a deterministic non-prompt-injectable commit identity and message, on branch
`cap/task-<taskId>`, pushing with `--force-with-lease`; the change-request HTTP calls SHALL run
platform-side (native fetch). A no-diff workspace SHALL record `deliver_status='no_changes'` with no
empty branch or change request.

#### Scenario: A failed task never pushes
- **WHEN** a task with `deliver!='none'` terminates as `failed` or `cancelled`
- **THEN** no commit/branch/push/change-request occurs

#### Scenario: A clean codex/claude edit lands as a branch + CR
- **WHEN** a `completed` task with `deliver='pr'` left a non-empty working-tree diff
- **THEN** the platform commits it to `cap/task-<taskId>` in the sandbox, pushes it, opens a change request via native fetch, and records `branch_pushed`, `commit_sha`, `change_request_url`

### Requirement: The push-back credential is owner-scoped and write-capable
The system SHALL resolve the push-back token owner-scoped to the task owner (the `task.created` audit
event userId) via a `ForgeCredential`; one operator's token SHALL NEVER be used for another's push-back;
an unattributed task SHALL skip push-back. `User.githubAccessToken` MAY be used as a fallback ONLY for
the github public-host case; gitee/gitlab have no login-token fallback and REQUIRE a `ForgeCredential`.

#### Scenario: A task with no connected forge credential skips
- **WHEN** a `completed` gitlab task's owner has no connected gitlab `ForgeCredential`
- **THEN** push-back is skipped with `deliver_status='skipped'` and an audited reason, and the task is not failed

### Requirement: Delivery results are surfaced and audited; push-back never blocks settling
The system SHALL persist `deliver`, `deliver_status` (`skipped|no_changes|pushed|pr_opened|failed`),
`branch_pushed`, `commit_sha`, `change_request_url`, `change_request_number` (all nullable) on the task
and echo them on every read path — the persisted `deliver_status` IS the durable, read-path-visible
record of EACH attempt's outcome. In addition, a CHANGE-REQUEST audit event SHALL be emitted when a change
request is opened (`task.change_request_opened`, resultCode 201) or an existing open one is reused
(`task.change_request_reused`, resultCode 200) — the only two delivery audit kinds (honoring the
one-kind-one-code audit invariant; a non-CR outcome is recorded by `deliver_status`, NOT a separate audit
kind). The push-back step SHALL be best-effort and time-boxed: any failure or timeout SHALL be recorded
(`deliver_status='failed'`) and SHALL NOT block the terminal transition, sandbox teardown, or
concurrency-slot release.

#### Scenario: A wedged forge call does not hold a slot
- **WHEN** the forge API or push hangs past the delivery timeout
- **THEN** the step is abandoned with `deliver_status='failed'` recorded on the task, and the task still tears down and releases its slot

#### Scenario: The change request URL is returned through every surface
- **WHEN** a client reads a delivered task via MCP `get_task`, `/v1`, or the console
- **THEN** the same `change_request_url` / `branch_pushed` / `deliver_status` fields are present

