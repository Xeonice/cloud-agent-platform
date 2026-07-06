## ADDED Requirements

### Requirement: Settings manages sandbox runtime environments

The console settings area SHALL expose an admin-only `运行环境` management section.
It SHALL list sandbox environments with name, provider family/source kind,
runtime compatibility, readiness status, default marker, and last validation
time. Admins SHALL be able to create/import an environment source, run
validation, inspect validation errors, and choose the default environment.

#### Scenario: Admin sees environment list

- **WHEN** an admin opens settings
- **THEN** the `运行环境` section lists configured environments with readiness and
  compatibility information
- **AND** validation details are available without crowding the main list

#### Scenario: Non-admin cannot edit environments

- **WHEN** a non-admin operator opens settings
- **THEN** environment management actions are absent or disabled
- **AND** direct API attempts to mutate environments are rejected by the backend

#### Scenario: Validation failure is visible

- **WHEN** an environment validation fails
- **THEN** the settings detail view shows the latest failure reason and probe
  summary
- **AND** the environment is shown as not selectable for new tasks

### Requirement: Create-task surfaces ready environment selection

The create-task dialog and full create-task page SHALL provide a compact
`运行环境` selector. The selector SHALL be filtered by the selected agent runtime
and SHALL only allow ready compatible environments. It SHALL include a default
choice when the task will use the managed or deployment default.

#### Scenario: Selector filters by runtime

- **WHEN** the operator switches the task runtime from Codex to Claude Code
- **THEN** the environment selector updates to show only ready environments
  compatible with `claude-code`
- **AND** incompatible environments are not selectable

#### Scenario: Selected environment is submitted

- **WHEN** the operator selects a ready environment and submits a task
- **THEN** the create request body carries that environment's
  `sandboxEnvironmentId`
- **AND** the command preview or task summary reflects the selected environment
  without exposing provider secrets

#### Scenario: No ready custom environment still allows default

- **WHEN** no ready managed environment exists for the selected runtime
- **THEN** the selector offers the default deployment environment path when the
  backend reports it usable
- **AND** the operator can still create a task with existing default behavior
