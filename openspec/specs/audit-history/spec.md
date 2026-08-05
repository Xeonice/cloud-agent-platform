# audit-history Specification

## Purpose
TBD - created by archiving change rebuild-console-tanstack-start. Update Purpose after archive.
## Requirements
### Requirement: Persist task lifecycle and audit events

The orchestrator SHALL persist an immutable, append-only audit event record for every task lifecycle transition and notable operational outcome, so the history page ("历史与日志 · 审计时间线") renders from real recorded events rather than client-side mocks. An audit event record SHALL capture at minimum: a stable event id, the owning task id, the GitHub-identity user the event is attributed to, an event `type` (the lifecycle/audit kind, e.g. `task.created`, `task.running`, `task.completed`, `task.failed`, `task.cancelled`, `agent_failed_to_start`, `force_failed`), a severity `level` in the set `{ info, warning, error }`, a short human-readable title and description, a server-assigned UTC `timestamp`, and (where the prototype shows one) an HTTP-status-like result code. The guardrails service — which already drives task lifecycle transitions (`running`/`completed`/`failed`/`cancelled`, `agent_failed_to_start`, and force-fail causes such as deadline, idle, and circuit-break) — SHALL emit a corresponding audit event at the moment of each transition, recording the transition's outcome and its cause where one exists. Event recording SHALL be append-only: an event, once written, SHALL NOT be mutated or deleted by lifecycle progression, so the timeline preserves the full ordered history of a task. Audit recording SHALL be best-effort with respect to the controlled action — a failure to persist an audit event SHALL NOT roll back or block the lifecycle transition itself — but every successful lifecycle transition driven by guardrails SHALL have a recording attempt.

#### Scenario: Lifecycle transition is recorded as an audit event

- **WHEN** the guardrails service transitions a task to a new lifecycle state (`running`, `completed`, `failed`, or `cancelled`)
- **THEN** the orchestrator persists an append-only audit event carrying the task id, the attributed user, the event `type` for that transition, a `level`, a title/description, and a server-assigned UTC `timestamp`
- **AND** the recorded event reflects the transition outcome (and its cause when the transition has one, such as a force-fail reason)

#### Scenario: Force-fail cause is captured

- **WHEN** guardrails force-fails a task due to a deadline overrun, idle ceiling, or agent-start circuit-break
- **THEN** the persisted audit event is `level: error` with `type` distinguishing the cause (e.g. deadline / idle / circuit-break force-fail or `agent_failed_to_start`)
- **AND** its description names the cause so the timeline shows why the task failed

#### Scenario: Events are append-only and never rewritten

- **WHEN** a task progresses through multiple states over its lifetime (e.g. created → running → completed)
- **THEN** each transition is stored as a distinct, separately timestamped audit event and no earlier event is mutated or deleted
- **AND** the full ordered sequence remains queryable after the task reaches a terminal state

#### Scenario: Audit persistence failure does not block the transition

- **WHEN** persisting an audit event for a lifecycle transition fails
- **THEN** the lifecycle transition itself still completes and the task reaches its intended state
- **AND** the persistence failure is surfaced to operational logging rather than rolled back into the task state

### Requirement: HTTP-status-like result codes on audit events

Where the prototype timeline displays a result code on an event row, the persisted audit event SHALL carry an integer `resultCode` drawn from HTTP-status semantics so the console can render it verbatim. Successful creation SHALL map to `201`, a successful read/transition with no new resource to `200`, a conflict (such as a rejected concurrent operation or a slot/admission conflict) to `409`, and a validation/precondition failure to `422`. The `resultCode` SHALL be consistent with the event `level` (a `2xx` code SHALL NOT carry `level: error`, and a `4xx` code SHALL NOT carry `level: info`), so the colored audit-dot (info/warning/danger) and the status code on a row never contradict each other.

#### Scenario: Task creation records a 201

- **WHEN** a task is created and an audit event is recorded for it
- **THEN** the event carries `resultCode: 201` and `level: info`

#### Scenario: Conflict records a 409

- **WHEN** an operation is rejected because it conflicts with current state (for example a concurrent action or an admission/slot conflict)
- **THEN** the recorded audit event carries `resultCode: 409` and a non-`info` level

#### Scenario: Validation failure records a 422

- **WHEN** an operation is rejected for a validation or precondition failure
- **THEN** the recorded audit event carries `resultCode: 422` and a non-`info` level

#### Scenario: Result code and level never contradict

- **WHEN** any audit event with a `resultCode` is persisted
- **THEN** a `2xx` code is never paired with `level: error` and a `4xx`/`5xx` code is never paired with `level: info`

### Requirement: Query recent audit events for the history timeline

The orchestrator SHALL expose an authenticated read endpoint that returns recent audit events ordered most-recent-first for the history page timeline. The query SHALL be filterable by severity `level` (the prototype's 信息/警告/错误 segmented control: `info` / `warning` / `error`, plus "全部"/all) and by task lifecycle `status`, and SHALL accept a bound on the number of returned events (a default cap plus a caller-supplied limit) so the timeline does not unboundedly grow. Each returned event SHALL include its `type`, `level`, `timestamp`, title, description, `resultCode` (when present), the associated task id, and a session linkage that lets the console deep-link the event's task to its live session route (`/tasks/$taskId`). The endpoint SHALL require a valid session resolving to an allowlisted user and SHALL reject a missing/expired/non-allowlisted session with HTTP `401`, performing no read.

#### Scenario: Recent events returned most-recent-first

- **WHEN** an authenticated allowlisted operator queries the audit events endpoint without filters
- **THEN** the orchestrator returns recent events ordered most-recent-first, bounded by the default cap, each carrying `type`, `level`, `timestamp`, title, description, `resultCode` (when present), task id, and session linkage

#### Scenario: Filter by severity level

- **WHEN** the operator queries with a `level` filter of `info`, `warning`, or `error`
- **THEN** only events whose severity matches the requested level are returned, and the "全部"/all selection returns every level

#### Scenario: Filter by task status

- **WHEN** the operator queries with a lifecycle `status` filter
- **THEN** only events whose associated task is in (or transitioned to) that status are returned

#### Scenario: Result limit is honored

- **WHEN** the operator supplies a `limit` smaller than the available event count
- **THEN** at most that many events are returned, still ordered most-recent-first

#### Scenario: Unauthenticated query is rejected

- **WHEN** the audit events endpoint is called with a missing, expired, revoked, or non-allowlisted session
- **THEN** the orchestrator responds `401` and returns no events

### Requirement: Audit events are associated with tasks and linked to the session

Every audit event SHALL be associated with exactly one task by its task id, and SHALL carry enough linkage for the console to navigate from a timeline row to that task's live session (`/tasks/$taskId`) and to the most recent run identifier where one applies. Events SHALL also be attributable to the account under which the action occurred, regardless of how that account authenticates — a GitHub-linked identity and a local account SHALL both be attributed. Attribution SHALL resolve the account's own identifier directly; it SHALL NOT depend on a GitHub-id reverse lookup, because an account that has never been linked to a GitHub identity has no such id and would otherwise be recorded with no attribution at all. The association SHALL be stable across the task's lifetime: querying a task's events SHALL return its full event sequence even after the task reaches a terminal state, and an event SHALL NOT be orphaned (every persisted event references a real task id).

#### Scenario: Event links back to its task session

- **WHEN** the history timeline renders an audit event that has an associated session
- **THEN** the event exposes the task id (and run identifier where applicable) sufficient for the console to deep-link to that task's session route `/tasks/$taskId`

#### Scenario: Event is attributed to a user identity

- **WHEN** an audit event is recorded for a task action
- **THEN** the event references the account under which the action occurred, so the timeline can attribute the event to that operator

#### Scenario: A local account is attributed without a GitHub identity

- **WHEN** an audit event is recorded for an action taken by an account that has no linked GitHub identity
- **THEN** the persisted event carries that account's own identifier as its attributed user
- **AND** the attribution is not empty

#### Scenario: Task events queryable by task id

- **WHEN** the events for a specific task id are requested
- **THEN** the orchestrator returns that task's full ordered event sequence, including events recorded after the task reached a terminal state

#### Scenario: No orphaned events

- **WHEN** any persisted audit event is inspected
- **THEN** it references a real task id and is never stored without a task association

### Requirement: Task failures record a diagnosable cause

When a task reaches a non-success terminal state, the audit trail SHALL capture enough to diagnose
WHY it failed without the sandbox, rather than only a generic "任务失败". At the exit seam (the
terminal bridge resolving an exit status into `GuardrailsService.recordExit`, and the
`force_failed:abnormal_exit` path), the orchestrator SHALL record a failure-detail audit event that
carries: (1) the resolved process **exit code** (`AioExitStatus.code`, or an explicit indication
when it could not be resolved / the exit was abnormal), (2) a **human-readable reason** derived
from that code (mapping the Unix `128+signal` convention — e.g. timeout, SIGINT, SIGKILL/疑似 OOM,
SIGTERM, abnormal disconnect — and otherwise "codex 自身错误/任务提交失败"), and (3) an
**excerpt of the task transcript tail** sampled from the API-side `session.log` (ANSI-stripped,
length-capped) so codex's actual last output (rate-limit / out-of-credits / error text) is visible.

This detail event SHALL follow the existing force-fail-cause pattern (a distinct `type` + an
`error` level + `resultCode: 422`) and SHALL NOT replace or mutate the central generic
`task.failed` transition event. Capture SHALL be best-effort and MUST NOT block or roll back the
lifecycle transition, the sandbox teardown, or the slot release — a failure to read the transcript
or persist the detail event is logged and swallowed. The capture SHALL NOT depend on the sandbox
being alive: it SHALL source the exit code from the already-resolved exit status and the transcript
from the API-side `session.log` (which outlives sandbox teardown), and SHALL NOT rely on a
post-mortem AIO `/v1/shell/view` (or other sandbox HTTP) call. A clean `completed` exit SHALL NOT
emit a failure-detail event.

#### Scenario: Non-zero codex exit records the exit code and reason

- **WHEN** a task's codex process exits with a non-zero exit code and the task transitions to `failed`
- **THEN** a failure-detail audit event is persisted with `level: error` and `resultCode: 422`
- **AND** its description carries the numeric exit code and the human-readable reason mapped from it
- **AND** the central `task.failed` transition event is still recorded unchanged

#### Scenario: Transcript tail is captured for the failure

- **WHEN** the failure-detail event is recorded for a failed task that produced terminal output
- **THEN** the event carries an ANSI-stripped, length-capped excerpt of the tail of the task's
  API-side `session.log`
- **AND** the excerpt is available even after the task's sandbox has been torn down

#### Scenario: Abnormal exit also records a diagnosable cause

- **WHEN** a task is force-failed via the abnormal-exit path (sandbox died / WS closed before the
  session was established / exit code unresolved)
- **THEN** the recorded cause indicates the abnormal disconnect (rather than a bare numeric code)
- **AND** a transcript-tail excerpt is captured when any output was produced

#### Scenario: Capture failure never blocks the transition

- **WHEN** reading the transcript tail or writing the failure-detail event fails
- **THEN** the task's lifecycle transition, sandbox teardown, and slot release still complete
- **AND** the failure is logged and swallowed (best-effort)

#### Scenario: Clean completion records no failure detail

- **WHEN** a task's codex process exits cleanly (code 0) and the task transitions to `completed`
- **THEN** no failure-detail (`exited:*`) audit event is recorded

### Requirement: Provisioning history records structured stages and safe causes

The orchestrator SHALL durably record task-correlated provisioning progress and
terminal provisioning causes so an operator can distinguish acceptance,
sandbox creation, remote-ref resolution, repository transfer, checkout,
submodules, runtime setup, readiness, and cleanup without accessing ephemeral
sandbox logs. A terminal provisioning detail SHALL carry a stable safe cause
covering at least capacity exhaustion, timeout, forge authentication,
TLS/network, missing branch/ref, platform dependency unavailability, and an
unknown fallback, plus attempt and timestamp information. A local command-start
or missing-executable failure SHALL be recorded as the platform dependency cause
and SHALL NOT be recorded as TLS/network. It SHALL accompany rather than replace
the central task lifecycle transition.

Audit descriptions and structured fields SHALL NOT contain a forge token,
authorization header, credential-bearing URL, temporary secret content/path,
authenticated command, raw exec request, provider endpoint, argv, stderr, or
unsanitized Git output. Recording stage/audit detail SHALL be idempotent across
admission lease replay, and failure to persist a progress event SHALL NOT block
the controlled provisioning action; durable admission work remains the recovery
source of truth.

#### Scenario: Disk exhaustion is recorded after authenticated refs succeed

- **WHEN** refs authentication succeeds and repository transfer later fails with filesystem capacity exhaustion
- **THEN** audit history records the repository-transfer stage and capacity-specific safe cause
- **AND** the central terminal task event is still recorded

#### Scenario: Clone timeout is distinct from control-plane failure

- **WHEN** workspace materialization exceeds its Git deadline
- **THEN** audit history records a workspace timeout at the active stage
- **AND** it does not report a forge credential rejection or generic BoxLite health failure

#### Scenario: Missing Git is recorded separately from remote failure

- **WHEN** remote-ref resolution cannot start the control-plane Git executable
- **THEN** audit history records the platform dependency cause at remote-ref resolution
- **AND** it records no TLS/network cause, raw command, stderr, config path, or token

#### Scenario: Lease replay does not duplicate terminal detail

- **WHEN** a worker loses its lease after persisting a terminal provisioning cause and recovery replays the work item
- **THEN** the same idempotency identity prevents a duplicate terminal detail event
- **AND** task settlement remains exactly once

#### Scenario: Secret canary never reaches history

- **WHEN** a private-repository provisioning test uses a unique credential canary and exercises success, failure, timeout, retry, refresh, and retention
- **THEN** the canary is absent from audit rows, task failure projections, structured logs, and retained workspace credential files

### Requirement: Every provisioning stage row has a declared owner

Provisioning progress rows are written under the dedupe identity `task.provisioning:{taskId}:{attempt}:{stage}`, and more than one writer can reach that identity: the admission worker writes monotonic durable checkpoints, while the orchestrator's provider-composite progress hook writes audit-only hints for phases whose physical ordering differs. The capability SHALL declare, per provisioning stage, which writer owns that stage's row, and **every stage a provider family reports SHALL have at least one declared owner**. A stage whose only writer is the orchestrator's audit-only hint SHALL keep that hint; the hint SHALL be removable only for stages the admission worker independently checkpoints under the same dedupe identity.

Ownership SHALL be provable by execution, not by inspection of comments: a test SHALL enumerate the stages each provider family reports and assert the row for each is still recorded when the audit-only hint is absent.

#### Scenario: Two writers of the same identity produce one row

- **WHEN** the admission worker's checkpoint and the provider-composite hint both fire for the same task id, attempt, and stage
- **THEN** exactly one audit row exists for that dedupe identity, and no duplicate is produced by the second writer

#### Scenario: Every reported stage still has a row without the hint

- **WHEN** a durable admission runs to completion on a provider family with the provider-composite audit hint removed
- **THEN** an audit row exists for every provisioning stage that family reported, each under its `task.provisioning:{taskId}:{attempt}:{stage}` identity

#### Scenario: A stage the worker never checkpoints keeps its hint

- **WHEN** a stage is reported by a provider family but is never advanced through an admission-worker checkpoint
- **THEN** removing the orchestrator's audit-only hint makes the ownership test fail with that stage named, rather than silently dropping the stage from the history timeline

#### Scenario: Ownership is enumerable per stage

- **WHEN** the declared owner table is read against the provisioning stage list
- **THEN** each reported stage maps to exactly one declared owner, and no reported stage maps to none

### Requirement: Audit rows are captured synchronously inside the operation that caused them

Audit capture SHALL remain synchronous with respect to the operation that produced it: the write SHALL be issued within that operation's own execution, and SHALL NOT be enqueued, batched across ticks, deferred to a later tick, or staged in an intermediate store on its way to persistence. Re-homing an audit write onto the in-process domain event bus SHALL preserve this property, because the bus dispatches synchronously before `publish` returns; any re-homing that would introduce queueing or deferral SHALL be refused instead of implemented.

Where an audit row is written from a domain-event subscriber, its timestamp and its actor attribution SHALL be derived from the event payload, never from ambient request context, because a published event can be dispatched from a call stack (boot re-adoption, detached session reclaim) that has no such context.

#### Scenario: No deferral primitive on the audit write path

- **WHEN** the audit write paths this change touches are searched for `setTimeout`, `setImmediate`, `process.nextTick`, or an enqueue helper
- **THEN** zero matches are found

#### Scenario: A synchronously dispatched subscriber has completed before the publisher continues

- **WHEN** an audit write is reached through a subscriber of a published domain event
- **THEN** that write has been issued before `publish` returns to the orchestrator, and no part of it is scheduled onto a later tick

#### Scenario: Subscriber-written rows take their attribution from the payload

- **WHEN** an audit row is written from a domain-event subscriber
- **THEN** its occurred-at timestamp and its attributed account are read from the event payload's fields, and the write path reads zero ambient request-context values

### Requirement: An audit write that records an actor or a failure cause cannot migrate onto the current event envelope

The event envelope carries exactly `eventId`, `occurredAt`, `type`, and `taskId`; no catalog payload carries an acting account identifier or a failure cause. Because attribution is already normative — every audit event is attributed to the account under which the action occurred, including a local account with no linked GitHub identity — an audit write that records an actor or a failure cause SHALL NOT be re-homed onto a subscriber of the current catalog. Such a write is adjudicated `CALL` under the information-missing criterion, and remains a direct port call until a separate change extends the envelope or the payload and passes the same catalog review the original events received.

#### Scenario: The envelope carries no actor field

- **WHEN** the envelope's field names are enumerated
- **THEN** they are exactly `eventId`, `occurredAt`, `type`, and `taskId`, and none of them names an acting account

#### Scenario: The lifecycle transition recorder stays a direct call

- **WHEN** the task lifecycle transition recorder — which takes an acting user identifier and a failure detail — is evaluated against the catalog
- **THEN** it is adjudicated `CALL` under the information-missing criterion, and its existing call sites outside guardrails are unchanged by this change

#### Scenario: Attribution keeps working for local accounts

- **WHEN** an audit event is recorded for an action taken by an account with no linked GitHub identity, on the integrated tree
- **THEN** the persisted event still carries that account's own identifier as its attributed user, and the attribution is not empty

#### Scenario: Extending the envelope is a separate reviewed change

- **WHEN** a proposal to re-home an actor-attributed audit write is read
- **THEN** it names the envelope or payload field it needs and defers that addition to its own change, rather than deriving the actor from ambient context or recording the row without attribution

