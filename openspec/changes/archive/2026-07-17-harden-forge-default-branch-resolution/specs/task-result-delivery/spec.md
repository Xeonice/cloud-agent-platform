## MODIFIED Requirements

### Requirement: A single Forge port abstracts GitHub, Gitee, and GitLab

The system SHALL expose a single `Forge` port through the `FORGE` DI token and
`ForgeRegistry` resolver, with concrete `GithubForge`, `GiteeForge`, and
`GitlabForge` implementations selected solely by the resolved
`ForgeTarget.kind` and `apiBaseUrl`. The port SHALL provide the synchronous,
pure `cloneAuthHeader` plus `findExistingChangeRequest`,
`openChangeRequest`, and `listRepos`. It SHALL NOT provide
`resolveBaseBranch` or a git push operation: checkout and change-request base
SHALL come from the shared immutable task branch snapshot, while Git push stays
inside the selected sandbox/provider workspace. The repository identifier SHALL
remain a discriminated union (`owner-repo` for GitHub/Gitee and `project` for
GitLab) so a GitLab project id cannot enter a GitHub/Gitee call path.

#### Scenario: The forge implementation is chosen by kind, not call site

- **WHEN** push-back or the import picker resolves a ForgeTarget for a repository
- **THEN** the registry returns the matching implementation and its HTTP calls use the target apiBaseUrl

#### Scenario: Forge port cannot choose another base branch

- **WHEN** delivery opens a change request for a task resolved to `trunk`
- **THEN** the Forge implementation receives `baseBranch = trunk` from the task snapshot
- **AND** no Forge method independently resolves or guesses a default branch

### Requirement: Forge HTTP calls the operator's connected forge directly and is not SSRF-gated

The system SHALL perform `findExistingChangeRequest`, `openChangeRequest`, and
`listRepos` as platform-process fetches to the operator's connected forge API
with the decrypted credential. Because the target is the operator's own
connected forge rather than an arbitrary compatible-provider URL, these calls
SHALL NOT pass through `assertSafeProviderUrl`; that guard SHALL remain scoped
to the compatible-provider gateway. Authenticated Git symbolic-HEAD probing
SHALL remain a separate exact-host Git boundary, not a Forge HTTP method. The
system SHALL NOT route Forge HTTP through the sandbox or invent an API fallback
when the platform cannot reach a self-hosted forge; delivery unreachability
SHALL remain a fail-open audited skip.

#### Scenario: A self-hosted forge on a private network is called directly

- **WHEN** a task targets a registered self-hosted forge whose apiBase resolves to a private IP
- **THEN** the platform calls it with native fetch and no compatible-provider SSRF rejection
- **AND** an unreachable delivery API fails open with an audited skip

### Requirement: openChangeRequest and findExistingChangeRequest map per forge and are idempotent

For GitHub/Gitee the system SHALL `POST
{apiBase}/repos/{owner}/{repo}/pulls` with
`{head,base,title,body}` and map `number`/`html_url`; for GitLab it SHALL `POST
{apiBase}/projects/{id}/merge_requests` with
`{source_branch,target_branch,title,description}` and map `iid`/`web_url`.
Before opening, the system SHALL look for an existing open change request on the
head/source branch—GitHub via `?state=open&head={owner}:{b}`, GitLab via
`?state=opened&source_branch={b}`, and Gitee by listing `?state=open` then
filtering `head.ref===b`—and SHALL reuse it, including a 422 already-exists
recovery, as idempotent success. The target/base branch supplied to every forge
SHALL be the shared task resolved-branch snapshot and SHALL NOT be fetched or
guessed independently during delivery.

#### Scenario: GitLab MR uses its own shape

- **WHEN** delivering to a GitLab repository
- **THEN** the MR is created at `/merge_requests` with source/target branches, listed with `state=opened`, and mapped from `iid`/`web_url`

#### Scenario: Re-delivering the same task reuses the open CR

- **WHEN** a task is re-run and an open change request already exists for `cap/task-<taskId>`
- **THEN** the existing change request is reused and no duplicate is created

#### Scenario: Delivery base follows the accepted snapshot after repository refresh

- **WHEN** a task accepted on `develop` is delivered after the Repo default is refreshed to `trunk`
- **THEN** its PR or MR base remains `develop`
- **AND** the Forge API is not queried for a replacement default
