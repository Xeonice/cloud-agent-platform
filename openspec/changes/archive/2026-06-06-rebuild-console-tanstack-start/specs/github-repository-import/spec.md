## ADDED Requirements

### Requirement: List the authenticated allowlisted user's GitHub repositories

The orchestrator SHALL expose an endpoint that returns the list of GitHub repositories the currently authenticated operator can access, by calling the GitHub REST API `GET /user/repos` on the server using that operator's own GitHub OAuth access token (obtained during the multi-user-oauth login flow). The operator's GitHub access token SHALL NEVER be returned to the browser; the call to GitHub MUST happen server-side. This endpoint is a protected REST endpoint and SHALL be subject to the same session validation as every other protected endpoint: it SHALL require a valid, non-expired session resolving to an allowlisted user, and SHALL respond HTTP 401 to a missing, malformed, expired, revoked, or non-allowlisted session. Each returned entry SHALL carry at minimum the GitHub repository's stable identity (numeric `id` and/or `full_name` such as `owner/name`), its `name`/`full_name`, its default branch, its visibility (private/public), and its description when present. This list represents "available GitHub repositories" sourced live from GitHub and is distinct from the platform's imported `Repo` records.

This endpoint is the load-bearing backend for the prototype's "仓库导入" import dialog (the prototype's `USER_REPOSITORIES` mock that simulates `GET /user/repos`).

#### Scenario: Authenticated operator lists their GitHub repositories
- **WHEN** an operator with a valid allowlisted session requests the available-GitHub-repositories endpoint
- **THEN** the orchestrator calls GitHub `GET /user/repos` server-side using that operator's GitHub OAuth access token
- **AND** it returns the repositories with at least each repo's GitHub numeric `id`, `full_name`, default branch, visibility, and description (when present)
- **AND** it never returns the operator's GitHub access token to the browser

#### Scenario: Unauthenticated request for GitHub repositories is rejected
- **WHEN** a request to the available-GitHub-repositories endpoint omits the session credential or presents one that is malformed, expired, revoked, or non-allowlisted
- **THEN** the orchestrator responds HTTP 401, does not call GitHub, and returns no repository data

#### Scenario: List uses the requesting operator's own token, not a shared token
- **WHEN** two different allowlisted operators each request the available-GitHub-repositories endpoint
- **THEN** each request calls GitHub with that operator's own GitHub OAuth access token, so each operator sees only the repositories their own GitHub account can access

### Requirement: Surface GitHub listing and import errors instead of masking them

The orchestrator SHALL surface failures from the GitHub API and from the import operation to the console as distinguishable, actionable errors rather than silently returning an empty list or a generic success. When the GitHub `GET /user/repos` call fails because the operator's stored GitHub access token is missing, expired, or revoked by GitHub, the orchestrator SHALL respond with a status that the console can interpret as "GitHub authorization required" (prompting re-authorization) rather than HTTP 401-as-session-expired and rather than an empty repository list. When the GitHub call fails for other reasons (rate limiting, GitHub outage, network error), the orchestrator SHALL respond with an error that preserves the cause (for example a 429/5xx-class signal) so the console can show a retry-able failure state. The console SHALL distinguish the empty state ("no repositories returned") from the error state ("the listing failed") so an operator is never shown an empty importable list that is actually a hidden failure.

#### Scenario: Expired or revoked GitHub token surfaces a re-authorization prompt
- **WHEN** the GitHub `GET /user/repos` call fails because the operator's GitHub access token is missing, expired, or revoked by GitHub
- **THEN** the orchestrator returns a response the console interprets as "GitHub authorization required"
- **AND** the console prompts the operator to re-authorize GitHub rather than showing an empty importable list

#### Scenario: GitHub rate-limit or outage surfaces a retry-able error
- **WHEN** the GitHub `GET /user/repos` call fails with a rate-limit, outage, or network error
- **THEN** the orchestrator returns an error that preserves the cause
- **AND** the console renders a retry-able failure state distinct from an empty result

#### Scenario: Empty result is not conflated with failure
- **WHEN** GitHub returns a successful but empty repository list for the operator
- **THEN** the console shows an explicit empty state, not an error
- **AND** when the listing fails, the console shows an error state, not an empty state

### Requirement: Import a selected GitHub repository into the platform

The orchestrator SHALL expose an endpoint that imports a single GitHub repository, selected from the available-GitHub-repositories listing, into the platform by creating a platform `Repo` record. The endpoint SHALL be a protected REST endpoint subject to the same session validation as every other protected endpoint (valid, non-expired, allowlisted session; otherwise HTTP 401). On import the orchestrator SHALL persist the platform `Repo` with at least its required `name` and git source derived from the selected GitHub repository (the GitHub clone URL or `full_name`), and SHALL capture GitHub-import metadata sufficient to render the prototype's imported-repository panel and to de-duplicate future imports — at minimum the originating GitHub repository's stable numeric `id` (or `full_name`), default branch, and description. The originating GitHub repository's stable identity SHALL be recorded on the created `Repo` so that the platform can later distinguish a GitHub-imported repo from a manually created one and so that re-import attempts can be detected. On success the endpoint SHALL return HTTP 201 with the created platform `Repo` (including its generated platform id).

This endpoint extends the existing `Repo` create path (repo-and-task-management) with GitHub-import provenance; it does not replace the generic create-repo endpoint.

#### Scenario: Importing a selected GitHub repo creates a platform Repo
- **WHEN** an authenticated allowlisted operator imports a GitHub repository chosen from their available-GitHub-repositories listing
- **THEN** the orchestrator creates a platform `Repo` record with the repo's `name`, a git source derived from the GitHub repository, and GitHub-import metadata including the originating GitHub numeric `id` (or `full_name`), default branch, and description
- **AND** it returns HTTP 201 with the created platform `Repo` carrying its generated platform id

#### Scenario: Imported Repo records its GitHub provenance
- **WHEN** the created platform `Repo` from a GitHub import is inspected
- **THEN** it carries the originating GitHub repository's stable identity so the platform can distinguish it from a manually created repo and detect re-import attempts

#### Scenario: Import requires a valid allowlisted session
- **WHEN** an import request omits the session credential or presents one that is malformed, expired, revoked, or non-allowlisted
- **THEN** the orchestrator responds HTTP 401 and creates no `Repo` record

### Requirement: De-duplicate imports against already-imported repositories

The orchestrator SHALL prevent importing the same GitHub repository more than once into the platform. When an import targets a GitHub repository whose stable identity (numeric GitHub `id`, or `full_name` as a fallback key) already corresponds to an existing platform `Repo`, the orchestrator SHALL NOT create a duplicate `Repo`; it SHALL instead respond with a conflict signal (HTTP 409) identifying the already-imported `Repo`, or idempotently return the existing record, rather than producing a second platform `Repo` for the same GitHub source. De-duplication SHALL key on the originating GitHub repository's stable identity, not solely on the mutable display `name`, so that two distinct GitHub repositories that happen to share a short name are not falsely treated as duplicates and a renamed GitHub repository is still recognized as already imported. The available-GitHub-repositories listing presented to the operator SHALL be reconcilable against existing imported `Repo` records so the console can mark which GitHub repositories are already imported.

#### Scenario: Re-importing an already-imported repository does not create a duplicate
- **WHEN** an operator imports a GitHub repository whose stable GitHub identity already matches an existing platform `Repo`
- **THEN** the orchestrator does not create a second `Repo` record
- **AND** it responds with a conflict (HTTP 409) identifying the existing imported `Repo`, or idempotently returns that existing `Repo`

#### Scenario: De-duplication keys on stable GitHub identity, not display name
- **WHEN** two distinct GitHub repositories share the same short `name` but have different GitHub numeric `id`s
- **THEN** importing the second one is allowed and is not rejected as a duplicate, because de-duplication keys on the originating GitHub identity rather than the display name

#### Scenario: Listing marks already-imported repositories
- **WHEN** the console renders the available-GitHub-repositories listing while one or more of them are already imported as platform `Repo` records
- **THEN** the already-imported repositories are reconcilable against existing imported `Repo` records so the console can mark them as already imported

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

The orchestrator and console SHALL treat "available GitHub repositories" (live entries from GitHub `GET /user/repos`, scoped to the requesting operator's GitHub account) and "imported repositories" (durable platform `Repo` records) as two distinct concepts exposed through distinct reads. The available-GitHub-repositories read SHALL reflect the operator's current GitHub access and SHALL NOT be treated as the platform's repository inventory. The imported-repositories read (the existing list-repos endpoint from repo-and-task-management) SHALL reflect only repositories that have been imported into the platform and SHALL be the source of truth for repo selection in task creation and scope decisions. A GitHub repository SHALL only become usable for task creation after it has been imported into a platform `Repo`.

#### Scenario: Available list reflects GitHub, imported list reflects the platform
- **WHEN** an operator has GitHub access to several repositories but has imported only some of them
- **THEN** the available-GitHub-repositories read returns the GitHub-accessible set
- **AND** the imported-repositories read returns only the imported platform `Repo` records

#### Scenario: Only imported repositories are selectable for task creation
- **WHEN** a task-creation surface offers repository choices
- **THEN** it offers only imported platform `Repo` records, not un-imported available GitHub repositories
- **AND** a GitHub repository becomes selectable only after it has been imported
