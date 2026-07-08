## ADDED Requirements

### Requirement: BoxLite environment validation cleans up actual probe sandboxes

When validating a managed BoxLite image environment, the BoxLite provider SHALL
delete the actual provider sandbox id returned by the create/start flow. If the
provider returns a generated box id that differs from the requested probe name,
cleanup SHALL target the returned id. If creation fails before an id is known,
cleanup MAY best-effort delete the requested probe name, but validation SHALL
NOT report success merely because cleanup failed.

#### Scenario: Generated BoxLite box id is cleaned up

- **WHEN** managed image validation requests a probe sandbox name and BoxLite
  returns a different generated box id
- **THEN** validation uses the returned box id for exec and cleanup
- **AND** the returned box is deleted after validation finishes

#### Scenario: Cleanup failure does not mask validation failure

- **WHEN** BoxLite validation fails and cleanup also fails
- **THEN** the validation result remains failed for the original validation
  reason
- **AND** the cleanup failure is not reported as a successful validation

### Requirement: BoxLite image validation reports registry pull failures clearly

The BoxLite provider SHALL surface non-secret, actionable validation failures
when a managed BoxLite image cannot be pulled or started because of registry
transport, registry authorization, registry reachability, missing image,
architecture mismatch, or provider create/start errors. CAP SHALL NOT store
registry credentials or provider API tokens in validation output.

#### Scenario: HTTP-only registry fails with transport guidance

- **WHEN** BoxLite validation fails because the image reference points at a
  registry that the BoxLite host attempts to pull through unsupported HTTPS or
  otherwise cannot reach
- **THEN** validation fails with a non-secret message that identifies registry
  reachability or transport as the likely cause
- **AND** the environment does not become selectable

#### Scenario: Private registry authorization failure is distinct

- **WHEN** BoxLite validation fails because the BoxLite host lacks permission to
  pull a private image
- **THEN** validation fails with a non-secret message that identifies registry
  authorization as the likely cause
- **AND** CAP does not store the registry credential needed to fix it
