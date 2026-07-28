## MODIFIED Requirements

### Requirement: Helper-only sandbox packages are not runtime extension packages

Sandbox helper logic SHALL be located inside the owning package unless it represents a stable external extension boundary. Scheduler, lifecycle, workspace-git, AIO-local configuration, and conformance helpers SHALL NOT remain runtime packages solely to hold internal helper code.

A package whose code has been superseded SHALL be REMOVED from the repository,
not merely excluded from the workspace graph. Excluding it stops the build from
seeing it but leaves it visible to every reader, grep and search — code that
cannot run while still reading as live, which costs review attention and
misdirects work onto files that no build would ever compile.

#### Scenario: Internal helpers move under owning packages
- **WHEN** the sandbox package graph is inspected after the refactor
- **THEN** scheduler, lifecycle, and workspace helper code is under `@cap/sandbox`
- **AND** AIO local configuration/spec helper code is under `@cap/sandbox-provider-aio`
- **AND** conformance helpers are dev-only testkit or test code rather than runtime dependencies

#### Scenario: A superseded package leaves no directory behind
- **WHEN** a helper package's code has moved to its owning package
- **THEN** the superseded package directory no longer exists
- **AND** no workspace exclusion entry remains for it
- **AND** documentation does not describe it as a package that exists
