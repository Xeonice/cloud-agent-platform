## ADDED Requirements

### Requirement: URL import validates owner access and persists the real default branch

The Console/Internal URL import path SHALL receive the authenticated account id
and SHALL validate repository access with the owner-scoped forge credential for
the exact normalized host, without embedding that credential in the URL. Picker
imports SHALL persist the forge API's default branch. URL imports SHALL resolve
the remote symbolic HEAD through a credentialed, bounded refs probe and persist
that branch before the repository becomes task-selectable. The importer SHALL
NOT fabricate `main` when the forge omits metadata or the remote HEAD cannot be
resolved; it SHALL return a stable, safe access/auth/network/default-branch
failure and create no Repo row.

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

#### Scenario: Remote HEAD is never replaced with main

- **WHEN** the forge response omits a default branch and the bounded symbolic-HEAD probe cannot resolve one
- **THEN** import fails with a default-branch resolution error
- **AND** neither the API nor Console substitutes `main`

#### Scenario: Import remains outside Public V1 and MCP

- **WHEN** public operation and MCP tool inventories are generated
- **THEN** repo list/get remain available while repo import/create remains absent
- **AND** the exclusion is declared in the change's surface metadata
