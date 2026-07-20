# boxlite-sandbox-provider

## MODIFIED Requirements

### Requirement: BoxLite enforces resolved disk capacity and a separate Git deadline

For native BoxLite provisioning, the provider SHALL send the resolved sandbox
disk size as `disk_size_gb` on sandbox creation and SHALL use that same resolved
value for environment-validation probes and task sandboxes. The value SHALL
come from the immutable managed-environment resource snapshot or the validated
BoxLite deployment fallback, and invalid or unsupported values SHALL make
BoxLite ineligible before task admission consumes a long-running slot.

BoxLite repository materialization SHALL execute the workspace transfer stage
as a detached supervised job polled through short control-plane execs rather
than one blocking exec held open for the whole transfer. Each poll SHALL use
the native REST control-plane timeout; transfer liveness SHALL be governed by
the dual-gate policy (no-progress heartbeat plus absolute cap) rather than a
single Git wall-clock deadline. A dropped or timed-out poll response SHALL NOT
force whole-sandbox fencing: the job's pid and exit markers provide settlement
proof, and a subsequent probe SHALL settle the stage from them. A transfer
failing either liveness gate SHALL return a typed materialization timeout and
clean up its sandbox-owned temporary state. AIO stage execution SHALL inherit
the identical detached path through the shared workspace-materialization hook.

#### Scenario: Native create receives the resolved disk size

- **WHEN** BoxLite provisions a validation probe or task whose resolved resource snapshot contains a disk size
- **THEN** the native create body contains the same `disk_size_gb` value
- **AND** the created sandbox reports a root filesystem consistent with the requested capacity before workspace materialization starts

#### Scenario: Deployment fallback supports legacy environments

- **WHEN** a legacy BoxLite environment has no explicit disk resource
- **THEN** provisioning uses the validated BoxLite deployment fallback and snapshots it on the run
- **AND** it does not fall back to an unobserved BoxLite SDK default

#### Scenario: Transfer outlives every individual poll exec

- **WHEN** a repository transfer takes longer than the BoxLite control-plane timeout while its progress stream keeps advancing
- **THEN** the transfer completes via repeated short polling execs
- **AND** no single exec request is held open for the transfer's full duration

#### Scenario: Dropped poll does not fence the sandbox

- **WHEN** one polling exec's HTTP response is dropped mid-transfer
- **THEN** the provider does not force-remove the sandbox
- **AND** the next marker probe settles the stage from the pid/exit markers (continue polling if alive, settle from the exit code if exited)

#### Scenario: Liveness-gate timeout stays typed

- **WHEN** a BoxLite transfer fails the no-progress heartbeat gate or the absolute cap
- **THEN** materialization returns the typed timeout result for the transfer stage
- **AND** sandbox-owned temporary state (including credential files) is cleaned up
