## ADDED Requirements

### Requirement: Importable repos are listed per connected forge for the picker
The system SHALL list, for each connected forge, the repositories the stored credential can access so the
operator can pick which to import — GitHub via its existing import flow, GitLab via
`GET /projects?membership=true` (or `owned`/`min_access_level`), and Gitee via `GET /v5/user/repos` —
each a paginated platform-process `fetch` to the operator's connected forge, returning entries with at
least full path, visibility, and default branch. These calls are ordinary trusted forge calls (the forge
is operator-connected) and are NOT routed through `assertSafeProviderUrl`.

#### Scenario: Picking a GitLab repo from the connected account
- **WHEN** an operator selects the GitLab source in the import dialog and has a connected GitLab credential
- **THEN** the platform lists the operator's GitLab projects (paginated, mapped to full path / visibility / default branch) and the operator imports a chosen one

#### Scenario: Picking a Gitee repo from the connected account
- **WHEN** an operator selects the Gitee source with a connected Gitee credential
- **THEN** the platform lists the operator's Gitee repositories via `GET /v5/user/repos` for selection

### Requirement: Import records the forge and a forge-correct git source
The system SHALL, on import (whether from the picker or by pasting a git URL), record the repository's
`forge` and a `gitSource` derived from the forge + host (NOT hardcoded to github.com), so forge detection
(the `Repo.forge` column) is populated for every imported repo regardless of source forge. The GitHub
import write (`POST /repos/github/import`) SHALL record `forge='github'`; a GitLab/Gitee picker or by-URL
import SHALL go through `POST /repos` with a forge-neutral `CreateRepoRequest{name, gitSource, forge?}`
(forge explicit, else inferred from the gitSource public host). The import contracts SHALL be forge-aware
(`AvailableRepo{forge, fullPath, gitSource, visibility, defaultBranch, gitlabProjectId?}` for the picker
listing + `forge` on the import bodies), and `RepoSchema` SHALL carry a nullable `forge` echoed by both
`ReposService` and the GitHub import response.

#### Scenario: A GitLab picker import lands with the right forge + source
- **WHEN** an operator imports a GitLab project from the picker via `POST /repos {name, gitSource, forge:'gitlab'}`
- **THEN** the repo is stored with `forge='gitlab'` and a gitlab gitSource (NOT a github.com URL, NOT `forge=null`), so detection step (1) resolves it

#### Scenario: A GitHub import records its forge
- **WHEN** an operator imports a repo via `POST /repos/github/import`
- **THEN** the created repo is stored with `forge='github'` and echoed on the response (never `forge=null`)

#### Scenario: Importing a repo by URL
- **WHEN** an operator pastes `https://git.corp.com/team/app.git` (forge detected from host or selected)
- **THEN** the repo is registered with its forge + gitSource without enumeration, and later clone / push-back use it
