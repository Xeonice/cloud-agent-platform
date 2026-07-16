## ADDED Requirements

### Requirement: Console task creation uses verified branches and durable acceptance

Both Console create-task entry points SHALL use the shared task mutation and
SHALL preselect only a persisted verified repository default branch. When no
real branch is known for a legacy repo, the form SHALL omit the branch and let
the authenticated backend resolution path decide; it SHALL NOT fabricate
`main`. After the create response returns a committed task id, the modal/page
SHALL stop its creating state, navigate to `/tasks/$taskId`, invalidate task
queries, and observe provisioning through canonical polling/SSE. The creating
spinner SHALL NOT remain coupled to sandbox creation or clone duration.

The task page SHALL render secret-free provisioning stages and actionable
capacity, timeout, forge-authentication, network/TLS, and missing-branch/ref
failures from the canonical Task response. It SHALL not parse raw server logs or
git output to infer a cause. URL import SHALL display the owner-aware access or
default-branch probe failure and SHALL not add an unresolved repository to the
picker.

#### Scenario: Create navigates while clone is still running

- **WHEN** the create mutation receives the committed task response while workspace transfer remains active
- **THEN** the Console closes/unmounts the create UI and navigates immediately to `/tasks/$taskId`
- **AND** the task page renders the current provisioning stage from polling/SSE

#### Scenario: Master is preselected from repository data

- **WHEN** the selected repository's verified `defaultBranch` is `master`
- **THEN** both create entry points preselect `master`
- **AND** no code path replaces it with `main`

#### Scenario: Unknown legacy branch is not fabricated

- **WHEN** a legacy repository has a null default branch
- **THEN** the Console submits no invented branch value
- **AND** it renders the backend's resolved branch or structured resolution failure after durable acceptance

#### Scenario: Provisioning failure is actionable

- **WHEN** a task fails workspace transfer because its sandbox disk is exhausted
- **THEN** the task page renders the capacity-specific safe message/action
- **AND** the create modal is no longer shown as indefinitely creating
