## ADDED Requirements

### Requirement: Proposal records a machine-readable public-surface decision

The deep-propose flow SHALL write `surface-impact.json` inside the change
directory and validate it before reporting the change ready for implementation.
For Public V1, MCP, OpenAPI, API Playground, and internal-only behavior, the
sidecar SHALL declare a status, affected operation/tool ids or an explicit
registry-wide scope, and a non-empty reason. Every Public V1 change SHALL either
declare the corresponding MCP change/mapping or a reasoned MCP exclusion; every
MCP-only change SHALL likewise declare why no Public V1 counterpart applies.
Protocol projections and exclusions SHALL be listed by stable operation id.

#### Scenario: Public V1 changes without an MCP decision

- **WHEN** a proposed change marks Public V1 changed but omits both an MCP change
  and a reasoned exclusion for the affected capability
- **THEN** the sidecar validator exits non-zero
- **AND** the propose flow does not report the change ready for implementation

#### Scenario: An internal-only feature is deliberate

- **WHEN** a feature is intentionally limited to an internal console or runtime
  surface
- **THEN** the sidecar may mark Public V1 and MCP not applicable
- **AND** each status includes a concrete non-empty reason

#### Scenario: The OpenSpec backbone remains unchanged

- **WHEN** the sidecar is generated and validated
- **THEN** it exists only inside the change directory
- **AND** no OpenSpec CLI file, `spec-driven` schema, or artifact dependency edge
  is added or modified

#### Scenario: Existing active changes migrate when touched

- **WHEN** an older active change has no sidecar and is neither modified nor
  selected for apply
- **THEN** repository validation does not require a bulk historical backfill
- **AND** once that change is modified or selected for apply, its preflight
  requires a valid sidecar

### Requirement: Generated public-surface tasks carry verification metadata

Every generated task SHALL identify the requirement ids it implements, the
surfaces it can affect, and one verifier id from a repository-owned allowlist.
The metadata SHALL be adjacent to the task checkbox and machine-readable. Raw
shell text embedded in Markdown MUST NOT be executed as a verifier. Registry,
REST, and MCP work for one semantic capability SHALL be placed in one track or
linked by explicit track dependencies.

#### Scenario: A generated task lacks metadata

- **WHEN** a task omits requirements, surfaces, or an allowlisted verifier id
- **THEN** task-metadata validation exits non-zero and the proposal is not ready
  for apply

#### Scenario: Coupled surface tasks are not independent

- **WHEN** separate tasks update the registry and its REST/MCP bindings for the
  same semantic capability
- **THEN** their Track metadata places them together or declares an ordering
  dependency that prevents uncoordinated parallel completion
