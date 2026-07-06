## ADDED Requirements

### Requirement: /v1 task creation accepts sandbox environment selection

The public `/v1` task create surface SHALL accept the same optional
`sandboxEnvironmentId` selection as the console create path. `/v1` task creation
SHALL delegate to the same task admission and environment validation path, so
console and external clients receive the same ready/compatible/fail-closed
behavior.

#### Scenario: /v1 create uses selected environment

- **WHEN** a scoped client calls `POST /v1/tasks` with a ready compatible
  `sandboxEnvironmentId`
- **THEN** the created task uses that selected sandbox environment
- **AND** the response includes the environment selection according to the task
  response schema

#### Scenario: /v1 invalid environment is rejected

- **WHEN** a scoped client calls `POST /v1/tasks` with an unknown, failed, stale,
  or incompatible `sandboxEnvironmentId`
- **THEN** the request is rejected before sandbox provisioning
- **AND** no task-specific provider fallback is attempted

#### Scenario: OpenAPI documents environment selection

- **WHEN** a client fetches `GET /v1/openapi.json`
- **THEN** the task create schema documents the optional `sandboxEnvironmentId`
  field and the task response schema documents the public environment summary
