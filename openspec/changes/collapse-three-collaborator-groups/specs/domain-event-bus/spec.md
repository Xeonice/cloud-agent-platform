## ADDED Requirements

### Requirement: Two budget entries are reduced and one is deleted, in the same commit and by different rules

This change SHALL exercise BOTH halves of the ratchet's entry discipline at once, so the pair is
recorded as a worked example rather than as prose for a future change to interpret:

- **Reduced, never deleted** — `provisioningDiagnosticRecorder` 4 → 2,
  `provisioningDiagnosticWriteGate` 4 → 2, and `this.transcripts` 2 → 1. Each entry SHALL keep its
  `symbol` byte-identical, SHALL refresh its `samples` to the surviving references at their
  post-change line numbers, and SHALL carry in its `change` field the arithmetic reconciliation and
  the reason its floor is where it is.
- **Deleted, never recorded as zero** — the metrics-projection entry reaches a live count of 0 and
  SHALL be removed from the baseline file entirely. Leaving a `count: 0` entry is as red as leaving
  a stale one, because the comparator is fail-closed in both directions.

The collaborator declaration in the gate itself SHALL fall from six entries to five in the same
commit, and the gate's own hard-coded expectation SHALL move with it. The count a change records
SHALL be the gate's measurement of the post-change file, not a count of deleted call sites: a
reference removed from one line and reintroduced on another — as an assignment, a type annotation,
or a comment, none of which the counter strips — has moved rather than gone.

#### Scenario: The reduced entries reconcile to their own deltas

- **WHEN** each reduced entry's `change` field is read
- **THEN** it states the arithmetic (4 − 2 = 2 removed local aliases for each diagnostics entry,
  2 − 1 = 1 removed optional guard for transcripts), states that the measured symbol string is
  unchanged, and names the floor's cause rather than presenting the floor as a target that was hit

#### Scenario: The zeroed entry is deleted rather than zeroed

- **WHEN** the baseline file is read after the change
- **THEN** it holds no entry for metrics-projection at all, and the gate's collaborator declaration
  lists five collaborators rather than six

#### Scenario: The gate agrees with its own baseline on the integrated tree

- **WHEN** the dependency-budget gate and its paired test are run on the integrated tree
- **THEN** both exit 0, so every recorded count equals a live re-count and no entry is stale in
  either direction

#### Scenario: Untouched entries are byte-identical

- **WHEN** the entries this change does not lower are compared with their form at its start
- **THEN** `this.audit` 9 and `this.runnerMinutes` 5 are unchanged in count and in `symbol`
