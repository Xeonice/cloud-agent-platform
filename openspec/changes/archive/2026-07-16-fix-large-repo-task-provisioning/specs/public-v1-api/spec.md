## MODIFIED Requirements

### Requirement: Versioned additive /v1 surface delegating to existing services

The system SHALL expose a version-prefixed `/v1` REST surface as additive
`@Controller('v1/...')` controllers that delegate to the SAME existing services
(tasks, repos, transcript, scheduled tasks, runtime model catalog). It SHALL NOT
use framework-wide URI versioning, and it SHALL NOT change or remove any
existing unversioned (console) endpoint, so existing `apps/web` routes remain
compatible. The `/v1` surface SHALL be: `POST /v1/tasks`, `GET /v1/tasks`,
`GET /v1/tasks/:id`, `POST /v1/tasks/:id/stop`,
`GET /v1/tasks/:id/transcript`, `GET /v1/tasks/:id/events`, `GET /v1/repos`,
`GET /v1/repos/:id`, `GET /v1/schedules`, `POST /v1/schedules`,
`GET /v1/schedules/:id`, `PATCH /v1/schedules/:id`,
`POST /v1/schedules/:id/pause`, `POST /v1/schedules/:id/resume`,
`POST /v1/schedules/:id/dispatch`, `DELETE /v1/schedules/:id`,
`GET /v1/schedules/:id/runs`, and `POST /v1/runtime-models/query`. These 18
public data operations SHALL be declared by one shared contract manifest
consumed by OpenAPI, the API playground, MCP parity checks, and a reflection
test over the real Nest controllers. Metadata routes (`/v1/openapi.json`,
`/v1/docs`) and the internal sandbox callback
(`/internal/sandbox/approvals`) SHALL remain outside that public data-operation
manifest.

A `/v1` task write SHALL go through the SAME canonical task preparation,
transactional task/admission-work write, and asynchronous admission/guardrails
services as Console and MCP create, with only the V1 idempotency wrapper
differing, so there is exactly one task-domain creation path. After the
task/admission work transaction commits, `POST /v1/tasks` SHALL return the
created task with its initial status and SHALL NOT await guardrails admission,
provider selection, sandbox creation, workspace transfer, runtime setup, or
agent launch. A `/v1` schedule fire SHALL also create tasks through that same
durable service path. The runtime-model catalog operation SHALL delegate to the
same shared contextual catalog service used by Console and MCP.

#### Scenario: /v1 task create delegates to the same admission path

- **WHEN** a `POST /v1/tasks` request with a valid `repoId` in its body is accepted
- **THEN** it uses the same shared preparation/model validation, transactional task/admission write, and asynchronous guardrails admission logic as Console and MCP, with no second domain path
- **AND** the response is the committed task with its initial status before provisioning completes

#### Scenario: Slow provisioning does not hold the V1 request

- **WHEN** the selected provider's workspace transfer remains in progress beyond the HTTP request's normal latency budget
- **THEN** `POST /v1/tasks` has already returned the initial canonical Task
- **AND** the caller observes later provisioning stages and terminal outcome through task polling or SSE

#### Scenario: The console surface remains compatible

- **WHEN** durable asynchronous admission and additive provisioning response fields are enabled
- **THEN** every existing unversioned endpoint remains available with additive-compatible request and response schemas, and framework URI versioning is not enabled

#### Scenario: /v1 schedule routes delegate to scheduled task services

- **WHEN** a scoped client creates, updates, pauses, resumes, deletes, or reads a schedule through `/v1/schedules`
- **THEN** the controller delegates to the scheduled task service
- **AND** it does not bypass owner scoping, task-template validation, durable task admission, or schedule run ledger behavior

#### Scenario: /v1 model catalog delegates to the shared catalog service

- **WHEN** a scoped client queries `POST /v1/runtime-models/query`
- **THEN** the controller delegates to the same owner- and environment-aware service used by Console and MCP
- **AND** the operation is present in the registry-derived manifest and controller-reflection check

### Requirement: Idempotent /v1 task creation

`POST /v1/tasks` SHALL accept an optional `Idempotency-Key` header. A first
request with a given key (scoped per principal) SHALL create the task, its
unique durable admission work item, and the key record in the SAME transaction;
a retry with the SAME key and the SAME request body SHALL return the SAME task
without creating or admitting a second one; a retry with the same key but a
DIFFERENT body SHALL be rejected (409). The dedup record SHALL expire after a
bounded window (24h). A replay SHALL return the current canonical Task promptly
and SHALL NOT synchronously wait for, restart, or duplicate provisioning.

#### Scenario: A retried create with the same key returns the same task

- **WHEN** two `POST /v1/tasks` requests carry the same `Idempotency-Key` and the same body
- **THEN** exactly one task, one admission work item, and at most one live sandbox result, and both responses return that same task

#### Scenario: Replay does not wait for provisioning

- **WHEN** an exact idempotent replay arrives while the winning task is still provisioning
- **THEN** the replay returns the current canonical Task without blocking on or re-running admission
- **AND** polling/SSE remains the observation path for later lifecycle changes

#### Scenario: A reused key with a different body is rejected

- **WHEN** a `POST /v1/tasks` reuses an `Idempotency-Key` already recorded for the principal but with a different body
- **THEN** the request is rejected with 409 and no second task or admission work item is created

## ADDED Requirements

### Requirement: Public task and repository reads project provisioning truth safely

The canonical public registry operations SHALL project the same additive,
secret-free task provisioning summary and structured failure variants for
`tasks.create`, `tasks.list`, `tasks.get`, and `tasks.stop` that are used by the runtime
contracts. `repos.list` and `repos.get` SHALL return the verified persisted
default branch through their existing nullable field. Generated OpenAPI SHALL
describe the exact optional/nullable response semantics and stable failure
variants, and the API Playground SHALL derive the same operations and preserve
their success and non-success bodies. No provider secret, lease identity,
authenticated Git command, or raw diagnostic SHALL enter these projections.

#### Scenario: Registry-derived task response includes safe progress

- **WHEN** a Public V1 client creates or reads a task during workspace transfer
- **THEN** the response validates against the canonical Task schema and includes the safe transfer stage
- **AND** the matching OpenAPI operation and MCP structured output use that same schema

#### Scenario: Repo read returns the verified default branch

- **WHEN** a Public V1 client reads a repository imported with remote default `master`
- **THEN** `repos.list` and `repos.get` return `defaultBranch = master`
- **AND** no public repo-import write operation is added

#### Scenario: Public projections contain no provider secrets

- **WHEN** task/repo responses, OpenAPI examples, Playground rendering, and MCP structured content are inspected
- **THEN** they contain no credential, temporary secret path, lease owner, provider endpoint, or raw authenticated command
