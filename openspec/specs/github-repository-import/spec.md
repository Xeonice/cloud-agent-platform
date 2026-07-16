# github-repository-import Specification

## Purpose
TBD - created by archiving change rebuild-console-tanstack-start. Update Purpose after archive.
## Requirements
### Requirement: List the authenticated operator's GitHub repositories

The orchestrator SHALL expose an endpoint that returns the list of GitHub repositories the currently authenticated operator can access, by calling the GitHub REST API `GET /user/repos` on the server using that operator's own connected GitHub PAT from the forge credential store (`kind=github`, `host=github.com`). The operator's GitHub PAT SHALL NEVER be returned to the browser; the call to GitHub MUST happen server-side. This endpoint is a protected REST endpoint and SHALL be subject to the same session validation as every other protected endpoint: it SHALL require a valid, non-expired session resolving to an enabled local account, and SHALL respond HTTP 401 to a missing, malformed, expired, revoked, or disabled session. Each returned entry SHALL carry at minimum the GitHub repository's stable identity (numeric `id` and/or `full_name` such as `owner/name`), its `name`/`full_name`, its default branch, its visibility (private/public), and its description when present. This list represents "available GitHub repositories" sourced live from GitHub and is distinct from the platform's imported `Repo` records.

This endpoint is the load-bearing backend for the prototype's "仓库导入" import dialog (the prototype's `USER_REPOSITORIES` mock that simulates `GET /user/repos`).

#### Scenario: Authenticated operator lists their GitHub repositories
- **WHEN** an operator with a valid enabled-account session requests the available-GitHub-repositories endpoint
- **THEN** the orchestrator calls GitHub `GET /user/repos` server-side using that operator's connected GitHub PAT
- **AND** it returns the repositories with at least each repo's GitHub numeric `id`, `full_name`, default branch, visibility, and description (when present)
- **AND** it never returns the operator's GitHub PAT to the browser

#### Scenario: Unauthenticated request for GitHub repositories is rejected
- **WHEN** a request to the available-GitHub-repositories endpoint omits the session credential or presents one that is malformed, expired, revoked, or disabled
- **THEN** the orchestrator responds HTTP 401, does not call GitHub, and returns no repository data

#### Scenario: List uses the requesting operator's own token, not a shared token
- **WHEN** two different enabled operators each request the available-GitHub-repositories endpoint
- **THEN** each request calls GitHub with that operator's own connected GitHub PAT, so each operator sees only the repositories their token can access

### Requirement: Surface GitHub listing and import errors instead of masking them

The orchestrator SHALL surface failures from the GitHub API and from the import operation to the console as distinguishable, actionable errors rather than silently returning an empty list or a generic success. When the GitHub `GET /user/repos` call fails because the operator's connected GitHub PAT is missing, expired, revoked, or lacks scope, the orchestrator SHALL respond with a status that the console can interpret as "GitHub PAT required" (prompting the operator to connect or refresh the PAT) rather than HTTP 401-as-session-expired and rather than an empty repository list. When the GitHub call fails for other reasons (rate limiting, GitHub outage, network error), the orchestrator SHALL respond with an error that preserves the cause (for example a 429/5xx-class signal) so the console can show a retry-able failure state. The console SHALL distinguish the empty state ("no repositories returned") from the error state ("the listing failed") so an operator is never shown an empty importable list that is actually a hidden failure.

#### Scenario: Missing or revoked GitHub PAT surfaces a PAT-required prompt
- **WHEN** the GitHub `GET /user/repos` call fails because the operator's GitHub PAT is missing, expired, revoked, or lacks scope
- **THEN** the orchestrator returns a response the console interprets as "GitHub PAT required"
- **AND** the console prompts the operator to connect or refresh the GitHub PAT rather than showing an empty importable list

#### Scenario: GitHub rate-limit or outage surfaces a retry-able error
- **WHEN** the GitHub `GET /user/repos` call fails with a rate-limit, outage, or network error
- **THEN** the orchestrator returns an error that preserves the cause
- **AND** the console renders a retry-able failure state distinct from an empty result

#### Scenario: Empty result is not conflated with failure
- **WHEN** GitHub returns a successful but empty repository list for the operator
- **THEN** the console shows an explicit empty state, not an error
- **AND** when the listing fails, the console shows an error state, not an empty state

### Requirement: Import a selected GitHub repository into the platform

The orchestrator SHALL expose a protected endpoint that imports a GitHub
repository selected by stable identity from the available-repositories listing.
The requesting operator SHALL have a valid, non-expired session resolving to an
enabled account; otherwise the endpoint SHALL respond HTTP 401 and create no
Repo. The request body SHALL select the GitHub numeric `id` and `full_name`, but
SHALL NOT be authoritative for default branch or description. Before writing,
the orchestrator SHALL use that operator's connected GitHub PAT to re-list and
match the repository, then persist the server-verified current `default_branch`,
description, stable identity, name, and GitHub clone source. It SHALL accept any
valid GitHub default such as `trunk`, `develop`, `master`, or `main` and SHALL
NOT invent a conventional default. On success the endpoint SHALL return HTTP
201 with the canonical platform Repo and generated id.

This endpoint extends the existing Repo create path with GitHub-import
provenance; it does not replace the generic create-repo endpoint.

#### Scenario: Importing a selected GitHub repo creates a platform Repo

- **WHEN** an authenticated enabled operator imports a GitHub repository chosen from their available-repositories listing
- **THEN** the orchestrator creates a Repo with its server-verified GitHub identity, source, default branch, and description
- **AND** it returns HTTP 201 with the canonical Repo carrying its generated platform id

#### Scenario: Server-verified trunk overrides a stale browser value

- **WHEN** the browser submits a selected repository with stale `defaultBranch = main` but the authenticated GitHub API candidate reports `default_branch = trunk`
- **THEN** the persisted and returned Repo uses `trunk`
- **AND** no task or Console path rewrites it to `main` or `master`

#### Scenario: Imported Repo records its GitHub provenance

- **WHEN** the created platform Repo from a GitHub import is inspected
- **THEN** it carries the originating GitHub repository's stable identity so the platform can distinguish it from a manually created repo and detect re-import attempts

#### Scenario: Import requires a valid enabled-account session

- **WHEN** an import request omits the session credential or presents one that is malformed, expired, revoked, or disabled
- **THEN** the orchestrator responds HTTP 401 and creates no Repo record

### Requirement: De-duplicate imports against already-imported repositories

The orchestrator SHALL prevent multiple platform Repo rows for one GitHub stable
identity. After owner-authenticated revalidation, an import whose numeric GitHub
id (or `full_name` fallback) matches an existing Repo SHALL idempotently
reconcile the current verified default branch and other allowed mutable
metadata into that existing row and return it rather than creating a duplicate.
De-duplication SHALL key on stable GitHub identity, not mutable display name, so
distinct repositories with the same short name remain distinct and a renamed
repository is still recognized. The available-repositories listing SHALL remain
reconcilable with existing imported rows so the Console can offer a refresh
action instead of an import that creates another row.

#### Scenario: Re-import refreshes verified metadata without a duplicate

- **WHEN** an operator imports a GitHub repository whose stable identity matches an existing Repo and GitHub now reports a different valid default branch
- **THEN** the existing Repo id is returned with the newly verified default branch
- **AND** no second Repo record is created

#### Scenario: De-duplication keys on stable GitHub identity, not display name

- **WHEN** two distinct GitHub repositories share the same short `name` but have different GitHub numeric ids
- **THEN** importing the second one is allowed and is not rejected as a duplicate

#### Scenario: Listing marks already-imported repositories as refreshable

- **WHEN** the Console renders the available GitHub listing while repositories are already imported
- **THEN** candidates reconcile to the existing platform Repo ids
- **AND** the Console can refresh their verified branch without presenting a second-row import

### Requirement: Set and track a default repository

The orchestrator SHALL allow an operator to designate exactly one imported platform `Repo` as the default repository, and SHALL persist and read back that designation so the console can pre-select it (the prototype's "DEFAULT" tile and default-repo selection on the repositories, settings, workspace, and create-task surfaces). Setting a new default SHALL clear the prior default so that at most one default exists at a time. The default designation SHALL only ever reference an imported platform `Repo`; it SHALL NOT reference an un-imported "available GitHub repository". The current default SHALL be retrievable so that any console surface can read it back without recomputing it client-side.

#### Scenario: Setting a default repository persists and reads back
- **WHEN** an operator designates an imported platform `Repo` as the default
- **THEN** the orchestrator persists that designation
- **AND** a subsequent read of the default returns that same `Repo`

#### Scenario: A new default clears the previous default
- **WHEN** an operator designates a different imported `Repo` as the default while a default already exists
- **THEN** the orchestrator records the new default and clears the previous one, so at most one default exists at any time

#### Scenario: Only an imported repo can be the default
- **WHEN** a request attempts to set the default to a GitHub repository that has not been imported as a platform `Repo`
- **THEN** the orchestrator rejects the request and the default designation is unchanged, because the default may only reference an imported platform `Repo`

### Requirement: Distinguish available GitHub repositories from imported platform repositories

The orchestrator and console SHALL treat "available GitHub repositories" (live entries from GitHub `GET /user/repos`, scoped to the requesting operator's connected GitHub PAT) and "imported repositories" (durable platform `Repo` records) as two distinct concepts exposed through distinct reads. The available-GitHub-repositories read SHALL reflect the operator's current PAT access and SHALL NOT be treated as the platform's repository inventory. The imported-repositories read (the existing list-repos endpoint from repo-and-task-management) SHALL reflect only repositories that have been imported into the platform and SHALL be the source of truth for repo selection in task creation and scope decisions. A GitHub repository SHALL only become usable for task creation after it has been imported into a platform `Repo`.

#### Scenario: Available list reflects GitHub, imported list reflects the platform
- **WHEN** an operator has GitHub access to several repositories but has imported only some of them
- **THEN** the available-GitHub-repositories read returns the GitHub-accessible set
- **AND** the imported-repositories read returns only the imported platform `Repo` records

#### Scenario: Only imported repositories are selectable for task creation
- **WHEN** a task-creation surface offers repository choices
- **THEN** it offers only imported platform `Repo` records, not un-imported available GitHub repositories
- **AND** a GitHub repository becomes selectable only after it has been imported

### Requirement: A local account with a connected GitHub PAT can import repos

GitHub repo listing/import SHALL resolve the requesting account's OWN connected GitHub PAT by the
account primary key (`user.id`) from the forge credential store (`kind=github`, `host=github.com`),
so a local (password/OTP) account that has connected a GitHub PAT can list and import. The boundary
gate SHALL require an authenticated account (an identity-less principal is rejected); an account
with no usable GitHub PAT SHALL receive the distinct `github_auth_required` signal — NOT a session
401, NOT a silent empty list.

#### Scenario: Local account with a connected GitHub PAT imports

- **WHEN** a local account that has connected a GitHub PAT lists or imports GitHub repos
- **THEN** its own connected GitHub PAT is resolved by account id and the operation proceeds

#### Scenario: No usable GitHub PAT yields github_auth_required

- **WHEN** an authenticated account has no usable GitHub PAT
- **THEN** it receives `github_auth_required` (not a session 401, not a silent empty list)

#### Scenario: Identity-less principal is rejected at the boundary

- **WHEN** a machine/legacy principal with no account calls the import surface
- **THEN** it is rejected before any token read
