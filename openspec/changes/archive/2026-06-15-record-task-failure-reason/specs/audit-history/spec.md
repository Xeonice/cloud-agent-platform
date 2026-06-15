# audit-history Spec Delta — record-task-failure-reason

## ADDED Requirements

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
