# repo-and-task-management Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Postgres + Prisma data model for repos and tasks
The system SHALL persist repositories and tasks in Postgres via a Prisma schema, where a `Repo` record holds at least an id, a name, a git source, a created-at timestamp, and OPTIONAL GitHub-import metadata (`description`, `defaultBranch`, `branchCount`, `updatedAt`), and a `Task` record holds at least an id, a foreign key to a `Repo`, a prompt, a status, a created-at timestamp, and the OPTIONAL run parameters `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs`. The `Task.branch`, `Task.strategy`, `Task.skills`, `Task.idleTimeoutMs`, and `Task.deadlineMs` columns MUST persist the values accepted by the create-task request body so they can be read back on every task read path (the prior model dropped branch/strategy and never persisted the deadline at all). `Task.skills` is the operator's selected skill ids (an optional list); `Task.idleTimeoutMs` and `Task.deadlineMs` are OPTIONAL nullable integer (millisecond) guardrail parameters. `branch`/`strategy`/`skills` are inert run parameters; `idleTimeoutMs`/`deadlineMs` are guardrail parameters that are consumed at admission (they arm the idle/deadline watchers) yet are ALSO persisted so the configured guardrails are readable on every task read path. The GitHub-import metadata on `Repo` is nullable so that repos created without GitHub import (plain `gitSource` only) remain valid.

#### Scenario: Prisma schema defines Repo and Task models with the new fields
- **WHEN** the Prisma schema is inspected
- **THEN** it declares a `Repo` model with id, name, git source, and createdAt fields
- **AND** the `Repo` model declares nullable `description`, `defaultBranch`, `branchCount`, and `updatedAt` GitHub-import metadata columns
- **AND** it declares a `Task` model with id, a relation to `Repo`, prompt, status, and createdAt fields
- **AND** the `Task` model declares nullable `branch` and `strategy` columns, a `skills` list column, and nullable integer `idleTimeoutMs` and `deadlineMs` columns

#### Scenario: Migration provisions the tables with the new columns
- **WHEN** the Prisma migrations are applied against an empty Postgres database
- **THEN** the `repos` and `tasks` tables exist with the declared columns
- **AND** the `repos` table includes the `description`, `default_branch`, `branch_count`, and `updated_at` columns
- **AND** the `tasks` table includes the `branch`, `strategy`, `skills`, `idle_timeout_ms`, and `deadline_ms` columns

#### Scenario: Task run/guardrail parameters survive a write/read round trip in the database
- **WHEN** a task row is written with a non-null `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs`, then re-read from Postgres
- **THEN** the persisted row returns the same `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs` values that were written
- **AND** they are not silently coerced to null or dropped

#### Scenario: Repo without GitHub metadata remains valid
- **WHEN** a `Repo` row is created with only id, name, gitSource, and createdAt and no GitHub-import metadata
- **THEN** the row persists with `description`, `defaultBranch`, `branchCount`, and `updatedAt` all null
- **AND** the record is still a valid `Repo`

### Requirement: REST API for repos
The system SHALL expose REST endpoints to create a repo, list repos, and fetch a single repo by id, validating request and response bodies against the shared contracts schemas. Repo read responses (list and fetch-by-id) SHALL include the OPTIONAL GitHub-import metadata fields `description`, `defaultBranch`, `branchCount`, and `updatedAt` when present on the record, so the repository console page can render the imported repo's description, default branch, branch count, and last-updated time without fabricating them. A repo created from a plain git source without GitHub metadata SHALL remain valid, with those fields returned as null/absent. Validation behavior for the create body is unchanged: an invalid repo body is rejected with HTTP 400 and no record is created.

#### Scenario: Create and list repos
- **WHEN** a client POSTs a valid repo body to the create-repo endpoint and then GETs the list-repos endpoint
- **THEN** the create call returns HTTP 201 with the created repo including a generated id
- **AND** the listed repos include the newly created repo

#### Scenario: Invalid repo body is rejected
- **WHEN** a client POSTs a body that fails the repo contracts schema
- **THEN** the API responds with HTTP 400 and does not create a repo record

#### Scenario: Repo read responses carry GitHub-import metadata when present
- **WHEN** a client GETs a repo (by id or via the list) that was imported from GitHub with metadata persisted
- **THEN** the response includes the repo's `description`, `defaultBranch`, `branchCount`, and `updatedAt`
- **AND** these values match what was persisted on the record

#### Scenario: Repo without GitHub metadata returns null fields
- **WHEN** a client GETs a repo created from a plain `gitSource` with no GitHub-import metadata
- **THEN** the response is a valid repo
- **AND** its `description`, `defaultBranch`, `branchCount`, and `updatedAt` are null or absent rather than fabricated

### Requirement: REST API for tasks
The system SHALL expose REST endpoints to create a task for a repo, list tasks, and fetch a single task by id, validating bodies against the shared contracts schemas. The create-task endpoint SHALL accept the OPTIONAL `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs` parameters in the request body, and SHALL persist them on the created `Task` record. Every task read path — the create response, the list-tasks response, and the fetch-by-id response — SHALL include the persisted `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs` (echoing whatever was supplied, or null/empty when omitted), so that values submitted by the console are always readable back rather than silently dropped. `idleTimeoutMs` and `deadlineMs` SHALL ALSO be passed through concurrency admission so the idle/deadline watchers arm for that task (see `guardrails`); a `deadlineMs` previously consumed at admission but never persisted SHALL now be both consumed AND persisted. When a `branch` is supplied, clone/provision behavior is unchanged. The `skills` value selects which server-side allowlisted skills are preinstalled at provision time (see `aio-sandbox-execution`); it does NOT alter task lifecycle.

#### Scenario: Create a task under a repo
- **WHEN** a client POSTs a valid task body referencing an existing repo id
- **THEN** the API returns HTTP 201 with the created task including its id and initial status
- **AND** the task is associated with the referenced repo

#### Scenario: Task for unknown repo is rejected
- **WHEN** a client POSTs a task body referencing a repo id that does not exist
- **THEN** the API responds with HTTP 404 and does not create a task record

#### Scenario: Run and guardrail parameters are persisted and read back
- **WHEN** a client POSTs a task body that includes a `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs`
- **THEN** the create response (HTTP 201) includes the same `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs` values
- **AND** a subsequent GET of that task by id returns the same values
- **AND** the task appears in the list-tasks response carrying the same values

#### Scenario: Omitted parameters read back as null/empty
- **WHEN** a client POSTs a task body that omits `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs`
- **THEN** the create response and the fetch-by-id response return `branch`/`strategy`/`idleTimeoutMs`/`deadlineMs` as null (or absent) and `skills` as empty/absent, never as a stale or fabricated value
- **AND** the task is created with no idle ceiling and no deadline (never reclaimed for idleness)

#### Scenario: Task response schema exposes the run and guardrail parameters
- **WHEN** the task response schema in the contracts package is inspected
- **THEN** the `Task`/`TaskResponse` schema declares optional `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs` fields
- **AND** the create-task request schema and the task response schema agree on their shapes so a sent value is a readable value

### Requirement: Task lifecycle states with distinct failed-to-start state
The system SHALL model task status as an explicit enumerated set that includes at least `pending`, `queued`, `running`, `awaiting_input`, `completed`, `failed`, a distinct `agent_failed_to_start` state separate from `running` and from a generic `failed`, and a distinct `cancelled` terminal state for an operator-initiated stop (separate from both `completed` and `failed`), and SHALL only permit transitions defined by the lifecycle. The lifecycle SHALL permit transitioning an active task to `cancelled` from `queued`, `running`, and `awaiting_input`; `cancelled` is terminal (no transitions out). `cancelled` is reached only by an explicit operator stop, never by a guardrail force-fail (which uses `failed`) and never by a clean agent exit (which uses `completed`). Persisting and reading back `branch`, `strategy`, `skills`, `idleTimeoutMs`, and `deadlineMs` on a `Task` SHALL NOT alter the lifecycle: the run parameters are inert, and the guardrail parameters only arm watchers — they MUST NOT add, remove, or gate any status transition beyond the watchers' existing force-fail edges.

#### Scenario: Status enum includes distinct failed-to-start and cancelled values
- **WHEN** the task status enum in the contracts package is inspected
- **THEN** it includes a distinct `agent_failed_to_start` value (not the same as `running`/`failed`) and a distinct `cancelled` value (not the same as `completed`/`failed`)

#### Scenario: Agent that never starts surfaces the distinct state
- **WHEN** the agent process for a task exits before reaching a running state
- **THEN** the task status is set to `agent_failed_to_start` rather than remaining `pending` or `running` indefinitely

#### Scenario: Active task can transition to cancelled
- **WHEN** an operator stop is applied to a task in `queued`, `running`, or `awaiting_input`
- **THEN** the transition to `cancelled` is permitted and `cancelled` is terminal with no transitions out

#### Scenario: Illegal transition is rejected
- **WHEN** a transition not permitted by the lifecycle (for example `completed` back to `pending`, or `cancelled` to `running`) is requested
- **THEN** the transition is rejected and the persisted status is unchanged

#### Scenario: Run and guardrail parameters do not affect lifecycle transitions
- **WHEN** a task is created with a `branch`, `strategy`, `skills`, `idleTimeoutMs`, and/or `deadlineMs` and then progresses through its lifecycle
- **THEN** the same status transitions are permitted and rejected as for a task created without those fields (aside from the idle/deadline watchers' existing force-fail edges)
- **AND** the persisted parameters remain unchanged across status transitions

### Requirement: Operator can stop a running or queued task
The system SHALL expose an authenticated endpoint `POST /tasks/:taskId/stop` that lets an operator deliberately stop an active task. Stopping a task in `queued`, `running`, or `awaiting_input` SHALL transition it to the terminal `cancelled` state and run the standard terminal-teardown path: invoke `SandboxProvider.teardownSandbox()` (a no-op when no sandbox was provisioned, e.g. a queued task), tear down session-scoped credentials, and release its concurrency slot (admitting the next queued task). The endpoint is the deliberate, operator-driven mechanism that replaces automatic idle reclamation as the routine way to free a slot from a finished or unwanted session; it SHALL be subject to the same authentication/authorization guard as the other task routes. Stopping a task already in a terminal state SHALL be a safe no-op (idempotent) rather than an error that corrupts state.

#### Scenario: Stopping a running task cancels it and frees its slot
- **WHEN** an operator POSTs to `/tasks/:taskId/stop` for a `running` task
- **THEN** the task transitions to `cancelled`, its sandbox and session credentials are torn down, and its concurrency slot is released so the next queued task can be admitted

#### Scenario: Stopping a queued task cancels it without a sandbox teardown error
- **WHEN** an operator stops a task still `queued` (no sandbox provisioned)
- **THEN** the task transitions to `cancelled` and the teardown path completes without error (sandbox teardown is a no-op for a task that never provisioned)

#### Scenario: Stopping a terminal task is a safe no-op
- **WHEN** an operator stops a task already in `completed`/`failed`/`cancelled`/`agent_failed_to_start`
- **THEN** the request does not corrupt the task state and does not double-release a slot

#### Scenario: Stop endpoint is authenticated
- **WHEN** an unauthenticated or de-allowlisted caller hits `POST /tasks/:taskId/stop`
- **THEN** the request is rejected by the same auth guard that protects the other task routes before any state change occurs

### Requirement: Task carries an agent-runtime selector
The `Task` model SHALL hold an OPTIONAL `runtime` value selecting the agent runtime
(`claude-code` | `codex`), defaulting to `codex` when absent so existing tasks and
omitted requests remain valid. The `Task.runtime` column SHALL persist the value
supplied by the create-task request so it is readable on every task read path. The
column is additive and nullable; a prior task with no `runtime` SHALL read back as
`codex`.

#### Scenario: Migration adds a nullable runtime column defaulting to codex
- **WHEN** the migration runs against an existing database
- **THEN** the `Task` table gains a nullable `runtime` column, and pre-existing rows
  read back as `codex`

#### Scenario: Runtime survives a write/read round trip
- **WHEN** a task is created with `runtime = claude-code`
- **THEN** the persisted record carries `runtime = claude-code` and every read path
  returns it unchanged

### Requirement: Create-task API accepts and echoes runtime, and dispatches to it
The create-task endpoint SHALL accept an OPTIONAL `runtime` field (`claude-code` | `codex`) in the
request body, validated against the shared contract schema, persist it on the created `Task`, and
include it on the create response, the list-tasks response, and the fetch-by-id response (echoing
whatever was supplied, or `codex` when omitted). At admission the task SHALL be dispatched to the
selected runtime's `AgentRuntime` implementation (see `agent-runtime`). A request selecting a runtime
that is not configured/ready SHALL be rejected or fail-closed with a distinct reason rather than
launching an unauthenticated agent.

The create path SHALL ADDITIONALLY derive the task's EXECUTION MODE from the consumer: a programmatic
consumer (MCP `create_task` / `POST /v1/tasks`) yields `headless-exec`; a console-created task yields
`interactive-pty`. The derived mode SHALL be persisted on the `Task` and drive provisioning,
exit-detection, and transcript read (see `agent-runtime`). A `headless-exec` task SHALL reach a
terminal status AUTONOMOUSLY on agent completion — no operator interaction, write-lease, or persistent
multi-turn is required or offered for it. Console (`interactive-pty`) creation is unchanged.

#### Scenario: Create a task selecting the Claude runtime
- **WHEN** a create-task request includes `runtime = claude-code` and Claude is configured
- **THEN** the task is persisted with `runtime = claude-code`, the response echoes it, and admission resolves the Claude runtime

#### Scenario: Omitted runtime defaults to codex
- **WHEN** a create-task request omits `runtime`
- **THEN** the task is created and read back as `runtime = codex`, with codex dispatched

#### Scenario: Invalid runtime value is rejected
- **WHEN** a create-task request carries a `runtime` value outside the allowed set
- **THEN** the request is rejected with HTTP 400 and no task is created

#### Scenario: Unconfigured runtime fails closed
- **WHEN** a create-task request selects `claude-code` but no Claude token is configured
- **THEN** the task does not launch an unauthenticated agent and surfaces a distinct "runtime not configured" reason

#### Scenario: Programmatic creation runs headless and reaches terminal
- **WHEN** a task is created via MCP `create_task` or `POST /v1/tasks`
- **THEN** it is persisted with execution mode `headless-exec`, launched non-interactively, and reaches a terminal status on agent completion without operator interaction

#### Scenario: Console creation stays interactive
- **WHEN** a task is created from the console
- **THEN** it is persisted with execution mode `interactive-pty` and behaves exactly as before (live terminal + operator takeover)

### Requirement: The task response exposes the execution mode

The task response (`TaskResponse`) SHALL include `executionMode` (`interactive-pty` | `headless-exec`),
derived at task creation from the consumer (console → `interactive-pty`; MCP/`/v1` → `headless-exec`)
and already persisted on the task. This lets the console branch the session view by mode (terminal vs
polled conversation) without inferring it. The field is additive and backward-compatible.

#### Scenario: Task response carries executionMode

- **WHEN** a client fetches a task (single or list)
- **THEN** the response includes `executionMode` reflecting how the task was created (`interactive-pty` for console, `headless-exec` for MCP/`/v1`)

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

### Requirement: Task creation accepts sandbox environment selection

Task creation SHALL accept an optional `sandboxEnvironmentId` run parameter. The
system SHALL validate that the selected environment exists, is ready, and is
compatible with the selected runtime before the task is admitted for sandbox
provisioning. Invalid selections SHALL be rejected without creating an unusable
sandbox.

#### Scenario: Valid selected environment is persisted

- **WHEN** a task create request supplies a ready compatible
  `sandboxEnvironmentId`
- **THEN** the task record persists that environment id
- **AND** task read paths echo the selected environment id

#### Scenario: Unknown environment is rejected

- **WHEN** a task create request supplies a `sandboxEnvironmentId` that does not
  exist
- **THEN** the request is rejected before sandbox provisioning
- **AND** no provider fallback is attempted

#### Scenario: Not-ready environment is rejected

- **WHEN** a task create request supplies an environment whose status is failed,
  stale, or validating
- **THEN** the request is rejected before sandbox provisioning
- **AND** the error identifies the environment readiness problem

#### Scenario: Omitted environment resolves the default

- **WHEN** a task create request omits `sandboxEnvironmentId`
- **THEN** task creation uses the compatible managed default environment when
  configured
- **AND** otherwise preserves the existing deployment-level sandbox default
  behavior

### Requirement: Task reads expose a public environment summary

Task read responses SHALL expose a public, non-secret sandbox environment summary
when a task has a managed selected environment. The summary SHALL include id,
display name, status at selection time when available, provider family/source
kind, and runtime compatibility. It SHALL NOT expose host-local secrets or
provider credentials.

#### Scenario: Task response includes environment summary

- **WHEN** an operator reads a task that selected a managed sandbox environment
- **THEN** the response includes a sandbox environment summary
- **AND** the summary does not expose provider credentials or task secrets

#### Scenario: Legacy task response remains valid

- **WHEN** an operator reads a task created before sandbox environments existed
- **THEN** the response remains valid with a null or absent environment summary
- **AND** existing clients that do not know the field continue to work

### Requirement: Task reads expose schedule provenance
Task records created by a schedule SHALL expose schedule provenance on task read
paths. The provenance SHALL identify the schedule and the scheduled fire time,
and it SHALL be nullable for tasks created directly through the console, `/v1`,
or MCP. Schedule provenance SHALL NOT expose owner credentials, schedule claim
leases, or scheduler internals.

#### Scenario: Scheduled task response includes provenance
- **WHEN** a client reads a task created from a schedule
- **THEN** the task response includes a nullable schedule provenance object with
  the schedule id and scheduled fire time
- **AND** the ordinary task status remains one of the existing task lifecycle
  values

#### Scenario: Direct task response has no provenance
- **WHEN** a client reads a task created directly from the console, `/v1`, or MCP
- **THEN** the task response has null or absent schedule provenance
- **AND** the response remains valid against the shared task contract

### Requirement: Schedule-created tasks preserve normal task lifecycle behavior
Tasks created by schedules SHALL move through the same task lifecycle as
directly created tasks. The scheduler SHALL NOT write task statuses directly
except through the existing task creation and admission services, and schedule
provenance SHALL NOT add, remove, or gate lifecycle transitions.

#### Scenario: Scheduled task queues when capacity is full
- **WHEN** a schedule fires while the guardrails concurrency ceiling is already
  full
- **THEN** the created task transitions to `queued` through the existing
  guardrails admission path
- **AND** it is later admitted in FIFO order like other queued tasks

#### Scenario: Scheduled task reaches terminal through existing settlement
- **WHEN** a task created by a schedule completes, fails, or is cancelled
- **THEN** transcript capture, optional delivery, sandbox teardown, and slot
  release run through the existing terminal settlement path

### Requirement: Tasks durably carry the requested runtime model

The canonical create-task request SHALL accept an optional `model` selector in
addition to `runtime`. Every Console, Public V1, MCP, and scheduled-task create
path SHALL parse the field through the shared task contract, persist its exact
normalized requested value on the Task, and expose it as nullable `model` in
canonical task responses. Omission SHALL persist and return null and SHALL mean
"use the effective runtime default" rather than a server-invented model id.
Create, get, list, stop, schedule provenance, and recovery projections SHALL
not drop or rewrite the value.

#### Scenario: An explicit task model is persisted and returned

- **WHEN** a task is created with a validated explicit model selector
- **THEN** the Task row stores that exact normalized selector
- **AND** create, get, list, and stop responses return it in `model`

#### Scenario: Omitted model remains an explicit default choice

- **WHEN** a task is created without a model selector
- **THEN** the Task row and canonical task response contain `model: null`
- **AND** no guessed account or CLI default is written into the task

#### Scenario: Every create contract carries the same model field

- **WHEN** the task-create field sets for Console, Public V1 excluding `repoId`, MCP `create_task`, and a schedule task template are compared
- **THEN** each surface accepts the same optional `model` definition from the canonical contract
- **AND** transport validation cannot silently strip the field before task admission

#### Scenario: Recovery retains the requested model

- **WHEN** CAP reconstructs a persisted task for admission recovery or schedule startup recovery
- **THEN** the reconstructed launch input contains the Task's persisted model without recataloging or replacing it

### Requirement: Requested and runtime-reported models remain distinct facts

`Task.model` SHALL represent caller intent only. Runtime/session history SHALL
continue to record an independently observed actual model when the CLI reports
one. The system SHALL NOT overwrite the requested model with an alias
resolution, configured default, provider fallback, or runtime-reported value.

#### Scenario: Runtime reports the selected model

- **WHEN** a task requests an alias and session history reports the concrete model used
- **THEN** the task response retains the requested alias while session metadata retains the concrete reported model

#### Scenario: Runtime substitutes a different model

- **WHEN** the runtime-reported actual model differs from the explicit requested selector
- **THEN** CAP preserves both facts and surfaces the mismatch observably
- **AND** it does not silently mutate `Task.model` to make the values appear equal

