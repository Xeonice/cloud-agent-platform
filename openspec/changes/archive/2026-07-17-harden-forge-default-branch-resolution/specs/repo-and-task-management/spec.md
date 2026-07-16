## MODIFIED Requirements

### Requirement: Repository and task branches resolve without fabricated defaults

Every forge import and explicit default-branch refresh SHALL persist only a
verified repository default branch, and repo list/get responses SHALL return
that value through the existing nullable `defaultBranch` field. `Task.branch`
SHALL continue to persist and echo only the caller's explicit branch intent;
omission SHALL remain null. Before workspace transfer, a new branch decision
SHALL resolve in order: explicit task branch, persisted repo default branch,
then an owner-authenticated remote symbolic-HEAD probe for a legacy null repo.
Recovery and delivery SHALL prefer an existing immutable admission snapshot. If
no branch resolves, task provisioning SHALL fail with a structured cause and
SHALL NOT invent either `main` or `master`. The one resolved snapshot SHALL be
used for workspace checkout, recovery, and pull/merge-request base selection.

#### Scenario: Omitted task branch uses persisted master without rewriting intent

- **WHEN** a task omits `branch` for a repository whose persisted default is `master`
- **THEN** `Task.branch` reads back as null while the provisioning snapshot resolves `master`
- **AND** workspace checkout uses `master`, not an invented `main`

#### Scenario: GitHub trunk is preserved across every consumer

- **WHEN** a GitHub repository has verified `defaultBranch = trunk` and a task omits `branch`
- **THEN** provisioning, recovery, and PR delivery all consume the same `trunk` snapshot
- **AND** no consumer independently replaces it with `main` or `master`

#### Scenario: Explicit branch has precedence

- **WHEN** a task explicitly requests a valid branch different from the repo default
- **THEN** the explicit value is persisted as task intent and used for checkout
- **AND** recovery reuses the same resolved snapshot

#### Scenario: Legacy null branch is resolved with the task owner

- **WHEN** a legacy Repo has a null default branch and its task owner can resolve remote symbolic HEAD
- **THEN** provisioning snapshots that resolved branch and may safely backfill the Repo
- **AND** no credential from another owner is consulted

#### Scenario: Repository refresh does not rewrite an accepted task

- **WHEN** an accepted task has snapshotted `develop` and the repository default is later refreshed to `trunk`
- **THEN** that task continues to use `develop` for recovery and delivery
- **AND** a later unsnapshotted task may resolve the refreshed `trunk` value

### Requirement: Task reads expose safe provisioning progress and failure causes

Canonical Task responses SHALL include an OPTIONAL nullable, secret-free
provisioning summary for legacy compatibility. The summary SHALL expose only a
stable state/stage, attempt count, resolved branch when known, and update time;
it SHALL NOT expose lease owners, provider endpoints, native sandbox ids,
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
