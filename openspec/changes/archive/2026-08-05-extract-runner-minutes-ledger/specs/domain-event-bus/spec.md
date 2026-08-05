## MODIFIED Requirements

### Requirement: The dependency budget ratchet is seeded with measured counts

The R11 dependency-budget ratchet records, per collaborator, the number of guardrails symbol references that the phase-4 migrations must burn down. Counts SHALL be measured live on the change's own tree rather than copied from documentation. The measured seed established when the baseline was created was: `this.audit` 9, `this.runnerMinutes` 6, `provisioningDiagnosticRecorder` 4, `provisioningDiagnosticWriteGate` 4, `this.transcripts` 2, metrics-projection 2. The ratchet SHALL be fail-closed in both directions: a count above baseline fails, and a stale entry whose real count is lower also fails until the baseline is reduced in the same commit.

A change that lowers a recorded count SHALL lower it only by deleting symbol references, and SHALL prove that in the same commit: the measured symbol string SHALL be unchanged (renaming the field is a forged burn-down, since the counter is a `\b`-anchored regex over that exact symbol), and the delta from the previous count SHALL equal the number of references that change removes, as named in that change's durable removal record (the adjudication table where the change produces one). An entry SHALL be reduced, never deleted, while its live count is above zero. The `samples` array is documentation and does not participate in comparison; a change that edits an entry SHALL refresh its stale sample lines in the same commit.

The reconciliation is stated **per collaborator and per change**, not against the original seed forever: each change reconciles only the entries it lowers, SHALL leave every entry it does not touch byte-identical, and its "no other collaborator moved" obligation is measured against the counts at the START of that change rather than against the seed. A later change lowering a different collaborator therefore does not retroactively falsify an earlier change's reconciliation.

#### Scenario: The baseline matches a live re-count

- **WHEN** the ratchet is run against the integrated tree
- **THEN** each recorded count equals the live count for that collaborator and the ratchet exits 0

#### Scenario: An added call site turns the ratchet red

- **WHEN** one extra call to a budgeted collaborator is injected into `guardrails.service.ts`
- **THEN** the ratchet fails and names the collaborator whose count rose

#### Scenario: A stale higher baseline also turns the ratchet red

- **WHEN** a call site is removed without lowering the recorded count in the same commit
- **THEN** the ratchet fails on the stale entry rather than passing because the tree is "better than baseline"

#### Scenario: The audit delta equals that change's adjudicated removals

- **WHEN** the recorded `this.audit` count on the audit-adjudication change's integrated tree is compared with that change's starting count of 9
- **THEN** the difference equals the number of adjudication rows marked REMOVED (0 if the provisioning-progress hint is retained, 1 if its coverage proof succeeded), and no other collaborator's count was changed **by that change**

#### Scenario: A change reconciles only the entries it lowers

- **WHEN** a change lowers exactly one collaborator's recorded count
- **THEN** its own entry carries the delta reconciliation, and the other five entries in `scripts/ratchets/r11.json` are byte-identical to their form at the start of that change

#### Scenario: A renamed field cannot be presented as a burn-down

- **WHEN** the measured symbol of the entry a change lowered is compared before and after that change
- **THEN** it is unchanged (`this.audit` for the audit adjudication, `this.runnerMinutes` for the runner-minutes ownership move), so the count reflects deleted references rather than a symbol the regex no longer matches

#### Scenario: A non-zero entry is reduced rather than deleted

- **WHEN** any entry whose live count is still above zero is inspected after the change that lowered it
- **THEN** it is still present with its remaining count and refreshed sample lines, because deletion is reserved for entries whose live count reaches zero

## ADDED Requirements

### Requirement: The runner-minutes budget entry falls from 6 to 5 as a measured first decrease, not a burn-down

The `guardrails-symbol-reference:this.runnerMinutes` entry SHALL be lowered from 6 to 5 in the
same commit that deletes the read reference, and SHALL NOT be deleted, because its live count
stays above zero. Reaching 0 is structurally unreachable while guardrails still writes to the
ledger — R11 counts symbol references and the five write references survive by design — so the
recorded outcome SHALL be stated as a FIRST DECREASE and SHALL NOT be described as a burn-down of
the runner collaborator.

The change SHALL additionally record, in a durable artifact, the ceiling that the event-subscriber
route could reach for this collaborator and why, so that a later change does not re-derive it from
scratch or assume 0 is available. That ceiling is **1, not 0**: three `recordStart` references are
covered by `TaskRunStarted` and the `fenceTerminal` `recordEnd` by `TaskSettled`, but the second
`recordEnd` — the `clearAdmissionRuntime` teardown of a superseded attempt whose task is still
alive — has no lawful covering event, because publishing `TaskSettled` there is forbidden by a
standing negative requirement written expressly so a later change cannot "fix" the 2-call-sites-to-1-event
asymmetry. The record SHALL also name the two costs that route carries beyond the spec conflict:
every reflective runner-minutes assertion in `guardrails.service.spec.ts` is a NEGATIVE assertion
(`intervals()` deep-equals `[]`, or no interval has a null `endedAt`), so a guardrails that stopped
recording would make all of them pass **vacuously** — zero-diff satisfied while the assertions stop
testing anything; and accounting driven by subscribers becomes fail-open under the publish
escape-hatch, which the retained-calls scenario keeps it immune to today. The entry's `change` field SHALL carry the anti-forgery reconciliation:
the delta of 1 equals exactly the one removed read reference, and the measured symbol string is
still `this.runnerMinutes`. The entry's `samples`, stale by one generation at lines
1566/2038/2623/2949/2971/3555 against the live 1824/2319/2917/3264/3286/3880, SHALL be refreshed
to the five surviving references at their live line numbers in the same commit.
`scripts/ratchets/r11-dependency-budget.test.mjs` hard-codes the expected mapping (`:73`) and
SHALL be updated in that same commit; it and the two shared writer source files
(`guardrails.service.ts`, `metrics.service.ts`) SHALL be integrated on a single serial track
rather than in parallel tracks.

Reaching 5 is a property of HOW the orchestrator obtains the collaborator, not only of the deletion:
the counter scans raw source text line by line and strips nothing, so a re-assignment of the
measured symbol, a type annotation naming it, or a comment quoting it each counts as one. A change
that deletes a reference and reintroduces the symbol elsewhere in the same file has moved the
reference, not removed it, and SHALL NOT record a decrease. The entry's recorded count SHALL
therefore be reconciled against the gate's own measurement of the post-change file rather than
against the count of deleted call sites.

#### Scenario: The entry reads 5 and the live count agrees

- **WHEN** `pnpm test:dependency-budget` is run on the integrated tree
- **THEN** it exits 0, the recorded `this.runnerMinutes` count is 5, and a live re-count of
  `this.runnerMinutes` in `guardrails.service.ts` is also 5

#### Scenario: The symbol is not reintroduced by the resolution plumbing or by a comment

- **WHEN** the gate's own `measureSource` is run over the post-change `guardrails.service.ts`, whose
  text includes every comment the change added
- **THEN** it returns 5, so no re-assignment, type annotation, or comment restored the reference the
  deletion removed — a design in which the orchestrator re-names the collaborator to obtain it
  would return 6 and is refused

#### Scenario: The delta is reconciled to exactly the removed read

- **WHEN** the entry's `change` field is read
- **THEN** it states that 6 − 5 = 1 equals the single removed reference
  (`return this.runnerMinutes.intervals();`) and that the measured symbol string is unchanged

#### Scenario: The entry is refreshed, not deleted

- **WHEN** `scripts/ratchets/r11.json` is read after the change
- **THEN** the `this.runnerMinutes` entry is still present with `count: 5`, its `symbol` is still
  `this.runnerMinutes`, and its `samples` list the five surviving call sites at their live line
  numbers with zero lines carried over from the stale generation

#### Scenario: No other collaborator entry moves

- **WHEN** the other five entries are compared with their form at the start of this change
- **THEN** `this.audit` 9, `provisioningDiagnosticRecorder` 4, `provisioningDiagnosticWriteGate` 4,
  `this.transcripts` 2, and metrics-projection 2 are unchanged in count and byte-identical in
  `symbol`

#### Scenario: The outcome is recorded as a first decrease

- **WHEN** the change's records describing the R11 result are read
- **THEN** they state 6 → 5 together with the reason 6 → 0 is unreachable while the five write
  references remain, and zero records claim the runner collaborator is burned down or that its
  entry may now be deleted

#### Scenario: The event-route ceiling is recorded as 1 with its blocking evidence

- **WHEN** the durable artifact's entry for the runner group is read
- **THEN** it states the ceiling as 1 rather than 0, cites the `clearAdmissionRuntime` `recordEnd`
  as the one reference no event may lawfully cover together with the standing requirement that
  forbids publishing `TaskSettled` at that seam, and names both further costs — that the reflective
  runner-minutes assertions would pass vacuously rather than fail, and that subscriber-driven
  accounting becomes fail-open under the publish escape-hatch

#### Scenario: The hard-coded ratchet test moves in the same commit

- **WHEN** the commit that edits `scripts/ratchets/r11.json` is inspected and
  `scripts/ratchets/r11-dependency-budget.test.mjs` is run on the integrated tree
- **THEN** both files appear in that same commit, and the test passes with its expected
  `this.runnerMinutes` mapping at 5
