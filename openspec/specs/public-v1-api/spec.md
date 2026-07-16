# public-v1-api Specification

## Purpose
TBD - created by archiving change public-v1-api. Update Purpose after archive.
## Requirements
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

### Requirement: OpenAPI spec generated from the zod contracts

The system SHALL serve an OpenAPI 3.1 document at `GET /v1/openapi.json`, generated from the `@cap/contracts` zod schemas the `/v1` controllers validate against (so the spec cannot drift from the wire), plus an interactive `GET /v1/docs`. Both SHALL be reachable WITHOUT an operator credential (read-only public metadata). The generated document SHALL describe every `/v1` route and its request/response schemas.

#### Scenario: Spec is served and covers every /v1 route

- **WHEN** a client requests `GET /v1/openapi.json` with no credential
- **THEN** it receives a valid OpenAPI 3.1 document (200) that includes every `/v1` route, built from the same schemas used for request validation

#### Scenario: Spec stays in sync with the wire

- **WHEN** a `/v1` route's request/response schema changes
- **THEN** the generated spec reflects it because both derive from the one `@cap/contracts` schema (asserted by a generation test that every `/v1` route's schema is registered)

#### Scenario: Documented failures match runtime behavior

- **WHEN** a client inspects an operation in `GET /v1/openapi.json`
- **THEN** it sees validation/auth/not-found responses plus operation-specific
  conflict and rate-limit responses that the real controller can return

### Requirement: Keyset pagination on /v1 list endpoints

The `/v1` list endpoints (`GET /v1/tasks`, `GET /v1/repos`) SHALL accept `?limit=` and `?cursor=` and return a stable `{ items, nextCursor }` envelope. Ordering SHALL be by a unique tuple `(createdAt, id)` so no row is dropped or duplicated at a page boundary; `limit` SHALL have a sane default and maximum; `nextCursor` SHALL be null on the last page.

#### Scenario: A list is paginated by an opaque cursor

- **WHEN** a client requests `GET /v1/tasks?limit=N` and follows the returned `nextCursor`
- **THEN** it walks the full set in `(createdAt,id)` order with no dropped or duplicated rows, and `nextCursor` is null once the last page is returned

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

### Requirement: SSE lifecycle observation over a guaranteed polling floor

External callers (who cannot use the cookie WebSocket) SHALL be able to observe a task's lifecycle to a terminal state. Polling `GET /v1/tasks/:id` SHALL be the GUARANTEED floor — every status transition is durably persisted before the response. Additionally, `GET /v1/tasks/:id/events` SHALL stream lifecycle events as `text/event-stream`, sourced from the append-only `AuditEvent` tail (NOT the live PTY/WebSocket stream), each event carrying an id for `Last-Event-ID` resume, with a keep-alive heartbeat emitted at least every 90 seconds, and SHALL close after a terminal event. The OpenAPI response SHALL describe the complete HTTP body as framed `text/event-stream` text, while exposing the JSON schema carried by each `data:` field separately; it SHALL NOT describe the whole response as one JSON event. The stream SHALL set the headers required to defeat proxy buffering (`text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`). The SSE path's end-to-end behavior through the Cloudflare tunnel SHALL be verified by a live probe before it is relied upon; the polling floor does not depend on that verification.

#### Scenario: Polling observes every status transition

- **WHEN** a client polls `GET /v1/tasks/:id`
- **THEN** it observes each persisted status (pending → queued → running → terminal) because every transition is written before the response

#### Scenario: SSE streams lifecycle events and closes on terminal

- **WHEN** a client opens `GET /v1/tasks/:id/events`
- **THEN** it receives `text/event-stream` lifecycle events from the AuditEvent tail (each with an id), a heartbeat at least every 90s, and the stream closes after a terminal event
- **AND** the raw PTY/WebSocket terminal stream is NOT exposed on this endpoint

### Requirement: /v1 operations are scope-gated

Each `/v1` operation SHALL enforce the shared scope vocabulary via the principal carried by the auth guard: list/read requires `tasks:read` / `repos:read`, create/stop requires `tasks:write`. A principal missing the required scope SHALL be rejected with 403 (distinct from 401); a scopeless principal (a GitHub session) SHALL be allowed (allow-all), preserving console behavior. Under the shared-pool model, any admitted principal may list/stop any task (accepted).

#### Scenario: A read-only key cannot create via /v1

- **WHEN** an `api-key` principal whose scopes are only `tasks:read` calls `POST /v1/tasks`
- **THEN** the request is rejected with 403 insufficient scope, and no task is created

#### Scenario: A session principal retains full /v1 access

- **WHEN** a GitHub-session principal (no scopes) calls any `/v1` operation
- **THEN** the operation is permitted (allow-all)

### Requirement: /v1 transcript surfaces the enriched transcript fields
The `GET /v1/tasks/:id/transcript` response SHALL surface the additive
session-history fields introduced for the transcript timeline — per-turn
timestamps, the `system` milestone turn kind, tool diffstat, and session totals —
serialized from the SAME `@cap/contracts` session-history schema the console
consumes. The additions SHALL be ADDITIVE and OPTIONAL so existing `/v1`
consumers are not broken, and the `GET /v1/openapi.json` document SHALL be
regenerated so it continues to describe the transcript response from the same
schemas used for validation (no drift). No new `/v2` surface is introduced.

#### Scenario: v1 transcript includes the new fields
- **WHEN** a scoped client requests `GET /v1/tasks/:id/transcript` for a task whose transcript carries the new data
- **THEN** the response includes the per-turn timestamps, any `system` turns, tool diffstat, and session totals, serialized from the shared session-history schema

#### Scenario: Additions are backward-compatible for existing consumers
- **WHEN** an existing `/v1` consumer reads a transcript response that omits the new optional fields (e.g. an old durable archive)
- **THEN** the response remains valid against the contract and the consumer is not broken

#### Scenario: OpenAPI document reflects the enriched transcript schema
- **WHEN** a client fetches `GET /v1/openapi.json` after this change
- **THEN** the transcript response schema in the document reflects the new optional fields, generated from the same zod schemas used for request/response validation

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

### Requirement: /v1 schedule contracts are additive and documented
The `/v1` schedule request/response schemas SHALL be added to `@cap/contracts`
alongside existing `/v1` schemas. The schedule schemas SHALL include create,
update, schedule response, schedule-run response, paginated list envelopes, and
recurrence descriptors for product clients. The generated OpenAPI 3.1 document
SHALL include every `/v1/schedules` route and derive request/response shapes
from the same schemas used for controller validation. Existing cron-based
schedule fields SHALL remain available as a compatibility path unless a future
breaking API version removes them, but recurrence-first fields SHALL be the
documented product path.

#### Scenario: OpenAPI includes schedule routes
- **WHEN** a client requests `GET /v1/openapi.json`
- **THEN** the document includes every `/v1/schedules` route
- **AND** each route references the same schedule schemas used by the controller
  validation path
- **AND** the documented schedule create/update schemas include recurrence
  descriptors that do not require cron syntax

#### Scenario: Schedule schemas do not mutate task create schemas
- **WHEN** schedule DTOs are added to `@cap/contracts`
- **THEN** existing task create and task read schemas remain backward-compatible
- **AND** schedule-specific create/update fields are not required by
  `POST /v1/tasks`

#### Scenario: Recurrence and cron inputs are mutually exclusive
- **WHEN** a client submits both a recurrence descriptor and a cron expression in
  one schedule create or update request
- **THEN** the request is rejected with a validation error
- **AND** no schedule definition is changed

### Requirement: /v1 schedule operations are scoped to task scopes and account owner
The `/v1` schedule routes SHALL enforce `tasks:read` for reads and `tasks:write`
for creates, updates, pause, resume, and delete. A principal missing the
required scope SHALL be rejected with 403. A principal with scopes but no owner
account SHALL NOT create schedules. All ordinary schedule operations SHALL be
owner-scoped to the principal account.

#### Scenario: Read-only key cannot create a schedule
- **WHEN** an API key with only `tasks:read` calls `POST /v1/schedules`
- **THEN** the request is rejected with 403
- **AND** no schedule row is created

#### Scenario: API key reads only owner schedules
- **WHEN** an API key with `tasks:read` lists schedules
- **THEN** the response includes schedules owned by that key's account
- **AND** it omits schedules owned by other accounts

### Requirement: /v1 schedule run reads are paginated
The `/v1` schedule run list endpoint SHALL return a stable keyset-paginated
envelope ordered by `(scheduledFor, id)` descending or another documented unique
tuple. Each item SHALL include schedule id, scheduled fire time, status, optional
linked task id, and non-secret error text when applicable.

#### Scenario: Client lists recent fires for a schedule
- **WHEN** a scoped client requests `GET /v1/schedules/:id/runs?limit=N`
- **THEN** it receives at most N schedule-run items plus a `nextCursor`
- **AND** each item links to the created task when task creation succeeded

### Requirement: /v1 recurrence responses hide scheduler internals for product clients
The `/v1` schedule response SHALL include recurrence metadata or a recurrence
summary suitable for product clients to display without parsing or showing cron.
For schedules created from compatibility cron expressions that cannot be mapped
to supported recurrence descriptors, the response SHALL still include a
non-secret custom recurrence summary and next run time.

#### Scenario: Supported recurrence reads back as descriptor
- **WHEN** a client creates a schedule with a supported recurrence descriptor
- **THEN** subsequent schedule reads include that recurrence descriptor or an
  equivalent normalized descriptor
- **AND** clients can render the schedule without using `cronExpression`

#### Scenario: Unmappable cron reads back as custom recurrence
- **WHEN** a schedule exists with a valid cron expression that does not map to a
  supported recurrence preset
- **THEN** the schedule response includes a custom recurrence summary and the
  schedule timezone
- **AND** the response does not require product clients to display the raw cron
  expression to ordinary users

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

### Requirement: Public V1 handlers are exhaustively registry-bound

Every public `/v1` data handler SHALL carry exactly one typed public operation id
binding. A central fail-closed REST boundary SHALL resolve the operation's scope,
owner policy, canonical parser, output schema, and public error mapping from the
shared capability registry rather than repeating policy literals in controllers.
The real Nest handler inventory and the registry REST projection SHALL form a
two-way exact match. Metadata/docs routes and internal callbacks SHALL remain
outside the data registry only through their existing explicit classification.
The development gate SHALL recursively inspect production API sources and SHALL
reject bound handlers that consume standard Nest input decorators, raw request
data outside the registry authorization helpers, or a raw response object for an
operation that is not declared as streaming.

#### Scenario: A handler is added without a registry binding

- **WHEN** a developer adds a public `/v1` data handler without a typed operation
  id, or binds an id that has no REST registry entry
- **THEN** `pnpm test:public-surface` exits non-zero before the change can merge

#### Scenario: Registry authorization drives the real handler

- **WHEN** a request reaches a bound Public V1 handler
- **THEN** its required scope and owner policy are loaded from that handler's
  registry entry and enforced before the application use case runs
- **AND** a missing principal, missing binding, or unknown id fails closed

#### Scenario: REST schema metadata diverges

- **WHEN** a bound handler's accepted input or returned canonical output differs
  from the schemas declared for its operation id
- **THEN** the focused public-surface conformance test fails and identifies the
  operation

#### Scenario: A handler bypasses canonical request or response projection

- **WHEN** a bound handler reads an undeclared raw request field, uses a standard
  Nest input decorator, or injects `@Res` for a non-streaming operation
- **THEN** the recursive production-source conformance test exits non-zero
- **AND** direct and namespace-qualified decorator forms are subject to the same
  policy

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
