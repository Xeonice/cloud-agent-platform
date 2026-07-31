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
than by review, and the check SHALL scan the COMPLEMENT: every production source in its
scope is scanned EXCEPT an explicit exemption list containing only the runtime
implementations themselves (currently two entries: the codex runtime and the
claude-code runtime). The check SHALL NOT enumerate the scaffolding files it scans — an
enumerated scanned-file list silently exempts every file nobody remembers to add. A
complement scan that matches ZERO files SHALL exit non-zero. A new hit SHALL be
resolved either by removing the branch or by adding a three-field exemption (file,
reason, owning change); an exemption entry missing a field SHALL fail the check's
audit. Test files remain out of the branch scan's scope.

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

#### Scenario: Enforcement scans everything except an explicit exemption list
- **WHEN** the branch check computes its scanned set
- **THEN** the set is the complement — all in-scope production sources minus the exemption list — not an enumerated allowlist of scaffolding files
- **AND** the exemption list contains only the runtime implementations, each entry carrying file, reason, and owning change

#### Scenario: An empty complement scan is a failure
- **WHEN** the complement scan resolves to zero files (e.g. a root moved or a glob broke)
- **THEN** the check exits non-zero instead of passing on nothing scanned

#### Scenario: A new scaffolding file is covered with no registration
- **WHEN** a new shared-scaffolding source containing an agent-identity branch is added, and no list is edited
- **THEN** the check fails naming that file
- **AND** the failure is resolved only by removing the branch or adding a three-field exemption

#### Scenario: A malformed exemption fails the audit
- **WHEN** an exemption entry lacks file, reason, or owning change
- **THEN** the check's self-audit exits non-zero naming the entry
