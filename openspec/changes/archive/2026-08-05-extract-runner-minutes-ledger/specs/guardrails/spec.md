## ADDED Requirements

### Requirement: The runner-minutes read face is removed under a proven owner while every write is retained

This change SHALL remove **exactly one** `this.runnerMinutes` symbol reference — the read inside
the forwarding accessor at `guardrails.service.ts:3880` (`return this.runnerMinutes.intervals();`)
— and SHALL retain all five write references: `recordStart` at `:1824`, `:2917`, `:3286` and
`recordEnd` at `:2319`, `:3264`. The removal is made under **form (3), the directly-read single
owner**, of the standing removal precondition — the form this change's `MODIFIED` delta adds,
because the two pre-existing forms (a registered event subscriber, or a second writer of the same
row identity) are both write-side and neither describes this removal. This change SHALL establish
all five of form (3)'s preconditions by measurement: the removed call is a read that records
nothing and that the orchestrator does not branch on; the interval state has exactly one owner
after the move; no forwarder remains on the orchestrator; the consumer (`MetricsService`) imports
the owner's `*.port.ts` and resolves its DI token rather than routing through guardrails; and the
proof is a characterization test binding the real implementation, pinning `deriveRunnerMinutes`'
complete output over the same intervals. Publishing a domain event SHALL NOT be offered as any
part of that proof, and no write reference SHALL be removed by this change.

#### Scenario: Exactly one reference is deleted

- **WHEN** the diff of `guardrails.service.ts` is filtered to lines containing `this.runnerMinutes`
- **THEN** it shows exactly one deletion hunk — the accessor's `return this.runnerMinutes.intervals();`
  — and zero modification hunks

#### Scenario: The five write call sites survive with byte-identical statements

- **WHEN** the surviving `this.runnerMinutes` lines are compared with their pre-change text
- **THEN** all five are byte-identical (`this.runnerMinutes.recordStart(taskId);` three times and
  `this.runnerMinutes.recordEnd(taskId);` twice), and each still sits inside the same method it
  sat in before

#### Scenario: The other owner is proven by execution, not asserted

- **WHEN** the removal's proof is inspected
- **THEN** it is the executable characterization test over the real `deriveRunnerMinutes` fed by
  the new owner's `intervals()`, and no part of the proof rests on an event having been published

#### Scenario: No write reference is opportunistically removed

- **WHEN** the live `this.runnerMinutes` symbol-reference count in `guardrails.service.ts` is
  measured on the integrated tree
- **THEN** it is exactly 5 — not fewer — so the change did not quietly widen its scope past the
  read face

#### Scenario: Added comments carry no quoted event name

- **WHEN** the change's added comment lines in `guardrails.service.ts` are searched for quoted
  catalog event names
- **THEN** zero matches are found, so the whole-file occurrence counts asserted by the publishing
  spec's text-scanning assertions stay pinned

### Requirement: "In place and unchanged" governs the seam, and this change keeps the call text byte-identical anyway

The existing "in place and unchanged" constraints on the runner-minutes call sites SHALL be read
as governing the **seam** — which method the call sits in, its position relative to the publish,
and the fact that it still runs — and NOT the identity of the object the call is dispatched on.
Those constraints are that `TaskRunStarted` is published "adjacent to that path's existing
`runnerMinutes.recordStart(taskId)` call, and SHALL NOT replace or move it", and that "Both
`recordEnd` call sites SHALL remain in place and unchanged".
Because this change keeps the accessed member name `runnerMinutes` and changes only how the
orchestrator obtains the object behind it — the data field becomes a private getter over two
differently-named backing members, one resolved from DI and one an injector-less fallback — the
five call-site statements remain byte-identical, so the seam reading is not exercised at the byte
level by this change and neither existing requirement needs to be restated. Renaming the accessed
member SHALL NOT be used to make a ratchet count fall, since the R11 counter is a `\b`-anchored
regex over the exact symbol `this.runnerMinutes` and a rename would be a forged burn-down. The
backing members SHALL NOT be named such that they match that regex, and — because the R11 counter
scans raw source text without stripping comments — no comment this change adds to
`guardrails.service.ts` SHALL contain the literal `this.runnerMinutes`, which would silently
restore the count the deletion removed.

#### Scenario: Each publish stays adjacent to its retained recordStart

- **WHEN** each of the three declared `TaskRunStarted` publish points is read on the integrated
  tree
- **THEN** the retained `runnerMinutes.recordStart(taskId)` call is still in the same method, on
  the same side of the publish as before, and no call site moved into a different method

#### Scenario: Both recordEnd sites still run at their original seams

- **WHEN** `fenceTerminal` runs for a task reaching a terminal status, and `clearAdmissionRuntime`
  runs for a superseded legacy attempt whose task has not reached a terminal status
- **THEN** each invokes `recordEnd` exactly once as before, and `clearAdmissionRuntime` still
  publishes zero `TaskSettled`

#### Scenario: The measured symbol string is unchanged

- **WHEN** all five surviving call sites are inspected after the change
- **THEN** the accessed symbol is still `this.runnerMinutes`, so the recorded count reflects a
  deleted reference rather than a symbol the ratchet regex stopped matching

#### Scenario: Only the member's declaration is restructured, never its call sites

- **WHEN** the diff hunks touching the `runnerMinutes` member are read
- **THEN** every edited line is part of its declaration — the data field is replaced by a private
  getter plus two backing members — zero call-site lines are edited, and the member's accessed
  name is unchanged

#### Scenario: The resolution plumbing does not re-introduce the symbol

- **WHEN** the ratchet's own `measureSource` is run over the post-change file
- **THEN** it counts exactly 5 occurrences of `this.runnerMinutes`, and neither the getter body,
  the backing member declarations, the `onModuleInit` resolution, nor any comment this change adds
  contributes an occurrence

### Requirement: The orchestrator constructor and its positional construction sites are untouched

`GuardrailsService` SHALL keep exactly its existing 11 constructor parameters in their existing
order and types, with the `@Optional()` bus still last, so that the 22 positional
`new GuardrailsService(...)` sites across 15 files (10 of them outside `apps/api/src/guardrails/`)
compile and run unchanged. The `runnerMinutes` member SHALL be usable from the moment an instance
exists under BOTH DI construction and positional construction: an instance built positionally,
with no injector from which to resolve the port, SHALL still answer `recordStart`, `recordEnd`,
and `intervals()` without a null-reference error, because existing reflective unit assertions
call `intervals()` on positionally constructed instances. The injector-less fallback SHALL be
initialized by a field initializer, which the compiler emits before the constructor body runs, so
it is in place before any collaborator the constructor builds can reach the member.

#### Scenario: The constructor signature is unchanged

- **WHEN** the `GuardrailsService` constructor signature is compared with its pre-change form
- **THEN** it has the same 11 parameters in the same order and types, the bus is still the last
  parameter and still `@Optional()`, and zero of the 22 positional construction sites were edited
  to pass a ledger or port argument

#### Scenario: A positionally constructed instance still accounts for runner minutes

- **WHEN** a `GuardrailsService` is constructed positionally (no injector available) and a task is
  admitted, started, and settled
- **THEN** the start and end are recorded and `runnerMinutes.intervals()` returns the closed
  interval, with no null-reference or undefined-field error at any point in the lifecycle

#### Scenario: The reflective internals assertions pass unmodified

- **WHEN** `apps/api/src/guardrails/guardrails.service.spec.ts` is run on the integrated tree
- **THEN** it passes with zero diff lines, including its seven reflective
  `internals.runnerMinutes.intervals()` assertions (14 occurrences of the identifier, at
  `:1375`/`:1380`, `:3011`/`:3021`, `:3072`/`:3078`, `:3132`/`:3136`, `:3199`/`:3207`,
  `:3274`/`:3280`, `:3341`/`:3347`)

### Requirement: Test doubles of the removed accessor are restated and every rewrite is ledgered

Every test double that stubs the removed accessor SHALL be restated against the port in the same
commit as the removal, preserving its existing fixture values and per-assertion strength. There
are four such doubles: `apps/api/src/metrics/metrics.verify.test.mjs:468` and `:537`,
`apps/api/src/metrics/task-resource.test.mjs:137`, and
`apps/api/src/metrics/terminal-diagnostics-metrics.service.spec.ts:71`. `terminal-diagnostics-metrics.service.spec.ts` is a `*.spec.ts` outside
`apps/api/src/guardrails/` whose own subject this change alters, so it SHALL carry an
(a)/(b)-classified entry in the change's assertion-rewrite ledger. The ledger SHALL be present in
the change directory even when it holds a single entry, and a ledger with no entries SHALL state
"zero entries" explicitly rather than being omitted.

#### Scenario: Every stub moves to the port with its strength intact

- **WHEN** the four stub sites are read on the integrated tree
- **THEN** each supplies intervals through a runner-minutes port double instead of a fake
  guardrails accessor, and each keeps the same fixture values and the same assertions it had
  before this change

#### Scenario: The changed-subject spec carries a classified ledger entry

- **WHEN** the change's assertion-rewrite ledger is read
- **THEN** it holds an entry for `terminal-diagnostics-metrics.service.spec.ts` classified (a) or
  (b), recording what the original assertion pinned, why it no longer holds, and the invariant the
  replacement pins

#### Scenario: The ledger is never silently empty

- **WHEN** the ledger holds no entries
- **THEN** it says "zero entries" in the change directory rather than the section being absent

#### Scenario: No guardrails-directory test is edited

- **WHEN** the change's diff is filtered to `apps/api/src/guardrails/*.spec.ts` and
  `apps/api/src/guardrails/*.test.mjs`
- **THEN** zero files appear

### Requirement: The phase-4 numeric acceptance target is replaced by criteria that each name their gate

The phase-4 acceptance target expressed as a guardrails line count SHALL be replaced, in the plan
documents that state it, by structural criteria. The replacement SHALL be performed by this change
rather than deferred, because this change is what measures the gap: the target's own baseline is
stale by the drift of a single earlier phase-4 commit, and the collaborator burn-down route cannot
reach the number under any accounting rule. Every replacement criterion SHALL name the command or
gate that decides it and SHALL state whether that gate exists today; a criterion with no gate SHALL
carry the concrete work that would give it one, so the plan never again carries a criterion nothing
can measure. Two candidate criteria SHALL be recorded as rejected with their reasons: symbol
references burning to zero (unreachable, since the orchestrator legitimately keeps naming
collaborators it still calls) and a bare "forwardRef cycle to zero" (no gate measures it, because
the layout check exempts cycles formed only of composition files). The line count SHALL be retained
as reported trend data in each change's outcome table, and SHALL NOT be an acceptance criterion.

#### Scenario: Every plan document stating the numeric target is updated in the same change

- **WHEN** the plan documents are searched for the numeric guardrails line target after this change
- **THEN** zero of them state it as an acceptance criterion, every occurrence that remains is
  explicitly labelled a historical review-time baseline, and the archived change directories are
  left untouched because they are immutable records

#### Scenario: Each replacement criterion names a gate and its status

- **WHEN** the replacement acceptance criteria are read
- **THEN** each names the command or CI step that decides it and is marked as either measurable
  today with no code change, or requiring a named gate addition, and none is left with an
  unspecified means of measurement

#### Scenario: The rejected candidates are recorded, not silently dropped

- **WHEN** the replacement text is read
- **THEN** it names both rejected candidate criteria and why each fails, so a later change does not
  re-propose them

#### Scenario: The line count survives as trend data only

- **WHEN** a phase-4 change's outcome table is read
- **THEN** it still reports the guardrails line count before and after, and no acceptance criterion
  anywhere depends on that number crossing a threshold

### Requirement: The remaining collaborator groups are scoped by a durable precondition graph and measured outcome table

This change SHALL produce a durable artifact in its change directory that scopes every remaining
phase-4 node — legacy inline-admission retirement, diagnostics (`provisioningDiagnosticRecorder` 4
+ `provisioningDiagnosticWriteGate` 4), transcript (`this.transcripts` 2), metrics-projection (2),
and the orchestration-body split — with (1) a precondition graph naming, per node, what must land
before it and why, and (2) an outcome table whose columns are the dimensions THIS change actually
measured: guardrails line delta, R11 count delta, r7 cross-context delta, forwardRef cycle edges
affected, and test files changed. Every cell describing this change SHALL be a number measured live
on the integrated tree; every cell describing a future node SHALL be labelled a prediction and
SHALL name the measurement that would confirm or refute it. Where a node's position in the graph
rests on a product decision rather than a measurement, the artifact SHALL say so in those words and
SHALL NOT present the decision as a finding.

#### Scenario: This change's row is measured, not predicted

- **WHEN** the artifact's row for the runner group is read
- **THEN** each of its five cells carries a number measured on the integrated tree — the guardrails
  line count before and after, `this.runnerMinutes` 6 → 5, r7 `guardrails.service.ts` 9 → 8, and
  0 forwardRef cycle edges removed — and none of them is marked as a prediction

#### Scenario: Every remaining node has a precondition edge or an explicit "none"

- **WHEN** the precondition graph is read
- **THEN** legacy inline-admission retirement is the root node with precondition "none"; the
  diagnostics node names it as the edge that removes the pass-through at
  `guardrails.service.ts:731`/`:732`; the transcript and metrics-projection nodes each say "none"
  explicitly, so their position is visibly a sequencing choice rather than a dependency; and the
  orchestration-body split names the nodes it waits on

#### Scenario: The diagnostics ceiling is recorded as two measured floors, never one number

- **WHEN** the diagnostics entry is read
- **THEN** it records **8 → 4 while legacy is alive** and **8 → 2 after legacy retires**, states
  that **8 → 0 is unreachable** without modifying the requirement that pins the bus as the
  eleventh constructor parameter with the preceding ten unchanged — because
  `guardrails.service.ts:654`/`:657` are the ninth and tenth — and carries none of these as an
  unqualified "burns to zero"

#### Scenario: Each remaining node carries a recommended shape with its evidence

- **WHEN** the diagnostics and transcript entries are read
- **THEN** each names one recommended migration shape — for diagnostics, inverting the write gate
  into an injected no-op recorder paired with extracting the two private wrapper methods, rather
  than extracting a service — with the evidence behind the recommendation, and the transcript entry
  records that it is not a file move: the runtime-registry token is provided but not exported by
  the tasks module, a controller imports back into the moved unit, the r7 entries are path-keyed so
  the move re-keys rather than shrinks them, and an undeclared new directory is a hard gate failure
  rather than a finding

#### Scenario: The acceptance gap is stated with the criteria that replace it

- **WHEN** the artifact is read for the phase-4 acceptance target
- **THEN** it states the current guardrails line count, the measured span of what collaborator
  burn-down can remove under both a conservative and an aggressive accounting rule with the rule
  named, and the residual orchestration-body remainder — and it records that the numeric target has
  been replaced by structural criteria, each of which names the gate or command that decides it and
  whether that gate exists today

#### Scenario: Predicted cells are falsifiable

- **WHEN** any predicted cell in the outcome table is read
- **THEN** it names the command or measurement that will confirm or refute it, rather than
  standing as an unfalsifiable estimate

## MODIFIED Requirements

### Requirement: Guardrails publishes domain events without changing lifecycle behavior

Guardrails orchestration SHALL publish domain events at its existing seams. Publishing SHALL NOT change, block, delay, reorder, or fail any existing lifecycle transition: a publish error SHALL be swallowed so the transition, the teardown, and the slot release proceed unconditionally.

An existing synchronous collaborator call (audit, runner-minutes accounting, transcripts, provisioning diagnostics, metrics projection) SHALL be removed only when the change removing it proves, with an executable test, that the same recorded semantics are still produced by another declared owner — one of exactly three forms: (1) a registered subscriber of a published event that carries every consumed field, (2) a second writer of the same row identity, or (3) a directly-read single owner, admissible only under the five preconditions stated below. A call whose semantics no other owner produces SHALL be retained unchanged. Publishing by itself SHALL NOT be treated as such a proof under any of the three forms.

The third form covers a removal in which no event and no second write is involved at all: state the orchestrator used to hold moves to a declared owner, and the consumer that used to read it through the orchestrator reads it from that owner instead. It SHALL be admissible only when the removing change establishes, by measurement rather than assertion, that every one of the following holds:

- **The removed call is a read.** It records nothing — it writes no row, publishes no event, emits no metric, mutates no state — and the orchestrator does not branch on its result. A call that records anything, or whose result steers orchestration, SHALL use form (1) or form (2).
- **The state has exactly one owner after the move.** No second construction site, module-level mutable instance, or duplicated copy of that state survives anywhere in the tree, so "the same recorded semantics" is the same object's state rather than a second reconstruction of it.
- **No forwarder remains.** The orchestrator retains no method, getter, property, or re-export whose body only forwards to that owner: the removed read face disappears from the tree entirely. A renamed, wrapped, or deprecated-but-live face SHALL NOT count as removed, and a symbol-reference count that falls because a face was renamed rather than deleted SHALL be treated as a forged burn-down.
- **The consumer calls the owner directly.** Every consumer that used to read through the orchestrator SHALL import the owner's declared `*.port.ts` and resolve it through the DI token that file exports. Routing the read back through the orchestrator, or through a third context's service, SHALL NOT count as direct.
- **The proof binds the real implementation.** The executable test SHALL be a characterization test that feeds the consumer's real derivation from the real owner's state and pins the consumer's complete output — not a selected field — against its pre-change output for the same inputs. A test in which either the owner or the derivation is a double SHALL NOT be accepted as the proof.

Absent all five preconditions the third form SHALL NOT be invoked, and the call SHALL be retained unchanged and adjudicated as retained. "Something else probably covers it" is not a proof under any of the three forms.

The bus SHALL be injected into `GuardrailsService` as an `@Optional()` **trailing** constructor parameter (the 11th), so that positional `new GuardrailsService(...)` construction outside `apps/api/src/guardrails/` continues to compile and run unchanged.

#### Scenario: Publishing failure does not disturb the transition

- **WHEN** a task reaches a terminal state while the injected bus's `publish` throws
- **THEN** the task still transitions to its terminal status, its timers are still cleared, its runner-minutes interval is still ended, its slot is still released, and the publish error is logged and swallowed

#### Scenario: Behaviour is identical with no bus injected

- **WHEN** `GuardrailsService` is constructed without the bus argument (the positional form used outside the guardrails directory) and the full lifecycle is exercised
- **THEN** every transition, teardown, audit call, and slot release behaves exactly as before this change, with no null-reference error

#### Scenario: Retained collaborator calls are still made

- **WHEN** a task is admitted, started, provisioned, and settled with the bus injected
- **THEN** every retained audit, runner-minutes, transcript, diagnostics, and metrics call is invoked exactly as many times as before this change

#### Scenario: A removed call's rows are still produced

- **WHEN** the operation behind a removed collaborator call is exercised on the integrated tree
- **THEN** the audit rows that call used to produce are still recorded, by the owner named in the adjudication artifact, under the same row identity

#### Scenario: The bus is the trailing constructor parameter

- **WHEN** the `GuardrailsService` constructor signature is inspected
- **THEN** the bus is the last parameter, is marked `@Optional()`, and the preceding 10 parameters keep their existing order and types

#### Scenario: Publishing is gated by the cutover toggle

- **WHEN** the escape-hatch environment value disables publishing and a full task lifecycle is exercised
- **THEN** zero events are published, and every retained synchronous collaborator call still runs

#### Scenario: A read-only face is removed under a directly-read single owner

- **WHEN** the orchestrator's forwarding read accessor over running intervals is deleted; the interval state has exactly one owner in the runner-metrics context with no second construction site; no method, getter, or re-export forwarding to that owner survives in `GuardrailsService`; the reading consumer obtains intervals by importing the owner's `*.port.ts` and resolving its DI token; and a characterization test pins the consumer's complete derived output, computed by the real derivation over the real owner's intervals, against its pre-change output for the same intervals
- **THEN** the removal is admissible under the third owner form, the dependency-budget ratchet records the collaborator's symbol-reference count falling by exactly the one deleted read, the cross-context-import gate shows the consumer's import naming the `*.port.ts` file, and every retained write call site still runs at its original seam

#### Scenario: A write-side removal cannot use the third form

- **WHEN** a change proposes to delete a collaborator call that records something — an audit row, a provisioning-diagnostic write, a transcript capture, or a metrics increment — and offers as its proof only that the state now has a single owner which some consumer reads directly
- **THEN** the third form does not apply, because the removed call is not a read; the removal is refused and the call is retained unchanged unless the change proves a registered subscriber of a published event carrying every consumed field, or a second writer of the same row identity

#### Scenario: A read the orchestrator branches on is not eligible

- **WHEN** the removed call is a read whose result the orchestrator itself reads and branches on before continuing the lifecycle
- **THEN** the third form does not apply, because moving the state does not preserve the orchestration decision the read fed, and the call is retained unchanged
