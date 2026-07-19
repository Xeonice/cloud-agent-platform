## MODIFIED Requirements

### Requirement: Guardrails owns diagnostic attempt lifecycle across every admission mode

Guardrails SHALL create a diagnostic attempt only after legacy or durable
admission wins running capacity and before provider selection or the first
provider boundary, SHALL pass that attempt's emitter through all provider and
host-runtime setup operations, and SHALL settle the attempt exactly once after
its primary and cleanup outcomes are known. The legacy synchronous path and
durable worker path SHALL use the same attempt recorder, stage vocabulary,
failure classifier, and cleanup disposition. HTTP or MCP disconnect SHALL NOT
cancel, discard, or detach diagnostic settlement from the accepted task. Task
cancellation SHALL fence subsequent provider work and SHALL settle the attempt
as cancelled only after cleanup has been attempted.

Task cancellation SHALL synchronously fence later provider boundaries and
signal task-owned in-flight provider work to stop. The committed Task terminal
transition SHALL be the linearization point for choosing the diagnostic primary,
structured failure log, and audit projection. After provider settlement,
Guardrails SHALL revalidate that terminal winner before projecting any
provisioning failure. If cancellation won, Guardrails SHALL settle the primary
as cancelled, preserve cleanup as an independent outcome, clear runtime state,
and SHALL NOT force-fail, launch an agent, or emit a competing terminal audit.
Cleanup SHALL use provider-backed evidence even when the legacy owner has not
yet reached running state.

Committed/unclaimed and capacity-queued durable work SHALL remain observable
through the canonical admission state and task diagnostic-version expectation
with `coverage = not_started`; Guardrails SHALL NOT fabricate a provider attempt.
Queue polling and promotion under the same durable work lineage SHALL open exactly
one diagnostic identity only when running provider processing begins. An expired
open running/provider claim SHALL create the next identity, and terminal recovery
SHALL continue existing evidence or report it partial/unavailable.

#### Scenario: Legacy request disconnect preserves the attempt

- **WHEN** a legacy task-create request disconnects while provider provisioning continues
- **THEN** Guardrails continues recording and eventually settles the task-owned diagnostic attempt
- **AND** later authorized reads can observe the same attempt without relying on the disconnected request log

#### Scenario: Durable and legacy paths classify the same injected failure equally

- **WHEN** the same provider runtime-setup failure is injected once through legacy admission and once through durable admission
- **THEN** both attempts record the same safe stage, operation outcome, and primary cause
- **AND** neither path falls back to provider prose or a mode-specific diagnostic format

#### Scenario: Cancellation waits for cleanup disposition

- **WHEN** a task is cancelled while its provider operation is active
- **THEN** Guardrails fences later launch work, requests provider cleanup, and records its cleanup disposition
- **AND** it settles the attempt as cancelled without losing a cleanup failure

#### Scenario: Capacity wait is visible without a fabricated provider attempt

- **WHEN** accepted durable work is unclaimed or waiting for a running slot
- **THEN** the task exposes its accepted/queued admission state and not-started diagnostic coverage
- **AND** Guardrails opens no provider attempt until running capacity is won

#### Scenario: Cancellation wins while legacy provisioning is active

- **WHEN** task cancellation commits while a legacy provider create or workspace operation is active
- **THEN** Guardrails aborts the task-owned provider signal, fences every later external boundary, and retains cancelled as the only terminal lifecycle outcome
- **AND** late provider success or failure cannot launch runtime, force-fail the task, or overwrite its diagnostic primary

#### Scenario: Cancellation settles diagnostics after truthful cleanup

- **WHEN** the cancelled provider continuation and terminal cleanup converge
- **THEN** the attempt records one cancelled primary plus the provider-confirmed cleanup outcome
- **AND** it does not remain active or report cleanup succeeded before physical evidence exists
