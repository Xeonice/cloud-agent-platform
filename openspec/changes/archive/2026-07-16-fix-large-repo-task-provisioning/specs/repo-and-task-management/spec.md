## ADDED Requirements

### Requirement: Repository and task branches resolve without fabricated defaults

Every forge import SHALL persist a verified repository default branch when one
is available, and repo list/get responses SHALL return that value through the
existing nullable `defaultBranch` field. `Task.branch` SHALL continue to persist
and echo only the caller's explicit branch intent; omission SHALL remain null.
Before workspace transfer, the system SHALL resolve checkout branch in order:
explicit task branch, persisted repo default branch, then an authenticated
remote symbolic-HEAD probe for a legacy null repo. If none resolves, task
provisioning SHALL fail with a structured missing-branch/ref cause and SHALL NOT
invent `main`. The resolved branch SHALL be snapshotted separately for recovery
and delivery.

#### Scenario: Omitted task branch uses persisted master without rewriting intent

- **WHEN** a task omits `branch` for a repository whose persisted default is `master`
- **THEN** `Task.branch` reads back as null while the provisioning snapshot resolves `master`
- **AND** workspace checkout uses `master`, not `main`

#### Scenario: Explicit branch has precedence

- **WHEN** a task explicitly requests a valid branch different from the repo default
- **THEN** the explicit value is persisted as task intent and used for checkout
- **AND** recovery reuses the same resolved snapshot

#### Scenario: Legacy null branch is resolved with the task owner

- **WHEN** a legacy Repo has a null default branch and its task owner can resolve remote symbolic HEAD
- **THEN** provisioning snapshots that resolved branch and may safely backfill the Repo
- **AND** no credential from another owner is consulted

### Requirement: Task creation durably accepts before provisioning

Console REST, Public V1, MCP, and scheduled-task creation SHALL use one canonical
acceptance transaction that persists the prepared Task and a unique durable
admission work item; Public V1 SHALL also persist its idempotency record in that
transaction. After commit, the direct create surfaces SHALL return the canonical
initial Task without awaiting guardrails admission, provider selection, sandbox
creation, workspace materialization, runtime setup, or agent launch. A durable
worker SHALL lease and process admission asynchronously, and process restart or
request disconnect SHALL not lose or duplicate accepted work.

#### Scenario: Slow clone does not delay the create response

- **WHEN** provisioning is paused behind a repository transfer that takes several minutes
- **THEN** Console REST, Public V1, and MCP each return the committed task id and initial status before transfer completes
- **AND** each surface refers to the same canonical task lifecycle rather than starting a second path

#### Scenario: API exits after commit

- **WHEN** the API process exits after committing a Task/admission work item but before locally waking the worker
- **THEN** startup/poll recovery claims and admits that task
- **AND** exactly one task and at most one live provider sandbox result

#### Scenario: Stop wins over pending admission

- **WHEN** an operator cancels an accepted task before or during a leased provisioning attempt
- **THEN** the worker observes the terminal/status fence and does not launch the agent
- **AND** any superseded sandbox is idempotently torn down

### Requirement: Task reads expose safe provisioning progress and failure causes

Canonical Task responses SHALL include an OPTIONAL nullable, secret-free
provisioning summary for legacy compatibility. The summary SHALL expose only a
stable state/stage, attempt count, resolved branch when known, and update time;
it SHALL NOT expose lease owners, provider endpoints, native sandbox ids,
connection metadata, raw git output, commands, or credentials. The existing
structured task failure union SHALL include stable provisioning variants that
distinguish capacity exhaustion, workspace timeout, forge authentication,
TLS/network, missing branch/ref, and an unknown fallback with an actionable safe
message/action.

#### Scenario: Active transfer is distinguishable from a stuck create

- **WHEN** an accepted task is actively transferring its repository
- **THEN** task create/list/get/stop response paths expose the workspace-transfer provisioning stage
- **AND** no internal lease or secret detail is present

#### Scenario: Capacity exhaustion is actionable

- **WHEN** workspace transfer fails because the sandbox filesystem is full
- **THEN** the task reaches a terminal failure with a capacity-specific structured failure and safe operator action
- **AND** it is not reported as a forge-authentication error or a generic null failure

#### Scenario: Legacy task response remains valid

- **WHEN** a task created before provisioning summaries existed is read
- **THEN** its response validates with a null/absent provisioning summary
- **AND** existing non-provisioning failure variants remain unchanged
