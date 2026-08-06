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

### Requirement: TaskRunStarted is published at exactly two declared points

`TaskRunStarted` SHALL be published at exactly the two seams that begin a run's runner-minutes
interval, and nowhere else: (1) the readoption recovery path that restores a running task after
restart, publishing `startPoint: readoption`, and (2) the durable path `armDurableRuntime`,
publishing `startPoint: durable_arm`. Each SHALL publish exactly once per run start, adjacent to that
path's existing `runnerMinutes.recordStart(taskId)` call, and SHALL NOT replace or move it.

TWO IS A COUNT, NOT THREE MINUS ONE. It comes from
`grep -rn "'task.run_started'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`, which reports
two publish sites on the retired tree, both in `guardrails.service.ts`. The R11 measurement of
`this.runnerMinutes` over the same file independently reports four write references, exactly two of
them `recordStart`, one beside each surviving publish. The third point was `startPoint:
legacy_capacity` inside `startRunningAfterCapacity`; it left with the legacy admission chain together
with the `recordStart` it sat beside — the same single reference the runner-minutes ratchet entry
falls by, so the two measurements corroborate each other rather than restating one number twice.

The `legacy_capacity` member SHALL remain declared in the published event contract, and this
requirement SHALL NOT be read as removing it: no live site produces that value, but narrowing that
union is a published-contract change this change does not make.

#### Scenario: Readoption publishes once

- **WHEN** startup recovery readopts a task that was running before restart
- **THEN** exactly one `TaskRunStarted` is published for that task, carrying `startPoint: readoption`,
  and the existing `recordStart` call still runs

#### Scenario: The durable path publishes once

- **WHEN** a task's durable runtime is armed through `armDurableRuntime`
- **THEN** exactly one `TaskRunStarted` is published for that task, carrying `admissionMode: durable`
  and `startPoint: durable_arm`

#### Scenario: Re-arming the durable runtime does not publish twice

- **WHEN** `armDurableRuntime` is invoked a second time for a task whose runtime is already armed and
  it early-returns
- **THEN** no second `TaskRunStarted` is published for that task

#### Scenario: There is no third publish point

- **WHEN** the tree is searched for `TaskRunStarted` publish call sites
- **THEN** exactly two are found, each sits in one of the two declared paths, and no site publishes
  the retired `legacy_capacity` start point

### Requirement: SandboxProvisioned is published on the one surviving provisioning path after the provider boundary succeeds

`SandboxProvisioned` SHALL be published on exactly the one orchestration path that crosses the
provider boundary — the durable path in `GuardrailsService` — once, only after
`provider.provision(...)` has returned successfully, the ownership re-check has proven the attempt
still holds its fence, and the resulting connection has been registered, using the environment
snapshot and selected-run data already in hand. No new data pipeline SHALL be introduced to populate
the payload.

ONE IS A COUNT OF THE LIVE CALLERS. The single payload builder `publishSandboxProvisioned` has
exactly one call site on the retired tree —
`grep -rn 'publishSandboxProvisioned' apps/api/src --include='*.ts' | grep -v '\.spec\.ts'` reports
its declaration plus that one caller. The second path was the in-request pipeline, which published
through an orchestrator adapter callback rather than holding the bus itself; the callback and the
pipeline are gone together.

`admissionMode` SHALL remain on the payload — the event's schema still carries it — but with one
publisher it SHALL be fixed at the publish point rather than passed in as an argument: a
discriminator no caller can vary is not an argument, and keeping it as one would leave the retired
path's shape behind in the signature.

#### Scenario: The durable path publishes after a successful provision

- **WHEN** the durable orchestration completes `provider.provision(...)`, re-verifies ownership, and
  registers the connection
- **THEN** exactly one `SandboxProvisioned` is published carrying the task id, sandbox reference,
  provider family, and the environment snapshot already built for the provision context

#### Scenario: A failed provision publishes nothing

- **WHEN** `provider.provision(...)` throws, is cancelled, or unwinds for a detaching transfer
- **THEN** zero `SandboxProvisioned` events are published for that attempt

#### Scenario: A superseded provision publishes nothing

- **WHEN** the ownership re-check after `provision(...)` shows the attempt lost its fence and the
  sandbox is discarded
- **THEN** zero `SandboxProvisioned` events are published for that attempt

#### Scenario: No new pipeline is added to build the payload

- **WHEN** the diff at the surviving publish point is inspected
- **THEN** the payload is assembled from values already present at that seam (provision plan
  environment, selected run, connection reference), with no new provider call, no new database read,
  and no new resolver

### Requirement: TaskAdmitted is published on the one surviving admission path

`TaskAdmitted` SHALL be published on exactly one admission path: the durable path, once the capacity
reservation has committed the task's transition. The event SHALL carry the transition token that
fenced that admission, the resulting admission outcome (`running` or `queued`), and the
`admissionMode` discriminant. A refused or superseded reservation SHALL NOT publish `TaskAdmitted`.

ONE IS A COUNT OF THE LIVE SITES:
`grep -rn "'task.admitted'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'` reports a single
publish site, in `tasks.service.ts`. The second was the orchestrator's legacy publish point — one
point with a running half and a queued half, each guarded to fire only for a transition that call
itself committed — and it left with the admission chain that reached it. The in-flight-join rule the
old scenario protected leaves with it: no orchestrator seam stores an in-flight admission promise any
more, so there is no second caller that could publish a duplicate.

#### Scenario: The durable path publishes on a committed reservation

- **WHEN** the durable reservation commits a transition to `running` or `queued`
- **THEN** exactly one `TaskAdmitted` is published carrying that outcome, `admissionMode: durable`,
  and the transition token minted for that reservation

#### Scenario: A superseded reservation publishes no admission

- **WHEN** the durable reservation returns the `superseded` outcome and the lease transition is
  rolled back
- **THEN** zero `TaskAdmitted` events are published for that attempt

#### Scenario: There is no second publish point

- **WHEN** the tree is searched for `TaskAdmitted` publish call sites
- **THEN** exactly one is found, and no orchestrator seam publishes an admission of its own

### Requirement: TaskSuperseded is published once per observation at two declared producer boundaries

`TaskSuperseded` SHALL be published where a supersession is actually observed, at exactly two
producer boundaries: (1) the durable capacity reservation returning the `superseded` outcome,
publishing `observationPoint: durable_capacity_reservation`, and (2) the durable admission transition
returning `superseded`, publishing `observationPoint: durable_admission_transition`. Each event SHALL
carry only what the observer holds — the superseded task id, the fence token the loser held, and the
observation-point discriminant — and SHALL NOT carry any superseder identity.

TWO IS A COUNT OF THE LIVE SITES:
`grep -rn "'task.superseded'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'` reports two
publish sites, both in `tasks.service.ts`. The third boundary was the in-request pipeline run
returning `superseded`, published through an orchestrator adapter callback; the callback and the
pipeline are gone together, and with them the rule that a single pipeline run collapse its several
internal `superseded` early-returns into at most one event — there is no pipeline run left to
collapse.

The `inline_pipeline_run` member SHALL remain declared in the published event contract, and this
requirement SHALL NOT be read as removing it: no live site produces that value, but narrowing that
union is a published-contract change this change does not make.

#### Scenario: A superseded reservation publishes once

- **WHEN** the durable capacity reservation returns the `superseded` outcome
- **THEN** exactly one `TaskSuperseded` is published carrying that boundary's observation point and
  the fence token the loser held

#### Scenario: A superseded admission transition publishes once

- **WHEN** the durable admission transition returns `superseded`
- **THEN** exactly one `TaskSuperseded` is published carrying that boundary's observation point

#### Scenario: No superseder is fabricated

- **WHEN** any published `TaskSuperseded` payload is inspected
- **THEN** it contains no field naming the superseding task, lease, worker, or request — because no
  observation point in the code holds that handle

#### Scenario: A non-superseded outcome publishes nothing

- **WHEN** a reservation or an admission transition completes with any outcome other than
  `superseded`
- **THEN** zero `TaskSuperseded` events are published for it

#### Scenario: There is no third producer boundary

- **WHEN** the tree is searched for `TaskSuperseded` publish call sites
- **THEN** exactly two are found, and no site publishes the retired `inline_pipeline_run`
  observation point

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

The diagnostics floor is **4, not 2**, because the two constructor parameters survive. When that
floor was first recorded the surviving second reference was the orchestrator's hand-off of both
collaborators into the legacy adapter, which was out of that earlier change's scope. **The claim that
the floor moves to 2 after legacy retirement is FALSE and is corrected here by measurement**:
retiring the legacy pipeline leaves the floor at 4, delta ZERO. The mechanism is that the
orchestrator reads the diagnostic collaborators exactly ONCE and that single read fed TWO consumers —
the legacy adapter and the durable diagnostics owner — so retirement removes one consumer while the
read itself survives with the owner that still needs it. Predicted by SIMULATE-THEN-MEASURE at
propose time (deleting the adapter literal from the source and running the dependency-budget gate's
own measurement reported recorder 2 and write gate 2) and CONFIRMED on the retired tree by the same
measurement: recorder 2, write gate 2. A future change SHALL NOT delete these two entries on the
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

#### Scenario: The single read of the diagnostic collaborators outlives the consumer that left

- **WHEN** the orchestrator's constructor is read after the retirement, at the one place it names
  both diagnostic collaborators
- **THEN** that single read is still there, handing both to the durable diagnostics lifecycle owner,
  so both constructor parameters remain live and the group's floor is 4 rather than 2 — the consumer
  that left took no reference with it

#### Scenario: No group is reported as burned down

- **WHEN** the change's records describing the three outcomes are read
- **THEN** none of the three is described as burned down or as reaching zero, and in particular
  metrics-projection is described as unmoved at 2 with its entry retained, because its old symbol's
  zero was a rename rather than a removal

### Requirement: "In place and unchanged" governs the seam, and this change keeps the call text byte-identical anyway

The existing "in place and unchanged" constraints on the runner-minutes call sites SHALL be read
as governing the **seam** — which method the call sits in, its position relative to the publish,
and the fact that it still runs — and NOT the identity of the object the call is dispatched on.
Those constraints are that `TaskRunStarted` is published "adjacent to that path's existing
`runnerMinutes.recordStart(taskId)` call, and SHALL NOT replace or move it", and that "Both
`recordEnd` call sites SHALL remain in place and unchanged".
Because the runner-minutes ledger change kept the accessed member name `runnerMinutes` and changed
only how the orchestrator obtains the object behind it — the data field became a private getter over
two differently-named backing members, one resolved from DI and one an injector-less fallback — the
call-site statements it left behind were byte-identical, so the seam reading was not exercised at the
byte level and neither existing requirement needed restating. Renaming the accessed
member SHALL NOT be used to make a ratchet count fall, since the R11 counter is a `\b`-anchored
regex over the exact symbol `this.runnerMinutes` and a rename would be a forged burn-down. The
backing members SHALL NOT be named such that they match that regex, and — because the R11 counter
scans raw source text without stripping comments — no comment added to
`guardrails.service.ts` SHALL contain the literal `this.runnerMinutes`, which would silently
restore a count a deletion removed.

The counts this requirement's scenarios pin are RE-PINNED here by measurement, because the legacy
retirement deleted one publish point and one call site: the declared `TaskRunStarted` publish points
are **two**, and the surviving `this.runnerMinutes` references are **four**. Both figures are live
counts on the retired tree — `grep -rn "'task.run_started'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`
and the ratchet's own `measureSource` — not the old figures minus one. The deleted `recordStart` and
the deleted publish sat beside each other inside `startRunningAfterCapacity`, which is why both
figures move by exactly one and neither move is a rename.

#### Scenario: Each publish stays adjacent to its retained recordStart

- **WHEN** each of the two declared `TaskRunStarted` publish points is read on the integrated
  tree
- **THEN** the retained `runnerMinutes.recordStart(taskId)` call is still in the same method, on
  the same side of the publish as before, and no call site moved into a different method

#### Scenario: Both recordEnd sites still run at their original seams

- **WHEN** `fenceTerminal` runs for a task reaching a terminal status, and `clearAdmissionRuntime`
  runs for a superseded admission attempt whose task has not reached a terminal status
- **THEN** each invokes `recordEnd` exactly once as before, and `clearAdmissionRuntime` still
  publishes zero `TaskSettled`

#### Scenario: The measured symbol string is unchanged

- **WHEN** all four surviving call sites are inspected after the change
- **THEN** the accessed symbol is still `this.runnerMinutes`, so the recorded count reflects a
  deleted reference rather than a symbol the ratchet regex stopped matching

#### Scenario: Only the member's declaration is restructured, never its call sites

- **WHEN** the diff hunks touching the `runnerMinutes` member are read
- **THEN** every edited line is part of its declaration — the data field is replaced by a private
  getter plus two backing members — zero surviving call-site lines are edited, and the member's
  accessed name is unchanged

#### Scenario: The resolution plumbing does not re-introduce the symbol

- **WHEN** the ratchet's own `measureSource` is run over the post-change file
- **THEN** it counts exactly 4 occurrences of `this.runnerMinutes`, and neither the getter body,
  the backing member declarations, the `onModuleInit` resolution, nor any comment contributes an
  occurrence

### Requirement: The orchestrator constructor and its positional construction sites are untouched

`GuardrailsService` SHALL keep exactly its existing 11 constructor parameters in their existing
order and types, with the `@Optional()` bus still last, so that the **20** positional
`new GuardrailsService(...)` sites across **16** files (**11** of them outside
`apps/api/src/guardrails/`) compile and run unchanged. The site count is measured, not asserted, and
it moves under this requirement's own nose: it was 22 across 15 files, then 23 across 16 when a later
change added an integration test that constructs the orchestrator positionally, then 24 across 17
when the runner-minutes ledger change's transcript-ordering assertion constructed one too, and it is
20 across 16 now that this retirement deleted `apps/api/src/tasks/tasks-legacy-request-lifetime.spec.ts`,
whose subject was the retired path and which held four of those sites. Every number here was
RE-COUNTED live on the retired tree with `node scripts/guardrails-construction-sites.mjs`, which
prints `20 16 11 16 12 8`, rather than adjusted by subtraction — the figure has drifted twice already
in this epic, and the previously recorded "12 of them outside" was itself one ahead of a live count of
11 when it was written, which is exactly how a stale count makes a future change mis-scope the blast
radius of touching the signature.

The `runnerMinutes` member SHALL be usable from the moment an instance
exists under BOTH DI construction and positional construction: an instance built positionally,
with no injector from which to resolve the port, SHALL still answer `recordStart`, `recordEnd`,
and `intervals()` without a null-reference error, because existing reflective unit assertions
call `intervals()` on positionally constructed instances. The injector-less fallback SHALL be
initialized by a field initializer, which the compiler emits before the constructor body runs, so
it is in place before any collaborator the constructor builds can reach the member.

Removing any of the three collaborator parameters is OUT of scope for a change that keeps this
requirement, and the reason is measured rather than stylistic: **16** of those construction sites
pass a value in the transcripts position or beyond, **12** of them across **8** files outside
`apps/api/src/guardrails/`, and one of them is `guardrails.service.spec.ts`. The threshold that
produces those numbers SHALL be stated with them, because it is where this count goes wrong:
`transcripts` is the EIGHTH parameter, so the affected set is every site passing at least eight
arguments — including the six that pass exactly eight, whose final argument IS the transcripts value.
That six is unchanged by this retirement: all four deleted sites passed eleven arguments. Counting
from nine instead silently drops those six and understates the blast radius by more than a third,
which is precisely the mis-scoping this requirement exists to prevent. A change that needs the
parameters gone SHALL modify this requirement in the same commit as the signature.

#### Scenario: The constructor signature is unchanged

- **WHEN** the `GuardrailsService` constructor signature is compared with its pre-change form
- **THEN** it has the same 11 parameters in the same order and types, the bus is still the last
  parameter and still `@Optional()`, and zero of the 20 surviving positional construction sites were
  edited to pass a ledger or port argument

#### Scenario: A positionally constructed instance still accounts for runner minutes

- **WHEN** a `GuardrailsService` is constructed positionally (no injector available) and a task is
  admitted, started, and settled
- **THEN** the start and end are recorded and `runnerMinutes.intervals()` returns the closed
  interval, with no null-reference or undefined-field error at any point in the lifecycle

#### Scenario: The surviving reflective internals assertions pass

- **WHEN** `apps/api/src/guardrails/guardrails.service.spec.ts` is run on the integrated tree
- **THEN** it passes, including its **six** surviving reflective
  `internals.runnerMinutes.intervals()` assertions (identifier at `:615`, `:672`, `:730`, `:801`,
  `:874`, `:941`), each still calling `intervals()` on a positionally constructed instance; the
  seventh sat inside a legacy-only provisioning test whose subject this change deleted, so its
  disappearance is a deletion of the test, never a relaxation of the assertion

#### Scenario: The recorded site counts match a live count

- **WHEN** `node scripts/guardrails-construction-sites.mjs` is run on the integrated tree
- **THEN** its six figures equal the six this requirement states — 20 sites, 16 files, 11 outside
  files, 16 heavy sites, 12 heavy outside, 8 heavy outside files — so a change reading this
  requirement to scope a signature edit is reading live numbers

## REMOVED Requirements

### Requirement: TaskRunStarted is published at exactly three declared points

**Reason**: The heading pins the count, and the count is now two: the `legacy_capacity` publish point
inside `startRunningAfterCapacity` left with the retired admission chain. A MODIFIED block is matched
to the live specification by heading text, so a heading whose number changed cannot match and the
modification would silently fail to apply — hence removal plus addition.

**Migration**: Replaced by "TaskRunStarted is published at exactly two declared points", whose count
is a live count of the publish sites rather than three minus one.

### Requirement: SandboxProvisioned is published on both provisioning paths after the provider boundary succeeds

**Reason**: "both … paths" is a count of two stated in the heading, and only one provisioning path
survives. The propose-time note flagged only the two headings carrying a number word; a live read
finds "both" is a number word too, so this heading changes and the re-pinning must be a removal plus
an addition for the same matching reason.

**Migration**: Replaced by "SandboxProvisioned is published on the one surviving provisioning path
after the provider boundary succeeds", counted from the single call site of the one payload builder.

### Requirement: TaskAdmitted is published on both admission paths

**Reason**: Same heading-count problem: only the durable admission path publishes now, so "both" is
false in the heading itself.

**Migration**: Replaced by "TaskAdmitted is published on the one surviving admission path". The
scenario about a repeated in-flight admission publishing once is not carried over: the orchestrator
no longer stores an in-flight admission promise for a second caller to join.

### Requirement: TaskSuperseded is published once per observation at three declared producer boundaries

**Reason**: The heading pins three boundaries; the `inline_pipeline_run` boundary left with the
pipeline, leaving two.

**Migration**: Replaced by "TaskSuperseded is published once per observation at two declared producer
boundaries". The scenario requiring one pipeline run to collapse its several internal `superseded`
early-returns into a single event is not carried over: there is no pipeline run left to collapse.
