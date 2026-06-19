## ADDED Requirements

### Requirement: Versioned additive /v1 surface delegating to existing services

The system SHALL expose a version-prefixed `/v1` REST surface as additive `@Controller('v1/...')` controllers that delegate to the SAME existing services (tasks, repos, transcript). It SHALL NOT use framework-wide URI versioning, and it SHALL NOT change or remove any existing unversioned (console) endpoint, so the `apps/web` contract stays byte-identical. The `/v1` surface SHALL be: `POST /v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/stop`, `GET /v1/repos`, `GET /v1/repos/:id`, `GET /v1/tasks/:id/transcript`. A `/v1` write SHALL go through the SAME admission/guardrails path as the console create, so there is exactly one task-admission code path.

#### Scenario: /v1 task create delegates to the same admission path

- **WHEN** a `POST /v1/tasks` request with a valid `repoId` in its body is admitted
- **THEN** the task is created via the same `TasksService.create(repoId, body)` the console uses, with the same guardrails admission — no second admission path
- **AND** the response is the created task with its initial status

#### Scenario: The console surface is unchanged

- **WHEN** the `/v1` controllers are added
- **THEN** every existing unversioned endpoint and the `apps/web`-imported contract schemas are byte-identical, and framework URI versioning is not enabled

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
