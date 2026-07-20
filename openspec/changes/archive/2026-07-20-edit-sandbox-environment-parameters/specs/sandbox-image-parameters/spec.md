# sandbox-image-parameters Delta

## ADDED Requirements

### Requirement: Image parameters are editable after registration

The system SHALL allow admins to replace the image parameter set of an existing sandbox environment through a dedicated admin-gated operation. The operation SHALL accept the full desired parameter set, where each entry either provides a value (plain or secret) or references an existing secret parameter by name to keep its stored value. The operation SHALL reject duplicate parameter names and SHALL reject keep-references to names that are not currently stored as secret parameters. The same admin gate used for image management SHALL protect the operation.

#### Scenario: Admin replaces the parameter set

- **WHEN** an admin submits an edited parameter set for a registered environment containing a new secret value for one name and changed plain values for others
- **THEN** the stored plain and secret parameter records reflect exactly the submitted set
- **AND** subsequent environment reads list the new parameter names with secret entries redacted

#### Scenario: Keep-reference retains a secret without resubmitting plaintext

- **WHEN** an admin submits an edited set that keeps an existing secret parameter by name without providing a value
- **THEN** the stored ciphertext for that secret parameter is retained unchanged
- **AND** the operation completes without the client ever receiving or resending the secret plaintext

#### Scenario: Keep-reference to an unknown secret is rejected

- **WHEN** an edited set keeps a name that is not currently stored as a secret parameter
- **THEN** the request is rejected as a client error identifying the unknown parameter name
- **AND** no parameter state changes

#### Scenario: Non-admin cannot edit parameters

- **WHEN** a non-admin attempts the parameter edit operation
- **THEN** the request is rejected by the same admin gate used for image management
- **AND** no parameter state changes

### Requirement: Parameter edits are decoupled from validation state

Editing image parameters SHALL NOT change the environment's status, validation records, contract version, or default flag, and SHALL NOT require re-validation. The edit operation SHALL be permitted regardless of the environment's current validation status, except for retired environments.

#### Scenario: Editing a ready environment leaves validation state untouched

- **WHEN** an admin edits parameters on a ready environment
- **THEN** the environment remains ready with its existing validation records, contract version, and default flag
- **AND** no new validation record is created

#### Scenario: Editing a failed environment is permitted

- **WHEN** an admin edits parameters on an environment whose latest validation failed
- **THEN** the parameter set is updated
- **AND** the environment's status is unchanged by the edit

### Requirement: Edited parameters take effect at next task provisioning

Tasks provisioned after a parameter edit SHALL materialize the edited parameter set. Sandboxes provisioned before the edit SHALL be unaffected by it.

#### Scenario: New task receives edited values

- **WHEN** an admin edits a secret parameter value and a task using that environment is provisioned afterwards
- **THEN** the task's materialized image parameter env file contains the new value

#### Scenario: Running sandbox is unaffected by an edit

- **WHEN** a parameter edit occurs while a task's sandbox is already provisioned and running
- **THEN** that sandbox's materialized parameters are not modified by the edit

### Requirement: Image Management console exposes parameter editing

The web console's Image Management surface SHALL provide an edit affordance on registered environments that prefills the current parameter set from the redacted read model: plain parameters with their values, secret parameters name-only. Secret rows left untouched SHALL be submitted as keep-references; secret plaintext SHALL never be rendered.

#### Scenario: Edit dialog prefills redacted parameters

- **WHEN** an admin opens the parameter edit dialog for an environment with plain and secret parameters
- **THEN** plain parameters are shown with editable values
- **AND** secret parameters are shown by name in a kept-value state without any value rendered

#### Scenario: Untouched secret rows submit as keep-references

- **WHEN** an admin edits only a plain parameter and submits the dialog
- **THEN** the request keeps every untouched secret parameter by name
- **AND** the stored secret ciphertexts are retained unchanged
