## MODIFIED Requirements

### Requirement: MCP tools delegate to existing services with per-tool scope gates

The MCP server SHALL expose tools delegating to the EXISTING services (one
admission path, no fork): `create_task` (`tasks:write`), `get_task`
(`tasks:read`), `list_tasks` (`tasks:read`), `stop_task` (`tasks:write`),
`get_transcript` (`tasks:read`, the canonical Console/REST transcript read),
`list_repos` and `get_repo` (`repos:read`), `create_schedule`
(`tasks:write`), `list_schedules` (`tasks:read`), `get_schedule`
(`tasks:read`), `update_schedule`, `pause_schedule`, `resume_schedule`,
`dispatch_schedule`, and `delete_schedule` (`tasks:write`),
`list_schedule_runs` (`tasks:read`), and `list_runtime_models`
(`tasks:write`). The derived tool inventory SHALL stay in parity with each explicit
MCP mapping in `PUBLIC_V1_OPERATIONS`; streaming SSE is the sole explicit
REST-only exclusion rather than an accidental missing tool.

`create_task` SHALL use the exact shared `V1CreateTaskRequestSchema`, including
UUID `repoId`, `skills`, `deadlineMs`, `idleTimeoutMs`, `runtime`, `model`,
`sandboxEnvironmentId`, and `deliver`, and SHALL parse the callback input
against that schema before admission. The HTTP-only `Idempotency-Key` header
SHALL be recorded as an explicit MCP protocol difference: it is not a tool
argument, and each MCP call is a distinct create. `list_tasks`, `list_repos`,
`list_schedules`, and `list_schedule_runs` SHALL accept the corresponding public
`limit`/`cursor` query contract (`limit` maximum 200) and return the same
`{ items, nextCursor }` keyset envelope as `/v1`. Task and repo pagination SHALL
use one shared query implementation with `/v1`; schedule pagination SHALL
delegate to the scheduled-task service page methods. `list_runtime_models`
SHALL use the exact public runtime-model request/response schemas and the same
owner-aware catalog service as `/v1`.

`create_task` structured content and `outputSchema` SHALL match the canonical
`TaskResponseSchema` returned by `POST /v1/tasks`, including nullable requested
`model`. Its JSON text content MAY retain the historical `{ id, status, task }`
wrapper for compatibility with existing text-rendering clients.

Schedule tools SHALL delegate to the existing scheduled-task service, SHALL
scope every operation to the account id in `AuthInfo.extra.userId`, and SHALL
fail closed before acting when that owner id is absent. Create and update inputs
SHALL be derived from or parity-checked against the shared schedule contracts so
`taskTemplate.model` cannot be stripped by an outdated SDK input shape. Each
tool SHALL enforce its required scope against the resolved `mcp` principal's
scopes BEFORE acting, returning an MCP error with 403-semantics when missing.
`create_task` SHALL return a handle (id + status) IMMEDIATELY — it SHALL NOT
block until the task completes — so a tool call never conflicts with a
minutes-long run; the client polls `get_task` to a terminal status then reads
`get_transcript`. `get_transcript` SHALL call the same shared transcript reader
as Console and `/v1`, including live running-task reads and audit-derived system
turns. Every tool SHALL advertise an SDK `outputSchema` and return matching
`structuredContent`, while retaining JSON text `content` for existing clients.
There SHALL be no standalone `start_sandbox` tool that bypasses the guardrails
admission path. The raw PTY/WebSocket terminal stream SHALL NEVER be exposed via
a tool.

#### Scenario: A scoped tool is gated

- **WHEN** an `mcp` principal whose scopes lack `tasks:write` calls `create_task`, `stop_task`, or `list_runtime_models`
- **THEN** the tool returns an MCP error with 403-semantics and performs no state change or catalog discovery

#### Scenario: create_task returns a handle without blocking

- **WHEN** `create_task` runs
- **THEN** it returns the task id + status immediately (provisioning proceeds asynchronously through the same admission the console uses), not after the task completes

#### Scenario: MCP task input stays aligned with the public task contract

- **WHEN** an MCP caller creates a task with skills, guardrail timeouts, runtime, model, sandbox environment, or delivery fields accepted by `POST /v1/tasks`
- **THEN** `create_task` accepts and forwards the same fields after shared-contract validation
- **AND** an invalid non-UUID `repoId` is rejected before task admission
- **AND** each MCP invocation remains a distinct create because the REST-only `Idempotency-Key` header is not mapped

#### Scenario: MCP list tools page identically to the public API

- **WHEN** an MCP caller supplies `limit` and follows `nextCursor` on a task, repo, schedule, or schedule-run list
- **THEN** each result is a `{ items, nextCursor }` envelope with the same maximum limit and keyset semantics as `/v1`

#### Scenario: MCP clients receive structured and text results

- **WHEN** a client lists and calls an MCP tool
- **THEN** the advertised tool includes an `outputSchema` and the result includes matching `structuredContent`
- **AND** the result retains JSON text content for clients that do not consume structured output

#### Scenario: MCP client manages its own schedules

- **WHEN** an MCP principal with `tasks:read`, `tasks:write`, and an account id in `AuthInfo.extra.userId` creates, reads, updates, dispatches, deletes, or lists runs for a schedule
- **THEN** the corresponding MCP tool delegates to the existing scheduled-task service with that account id
- **AND** schedule request bodies including `taskTemplate.model` are validated by the shared schedule contracts before the service acts

#### Scenario: MCP pauses and resumes an owned schedule

- **WHEN** an owner-scoped MCP caller invokes `pause_schedule` or `resume_schedule` with `tasks:write`
- **THEN** the existing scheduled-task pause or resume method runs with the token owner's account id

#### Scenario: Schedule tools fail closed without scope or owner

- **WHEN** an MCP principal calls a schedule tool without its required `tasks:read` or `tasks:write` scope, or without `AuthInfo.extra.userId`
- **THEN** the tool returns an MCP error with 403-semantics
- **AND** no scheduled-task service method runs

#### Scenario: Runtime model tool delegates without a second catalog path

- **WHEN** an owner-scoped MCP caller with `tasks:write` invokes `list_runtime_models`
- **THEN** the tool validates the canonical public input and delegates to the same catalog service used by `/v1`
- **AND** it returns the canonical catalog structured output without blocking on task execution

## ADDED Requirements

### Requirement: MCP exposes the same runtime model catalog as Public V1

The MCP tool inventory SHALL include `list_runtime_models` from the explicit MCP
mapping on the public V1 catalog operation. The tool SHALL use the same
runtime/environment input and catalog output schemas, require `tasks:write`,
derive the owner from `AuthInfo.extra.userId`, and delegate to the same catalog
service as REST. It SHALL fail closed before service invocation when scope or
owner is absent and SHALL never accept a client-supplied owner id.

#### Scenario: MCP and V1 return the same catalog shape

- **WHEN** the same owner queries the same unchanged runtime/environment context through MCP and Public V1
- **THEN** both surfaces validate the same input and return the same canonical catalog fields, revision, ordering, and safe metadata

#### Scenario: MCP catalog query requires owner and write scope

- **WHEN** an MCP principal lacks `tasks:write` or `AuthInfo.extra.userId`
- **THEN** `list_runtime_models` returns a scoped MCP error and does not invoke catalog discovery

#### Scenario: MCP catalog probe capacity is owner-fair

- **WHEN** one MCP owner exceeds the shared catalog service's per-owner probe allowance
- **THEN** excess calls receive safe retryable capacity data without creating another probe
- **AND** another owner's catalog call is not starved

### Requirement: MCP task and schedule tools preserve the requested model

`create_task` SHALL advertise and parse the canonical V1 optional `model` field,
forward it through the same shared preparation/model preflight, pure task write,
and admission path as Console and V1, and return it in canonical structured task
output. Schedule create/update tools SHALL advertise and parse
the canonical schedule schemas so `taskTemplate.model` reaches the scheduled
task service without SDK unknown-field stripping. MCP input parity checks SHALL
compare the actual advertised/callback schemas with the shared contracts rather
than relying on separately maintained field lists.

#### Scenario: MCP creates an explicit-model task

- **WHEN** `create_task` receives an available explicit model
- **THEN** the admitted task, structured content, later `get_task`, and `list_tasks` results contain that exact requested selector

#### Scenario: MCP model preflight fails before task creation

- **WHEN** `create_task` receives an unavailable model or its catalog cannot be obtained
- **THEN** the shared preflight returns the structured model-domain error before the pure task write and admission stages
- **AND** no Task row or task-owned execution sandbox is created, and any catalog probe is reclaimed

#### Scenario: MCP creates and updates a model-aware schedule

- **WHEN** MCP creates or updates a schedule whose task template contains `model`
- **THEN** the SDK-advertised input accepts the field and the scheduled-task service receives it unchanged after canonical validation

#### Scenario: Cross-surface task input parity is enforced

- **WHEN** a canonical task-create field is added or changed
- **THEN** automated schema parity fails unless V1, MCP `create_task`, and schedule task templates expose the same field definition

### Requirement: MCP maps model-domain failures to structured protocol errors

MCP SHALL translate synchronous catalog, direct task-create, and schedule
create/update model-domain failures explicitly instead of leaking Nest HTTP
exceptions. `runtime_model_not_available` SHALL be an invalid-params style tool
error, while `runtime_model_catalog_unavailable` SHALL be a retryable tool error.
Each error's structured data SHALL contain the stable domain code and safe
context and SHALL omit raw CLI/provider messages and secrets. The mapping SHALL
be parity-tested against the corresponding V1 422 and 503 errors. After
`dispatch_schedule` accepts and persists an occurrence, it SHALL instead return
the normal structured Schedule response whose latest run is terminal-failed or
retrying; it SHALL NOT return a tool error for that persisted outcome.

#### Scenario: MCP rejects an unavailable model structurally

- **WHEN** an MCP task or schedule call supplies a selector absent from the effective catalog
- **THEN** the tool returns an invalid-params style error whose data code is `runtime_model_not_available`
- **AND** no task, schedule mutation, or task-owned execution sandbox is created, and any catalog probe is reclaimed

#### Scenario: MCP reports a retryable catalog outage

- **WHEN** `list_runtime_models` or an explicit-model write cannot obtain the catalog
- **THEN** the tool returns an error whose data code is `runtime_model_catalog_unavailable` and whose safe data marks it retryable

#### Scenario: MCP honors the deployment gate before accepting work

- **WHEN** a model-aware N MCP server has `task-model-selection-v1` closed and MCP lists models, writes an explicit-model task/schedule, or dispatches an explicit-model occurrence
- **THEN** the tool returns retryable `runtime_model_catalog_unavailable` before a Task or occurrence is accepted
- **AND** MCP task creation that omits `model` continues through the existing admission path

#### Scenario: MCP dispatch returns a persisted retrying run

- **WHEN** `dispatch_schedule` accepts an occurrence and its stored explicit model encounters a transient catalog outage
- **THEN** the tool returns its canonical Schedule structured content with `latestRun.status = retrying`
- **AND** it does not return a retryable tool error after persisting the dispatch

#### Scenario: Public manifest and tool inventory stay aligned

- **WHEN** the model catalog operation is added to the public operation manifest
- **THEN** MCP inventory parity requires its `list_runtime_models` mapping and matching schemas
- **AND** the existing SSE-only exclusion remains the only deliberate non-tool public data operation
