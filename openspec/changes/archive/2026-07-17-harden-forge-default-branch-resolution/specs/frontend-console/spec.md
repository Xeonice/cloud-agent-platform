## ADDED Requirements

### Requirement: Console refreshes verified repository default branches

The repositories Console SHALL offer a refresh action for every imported
GitHub, Gitee, or GitLab repository instead of rendering the already-imported
state as permanently disabled. The action SHALL call the authenticated
Console/Internal default-branch refresh endpoint without sending a branch
value. On success it SHALL display the returned verified branch and invalidate
repository reads plus both task-create surfaces. On failure it SHALL retain and
display the prior verified branch and map the stable import error to safe
operator guidance without parsing Git output or guessing `main` or `master`.

#### Scenario: Refresh updates task-create defaults

- **WHEN** an operator refreshes an imported repository after remote symbolic HEAD changes to `trunk`
- **THEN** the repository UI and both task-create entry points use the returned `trunk` value
- **AND** the browser does not submit or fabricate another branch

#### Scenario: Failed refresh preserves visible verified state

- **WHEN** refresh fails with authentication, access, network, ref, or platform dependency error
- **THEN** the Console renders code-based safe guidance and keeps the previous verified branch visible
- **AND** it does not optimistically overwrite repository data

#### Scenario: Already imported candidate is refreshable without duplication

- **WHEN** a GitHub, Gitee, or GitLab picker candidate reconciles to an existing Repo
- **THEN** the Console offers branch refresh for that Repo rather than a second import
- **AND** successful refresh retains the same platform Repo id

## MODIFIED Requirements

### Requirement: Console task creation uses verified branches and durable acceptance

Both Console create-task entry points SHALL use the shared task mutation and
SHALL preselect only a persisted verified repository default branch. When no
real branch is known for a legacy repo, the form SHALL omit the branch and let
the authenticated backend resolution path decide; it SHALL NOT fabricate
`main` or `master`. After the create response returns a committed task id, the
modal/page SHALL stop its creating state, navigate to `/tasks/$taskId`,
invalidate task queries, and observe provisioning through canonical polling/SSE.
The creating spinner SHALL NOT remain coupled to sandbox creation or clone
duration.

The task page SHALL render secret-free provisioning stages and actionable
capacity, timeout, forge-authentication, network/TLS, missing-branch/ref, and
platform-dependency failures from the canonical Task response. A
`provisioning_platform_dependency_unavailable` failure SHALL direct the
operator to repair or upgrade the deployment and SHALL NOT suggest reconnecting
the forge or retrying a TLS connection. The Console SHALL not parse raw server
logs or Git output to infer a cause. URL import and refresh SHALL display the
owner-aware typed failure and SHALL not add or overwrite a repository after
failed verification.
Schedule latest-run and run-history surfaces SHALL apply the same
deployment-repair presentation when their canonical nested `taskFailure`
contains this code; they SHALL NOT silently omit it merely because existing
credential-only badges do not recognize the action.

#### Scenario: Create navigates while clone is still running

- **WHEN** the create mutation receives the committed task response while workspace transfer remains active
- **THEN** the Console closes or unmounts the create UI and navigates immediately to `/tasks/$taskId`
- **AND** the task page renders the current provisioning stage from polling/SSE

#### Scenario: Master is preselected from repository data

- **WHEN** the selected repository's verified `defaultBranch` is `master`
- **THEN** both create entry points preselect `master`
- **AND** no code path replaces it with `main`

#### Scenario: GitHub trunk is not replaced by a conventional default

- **WHEN** the selected GitHub repository's verified `defaultBranch` is `trunk`
- **THEN** both create entry points preselect and submit `trunk`
- **AND** neither `main` nor `master` is fabricated

#### Scenario: Unknown legacy branch is not fabricated

- **WHEN** a legacy repository has a null default branch
- **THEN** the Console submits no invented branch value
- **AND** it renders the backend's resolved branch or structured resolution failure after durable acceptance

#### Scenario: Provisioning failure is actionable

- **WHEN** a task fails workspace transfer because its sandbox disk is exhausted
- **THEN** the task page renders the capacity-specific safe message/action
- **AND** the create modal is no longer shown as indefinitely creating

#### Scenario: Platform dependency failure points to deployment repair

- **WHEN** a task exposes `provisioning_platform_dependency_unavailable`
- **THEN** the task page renders deployment-repair guidance from the canonical failure code
- **AND** it does not label the failure as forge authentication, network, or TLS

#### Scenario: Schedule run shows the same platform dependency action

- **WHEN** a schedule latest run or history item nests `provisioning_platform_dependency_unavailable`
- **THEN** the schedule surface renders the same deployment-repair guidance as the task page
- **AND** it does not hide the failure behind a credential-only badge or generic dispatch status
