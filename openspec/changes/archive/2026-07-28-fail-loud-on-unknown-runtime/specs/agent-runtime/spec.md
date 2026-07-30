## MODIFIED Requirements

### Requirement: No agent-identity branch exists in shared scaffolding
Shared scaffolding SHALL NOT branch on agent identity (`runtime.id === 'codex'`, `!==
'codex'`, or equivalent) — this applies to the pty client, the provider, the liveness
poller, and any integration/registry wiring. Any per-agent difference SHALL be carried
by the runtime's declared policy and read by the mechanism. An identity check disguised
as a port call (e.g. an `autoSubmit()` that returns `id === 'codex'`) SHALL NOT exist.

This SHALL hold wherever a decision is keyed on which agent is running, not only on the
terminal path: credential resolution, image preflight, transcript format selection, and
model-catalogue routing are shared scaffolding for this purpose.

Where a decision maps every runtime to a value, it SHALL be expressed as a TOTAL
mapping, so that introducing a runtime id is a COMPILE error at every site that must
decide something for it. Where a total mapping does not fit, an unrecognised runtime
SHALL raise a named error. A shared decision point SHALL NOT fall through to a default
runtime, return an empty result, or skip a validation it performs for known ids — a
warning log is not a gate, and an unrecognised runtime that keeps executing is a wrong
answer delivered quietly.

The absence of agent-identity branching SHALL be enforced by an executable check rather
than by review.

#### Scenario: Mechanism reads policy, not identity
- **WHEN** the pty client decides whether to reply to the startup DSR or inject a
  submit Enter
- **THEN** it reads the runtime's declared `terminalStartup`, and a grep of the
  shared-scaffolding sources for `id === 'codex'` / `id !== 'codex'` finds zero matches

#### Scenario: Adding a runtime id fails the build at every decision point
- **WHEN** a new member is added to the runtime id union
- **THEN** compilation fails at every total mapping that must produce a value for it —
  transcript format, credential resolution, preflight probes, model-catalogue routing —
  until each supplies one
- **AND** no such mapping compiles by silently reusing another runtime's value

#### Scenario: An unrecognised runtime is refused, not defaulted
- **WHEN** a task carries a runtime id that resolves to no registered runtime
- **THEN** the resolution raises a named error
- **AND** the task does not execute as a different agent

#### Scenario: Validation performed for known runtimes is not skipped for others
- **WHEN** an image's declared dependencies are checked for a task's runtime
- **THEN** an unrecognised runtime fails that check
- **AND** it does not pass by falling outside the condition that performs it

#### Scenario: The rule is enforced mechanically
- **WHEN** an agent-identity branch is introduced into shared scaffolding
- **THEN** a repository check fails and names the offending location
