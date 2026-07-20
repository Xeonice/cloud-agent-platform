# repo-and-task-management

## MODIFIED Requirements

### Requirement: Operator can stop a running or queued task
The system SHALL expose an authenticated endpoint `POST /tasks/:taskId/stop` that lets an operator deliberately stop an active task. Stopping a task in `queued`, `running`, or `awaiting_input` SHALL transition it to the terminal `cancelled` state and run the standard terminal-teardown path: invoke `SandboxProvider.teardownSandbox()` (a no-op when no sandbox was provisioned, e.g. a queued task), tear down session-scoped credentials, and release its concurrency slot (admitting the next queued task). Stopping a task whose admission is parked behind a detached workspace job SHALL also be reachable: the stop path SHALL kill the detached job through its pid marker and then run the same fence/teardown chain, and once the stop has won, a late job exit marker or a resumed claim SHALL NOT resurrect the task or its sandbox ownership. The endpoint is the deliberate, operator-driven mechanism that replaces automatic idle reclamation as the routine way to free a slot from a finished or unwanted session; it SHALL be subject to the same authentication/authorization guard as the other task routes. Stopping a task already in a terminal state SHALL be a safe no-op (idempotent) rather than an error that corrupts state.

#### Scenario: Stopping a running task cancels it and frees its slot
- **WHEN** an operator POSTs to `/tasks/:taskId/stop` for a `running` task
- **THEN** the task transitions to `cancelled`, its sandbox and session credentials are torn down, and its concurrency slot is released so the next queued task can be admitted

#### Scenario: Stopping a queued task cancels it without a sandbox teardown error
- **WHEN** an operator stops a task still `queued` (no sandbox provisioned)
- **THEN** the task transitions to `cancelled` and the teardown path completes without error (sandbox teardown is a no-op for a task that never provisioned)

#### Scenario: Stopping a parked task kills the detached clone
- **WHEN** an operator stops a task whose admission is parked behind a detached workspace transfer (no active claim run exists)
- **THEN** the stop path kills the detached job via its pid marker, the task transitions to `cancelled`, and the standard fence/teardown chain runs
- **AND** the stop does not error out for lack of an in-process claim run

#### Scenario: Late clone exit cannot resurrect a stopped task
- **WHEN** the detached job writes an exit marker, or a parked resume fires, after the stop has already settled the task as `cancelled`
- **THEN** the task stays `cancelled` and no new admission, sandbox ownership, or agent launch results

#### Scenario: Stopping a terminal task is a safe no-op
- **WHEN** an operator stops a task already in `completed`/`failed`/`cancelled`/`agent_failed_to_start`
- **THEN** the request does not corrupt the task state and does not double-release a slot

#### Scenario: Stop endpoint is authenticated
- **WHEN** an unauthenticated or de-allowlisted caller hits `POST /tasks/:taskId/stop`
- **THEN** the request is rejected by the same auth guard that protects the other task routes before any state change occurs

### Requirement: Task reads expose safe provisioning progress and failure causes

Canonical Task responses SHALL include an OPTIONAL nullable, secret-free
provisioning summary for legacy compatibility. The summary SHALL expose only a
stable state/stage, attempt count, resolved branch when known, update time, and
an OPTIONAL nullable transfer-progress object containing only numeric fields
(percent, receivedObjects, totalObjects, receivedBytes, throughput). Progress
that is not yet known (clone phases before object transfer) SHALL be modeled
explicitly as unknown/absent rather than 0. The summary
SHALL NOT expose lease owners, provider endpoints, native sandbox ids,
connection metadata, raw git output, commands, or credentials. The structured
task failure union SHALL include stable provisioning variants that distinguish
capacity exhaustion, workspace timeout, forge authentication, TLS/network,
missing branch/ref, platform dependency unavailability, and an unknown fallback
with an actionable safe message/action. A platform dependency failure SHALL use
`provisioning_platform_dependency_unavailable` with action
`repair_deployment`, SHALL be non-retryable by admission, and SHALL NOT be
presented as a remote network or TLS failure.

#### Scenario: Active transfer is distinguishable from a stuck create

- **WHEN** an accepted task is actively transferring its repository
- **THEN** task create/list/get/stop response paths expose the workspace-transfer provisioning stage
- **AND** no internal lease or secret detail is present

#### Scenario: Active transfer reports numeric progress

- **WHEN** a task's detached clone is receiving objects with a parsed percentage
- **THEN** the provisioning summary's progress object reports that percent with the parsed object/byte counts on task read
- **AND** the progress object contains only numeric fields with no free text, URLs, or raw git output

#### Scenario: Unknown progress is not reported as zero

- **WHEN** the clone is in a phase before object-transfer counts exist
- **THEN** the summary either omits/nulls the progress object or reports its percent as explicitly unknown
- **AND** a consumer can distinguish this from an actual 0% transfer

#### Scenario: Capacity exhaustion is actionable

- **WHEN** workspace transfer fails because the sandbox filesystem is full
- **THEN** the task reaches a terminal failure with a capacity-specific structured failure and safe operator action
- **AND** it is not reported as a forge-authentication error or a generic null failure

#### Scenario: Missing Git is a platform dependency failure

- **WHEN** the control-plane remote-ref command cannot start because the Git executable is unavailable
- **THEN** the task failure code is `provisioning_platform_dependency_unavailable` with `repair_deployment` guidance
- **AND** admission does not retry it or label it as authentication, network, TLS, or missing ref

#### Scenario: Legacy task response remains valid

- **WHEN** a task created before provisioning summaries existed is read
- **THEN** its response validates with a null/absent provisioning summary
- **AND** existing non-provisioning failure variants remain unchanged

#### Scenario: Upgrade migration admits the platform dependency code without rewriting old rows

- **WHEN** the additive Prisma migration runs against Task and admission-work rows satisfying the previous failure-code CHECK constraints
- **THEN** every existing failure value remains unchanged and valid
- **AND** both `tasks.failure_code` and failed `task_admission_work.cause_code` can persist `provisioning_platform_dependency_unavailable`

## ADDED Requirements

### Requirement: Admission settlement supports a parked state

The task-admission settlement union and the admission claim query SHALL gain a
`parked` settlement as a distinct swimlane alongside the existing
succeeded/queued/retrying/failed/cancelled vocabulary. Parked work SHALL be
persisted durably on the admission-work row (including the progress snapshot
needed for reads) with no destructive down-migration. Unlike `queued`, a
`parked` settlement SHALL NOT burn or reset the attempt counter, and parked
work SHALL become claimable again only when its detached job settles (or its
liveness gates fail) — the claim query SHALL NOT hand parked work to a worker
while the job is proven alive and within its gates.

#### Scenario: Parked is a distinct durable settlement

- **WHEN** a worker settles a claim as parked during a detached transfer
- **THEN** the admission-work row durably records the parked state and survives an API restart
- **AND** the row's attempt counter is unchanged by the parked settlement

#### Scenario: Parked work is not re-claimed while the job is alive

- **WHEN** the claim query runs while a task's detached job is proven alive and within its liveness gates
- **THEN** the parked row is not handed to another worker
- **AND** the row becomes claimable once the job exits or a liveness gate fails

#### Scenario: Migration is additive

- **WHEN** the migration adding the parked state and progress snapshot runs against existing admission-work rows
- **THEN** all existing rows and their settlement values remain valid unchanged
- **AND** no destructive down-migration is required
