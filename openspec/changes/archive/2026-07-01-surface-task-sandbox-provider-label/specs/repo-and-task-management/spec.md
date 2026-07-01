## ADDED Requirements

### Requirement: Task responses expose selected sandbox provider summary
The task REST API SHALL include a nullable `sandboxProvider` summary on every `TaskResponse` read path: create response, list-tasks response, fetch-by-id response, and task transition responses. When a task has a persisted sandbox run owner/selection, `sandboxProvider` SHALL contain only non-secret display data: `{ id: string, label: string }`, derived from the selected or latest persisted sandbox provider id for that task. When no sandbox provider has been selected or recorded for the task, `sandboxProvider` SHALL be `null`. The response MUST NOT expose provider-private routing or connection details such as `providerSandboxId`, `connectionJson`, native terminal URLs, endpoint/base/ws URLs, auth tokens, or provider metadata.

#### Scenario: BoxLite-backed task response carries BoxLite summary
- **WHEN** a task has a persisted sandbox run whose provider id is `boxlite`
- **THEN** the create/list/fetch/transition task response for that task includes `sandboxProvider.id = "boxlite"`
- **AND** `sandboxProvider.label` is the public BoxLite display label
- **AND** the response does not include `providerSandboxId`, `connectionJson`, endpoint URLs, native terminal URLs, auth tokens, or provider metadata

#### Scenario: AIO-backed task response carries AIO summary
- **WHEN** a task has a persisted sandbox run whose provider id is `aio-local`
- **THEN** the create/list/fetch/transition task response for that task includes `sandboxProvider.id = "aio-local"`
- **AND** `sandboxProvider.label` is the public AIO display label
- **AND** the response does not include provider-private routing or connection data

#### Scenario: Task without selected sandbox provider returns null summary
- **WHEN** a task has no persisted sandbox run owner/selection
- **THEN** every task read response returns `sandboxProvider: null`
- **AND** the API does not fabricate `AIO Sandbox` or any other provider label from deployment configuration

#### Scenario: Contract schema validates only the public provider summary
- **WHEN** the shared `TaskResponseSchema` is inspected or used to parse a task response
- **THEN** it accepts `sandboxProvider` as either `null` or an object with string `id` and `label`
- **AND** it does not declare provider-private fields such as `providerSandboxId`, `connectionJson`, native URLs, endpoint URLs, auth tokens, or provider metadata
