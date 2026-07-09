## MODIFIED Requirements

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

## ADDED Requirements

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
