# public-v1-api Specification

## Purpose
TBD - created by archiving change public-v1-api. Update Purpose after archive.
## Requirements
### Requirement: Versioned additive /v1 surface delegating to existing services

The system SHALL expose a version-prefixed `/v1` REST surface as additive
`@Controller('v1/...')` controllers that delegate to the SAME existing services
(tasks, repos, transcript, scheduled tasks). It SHALL NOT use framework-wide URI
versioning, and it SHALL NOT change or remove any existing unversioned
(console) endpoint, so the `apps/web` contract stays byte-identical. The `/v1`
surface SHALL be: `POST /v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:id`,
`POST /v1/tasks/:id/stop`, `GET /v1/repos`, `GET /v1/repos/:id`,
`GET /v1/tasks/:id/transcript`, `GET /v1/schedules`,
`POST /v1/schedules`, `GET /v1/schedules/:id`,
`PATCH /v1/schedules/:id`, `POST /v1/schedules/:id/pause`,
`POST /v1/schedules/:id/resume`, `DELETE /v1/schedules/:id`, and
`GET /v1/schedules/:id/runs`. A `/v1` task write SHALL go through the SAME
admission/guardrails path as the console create, so there is exactly one
task-admission code path. A `/v1` schedule fire SHALL also create tasks through
that same service path.

#### Scenario: /v1 task create delegates to the same admission path

- **WHEN** a `POST /v1/tasks` request with a valid `repoId` in its body is admitted
- **THEN** the task is created via the same `TasksService.create(repoId, body)` the console uses, with the same guardrails admission - no second admission path
- **AND** the response is the created task with its initial status

#### Scenario: The console surface is unchanged

- **WHEN** the `/v1` controllers are added
- **THEN** every existing unversioned endpoint and the `apps/web`-imported contract schemas are byte-identical, and framework URI versioning is not enabled

#### Scenario: /v1 schedule routes delegate to scheduled task services

- **WHEN** a scoped client creates, updates, pauses, resumes, deletes, or reads a
  schedule through `/v1/schedules`
- **THEN** the controller delegates to the scheduled task service
- **AND** it does not bypass owner scoping, task-template validation, or schedule
  run ledger behavior

### Requirement: /v1-only contract schemas are additive

The `/v1` request/response shapes (task create with `repoId` in the body, the paginated list envelopes, the idempotency shape) SHALL be NEW schemas in `@cap/contracts`, added ALONGSIDE — never mutating — the console's `CreateTaskRequestSchema` / list-response schemas that `apps/web` imports.

#### Scenario: Adding /v1 schemas does not change console schemas

- **WHEN** the `/v1` DTOs are added to `@cap/contracts`
- **THEN** the console's existing create/list schemas are unchanged, and the web app that imports them is unaffected

### Requirement: OpenAPI spec generated from the zod contracts

The system SHALL serve an OpenAPI 3.1 document at `GET /v1/openapi.json`, generated from the `@cap/contracts` zod schemas the `/v1` controllers validate against (so the spec cannot drift from the wire), plus an interactive `GET /v1/docs`. Both SHALL be reachable WITHOUT an operator credential (read-only public metadata). The generated document SHALL describe every `/v1` route and its request/response schemas.

#### Scenario: Spec is served and covers every /v1 route

- **WHEN** a client requests `GET /v1/openapi.json` with no credential
- **THEN** it receives a valid OpenAPI 3.1 document (200) that includes every `/v1` route, built from the same schemas used for request validation

#### Scenario: Spec stays in sync with the wire

- **WHEN** a `/v1` route's request/response schema changes
- **THEN** the generated spec reflects it because both derive from the one `@cap/contracts` schema (asserted by a generation test that every `/v1` route's schema is registered)

### Requirement: Keyset pagination on /v1 list endpoints

The `/v1` list endpoints (`GET /v1/tasks`, `GET /v1/repos`) SHALL accept `?limit=` and `?cursor=` and return a stable `{ items, nextCursor }` envelope. Ordering SHALL be by a unique tuple `(createdAt, id)` so no row is dropped or duplicated at a page boundary; `limit` SHALL have a sane default and maximum; `nextCursor` SHALL be null on the last page.

#### Scenario: A list is paginated by an opaque cursor

- **WHEN** a client requests `GET /v1/tasks?limit=N` and follows the returned `nextCursor`
- **THEN** it walks the full set in `(createdAt,id)` order with no dropped or duplicated rows, and `nextCursor` is null once the last page is returned

### Requirement: Idempotent /v1 task creation

`POST /v1/tasks` SHALL accept an optional `Idempotency-Key` header. A first request with a given key (scoped per principal) SHALL create the task and record the key; a retry with the SAME key and the SAME request body SHALL return the SAME task without creating a second one; a retry with the same key but a DIFFERENT body SHALL be rejected (409). The dedup record SHALL be inserted in the SAME transaction as the task so a raced retry cannot double-admit a sandbox, and SHALL expire after a bounded window (24h).

#### Scenario: A retried create with the same key returns the same task

- **WHEN** two `POST /v1/tasks` requests carry the same `Idempotency-Key` and the same body
- **THEN** exactly one task (and one sandbox admission) results, and both responses return that same task

#### Scenario: A reused key with a different body is rejected

- **WHEN** a `POST /v1/tasks` reuses an `Idempotency-Key` already recorded for the principal but with a different body
- **THEN** the request is rejected with 409 and no second task is created

### Requirement: SSE lifecycle observation over a guaranteed polling floor

External callers (who cannot use the cookie WebSocket) SHALL be able to observe a task's lifecycle to a terminal state. Polling `GET /v1/tasks/:id` SHALL be the GUARANTEED floor — every status transition is durably persisted before the response. Additionally, `GET /v1/tasks/:id/events` SHALL stream lifecycle events as `text/event-stream`, sourced from the append-only `AuditEvent` tail (NOT the live PTY/WebSocket stream), each event carrying an id for `Last-Event-ID` resume, with a keep-alive heartbeat emitted at least every 90 seconds, and SHALL close after a terminal event. The stream SHALL set the headers required to defeat proxy buffering (`text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`). The SSE path's end-to-end behavior through the Cloudflare tunnel SHALL be verified by a live probe before it is relied upon; the polling floor does not depend on that verification.

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
update, schedule response, schedule-run response, and paginated list envelopes.
The generated OpenAPI 3.1 document SHALL include every `/v1/schedules` route and
derive request/response shapes from the same schemas used for controller
validation.

#### Scenario: OpenAPI includes schedule routes
- **WHEN** a client requests `GET /v1/openapi.json`
- **THEN** the document includes every `/v1/schedules` route
- **AND** each route references the same schedule schemas used by the controller
  validation path

#### Scenario: Schedule schemas do not mutate task create schemas
- **WHEN** schedule DTOs are added to `@cap/contracts`
- **THEN** existing task create and task read schemas remain backward-compatible
- **AND** schedule-specific create/update fields are not required by
  `POST /v1/tasks`

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

