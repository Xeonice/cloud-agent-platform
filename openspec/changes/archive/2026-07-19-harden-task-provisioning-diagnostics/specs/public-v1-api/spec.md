## MODIFIED Requirements

### Requirement: Versioned additive /v1 surface delegating to existing services

The system SHALL expose a version-prefixed `/v1` REST surface as additive
`@Controller('v1/...')` controllers that delegate to the SAME existing services
(tasks, repos, transcript, task provisioning diagnostics, scheduled tasks,
runtime model catalog). It SHALL NOT use framework-wide URI versioning, and it
SHALL NOT change or remove any existing unversioned (console) endpoint, so
existing `apps/web` routes remain compatible. The `/v1` surface SHALL be: `POST
/v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:id`, `POST
/v1/tasks/:id/stop`, `GET /v1/tasks/:id/transcript`, `GET
/v1/tasks/:id/events`, `GET /v1/tasks/:id/provisioning-diagnostics`, `GET
/v1/repos`, `GET /v1/repos/:id`, `GET /v1/schedules`, `POST /v1/schedules`,
`GET /v1/schedules/:id`, `PATCH /v1/schedules/:id`, `POST
/v1/schedules/:id/pause`, `POST /v1/schedules/:id/resume`, `POST
/v1/schedules/:id/dispatch`, `DELETE /v1/schedules/:id`, `GET
/v1/schedules/:id/runs`, and `POST /v1/runtime-models/query`. These 19 public
data operations SHALL be declared by one shared contract manifest consumed by
OpenAPI, the API playground, MCP parity checks, and a reflection test over the
real Nest controllers. Metadata routes (`/v1/openapi.json`, `/v1/docs`) and the
internal sandbox callback (`/internal/sandbox/approvals`) SHALL remain outside
that public data-operation manifest.

A `/v1` task write SHALL go through the SAME canonical task preparation,
transactional task/admission-work write, and asynchronous admission/guardrails
services as Console and MCP create, with only the V1 idempotency wrapper
differing, so there is exactly one task-domain creation path. After the
task/admission work transaction commits, `POST /v1/tasks` SHALL return the
created task with its initial status and SHALL NOT await guardrails admission,
provider selection, sandbox creation, workspace transfer, runtime setup, or
agent launch. A `/v1` schedule fire SHALL also create tasks through that same
durable service path. The runtime-model catalog operation SHALL delegate to the
same shared contextual catalog service used by Console and MCP. The task
provisioning-diagnostics operation SHALL delegate to the same canonical,
task-owned diagnostic query service used by Console and MCP rather than reading
container output or constructing a transport-specific timeline.

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

#### Scenario: /v1 diagnostics delegates to the shared diagnostic query

- **WHEN** an authorized caller requests `GET /v1/tasks/:id/provisioning-diagnostics`
- **THEN** the controller delegates to the same task-owned diagnostic query service used by Console and MCP
- **AND** it does not inspect Docker logs, provider output, or audit prose to synthesize the response

## ADDED Requirements

### Requirement: Public V1 exposes scoped provisioning diagnostics without widening Task

The canonical public registry SHALL add the request-response operation
`tasks.provisioningDiagnostics` at `GET
/v1/tasks/:id/provisioning-diagnostics`. The operation SHALL require the
independent `tasks:diagnostics` scope for principals carrying scopes and SHALL
declare `ownerPolicy = required` plus the fixed `owner_required` boundary error.
This is a new owner-aware boundary, not reuse of the current optional-owner Task
read policy. Every Public V1 session or machine principal SHALL supply a non-null
authenticated account id and read only a task whose `ownerUserId` matches it.
Identity-less legacy principals and ownerless historical tasks SHALL return no
diagnostic evidence. Administrator cross-owner inspection SHALL remain an
Internal Console capability and SHALL NOT create a Public V1/MCP owner-policy
difference. A cross-owner task hidden by the Public V1 policy SHALL use the same
non-enumerating not-found behavior as other owner-scoped reads.

The operation SHALL accept the shared bounded `limit` and opaque `cursor`
pagination input and return one canonical strict response envelope containing
the task identity, explicit evidence-availability/degradation state, a page of
safe attempt/operation records, and `nextCursor`. Page traversal SHALL follow
the diagnostic ledger's stable order with a unique tie-breaker so retries and
page boundaries neither duplicate nor omit records. Public V1 and MCP SHALL use
the exact same input schemas, response schema, scope, owner policy, pagination
semantics, and diagnostic query service.

The response SHALL preserve the primary provisioning outcome independently
from any secondary cleanup outcome and MAY expose only bounded, allowlisted
facts from the canonical diagnostic union. It SHALL NOT expose a command,
stdout/stderr, request or response body, header, repository-authenticated URL,
credential or temporary path, prompt, environment dump, lease owner, provider
endpoint, stack, or arbitrary diagnostic bag. Ordinary Task response schemas
used by `tasks.create`, `tasks.list`, `tasks.get`, `tasks.stop`, and nested
schedule projections SHALL remain unchanged by this operation.

Generated OpenAPI and the API Playground SHALL derive the new path, scope,
pagination contract, strict response union, and secret-free examples from the
same registry and contracts. They SHALL NOT maintain an independently authored
diagnostics schema or example.

The operation SHALL remain behind a deployment capability gate until every
serving API/MCP/Web role advertises the same schema, required-owner policy,
scope parser, registry mapping, and wire fixture. While the gate is closed, the
operation SHALL return retryable `task_provisioning_diagnostics_unavailable` and no
evidence; scope grants SHALL remain disabled. The route MAY be discoverable
during the additive rollout, but it SHALL NOT become usable early through a
scopeless session principal.

#### Scenario: Owner pages through safe diagnostic evidence

- **WHEN** a principal with `tasks:diagnostics` reads a task owned by its account and follows `nextCursor`
- **THEN** every page validates against the canonical provisioning-diagnostics response schema
- **AND** the full traversal returns each persisted record once in stable ledger order

#### Scenario: Ordinary task scopes do not grant diagnostic access

- **WHEN** a scoped principal has `tasks:read` and `tasks:write` but lacks `tasks:diagnostics`
- **THEN** `tasks.provisioningDiagnostics` is rejected with 403
- **AND** possession of the task id does not disclose diagnostic evidence

#### Scenario: Public V1 owner isolation is enforced

- **WHEN** any Public V1 session or machine principal requests diagnostics for another account's task
- **THEN** the operation returns the owner-policy not-found result without revealing whether the task exists
- **AND** an administrator uses the separate session-authenticated Internal Console route when cross-owner inspection is required

#### Scenario: Identity-less legacy principal fails owner-required

- **WHEN** a scopeless legacy token with no authenticated account id calls the diagnostic operation
- **THEN** the fixed owner-required boundary rejects it before the diagnostic service reads a task
- **AND** allow-all scope compatibility does not bypass the required owner identity

#### Scenario: Ownerless historical task is not public diagnostic evidence

- **WHEN** a Public V1 principal requests diagnostics for a historical task whose `ownerUserId` is null
- **THEN** the operation returns the non-enumerating owner-policy result
- **AND** only the separately authorized Internal Console administrator path may inspect its safe retained evidence

#### Scenario: Mixed deployment keeps diagnostics closed

- **WHEN** any serving role lacks the matching diagnostics registry, scope parser, owner policy, or wire capability
- **THEN** Public V1 returns retryable `task_provisioning_diagnostics_unavailable` with no evidence
- **AND** diagnostics scope grants remain disabled

#### Scenario: Legacy evidence degrades explicitly

- **WHEN** an authorized caller reads a historical task whose provisioning predates some or all diagnostic ledger records
- **THEN** the response remains schema-valid and explicitly reports the bounded unavailable or partial evidence state
- **AND** it does not fabricate operation outcomes from generic audit text or rotated logs

#### Scenario: Ordinary Task responses remain unchanged

- **WHEN** a client calls `tasks.create`, `tasks.list`, `tasks.get`, or `tasks.stop` after diagnostics support is deployed
- **THEN** its canonical Task response contains no new diagnostic ledger, cleanup record, provider operation, or arbitrary diagnostic field
- **AND** existing nested schedule Task projections remain unchanged

#### Scenario: OpenAPI and Playground derive the same safe operation

- **WHEN** OpenAPI, API Playground rendering, and runtime Public V1 output are compared for `tasks.provisioningDiagnostics`
- **THEN** all three use the canonical registry input and output schemas and declare `tasks:diagnostics`
- **AND** secret-canary values injected into provider failures appear in none of their schemas, examples, or responses
