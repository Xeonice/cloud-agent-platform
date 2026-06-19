## ADDED Requirements

### Requirement: CI boots the built application and probes liveness

The CI pipeline SHALL include a check that starts the BUILT application (with its required runtime dependencies, e.g. a throwaway database) and probes the `/health` liveness endpoint, failing the pipeline when the application cannot reach a healthy boot. This guards the cross-provider dependency-injection / bootstrap failure class — a previous DI-ordering defect reached production and caused a multi-hour outage that neither the build nor the unit tests detected. This check SHALL be a required status check for merging, and SHALL be in place before any new application module is introduced.

#### Scenario: A boot/DI failure fails CI

- **WHEN** a change introduces a dependency-injection or bootstrap error that prevents the application from starting
- **THEN** the CI boot-smoke check starts the built app, fails to get a healthy `/health` response, and fails the pipeline — blocking the merge

#### Scenario: A healthy build passes the boot-smoke check

- **WHEN** the built application boots cleanly and serves `/health`
- **THEN** the boot-smoke check reports success
