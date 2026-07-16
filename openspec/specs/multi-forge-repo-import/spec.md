# multi-forge-repo-import Specification

## Purpose
TBD - created by archiving change add-multi-forge-task-delivery. Update Purpose after archive.
## Requirements
### Requirement: Importable repos are listed per connected forge for the picker
The system SHALL list, for each connected forge whose stored credential has API listing access, the repositories the stored credential can access so the operator can pick which to import — GitHub via its existing import flow, GitLab via `GET /projects?membership=true` (or `owned`/`min_access_level`), and Gitee via `GET /v5/user/repos` — each a paginated platform-process `fetch` to the operator's connected forge, returning entries with at least full path, visibility, and default branch. These calls are ordinary trusted forge calls (the forge is operator-connected) and are NOT routed through `assertSafeProviderUrl`.

Repository listing SHALL be a convenience path, not a prerequisite for importing a known repository. When a connected forge credential cannot call the listing API because the token is git-only, missing API scope, rate-limited, or the forge API is unavailable, the system SHALL surface a list-unavailable error distinct from "no repositories" and SHALL still allow URL import through the create-repo path.

#### Scenario: Picking a GitLab repo from the connected account
- **WHEN** an operator selects the GitLab source in the import dialog and has a connected GitLab credential with project-list access
- **THEN** the platform lists the operator's GitLab projects (paginated, mapped to full path / visibility / default branch) and the operator imports a chosen one

#### Scenario: Picking a Gitee repo from the connected account
- **WHEN** an operator selects the Gitee source with a connected Gitee credential that can call the repository listing API
- **THEN** the platform lists the operator's Gitee repositories via `GET /v5/user/repos` for selection

#### Scenario: Gitee listing unavailable still permits URL import
- **WHEN** an operator selects the Gitee source with a connected credential that cannot call `GET /v5/user/repos`
- **THEN** the platform surfaces a list-unavailable state rather than pretending there are zero repositories
- **AND** the operator can still import a known `https://.../*.git` repository URL without repository enumeration

### Requirement: Import records the forge and a forge-correct git source
The system SHALL, on import (whether from the picker or by pasting a git URL), record the repository's `forge` and a `gitSource` derived from the forge + host (NOT hardcoded to github.com), so forge detection (the `Repo.forge` column) is populated for every imported repo regardless of source forge. The GitHub import write (`POST /repos/github/import`) SHALL record `forge='github'`; a GitLab/Gitee picker or by-URL import SHALL go through `POST /repos` with a forge-neutral `CreateRepoRequest{name, gitSource, forge?}` (forge explicit, else inferred from the `gitSource` public host). The import contracts SHALL be forge-aware (`AvailableRepo{forge, fullPath, gitSource, visibility, defaultBranch, gitlabProjectId?}` for the picker listing + `forge` on the import bodies), and `RepoSchema` SHALL carry a nullable `forge` echoed by both `ReposService` and the GitHub import response.

For URL import, the system SHALL accept only HTTP(S) git URLs without embedded credentials, SHALL normalize the clone URL for duplicate detection, and SHALL reject or reconcile an exact duplicate `gitSource` rather than creating indistinguishable duplicate platform repos. A URL-imported repo SHALL be immediately selectable for task creation. Later clone and push-back SHALL use the same owner-scoped forge credential resolution as picker-imported repos.

#### Scenario: A GitLab picker import lands with the right forge + source
- **WHEN** an operator imports a GitLab project from the picker via `POST /repos {name, gitSource, forge:'gitlab'}`
- **THEN** the repo is stored with `forge='gitlab'` and a gitlab gitSource (NOT a github.com URL, NOT `forge=null`), so detection step (1) resolves it

#### Scenario: A GitHub import records its forge
- **WHEN** an operator imports a repo via `POST /repos/github/import`
- **THEN** the created repo is stored with `forge='github'` and echoed on the response (never `forge=null`)

#### Scenario: Importing a repo by URL
- **WHEN** an operator pastes `https://git.corp.com/team/app.git` and selects or infers the correct forge
- **THEN** the repo is registered with its forge + gitSource without enumeration, and later clone / push-back use it

#### Scenario: URL import rejects credential-bearing URLs
- **WHEN** an operator pastes a repository URL containing username/password/token userinfo
- **THEN** the import is rejected and no `Repo` is created, because credentials belong in the owner-scoped forge credential store

#### Scenario: Re-importing the same URL does not create a duplicate
- **WHEN** an operator imports a URL whose normalized `gitSource` already exists as a platform `Repo`
- **THEN** the system does not create a second indistinguishable repo row and instead returns an existing/conflict signal the console can reconcile

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
