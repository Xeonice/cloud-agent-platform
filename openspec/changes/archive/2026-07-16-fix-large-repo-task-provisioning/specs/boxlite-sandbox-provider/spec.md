## ADDED Requirements

### Requirement: BoxLite enforces resolved disk capacity and a separate Git deadline

For native BoxLite provisioning, the provider SHALL send the resolved sandbox
disk size as `disk_size_gb` on sandbox creation and SHALL use that same resolved
value for environment-validation probes and task sandboxes. The value SHALL
come from the immutable managed-environment resource snapshot or the validated
BoxLite deployment fallback, and invalid or unsupported values SHALL make
BoxLite ineligible before task admission consumes a long-running slot.

BoxLite repository materialization SHALL use a validated Git-specific deadline
separate from its native REST control-plane timeout. A successful repository
transfer that exceeds the control-plane timeout but remains within the Git
deadline SHALL not be aborted, while an operation exceeding the Git deadline
SHALL return a typed materialization timeout and clean up its sandbox-owned
temporary state.

#### Scenario: Native create receives the resolved disk size

- **WHEN** BoxLite provisions a validation probe or task whose resolved resource snapshot contains a disk size
- **THEN** the native create body contains the same `disk_size_gb` value
- **AND** the created sandbox reports a root filesystem consistent with the requested capacity before workspace materialization starts

#### Scenario: Deployment fallback supports legacy environments

- **WHEN** a legacy BoxLite environment has no explicit disk resource
- **THEN** provisioning uses the validated BoxLite deployment fallback and snapshots it on the run
- **AND** it does not fall back to an unobserved BoxLite SDK default

#### Scenario: Clone can outlive short REST requests

- **WHEN** a repository transfer takes longer than the BoxLite control-plane timeout and less than the Git materialization deadline
- **THEN** the transfer is allowed to complete
- **AND** short native REST requests continue to use the control-plane timeout

### Requirement: BoxLite Git credentials are ephemeral and exact-host scoped

The BoxLite provider SHALL materialize an owner-scoped forge header through the
provider secret-write primitive into a mode-0600 temporary Git configuration
whose URL subsection matches only the normalized repository scheme and host.
Git clone, submodule, and push command strings SHALL contain only the temporary
config path. A submodule on a different host SHALL NOT receive the parent
repository header. The provider SHALL remove the temporary config in a `finally`
path and SHALL verify its absence before retaining a sandbox.

#### Scenario: Clone command contains no header value

- **WHEN** BoxLite clones a private repository
- **THEN** the BoxLite execution command/request contains only a temporary config path and no authorization header or token
- **AND** ordinary provider logs and errors do not include secret content

#### Scenario: Cross-host submodule does not inherit the parent token

- **WHEN** a private parent repository contains a submodule on a different host
- **THEN** the exact-host Git configuration sends the parent credential only to the parent host
- **AND** the different-host submodule succeeds with its own resolved credential or fails without receiving the parent token

#### Scenario: Retention proves secret cleanup

- **WHEN** clone, checkout, push, timeout, cancellation, or failure finishes and the BoxLite sandbox is retained
- **THEN** the temporary Git credential file is absent
- **AND** a repeated cleanup remains safe
