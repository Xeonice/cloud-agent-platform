# sandbox-provider-port

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
Non-transfer stages SHALL retain the existing deadline semantics. Failures
SHALL normalize at least capacity
exhaustion, timeout, authentication, TLS/network, missing branch/ref, and an
unknown fallback into secret-free typed results, and a transfer failed by
either liveness gate SHALL normalize to the typed timeout result. Each logical
stage SHALL emit
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

## ADDED Requirements

### Requirement: Workspace transfer reports parsed clone progress

The detached repository transfer SHALL run `git clone` with `--progress`, with
stderr redirected to the job's progress marker, and SHALL parse that stream
tolerating git's multiple phases (Counting/Compressing/Receiving
objects/Resolving deltas), CR-delimited progress lines, and phases that carry
no percentage. The workspace progress event SHALL gain an additive variant
carrying only numeric transfer-progress facts — percent, receivedObjects,
totalObjects, receivedBytes, and throughput — where phases without a known
percentage SHALL be reported as explicitly unknown rather than 0. Progress
reporting SHALL remain best-effort/fire-and-forget: durable work state stays
authoritative and a lost progress report SHALL NOT fail or settle the stage.
The detached clone SHALL set `GIT_HTTP_LOW_SPEED_LIMIT`/`GIT_HTTP_LOW_SPEED_TIME`
as defense in depth so a stalled transfer self-terminates into a clean nonzero
exit marker.

#### Scenario: Receiving-objects percent is parsed and reported

- **WHEN** the detached clone's progress marker contains a CR-delimited `Receiving objects: 42% (N/M)` line
- **THEN** the emitted progress variant reports percent 42 with the parsed object counts
- **AND** the payload contains only numeric fields — no raw stderr text, URLs, or commands

#### Scenario: Pre-transfer phases report unknown, not zero

- **WHEN** the clone is still in a phase before object-transfer counts exist (e.g. remote counting)
- **THEN** the progress variant models percent as unknown/absent
- **AND** consumers can distinguish this from an actual 0% transfer

#### Scenario: Lost progress report does not affect settlement

- **WHEN** a progress report fails to deliver while the clone continues and eventually writes a success exit marker
- **THEN** the stage still settles as succeeded from the exit marker
- **AND** the missed report causes no stage failure or retry by itself

#### Scenario: Git self-terminates a low-speed stall

- **WHEN** the transfer rate stays below the configured low-speed limit for the configured low-speed time
- **THEN** git aborts the clone itself and the wrapper records a nonzero exit marker
- **AND** the stage settles as a typed failure without waiting for the external heartbeat gate
