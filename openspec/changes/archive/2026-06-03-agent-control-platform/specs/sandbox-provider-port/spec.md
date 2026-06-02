## ADDED Requirements

### Requirement: SandboxProvider port exposing sandbox-mode as a capability
The system SHALL define a `SandboxProvider` port abstraction whose interface exposes the execution sandbox mode (one of `read-only`, `workspace-write`, `danger-full-access`) as an explicit capability, so that the concrete OS-isolating implementation can be deferred and later swapped without changing callers.

#### Scenario: Port exposes a sandbox-mode capability
- **WHEN** the `SandboxProvider` port interface is inspected
- **THEN** it exposes the sandbox mode as a capability whose values include `read-only`, `workspace-write`, and `danger-full-access`

#### Scenario: Callers depend on the port, not a concrete impl
- **WHEN** orchestrator and runner code that provisions execution is inspected
- **THEN** it depends on the `SandboxProvider` port interface rather than directly on a specific sandbox implementation

### Requirement: Documented minimal Docker implementation forcing danger-full-access
The first `SandboxProvider` implementation SHALL be the minimal Docker implementation, and it SHALL document that running Codex inside Docker forces `--sandbox danger-full-access` because the inner Codex OS sandbox (bubblewrap/seccomp) collapses inside the container, and that Docker is therefore the platform deploy plane and not the per-task execution sandbox.

#### Scenario: Docker impl reports danger-full-access mode
- **WHEN** the minimal Docker `SandboxProvider` implementation reports its effective sandbox mode
- **THEN** it reports `danger-full-access`

#### Scenario: Trade-off is documented
- **WHEN** the minimal Docker implementation's documentation is inspected
- **THEN** it states that Docker-as-execution forces `danger-full-access` because the inner Codex sandbox collapses inside Docker
- **AND** it states that Docker is the platform deploy plane, not the per-task execution sandbox

### Requirement: Path to restore OS-level isolation is preserved
The `SandboxProvider` port SHALL be defined such that a future implementation can provide OS-level isolation (for example a Claude Code sandbox-runtime) by satisfying the same interface, without requiring changes to the port's consumers.

#### Scenario: A stricter mode is expressible through the same port
- **WHEN** a future implementation is registered that reports a non-`danger-full-access` sandbox mode
- **THEN** existing port consumers use it through the unchanged `SandboxProvider` interface
- **AND** no consumer code requires modification to honor the stricter mode
