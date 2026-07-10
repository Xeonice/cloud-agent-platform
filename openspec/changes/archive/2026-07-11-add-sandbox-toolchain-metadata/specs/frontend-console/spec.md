## ADDED Requirements

### Requirement: Task startup shows the effective sandbox toolchain versions

The console SHALL show the effective sandbox version and every builder-declared dependency version from the task's persisted sandbox metadata snapshot in the task startup/session surface. The console SHALL use friendly labels for the official `codex`, `claude-code`, and `openspec` keys and SHALL render unknown custom dependency keys without requiring a frontend catalog entry. It SHALL NOT infer versions from the CAP release, image tag, current environment validation, or locally configured defaults.

#### Scenario: Official sandbox starts with version details
- **WHEN** an operator opens a task whose official sandbox has completed metadata preflight
- **THEN** the startup/session surface shows the effective sandbox, Codex, Claude Code, and OpenSpec versions
- **AND** those values come from the task's persisted effective snapshot

#### Scenario: Custom dependency is displayed generically
- **WHEN** a task snapshot includes a builder-declared dependency key that the console does not recognize
- **THEN** the startup/session surface displays that key and version without dropping it

#### Scenario: Metadata is not yet available
- **WHEN** the sandbox is still provisioning and no effective metadata snapshot has been persisted
- **THEN** the console retains the existing sandbox-starting state without fabricating version values

#### Scenario: Metadata preflight fails
- **WHEN** sandbox startup fails because required metadata is missing or invalid
- **THEN** the task surface shows the resulting concrete preflight failure
- **AND** it does not display versions from the requested image or environment as though launch succeeded
