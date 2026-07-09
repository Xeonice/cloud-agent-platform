## ADDED Requirements

### Requirement: Custom image parameters are managed on sandbox environments

The system SHALL allow admins to configure runtime parameters on sandbox environment/image records. Parameters SHALL be scoped to the image/environment record and SHALL be injected into tasks that use that environment. The system SHALL support both plain parameters and secret parameters.

#### Scenario: Admin registers an image with plain and secret parameters

- **WHEN** an admin registers a sandbox environment with image parameters
- **THEN** plain parameters are stored as readable key/value pairs
- **AND** secret parameters are stored encrypted at rest
- **AND** the environment read response returns secret parameter names without secret values

#### Scenario: Non-admin cannot configure image parameters

- **WHEN** a non-admin attempts to register or modify image parameters
- **THEN** the request is rejected by the same admin gate used for image management
- **AND** no parameter state changes

### Requirement: Selected image parameters are materialized inside task sandboxes

The system SHALL materialize parameters for the selected/default sandbox environment used by a task. Materialization SHALL run after workspace materialization and before agent runtime setup/launch. Missing parameters SHALL NOT block task provisioning.

#### Scenario: Task receives selected image parameters

- **WHEN** a task uses a sandbox environment with image parameters
- **THEN** CAP writes those parameters into the standard image parameter env file inside the sandbox before the agent starts
- **AND** tools installed in the image can read the values during the first turn

#### Scenario: Environment without parameters does not write a placeholder secret

- **WHEN** a task uses a sandbox environment with no image parameters
- **THEN** CAP does not write placeholder secrets
- **AND** task provisioning continues normally

### Requirement: Image parameter files use a stable private env-file contract

The system SHALL write materialized image parameters to `/home/gem/.cap/image-env` as shell-safe exports readable by the sandbox task user. Files containing parameters SHALL be mode `0600` or stricter. Tool wrappers MAY source this file and map values to tool-specific configuration.

#### Scenario: gcode wrapper reads the standard env file

- **WHEN** a custom image contains `gcode` and a wrapper that sources `/home/gem/.cap/image-env`
- **AND** the selected image has `GCODE_TOKEN` configured as a secret parameter
- **THEN** `gcode` can receive `GCODE_TOKEN` without the token being baked into the image

### Requirement: Image parameter secrets never appear on read metadata

The system SHALL NOT return secret parameter values on image list/read APIs, validation records, sandbox run metadata, task read responses, audit metadata, or selected-run metadata. Non-secret metadata MAY include parameter names and whether each parameter is secret.

#### Scenario: Read response redacts secret values

- **WHEN** an admin lists sandbox environments
- **THEN** plain parameter values may be shown
- **AND** secret parameter entries include the key and `secret: true` but omit the value

#### Scenario: Run metadata omits parameter values

- **WHEN** a sandbox run owner record or task read response is inspected after parameter materialization
- **THEN** it does not contain image parameter secret values

### Requirement: Materialized image parameters are cleared before retained sandbox stop

The system SHALL remove materialized image parameter files during sandbox teardown before retaining or stopping a sandbox whenever the provider supports cleanup. Cleanup failures SHALL be best-effort and SHALL NOT block task settlement, but SHALL be logged without including secret values.

#### Scenario: Pre-stop cleanup removes image parameter env file

- **WHEN** a task sandbox is being stopped or retained after completion, cancellation, or failure
- **THEN** CAP attempts to remove `/home/gem/.cap/image-env`
- **AND** the cleanup command does not print parameter values
