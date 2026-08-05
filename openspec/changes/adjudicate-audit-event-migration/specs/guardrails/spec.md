## ADDED Requirements

### Requirement: Every guardrails audit symbol reference is adjudicated in a durable artifact

The change SHALL produce a durable adjudication artifact in its change directory carrying **exactly one row per `this.audit` symbol reference** measured live in `apps/api/src/guardrails/guardrails.service.ts` before the change — nine rows, at lines 1197, 2063, 2067, 2770, 3529, 3778, 3787, 3806, and 3815. Each row SHALL carry: `file:line`; the collaborator method the reference belongs to (or the guard it forms); that method's declared return type; whether the caller reads and branches on the result; the persistence tier (`batch` or `blocking-strict`); the verdict (`CALL`, `EVENT`, or `REMOVED`); the covering event type when the verdict is `EVENT`; the refusal criterion name when the verdict is `CALL`; and the proven other owner when the verdict is `REMOVED`.

Adjudication SHALL scan in both directions: each row SHALL also name the inbound dependents of that write — the runtime paths and tests that depend on its timing or its result — and not only the outbound call.

#### Scenario: Row count matches the live symbol count

- **WHEN** the artifact's rows are counted and the dependency-budget ratchet reports the live `this.audit` count on the pre-change tree
- **THEN** both are 9, and the number of rows not marked `REMOVED` equals the live count measured on the integrated tree

#### Scenario: No row is left unadjudicated

- **WHEN** each row is read
- **THEN** it carries a verdict, a tier, and — for a `CALL` verdict — exactly one of the three declared refusal criterion names; zero rows carry a blank verdict, a blank tier, or an unattributed refusal

#### Scenario: Every EVENT verdict names a payload that carries every consumed field

- **WHEN** the verdicts are tallied on the integrated tree
- **THEN** zero rows are `EVENT`, each recorded against the field that no catalog payload carries — the force-fail `cause`, the exit `code`/`abnormal`/`tail`, the provisioning `stage`/`attempt`, and the change-request `url`/`number`/`reused`

#### Scenario: The inbound direction is recorded for the acknowledgement rows

- **WHEN** the rows for `recordProvisioningFailure` and `recordTaskCancellation` are read
- **THEN** each names the dependent runtime path (terminal admission recovery throwing the checkpoint coordination error so the running work stays leased and reclaimable) and the existing test that asserts it, rather than only naming the guardrails call

#### Scenario: The inbound direction is recorded for the delivery row

- **WHEN** the row for `recordChangeRequest` is read
- **THEN** it names the hand-written inline source mirror in `delivery-results-surfaced-and-audited.test.mjs` as a dependent that cannot fail on its own if the call's handling changes

### Requirement: An audit call is removed only under a proven per-stage owner, and at most one is removed

This change SHALL remove **at most one** `this.audit` symbol reference: the provider-composite provisioning-progress hint at `guardrails.service.ts:1197`. The removal SHALL be conditional on an executable proof that, for **every** provisioning stage each provider family reports through `onProvisioningProgress`, an audit row with the dedupe identity `task.provisioning:{taskId}:{attempt}:{stage}` is still recorded by the admission worker after the hint is gone. If any reported stage has no such worker-owned row, the hint SHALL be retained, adjudicated `CALL`, and the recorded dependency-budget count SHALL stay at 9.

The other eight references SHALL be byte-identical to their pre-change form. The private `recordAudit` helper SHALL be retained, because three of its call sites (`:2066`, `:2769`, `:3528`) survive this change; retaining it SHALL NOT leave an uncalled private method. No removed call SHALL be relocated into a feature-flag branch: this change introduces no second live path, and its escape hatch is a version rollback.

#### Scenario: The coverage proof is executable and per-stage

- **WHEN** the coverage proof runs
- **THEN** it enumerates the provisioning stages each provider family reports through `onProvisioningProgress` and asserts, for each one, an audit row written under the matching `task.provisioning:{taskId}:{attempt}:{stage}` dedupe identity by the admission worker

#### Scenario: An uncovered stage blocks the removal

- **WHEN** a stage reported by a provider family has no admission-worker checkpoint under the same dedupe identity
- **THEN** the hint at `guardrails.service.ts:1197` remains in the tree, its adjudication row reads `CALL`, and the recorded `this.audit` count remains 9

#### Scenario: The remaining references are untouched

- **WHEN** the diff of `guardrails.service.ts` is filtered to lines containing `this.audit`
- **THEN** it shows at most one deletion hunk and zero modification hunks, and the surviving references keep their existing line content

#### Scenario: No private helper is orphaned

- **WHEN** the call sites of the private `recordAudit` helper are counted on the integrated tree
- **THEN** the count is at least 3 and the helper is retained, so the change leaves behind no uncalled private method

#### Scenario: The removal is unconditional, not flag-gated

- **WHEN** the tree is searched for a conditional branch that re-invokes a removed audit call when a toggle is closed
- **THEN** zero matches are found, and the symbol-reference count reflects deleted code rather than code parked behind a disabled branch

#### Scenario: Comments added near publish points carry no quoted event name

- **WHEN** the change's added comment lines in `guardrails.service.ts` are searched for quoted catalog event names
- **THEN** zero matches are found, so the whole-file occurrence counts asserted by the publishing spec stay pinned

## MODIFIED Requirements

### Requirement: Guardrails publishes domain events without changing lifecycle behavior

Guardrails orchestration SHALL publish domain events at its existing seams. Publishing SHALL NOT change, block, delay, reorder, or fail any existing lifecycle transition: a publish error SHALL be swallowed so the transition, the teardown, and the slot release proceed unconditionally.

An existing synchronous collaborator call (audit, runner-minutes accounting, transcripts, provisioning diagnostics, metrics projection) SHALL be removed only when the change removing it proves, with an executable test, that the same recorded semantics are still produced by another declared owner — either a registered subscriber of a published event that carries every consumed field, or a second writer of the same row identity. A call whose semantics no other owner produces SHALL be retained unchanged. Publishing by itself SHALL NOT be treated as such a proof.

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

### Requirement: Existing guardrails behavior is proven unchanged by characterization

Behavioral equivalence SHALL be proven as characterization against a baseline **measured live on this change's own tree**, not copied from an earlier change: `apps/api/src/guardrails/` holds 135 `test()` cases across 6 `*.spec.ts` files (57 + 54 + 15 + 3 + 3 + 3) and 8 `.test.mjs` assertion scripts, which are counted and reported separately from the spec files.

Behavioural assertions SHALL NOT be edited. An assertion that pins a *synchronous call order inside one method* MAY be rewritten, and every such rewrite SHALL be classified in the change's task ledger as either (a) an implementation detail — replaced by a result assertion over the set of audit rows the completed operation produced — or (b) a real requirement — re-expressed against the new seam and never relaxed. Each ledger entry SHALL record three things: the order the original assertion pinned, why that order no longer holds after the change, and the invariant the replacement pins. An assertion SHALL NOT be deleted, weakened into a count, or made order-insensitive beyond the single justified source of reordering. Outside `apps/api/src/guardrails/`, the only permitted edit to a `*.spec.ts` remains adding or omitting the trailing optional bus argument in a positional `new GuardrailsService(...)` construction, except where a test's own subject is changed by this change, in which case it SHALL be rewritten under the same (a)/(b) ledger.

Under this change's scope the three real audit assertion hotspots — `guardrails-durable-launch-decision.spec.ts` (46 audit assertions, including its two ordering assertions), `delivery-results-surfaced-and-audited.test.mjs` (61 audit assertions, a hand-written inline mirror of `deliverResult`), and `guardrails.service.spec.ts` (14 audit assertions, including the interleaving one pinned by an `auditStarted` flag) — SHALL pass **unmodified**. If any of them requires an edit, the change altered behaviour and the change is what is wrong, not the test.

#### Scenario: The stated baseline matches the tree

- **WHEN** the `test()` cases in `apps/api/src/guardrails/*.spec.ts` and the `.test.mjs` scripts are counted on the integrated tree
- **THEN** the counts are 135 across 6 spec files with the stated per-file distribution, and 8 `.test.mjs` scripts, all passing

#### Scenario: The three audit hotspots are unmodified

- **WHEN** the change's diff is filtered to `guardrails-durable-launch-decision.spec.ts`, `delivery-results-surfaced-and-audited.test.mjs`, and `guardrails.service.spec.ts`
- **THEN** zero of the three files appear in the diff, and all three pass on the integrated tree

#### Scenario: The negative force-fail assertions still hold

- **WHEN** a remote observation or a cancelled winner takes a task's terminal state
- **THEN** guardrails writes zero force-fail audit rows, and both existing negative assertions pass unmodified

#### Scenario: Every rewritten assertion carries a classified ledger entry

- **WHEN** any assertion in the repository is rewritten by this change
- **THEN** the task ledger holds an entry for it classified (a) or (b), recording the pinned order, why it no longer holds, and the invariant the replacement pins

#### Scenario: The inline source mirror moves with its subject

- **WHEN** the handling of a collaborator call that the hand-written mirror reproduces is changed
- **THEN** `delivery-results-surfaced-and-audited.test.mjs` is updated in the same commit with its per-argument assertion strength preserved — and when that handling is unchanged, the mirror is untouched

#### Scenario: Source-text-scanning tests keep their per-file strength

- **WHEN** a source-text-scanning test must be updated because a file it scans changed
- **THEN** the update keeps its per-file assertions rather than relaxing them to an aggregate total, and the run of the wiring and audit text-scanning scripts stays green
