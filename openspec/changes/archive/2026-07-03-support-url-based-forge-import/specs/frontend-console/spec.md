## ADDED Requirements

### Requirement: Repository import dialog supports URL import when forge listing is unavailable
The `/repositories` import dialog SHALL provide a URL import path for forge repositories in addition to the existing list-based picker. For GitLab, Gitee, GitHub, and self-hosted forge sources, an operator SHALL be able to paste an HTTP(S) git URL, select or confirm the forge kind when it cannot be inferred, and submit the repo through the create-repo mutation without first syncing the repository list. The URL form SHALL reject credential-bearing URLs and SHALL explain that credentials are managed through the code-hosting connection settings.

When the list-based sync for a selected forge fails because the token cannot list repositories or the forge API is unavailable, the dialog SHALL keep the URL import path visible and present the failure as "listing unavailable" rather than "not connected" or "no repositories". The dialog SHALL continue to show the list picker when listing succeeds.

#### Scenario: Import by URL without syncing the list
- **WHEN** an operator opens the repository import dialog, selects Gitee, and pastes `https://gitee.internal/team/app.git`
- **THEN** the dialog can submit `POST /repos` with the pasted `gitSource` and `forge='gitee'` without first calling the repository list API

#### Scenario: Listing failure keeps URL import available
- **WHEN** the operator's connected Gitee credential cannot call the repository listing API
- **THEN** the dialog shows a list-unavailable message and keeps the URL import controls usable
- **AND** it does not render the state as an empty repository list

#### Scenario: Credential-bearing URL is rejected in the browser
- **WHEN** an operator pastes a URL that includes username/password/token userinfo
- **THEN** the dialog blocks submission and tells the operator to store the token in code-hosting settings instead

#### Scenario: API-unverified forge credential is described honestly
- **WHEN** settings or import UI shows a connected forge credential whose API access is unverified
- **THEN** the UI indicates that clone/push may work but repository listing and PR/MR creation may require broader API permissions
