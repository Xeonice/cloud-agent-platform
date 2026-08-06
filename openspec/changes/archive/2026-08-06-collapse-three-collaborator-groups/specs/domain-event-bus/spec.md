## ADDED Requirements

### Requirement: Three budget entries are reduced and one is re-pointed, in the same commit and by different rules

This change SHALL exercise BOTH halves of the ratchet's entry discipline at once, so the pair is
recorded as a worked example rather than as prose for a future change to interpret:

- **Reduced, never deleted** — `provisioningDiagnosticRecorder` 4 → 2,
  `provisioningDiagnosticWriteGate` 4 → 2, and `this.transcripts` 2 → 1. Each entry SHALL keep its
  `symbol` byte-identical, SHALL refresh its `samples` to the surviving references at their
  post-change line numbers, and SHALL carry in its `change` field the arithmetic reconciliation and
  the reason its floor is where it is.
- **Re-pointed, never deleted on a rename** — the metrics-projection collaborator keeps its entry.
  Its OLD symbol reaches a live count of 0, but only because the port extraction renamed it; the
  orchestrator still names the collaborator exactly as many times as before. The entry's `symbol`
  SHALL therefore follow the collaborator to its new identifier and its `change` field SHALL state
  that the count did not move. Deleting it would retire the only measurement of a live coupling —
  the mirror image of a forged burn-down, and strictly worse than the state before this change.

An entry is deleted when its COLLABORATOR is gone, never when its identifier changed. The gate's
declaration therefore stays at six entries. The count a change records
SHALL be the gate's measurement of the post-change file, not a count of deleted call sites: a
reference removed from one line and reintroduced on another — as an assignment, a type annotation,
or a comment, none of which the counter strips — has moved rather than gone.

#### Scenario: The reduced entries reconcile to their own deltas

- **WHEN** each reduced entry's `change` field is read
- **THEN** it states the arithmetic (4 − 2 = 2 removed local aliases for each diagnostics entry,
  2 − 1 = 1 removed optional guard for transcripts), states that the measured symbol string is
  unchanged, and names the floor's cause rather than presenting the floor as a target that was hit

#### Scenario: The renamed entry survives and measures the new symbol

- **WHEN** the baseline file and the gate's declaration are read after the change
- **THEN** the metrics-projection entry is present with the port type as its `symbol` and a count of
  2, and the declaration still lists six collaborators — so the rename left nothing unmeasured

#### Scenario: The gate agrees with its own baseline on the integrated tree

- **WHEN** the dependency-budget gate and its paired test are run on the integrated tree
- **THEN** both exit 0, so every recorded count equals a live re-count and no entry is stale in
  either direction

#### Scenario: Untouched entries are byte-identical

- **WHEN** the entries this change does not lower are compared with their form at its start
- **THEN** `this.audit` 9 and `this.runnerMinutes` 5 are unchanged in count and in `symbol`
