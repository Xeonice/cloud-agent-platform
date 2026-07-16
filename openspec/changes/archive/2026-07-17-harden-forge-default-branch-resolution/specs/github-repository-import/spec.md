## MODIFIED Requirements

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
