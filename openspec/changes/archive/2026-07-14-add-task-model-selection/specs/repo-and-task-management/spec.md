## ADDED Requirements

### Requirement: Tasks durably carry the requested runtime model

The canonical create-task request SHALL accept an optional `model` selector in
addition to `runtime`. Every Console, Public V1, MCP, and scheduled-task create
path SHALL parse the field through the shared task contract, persist its exact
normalized requested value on the Task, and expose it as nullable `model` in
canonical task responses. Omission SHALL persist and return null and SHALL mean
"use the effective runtime default" rather than a server-invented model id.
Create, get, list, stop, schedule provenance, and recovery projections SHALL
not drop or rewrite the value.

#### Scenario: An explicit task model is persisted and returned

- **WHEN** a task is created with a validated explicit model selector
- **THEN** the Task row stores that exact normalized selector
- **AND** create, get, list, and stop responses return it in `model`

#### Scenario: Omitted model remains an explicit default choice

- **WHEN** a task is created without a model selector
- **THEN** the Task row and canonical task response contain `model: null`
- **AND** no guessed account or CLI default is written into the task

#### Scenario: Every create contract carries the same model field

- **WHEN** the task-create field sets for Console, Public V1 excluding `repoId`, MCP `create_task`, and a schedule task template are compared
- **THEN** each surface accepts the same optional `model` definition from the canonical contract
- **AND** transport validation cannot silently strip the field before task admission

#### Scenario: Recovery retains the requested model

- **WHEN** CAP reconstructs a persisted task for admission recovery or schedule startup recovery
- **THEN** the reconstructed launch input contains the Task's persisted model without recataloging or replacing it

### Requirement: Requested and runtime-reported models remain distinct facts

`Task.model` SHALL represent caller intent only. Runtime/session history SHALL
continue to record an independently observed actual model when the CLI reports
one. The system SHALL NOT overwrite the requested model with an alias
resolution, configured default, provider fallback, or runtime-reported value.

#### Scenario: Runtime reports the selected model

- **WHEN** a task requests an alias and session history reports the concrete model used
- **THEN** the task response retains the requested alias while session metadata retains the concrete reported model

#### Scenario: Runtime substitutes a different model

- **WHEN** the runtime-reported actual model differs from the explicit requested selector
- **THEN** CAP preserves both facts and surfaces the mismatch observably
- **AND** it does not silently mutate `Task.model` to make the values appear equal
