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
manifest. A `/v1` task write SHALL go through the SAME canonical task
preparation, pure row-write, and admission/guardrails services as the console
create, with only the V1 idempotency wrapper differing, so there is exactly one
task-domain creation path. A
`/v1` schedule fire SHALL also create tasks through that same service path. The
runtime-model catalog operation SHALL delegate to the same shared contextual
catalog service used by Console and MCP.

#### Scenario: /v1 task create delegates to the same admission path

- **WHEN** a `POST /v1/tasks` request with a valid `repoId` in its body is admitted
- **THEN** it uses the same shared preparation/model validation, task-row write, and guardrails admission logic as Console, with no second domain path
- **AND** the response is the created task with its initial status

#### Scenario: The console surface remains compatible

- **WHEN** the `/v1` model catalog and optional shared model field are added
- **THEN** every existing unversioned endpoint remains available with additive-compatible request and response schemas, and framework URI versioning is not enabled

#### Scenario: /v1 schedule routes delegate to scheduled task services

- **WHEN** a scoped client creates, updates, pauses, resumes, deletes, or reads a
  schedule through `/v1/schedules`
- **THEN** the controller delegates to the scheduled task service
- **AND** it does not bypass owner scoping, task-template validation, or schedule
  run ledger behavior

#### Scenario: /v1 model catalog delegates to the shared catalog service

- **WHEN** a scoped client queries `POST /v1/runtime-models/query`
- **THEN** the controller delegates to the same owner- and environment-aware service used by Console and MCP
- **AND** the operation is present in the registry-derived manifest and controller-reflection check

### Requirement: /v1-only contract schemas are additive

The `/v1`-only request/response shapes SHALL remain new schemas in
`@cap/contracts`, added alongside the Console schemas: task create with
`repoId` in the body, the paginated list envelopes, and the idempotency shape.
A new task field that is semantically shared by Console, V1, MCP, and schedule templates
SHALL be added once as a backward-compatible optional field on the canonical
`CreateTaskRequestSchema`, and the V1 wrapper SHALL inherit that definition
rather than introducing a V1-only copy. Existing required fields and existing
accepted requests SHALL remain compatible.

#### Scenario: Shared optional fields have one definition

- **WHEN** the optional task `model` field is added
- **THEN** Console, V1, MCP, and schedule templates inherit the same canonical field constraints
- **AND** V1 adds only its V1-specific wrapper concerns such as body `repoId`

#### Scenario: Existing clients remain compatible

- **WHEN** an existing Console or V1 client sends a pre-feature create request without `model`
- **THEN** the request retains its previous validation and runtime-default behavior

## ADDED Requirements

### Requirement: Public V1 exposes the contextual runtime model catalog

The public operation manifest SHALL define
`POST /v1/runtime-models/query` as a read-only catalog query with body
`{ runtime, sandboxEnvironmentId? }`, preserving omitted, null, and UUID
environment semantics. It SHALL require `tasks:write`, derive the owner from the
authenticated principal, delegate to the shared catalog service, and return the
canonical catalog response. It SHALL NOT accept `userId`, start a durable task
or task-owned execution sandbox, or participate in task-create idempotency. A
bounded taskless catalog probe MAY run and SHALL be reclaimed by the catalog
service. The operation SHALL use the principal request throttle plus the
catalog service's per-owner probe fairness limits and SHALL document HTTP 429
alongside safe retryable catalog-capacity behavior. The operation SHALL be
registered from the same contracts in the real controller, OpenAPI document,
API Playground, and explicit MCP mapping.

#### Scenario: A task writer queries its effective catalog

- **WHEN** a principal with `tasks:write` posts a valid runtime/environment context to `/v1/runtime-models/query`
- **THEN** it receives the catalog resolved for that principal's owner and effective execution environment

#### Scenario: Read-only scope cannot query a create preflight catalog

- **WHEN** an API key without `tasks:write` calls the catalog operation
- **THEN** it receives 403 and the catalog service is not invoked

#### Scenario: Client cannot choose another owner

- **WHEN** a client attempts to include an owner or user id in the catalog body
- **THEN** shared request validation rejects the unknown field and never resolves another owner's credentials

#### Scenario: Catalog probing is owner-rate-limited

- **WHEN** one principal exceeds the catalog request or taskless-probe allowance
- **THEN** excess work receives documented 429 or safe retryable capacity data before another probe is created
- **AND** other owners retain fair access to shared probe capacity

### Requirement: Public V1 task and schedule contracts carry requested models

`POST /v1/tasks` SHALL accept the canonical optional `model` field, and all V1
task responses SHALL return nullable requested `model`. V1 schedule create and
update task templates and schedule responses SHALL carry the same optional
field. The field SHALL remain a bounded string in OpenAPI rather than an enum of
environment-dependent model ids. Validation SHALL occur before the idempotency
write transaction for a new key, while the exact request including `model` SHALL
remain part of the existing idempotency body hash. V1 SHALL first perform a
side-effect-free key/body lookup: an existing same-body key returns its original
Task and an existing different-body key returns 409 without catalog discovery.
Only a missing key runs external preflight; the write transaction then rechecks
the key to resolve races before inserting a Task. Before returning a preflight
error after an initial miss, V1 SHALL perform a bounded side-effect-free winner
lookup so a concurrently committed same-body request is replayed instead of
being masked by a transient catalog result.

#### Scenario: V1 creates and reads an explicit-model task

- **WHEN** a V1 caller creates a task with an available model selector
- **THEN** the create response and subsequent get/list responses return that exact requested selector

#### Scenario: Idempotency distinguishes task intent

- **WHEN** the same principal reuses an idempotency key once with one model and once with a different model
- **THEN** the second request is rejected as the existing different-body 409 case
- **AND** no second task or catalog probe occurs inside the idempotency transaction

#### Scenario: Exact idempotent replay does not revalidate a historical task

- **WHEN** a same-principal request reuses an idempotency key with the exact same body after its model was removed or catalog discovery became unavailable
- **THEN** V1 returns the originally recorded Task without invoking catalog discovery

#### Scenario: Concurrent first requests recheck after preflight

- **WHEN** two same-key same-body requests both observe no idempotency record and complete external model preflight
- **THEN** the transaction-level recheck creates exactly one Task and both requests resolve to that Task

#### Scenario: Failed preflight recovers a concurrent winner

- **WHEN** a same-key same-body request's preflight fails while another request commits the Task within the bounded winner-resolution window
- **THEN** the failing path loads and returns the winner's Task rather than returning the preflight error

#### Scenario: OpenAPI does not freeze dynamic model ids

- **WHEN** a client inspects the generated task or schedule input schemas
- **THEN** `model` is documented as an optional bounded string with catalog guidance, not a static enum

### Requirement: Public V1 returns stable model-domain failures

Public V1 SHALL map synchronous catalog query, direct task-create, and schedule
create/update `runtime_model_not_available` to HTTP 422 and
`runtime_model_catalog_unavailable` to HTTP 503. Error envelopes SHALL carry the
stable code plus only safe runtime/environment/model context, and the 503 form
SHALL communicate retryability. OpenAPI SHALL document both operation-specific
responses anywhere an explicit model can be validated. Unknown provider or CLI
messages SHALL NOT become the public error contract.

#### Scenario: V1 rejects an unavailable model

- **WHEN** a V1 task or schedule request names a syntactically valid selector absent from its effective catalog
- **THEN** it receives HTTP 422 with code `runtime_model_not_available`
- **AND** no task, schedule mutation, or task-owned execution sandbox side effect occurs, and any taskless catalog probe is reclaimed

#### Scenario: V1 reports a catalog outage

- **WHEN** a V1 catalog query or explicit-model validation cannot obtain the effective catalog
- **THEN** it receives HTTP 503 with code `runtime_model_catalog_unavailable` and retryable semantics
- **AND** no raw CLI/provider diagnostics or secrets appear in the response

#### Scenario: Deployment gate is closed before occurrence acceptance

- **WHEN** a request is routed to a model-aware N V1 instance while `task-model-selection-v1` is closed and it queries the catalog, writes an explicit-model task/schedule, or manually dispatches an explicit-model occurrence
- **THEN** it receives HTTP 503 with retryable `runtime_model_catalog_unavailable` before the request creates or accepts model-aware work
- **AND** a task request that omits `model` retains the existing V1 behavior

#### Scenario: Manual schedule dispatch returns its persisted run outcome

- **WHEN** `POST /v1/schedules/:id/dispatch` accepts an occurrence whose stored model is unavailable or whose catalog is transiently unavailable
- **THEN** it returns the normal successful Schedule response with `latestRun` terminal-failed or retrying respectively
- **AND** it does not return 422/503 after persisting that occurrence outcome

#### Scenario: OpenAPI matches runtime failures

- **WHEN** the public OpenAPI document is generated
- **THEN** the catalog, task-create, and schedule-write operations describe the model-domain 422 and 503 responses they can actually return
