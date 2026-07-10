## MODIFIED Requirements

### Requirement: Environment validation gates task selection

The system SHALL validate sandbox environments before they can be selected by a task. Validation SHALL record status, checked timestamp, provider family, runtime compatibility, resolved image digest when available, probe output summary, builder-declared sandbox metadata, and failure reason. Validation SHALL start a probe sandbox and require valid `/etc/cap/sandbox-metadata.json` before marking a newly built image ready. Only environments with a ready status, valid metadata, and compatible runtime/provider family SHALL be selectable.

#### Scenario: Successful validation makes environment selectable

- **WHEN** validation proves the provider host can pull or resolve the image, start a sandbox, read valid builder-declared metadata, and pass the required runtime/tool probes
- **THEN** the environment status becomes ready
- **AND** the parsed sandbox version and dependency map are retained with the validation
- **AND** compatible task creation surfaces can select it

#### Scenario: Failed validation blocks selection

- **WHEN** validation fails because the image is missing, unreachable, unauthorized, architecture-incompatible, lacks required runtime tools, or has missing or invalid sandbox metadata
- **THEN** the environment status becomes failed
- **AND** task creation rejects that environment before sandbox provisioning

#### Scenario: Stale validation blocks new tasks

- **WHEN** an environment is marked stale because the CAP sandbox or sandbox-metadata contract changed
- **THEN** new task creation cannot select it until validation passes again
- **AND** already-running tasks that used the prior validation are not stopped by this state change

#### Scenario: Validation retains only declared dependencies

- **WHEN** a custom image metadata file declares two dependencies while the image contains additional undeclared packages
- **THEN** validation retains and exposes only the two declared dependency versions
- **AND** CAP does not scan the image for additional packages
