## ADDED Requirements

### Requirement: Terminal teardown captures the task rollout to durable storage
The guardrails service SHALL invoke a best-effort transcript capture at BOTH
terminal chokepoints — `onTerminal` (natural completion) and `forceFail` (all
abnormal causes: deadline, idle, circuit-breaker, abnormal-exit,
provision-failed) — persisting the task's codex rollout to durable storage while
the container is still present, immediately before (or around) the existing
stop-only `teardownSandbox`. The capture SHALL NOT change the stop-only teardown
or slot-free semantics, and SHALL NOT block, delay, or fail them: a capture error
SHALL be logged and swallowed so the terminal transition and slot release proceed
unconditionally.

#### Scenario: Natural completion captures before stop-only teardown
- **WHEN** `onTerminal` fires for a task reaching a natural terminal state
- **THEN** the guardrails service invokes the best-effort transcript capture while the container is still present, then performs the existing stop-only `teardownSandbox`

#### Scenario: Force-fail captures before stop-only teardown
- **WHEN** `forceFail` fires for any abnormal cause (deadline, idle, circuit-breaker, abnormal-exit, provision-failed)
- **THEN** the guardrails service invokes the best-effort transcript capture while the container is still present, then performs the existing stop-only `teardownSandbox`

#### Scenario: Capture failure does not block the terminal transition or slot release
- **WHEN** the transcript capture throws or fails during a terminal teardown
- **THEN** the error is logged and swallowed, and the task's terminal transition, stop-only teardown, and slot release proceed unaffected
