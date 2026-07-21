# sandbox-provider-port — delta for fix-clone-retry-and-tui-classifier

## MODIFIED Requirements

### Requirement: Workspace materialization reports bounded stages and typed failures

Provider workspace materialization SHALL execute under a deadline independent
from control-plane request timeouts and SHALL report stable stages covering
credential setup, remote-ref resolution, repository transfer, checkout,
submodules, and credential cleanup. The repository transfer stage SHALL execute
as a detached supervised job through the shared detached-job primitive, and its
liveness SHALL be governed by dual gates replacing the single wall-clock
deadline for that stage only: a no-progress heartbeat gate that fails the
transfer when the job's progress stream shows no byte-growth or mtime advance
for the configured no-progress window, and an absolute cap bounding total
transfer time. Both gates SHALL be configurable policy knobs validated with
min/max bounds following the existing provisioning-policy snapshot pattern,
with defaults of 90 seconds (no-progress) and 1 hour (absolute cap).
Non-transfer stages SHALL retain the existing deadline semantics.

The repository transfer stage SHALL retry automatically on transient failure:
up to three attempts total within the unchanged materialization deadline, with a
short backoff between attempts, and no attempt SHALL start when the remaining
deadline budget is below a safe floor. Only failures whose typed cause is
TLS/network or the unknown fallback are retried; authentication, missing
branch/ref, capacity-exhaustion, and timeout failures SHALL NOT retry. Each
attempt SHALL be independently observable in diagnostics — a non-final failed
attempt settles as retryable and a subsequent attempt emits its own start — so
retries are never silent; the one-start/one-terminal invariant applies per
attempt. The transfer command SHALL remain idempotent so every attempt starts
from a clean workspace.

Failures SHALL normalize at least capacity
exhaustion, timeout, authentication, TLS/network, missing branch/ref, and an
unknown fallback into secret-free typed results, and a transfer failed by
either liveness gate SHALL normalize to the typed timeout result. Stable Git
transport signatures observed on the transfer's captured output SHALL map to
the typed causes — connection reset/refused/timed-out, unresolvable host, RPC
failure, unexpected disconnect, early EOF, and transfer-closed map to
TLS/network; filesystem-full maps to capacity exhaustion; authentication-failed
and 401/403 responses map to authentication — with the raw output inspected
only in memory and never persisted, and unmatched output still normalizing to
the unknown fallback (never a fabricated cause). Each logical
stage attempt SHALL emit
at most one correlated start and one terminal or degraded diagnostic outcome,
and the emitted stage/cause SHALL agree with the provider-neutral result.
Diagnostic events SHALL NOT contain repository URLs, command or argv text,
stdout/stderr, temporary credential paths, request bodies, or raw Git/provider
errors. Cleanup SHALL execute in all success, failure, timeout, cancellation,
and retry paths, a cleanup failure SHALL remain secondary to the materialization
failure, and a retry SHALL be idempotent for the same task/workspace plan.

#### Scenario: Slow repository uses the workspace deadline

- **WHEN** repository transfer exceeds the provider's short control-plane timeout but completes within the configured workspace deadline
- **THEN** materialization continues and succeeds
- **AND** unrelated BoxLite health/create/inspect requests retain their shorter timeout

#### Scenario: Healthy slow clone outlives the legacy wall clock

- **WHEN** a repository transfer keeps advancing its progress stream but takes longer than the legacy 15-minute materialization deadline while staying under the absolute cap
- **THEN** the transfer is not killed and materialization succeeds

#### Scenario: Stalled transfer fails at the heartbeat gate

- **WHEN** a transfer's progress stream shows no byte-growth or mtime advance for the configured no-progress window (default 90 seconds)
- **THEN** the transfer stage settles as a typed materialization timeout well before the absolute cap
- **AND** sandbox-owned temporary state is cleaned up

#### Scenario: Runaway transfer fails at the absolute cap

- **WHEN** a transfer keeps emitting progress but exceeds the configured absolute cap (default 1 hour)
- **THEN** the transfer stage settles as a typed materialization timeout at the cap

#### Scenario: Liveness knobs are validated with bounds

- **WHEN** a deployment configures a no-progress window or absolute cap outside the allowed min/max range
- **THEN** policy snapshotting rejects or clamps the value per the provisioning-policy validation pattern rather than running with an unvalidated gate

#### Scenario: Transient network failure is retried and succeeds

- **WHEN** a repository transfer attempt fails with a TLS/network-class cause (for example a mid-transfer connection reset) and deadline budget remains
- **THEN** the transfer is retried from a clean workspace and materialization succeeds when a subsequent attempt completes
- **AND** the diagnostic stream shows the failed attempt settling as retryable followed by the new attempt's own start and terminal outcome

#### Scenario: Deterministic failures do not retry

- **WHEN** a repository transfer attempt fails with an authentication, missing-ref, or capacity-exhaustion cause
- **THEN** no further transfer attempt is made and the stage settles with that typed cause

#### Scenario: Retry respects the remaining deadline budget

- **WHEN** a transfer attempt fails but the remaining materialization deadline is below the safe attempt floor
- **THEN** no further attempt starts and the stage settles with the attempt's typed cause

#### Scenario: Git transport signatures map to typed network causes

- **WHEN** a transfer attempt's captured output carries a stable Git transport signature such as a connection reset, RPC failure, unexpected disconnect, or early EOF
- **THEN** the failure normalizes to the TLS/network typed cause rather than the unknown fallback
- **AND** no raw output text is persisted in diagnostics

#### Scenario: Unmatched output still falls back to unknown

- **WHEN** a transfer attempt fails with output matching no stable signature
- **THEN** the failure normalizes to the unknown fallback (never a fabricated cause)

#### Scenario: Disk exhaustion is distinguishable from authentication

- **WHEN** repository transfer fails because the guest filesystem is full after refs authentication succeeded
- **THEN** the provider returns the transfer stage with a capacity-exhaustion reason
- **AND** it does not misclassify the failure as an invalid forge credential

#### Scenario: Cancellation cleans temporary authentication

- **WHEN** a task is stopped or a materialization lease is superseded during repository transfer
- **THEN** provider execution is cancelled or fenced
- **AND** temporary credentials are removed before the sandbox is retained or deleted

#### Scenario: Materialization failure survives credential-cleanup failure

- **WHEN** repository transfer fails and removing its temporary credential state also fails
- **THEN** the transfer stage and its safe primary cause remain unchanged
- **AND** credential cleanup is emitted as a separate safe cleanup outcome
