## ADDED Requirements

### Requirement: Existing repository default branch refresh is owner-authenticated and non-destructive

The Console/Internal API SHALL expose an authenticated default-branch refresh
for an existing repository without accepting a client-supplied branch value.
The refresh SHALL resolve the requesting account's exact-host forge credential,
run the bounded symbolic-HEAD probe against the stored normalized clone URL,
validate the returned branch, update only the existing Repo's verified
`defaultBranch`, and return that same canonical Repo identity. A failed refresh
SHALL leave the last verified branch and all repository identity fields
unchanged. Refresh SHALL support GitHub, Gitee, and GitLab clone URLs and SHALL
NOT add a Public V1 write operation or MCP tool.
The remote probe SHALL run outside a database transaction. After validation,
the API SHALL perform only a short update fenced by the previously read Repo id
and unchanged forge/git identity so a deleted or re-identified row is not
recreated or overwritten by a stale probe.

#### Scenario: Verified remote rename refreshes the existing Repo

- **WHEN** an operator whose exact-host credential can access a repository refreshes it after symbolic HEAD changes from `master` to `trunk`
- **THEN** the existing Repo id is returned with `defaultBranch = trunk`
- **AND** no duplicate Repo is created and no accepted task snapshot is rewritten

#### Scenario: Failed refresh preserves the last verified branch

- **WHEN** authentication, access, remote HEAD, network, or platform dependency validation fails during refresh
- **THEN** the API returns the corresponding stable safe error
- **AND** the existing Repo retains its previous verified branch and identity

#### Scenario: Concurrent repository identity change fences a stale refresh

- **WHEN** the repository's forge or normalized git source changes after the refresh probe starts but before its short update
- **THEN** the stale refresh does not update or recreate the Repo
- **AND** no remote network wait holds an open database transaction

#### Scenario: Refresh remains an internal repository write

- **WHEN** Public V1 operations and MCP tools are generated
- **THEN** repository list/get remain available but no import or refresh write is exposed
- **AND** `repos:read` is never reused to authorize refresh

## MODIFIED Requirements

### Requirement: URL import validates owner access and persists the real default branch

The Console/Internal URL import path SHALL receive the authenticated account id
and SHALL validate repository access with the owner-scoped forge credential for
the exact normalized host, without embedding that credential in the URL. Picker
imports SHALL persist the forge API's default branch. URL imports SHALL resolve
the remote symbolic HEAD through a credentialed, bounded refs probe and persist
that branch before the repository becomes task-selectable. The importer SHALL
NOT fabricate `main` or `master` when the forge omits metadata or remote HEAD
cannot be resolved. It SHALL return a stable, safe access, authentication,
network, default-branch, or platform-dependency failure and create no Repo row.
A local command-start/dependency failure SHALL use
`repo_platform_dependency_unavailable` with HTTP 503 and SHALL NOT be classified as forge
network/TLS failure.

This owner-aware import remains a Console/Internal write path. It SHALL NOT add
a Public V1 repo-write operation, an MCP import tool, or reuse `repos:read` as a
write scope.

#### Scenario: Private Gitee URL resolves master with the owner's token

- **WHEN** an authenticated operator imports a private Gitee URL whose symbolic HEAD targets `master` and has a matching stored credential
- **THEN** the access probe succeeds without a credential-bearing URL
- **AND** the Repo row persists `defaultBranch = master` before it is returned as selectable

#### Scenario: Invalid owner credential creates no repository

- **WHEN** URL import cannot authenticate to the exact forge host with the current owner's credential
- **THEN** the API returns a stable safe authentication/access failure
- **AND** no Repo row or plaintext credential is persisted

#### Scenario: Missing Git is not reported as forge network failure

- **WHEN** URL import cannot start the local Git remote-ref command
- **THEN** the API returns `repo_platform_dependency_unavailable`
- **AND** it creates no Repo and does not return `repo_forge_network_unavailable`

#### Scenario: Remote HEAD is never replaced with a conventional guess

- **WHEN** the forge response omits a default branch and the bounded symbolic-HEAD probe cannot resolve one
- **THEN** import fails with a default-branch resolution error
- **AND** neither the API nor Console substitutes `main` or `master`

#### Scenario: Import remains outside Public V1 and MCP

- **WHEN** public operation and MCP tool inventories are generated
- **THEN** repo list/get remain available while repo import/create remains absent
- **AND** the exclusion is declared in the change's surface metadata
