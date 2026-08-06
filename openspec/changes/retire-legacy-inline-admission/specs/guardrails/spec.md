## ADDED Requirements

### Requirement: The legacy inline-admission pipeline is retired whole, and nothing survives to re-enter the orchestrator

The synchronous in-request admission pipeline SHALL be deleted in its entirety, together with every
seam that reached it in either direction. Deletion SHALL be verifiable by absence rather than by
inspection: no symbol naming the pipeline, its entry port, its reverse-callback port, or its state
holder may remain anywhere in source.

The reverse-callback surface is the load-bearing half and SHALL be named as such. The pipeline calls
back into the orchestrator through a 20-member port with 59 call sites, all of them inside the
pipeline's own file. Nothing outside the deleted directory ever held that port, so nothing survives
that could re-enter the orchestrator — but a retirement that deleted the forward seam while leaving
the reverse interface declared would leave the coupling's shape behind, and SHALL be refused.

Deleting the adapter orphans private orchestrator methods whose only caller was that adapter. Those
methods SHALL be deleted with it rather than left unreachable, and a method retained solely to keep
a test compiling SHALL be treated as the defect, not the fix.

The premise that production no longer carries legacy traffic was SUPPLIED BY THE USER and is NOT a
measurement from this tree. The provisioning-diagnostics write gate is default-closed, so the
absence of persisted rows recording legacy admission is not evidence of the absence of legacy
traffic. Every artifact this change produces that repeats the premise SHALL attribute it to the user
in those words.

#### Scenario: No symbol reaches the retired pipeline

- **WHEN** the source tree is searched for every identifier naming the pipeline, its entry port, its
  reverse-callback port, or its state holder
- **THEN** zero matches are found outside archived change directories, in production code and tests
  alike, and the directory itself no longer exists

#### Scenario: The reverse-callback surface is gone rather than re-declared

- **WHEN** the tree is searched for calls through the orchestrator callback port
- **THEN** zero remain, and no file declares an interface carrying that port's member set under any
  name, so the coupling was removed rather than renamed

#### Scenario: Orphaned methods leave with their only caller

- **WHEN** the orchestrator is searched for the private methods whose sole caller was the adapter
- **THEN** none is declared, and the near-namesake the durable path uses is untouched and still
  called from the durable launch path

#### Scenario: The premise is attributed, not asserted

- **WHEN** the change's artifacts are read for the claim that production carries no legacy traffic
- **THEN** every occurrence attributes it to the user as a supplied premise, and none presents it as
  measured, because this repository cannot measure it

### Requirement: The three ratchet movements this retirement causes are told apart by name

This change SHALL record each of three ratchet movements under its own name, and SHALL NOT describe
one as another — a retirement moves ratchets in three different ways, and conflating them is how a
burn-down gets forged:

- **Entries whose FILES disappear are deleted.** The cross-context, prisma-outside-store, and
  unclassified-file entries keyed on paths inside the retired directory are removed because the paths
  no longer exist. A vanished file is the only lawful reason to delete a path-keyed entry.
- **One symbol-reference entry is LOWERED, not deleted.** The runner-minutes entry falls by one
  because a write reference inside a legacy-only method is genuinely deleted. The measured symbol
  string is unchanged and the collaborator is still named, so the entry stays in the baseline at its
  new count.
- **Two symbol-reference entries DO NOT MOVE.** The provisioning-diagnostics recorder and write gate
  each stay where they are, because the orchestrator's read of them feeds a second consumer that this
  change does not touch. Neither entry may be deleted, and the count may not be reported as falling.

#### Scenario: The vanished-path entries are deleted and the reason is the vanished path

- **WHEN** the cross-context ratchet is compared before and after
- **THEN** every entry removed is keyed on a path inside the retired directory, and no entry keyed on
  a surviving file was removed

#### Scenario: The lowered entry stays in the baseline

- **WHEN** the dependency-budget baseline is read after the change
- **THEN** the runner-minutes entry is present at its new count with its symbol byte-identical, and
  its record states that the delta equals the write reference the retirement deleted

#### Scenario: The unmoved entries are unmoved and still measured

- **WHEN** the dependency-budget gate's measurement is run over the post-change orchestrator
- **THEN** the provisioning-diagnostics recorder and write gate report the same counts as before the
  change, both entries are still present in the baseline, and no record claims a decrease

## MODIFIED Requirements

### Requirement: Admission mode is chosen by an explicit total policy over the capability gate

There SHALL BE NO CHOICE between admission pipelines. The legacy inline pipeline is retired, so
every accepted task enters durable admission regardless of what the capability gate reports — an
unproven capability (attestation missing, expired, mixed build identity, or no gate provider wired)
SHALL resolve to durable admission exactly as an open gate does. There SHALL be no refusal path, no
`503`, and no third member of the admission-mode union: the branch is REMOVED, not widened.

What this gives up SHALL be recorded rather than glossed: the policy's own reason for degrading —
that a mixed-version deployment may not be able to honour durable admission — is abandoned, and the
retirement lands WITHOUT attestation renewal being automated, so a deployment whose attestation has
expired now runs durable rather than degrading. That is acceptable only because admission never
refuses; it would be unacceptable under a refusing design.

The historical policy this replaces read: choosing between the durable and legacy admission pipelines was a single
named policy that consumes the deployment-capability gate's full result, not a
boolean flattening of it. The policy SHALL be a total mapping over the gate's
closed reasons, so that introducing a new closed reason without deciding its
consequence fails to compile rather than silently inheriting a default. A gate
provider that is absent SHALL resolve to its own named outcome, distinct from
every reason a present gate can report. The chosen mode SHALL still be read
exactly once per acceptance and frozen for every later decision including the
transaction write.

This requirement governs how the mode is chosen and what the choice carries. It
does not change which mode is chosen: an unproven capability continues to resolve
to the legacy pipeline. **That sentence is now historical: no legacy pipeline exists to resolve to.**

#### Scenario: A closed gate resolves through the policy carrying its reason

- **WHEN** a task is accepted while the capability gate reports closed with a
  reason such as `deployment_attestation_expired`
- **THEN** the policy SHALL resolve the admission mode to durable and the resolved
  decision SHALL carry that reason, rather than reducing the gate result to a
  boolean before choosing

#### Scenario: An absent gate provider is distinguishable from a closed gate

- **WHEN** a task is accepted in a context where no admission gate provider is
  wired
- **THEN** the policy SHALL resolve to durable under a named outcome that is not
  any of the gate's closed reasons, so a dependency-injection regression is not
  reported as a legitimately closed gate

#### Scenario: An open gate resolves to durable admission unchanged

- **WHEN** a task is accepted while the capability gate is open
- **THEN** the policy SHALL resolve the admission mode to durable, and the frozen
  mode SHALL drive the same acceptance, transaction, and diagnostic behaviour as
  before this change

#### Scenario: A new closed reason cannot be added without deciding its consequence

- **WHEN** a closed reason is added to the deployment-capability gate without a
  corresponding entry in the policy
- **THEN** the project SHALL fail to typecheck, rather than compiling and letting
  the new reason inherit an unstated fallback

### Requirement: Three collaborator groups leave the orchestrator together, each at its own measured floor

This change SHALL remove references to three collaborators in one commit series, and SHALL record a
SEPARATE floor for each rather than one headline number, because the three floors have three
different causes. The floors are: provisioning diagnostics from 8 to **4**, transcripts from 2 to
**1**, and metrics-projection from 2 to **2 — unmoved**. Every count SHALL be established by running
the dependency-budget gate's own measurement over the post-change file, never by counting deleted
lines, and never by grepping the identifier a collaborator used to have.

The metrics-projection floor is **2, the same 2 it started at**, and saying so is the point. The port
extraction renamed that collaborator's symbol; the orchestrator kept naming it exactly as often as
before. A count that falls because an identifier was renamed is a forged burn-down, and an entry
retired on that basis leaves a live coupling with nothing measuring it. What this change delivers for
that group is a change of FORM — a bare module import became a port import, which is what moves the
cross-context ratchet — not a removal.

The transcript floor is **1, not 0**, and the reason SHALL be recorded rather than left as an
unexplained shortfall: the orchestrator's transcript capture is awaited at both terminal chokepoints
BEFORE the stop-only sandbox teardown, so that the archive write happens while the container still
exists. That happens-before is carried by the awaited call itself. Removing the call would move a
correctness guarantee into an ordering the framework does not promise, so the awaited call SHALL be
retained and only the optional-reference guard beside it SHALL disappear. A change that reports this
group as burned down, or that removes the awaited call in exchange for an event, SHALL be refused.

The diagnostics floor is **4, not 2**, because the two constructor parameters survive: the
orchestrator still passes both into the legacy inline-admission adapter, and that pass-through is
out of that change's scope. **The claim that the floor moves to 2 after legacy retirement is FALSE
and is corrected here by measurement**: retiring the legacy pipeline leaves the floor at 4, delta
ZERO. The mechanism is that the orchestrator's single read of the diagnostic collaborators feeds TWO
consumers — the legacy adapter and the durable diagnostics owner — so retirement removes one
consumer while the read itself survives. Verified by SIMULATE-THEN-MEASURE: deleting the adapter
literal from the source and running the dependency-budget gate's own measurement over the result
reports recorder 2 and write gate 2. A future change SHALL NOT delete these two entries on the
strength of the retired claim; their collaborator has not left.

#### Scenario: Each group's post-change count is measured, not inferred

- **WHEN** the dependency-budget gate's measurement function is run over the post-change
  `guardrails.service.ts`
- **THEN** it reports provisioning-diagnostics recorder 2, write gate 2, transcripts 1, and
  metrics-projection 2 — the last measured against the collaborator's NEW symbol, since measuring the
  old one would report a zero that only the rename produced — and each of those numbers appears in the
  change's records with the command that produced it

#### Scenario: The awaited transcript capture survives at its seam

- **WHEN** a task reaches a terminal state through either terminal chokepoint
- **THEN** the transcript capture is still awaited to completion BEFORE the stop-only teardown runs,
  the surviving reference is that awaited call, and the transition, teardown, and slot release still
  proceed unconditionally when capture fails

#### Scenario: The diagnostics pass-through into legacy is untouched

- **WHEN** the orchestrator's construction of the legacy inline-admission pipeline is read
- **THEN** it still passes both the diagnostic recorder and the write gate, so both constructor
  parameters remain live and the group's floor is 4 rather than 2

#### Scenario: No group is reported as burned down

- **WHEN** the change's records describing the three outcomes are read
- **THEN** none of the three is described as burned down or as reaching zero, and in particular
  metrics-projection is described as unmoved at 2 with its entry retained, because its old symbol's
  zero was a rename rather than a removal
