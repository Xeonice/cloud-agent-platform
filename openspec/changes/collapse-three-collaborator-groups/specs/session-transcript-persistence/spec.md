## ADDED Requirements

### Requirement: Transcript capture moves out of the tasks context without moving its happens-before

The transcript capture service SHALL be reachable by the orchestrator without the orchestrator's
module importing the tasks module, so the composition edge that exists solely to reach this service
is removed. The orchestrator SHALL keep an AWAITED call to capture at both terminal chokepoints,
before the stop-only teardown. That awaited call is the mechanism carrying the ordering guarantee —
the archive write must happen while the sandbox still exists — and this change SHALL NOT replace it
with a published event, a fire-and-forget call, or a lifecycle hook, because the framework gives no
ordering guarantee across providers and the repository has already taken a production incident from
assuming otherwise.

What DOES disappear is the optional-reference guard beside the call: the port SHALL be injected
non-optionally, with a no-op implementation standing in wherever no capture provider is wired, so
the orchestrator no longer branches on the collaborator's presence. Capture SHALL remain best-effort
at the seam: a capture that throws or rejects SHALL be logged and swallowed so the terminal
transition, the teardown, and the slot release proceed unconditionally.

The move SHALL declare its new directory in the contexts manifest in the SAME commit, SHALL re-key
rather than shrink the path-keyed cross-context ratchet entries, and SHALL re-provide any token the
moved service injects that the tasks module provided without exporting.

#### Scenario: Capture completes before teardown begins

- **WHEN** a task reaches a terminal state and the recorded call sequence is inspected, with capture
  made artificially slow
- **THEN** capture has COMPLETED before the stop-only teardown is invoked, and the assertion is on
  completion ordering rather than on elapsed time, so it cannot pass by racing

#### Scenario: The ordering assertion discriminates

- **WHEN** the same assertion is run against an implementation whose capture call is not awaited
- **THEN** it fails — an assertion that passes against both implementations is not testing the
  guarantee and SHALL be rewritten

#### Scenario: A failing capture still lets the task settle

- **WHEN** the capture provider throws, rejects, and is absent, in three separate runs
- **THEN** in every case the terminal transition, the teardown, and the slot release still complete,
  and the orchestrator contains no branch on whether a capture provider exists

#### Scenario: The composition edge is gone and the module graph still boots

- **WHEN** the guardrails module's imports are read, and the application context is booted
- **THEN** it no longer imports the tasks module for transcript access, and boot completes with no
  unresolved-dependency error for any token the moved service injects
