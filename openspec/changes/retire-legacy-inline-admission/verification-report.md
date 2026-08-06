# Verification report — retire-legacy-inline-admission

Three verify passes are recorded here. **Pass 1** (below) ran at HEAD `3619b08` and re-opened one
code task. **Pass 2** (["Verify pass 2"](#verify-pass-2--head-28b9d1d)) ran after that task landed, at
HEAD `28b9d1d`. **Pass 3** (["Verify pass 3"](#verify-pass-3--head-8064dd2), at the end of this file)
ran at HEAD `8064dd2` — the first pass with the characterization requirement inside the change's own
`specs/`, which task 7.1 moved there — and is the pass whose tally gates archive. It re-opens one code
task (6.2), so archive is gated until that task lands and a further pass clears it.

Tree verified (pass 1): branch `refactor/retire-legacy-inline-admission`, HEAD `3619b08`
("refactor(admission): retire the legacy inline pipeline and admit unconditionally durably"),
working tree clean at the time of measurement.

Executable baseline re-run during adjudication:

- `node scripts/spec-assert.mjs retire-legacy-inline-admission` → **21/21 passed**, 10 requirements
  decided without an LLM pass.
- `node scripts/openspec-metadata.mjs validate-change retire-legacy-inline-admission --phase verify`
  → validated, 16 tasks.

## Adjudication summary

| Route | Count | Ids |
| --- | --- | --- |
| Re-opened as code tasks | 1 | `guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched` |
| Spec defects (design.md Open Questions) | 0 | — |
| Archive-blocking spec defects | 0 | — |
| Re-classified MET | 4 | the four `## REMOVED Requirements` headings, below |

## Re-opened as a code task

`guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched`
— **UNMET**, re-opened as task 6.1. It is a code defect, not an ambiguous requirement: the
requirement is precisely testable, and it fails the test.

Verified TRUE by direct re-trace: the constructor keeps exactly 11 parameters in order with
`@Optional() @Inject(DOMAIN_EVENT_BUS) bus?` last (`guardrails.service.ts:630-706`); the field
initializer that makes `runnerMinutes` usable under positional construction is intact; the six
reflective `internals.runnerMinutes.intervals()` assertions sit at the pinned identifiers; and
`apps/api/src/tasks/tasks-legacy-request-lifetime.spec.ts` is gone. The first three pinned figures
(20 sites / 16 files / 11 outside) re-measure correctly.

Verified FALSE: the last three. `scripts/guardrails-construction-sites.mjs:13-18` seeds `args = 1`
and increments on every depth-1 comma, never discounting the trailing comma that Prettier puts
before `)`, so every multi-line site is counted one argument too many. Re-measured two independent
ways — a trailing-comma-aware scan and a TypeScript-compiler AST walk
(`ts.isNewExpression` → `node.arguments.length`) — both return `20 16 11 10 6 5`. The AST argument
histogram is `{2:1, 4:1, 5:1, 6:1, 7:6, 8:1, 10:7, 11:2}`: exactly ONE site passes eight arguments
(`apps/api/src/session-transcripts/transcript-capture-ordering.test.mjs:143`, last argument
`transcripts`), not the six the requirement names. The six it means each pass SEVEN, ending at
`prisma`, and take `transcripts` from the constructor default `NOOP_SESSION_TRANSCRIPT_CAPTURE`
(`guardrails.service.ts:678`).

The scenario "The recorded site counts match a live count" (`specs/guardrails/spec.md:509-514`)
passes today only because the spec and its measuring instrument share one bug, which is precisely
the failure mode the requirement was written to prevent ("a change reading this requirement to scope
a signature edit is reading live numbers"). Fixing the script and re-pinning 10/6/5 is deterministic
and self-contained; nothing about it needs a design decision, which is why it is routed to code
rather than to Open Questions.

## Re-classified MET

Four raw-unmet findings named requirements that live in the delta's `## REMOVED Requirements`
block. A skeptic exercising them refutes them by construction: their heading text pins a count
(`three`, `both`, `both`, `three`) that this change exists to retire. Each was re-traced
end-to-end against the live tree — what has to hold is that the removal's stated Reason is true and
that the ADDED replacement it migrates to is actually implemented. All four do.

### 1. `guardrails/taskrunstarted-is-published-at-exactly-three-declared-points` — MET (retired correctly)

- Delta: `specs/guardrails/spec.md:518-527` (REMOVED) → `:86-130` (ADDED, "exactly two declared points").
- Live count re-measured:
  `grep -rn "domainEventEnvelope('task.run_started'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`
  → exactly **2** sites, `apps/api/src/guardrails/guardrails.service.ts:1755` (`startPoint: 'readoption'`)
  and `:2912` (`startPoint: 'durable_arm'`, `admissionMode: 'durable'`). `tasks.service.ts` publishes none.
- The third point's home method `startRunningAfterCapacity` has zero occurrences anywhere in
  `apps/api/src` — deleted, not renamed. `legacy_capacity` survives only as a still-declared
  discriminant in `packages/contracts/src/domain-event.ts:191`, which the ADDED requirement
  explicitly preserves ("this change does not narrow that union").
- Ratcheted forward by `apps/api/src/guardrails/guardrails-domain-event-publishing.spec.ts:329-335`
  and by assertion `task-run-started-two-live-publish-points` (re-run: `ok`).
- Minor gap, non-blocking: the comments at `guardrails.service.ts:1747` ("Run-start publish point 1 of 3")
  and `:2906` ("3 of 3") were not renumbered. Cosmetic; folded into re-opened task 6.1.

### 2. `guardrails/sandboxprovisioned-is-published-on-both-provisioning-paths-after-the-provider-boundary-succeeds` — MET (retired correctly)

- Delta: `specs/guardrails/spec.md:528-537` (REMOVED, Reason + Migration only, **zero** `#### Scenario`
  children) → `:131-176` (ADDED, "the one surviving provisioning path"). There is no live behavioural
  scenario attached to the retired heading to satisfy.
- Live count re-measured: `grep -rn "this.publishSandboxProvisioned(" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`
  → exactly **1** call site, `guardrails.service.ts:1260`, matching assertion
  `sandbox-provisioned-one-live-publisher` (re-run: `ok`).
- Ordering re-traced against the ADDED scenarios: provider boundary at `:1229` → ownership re-check
  raising `TaskAdmissionLeaseLostError` at `:1230-1235` (a superseded fence publishes nothing) →
  connection registered at `:1246` → publish at `:1260-1265`. `admissionMode: 'durable'` is fixed
  inside the payload builder (`:901-911`), not passed as an argument.
- `apps/api/src/inline-admission/` does not exist; the second provisioning path is gone, not dormant.

### 3. `guardrails/taskadmitted-is-published-on-both-admission-paths` — MET (retired correctly)

- Delta: `specs/guardrails/spec.md:538-546` (REMOVED) → `:177-208` (ADDED, "the one surviving admission path").
- Live count re-measured: `grep -rn "domainEventEnvelope('task.admitted'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`
  → exactly **1** site, `apps/api/src/tasks/tasks.service.ts:2067`, inside
  `reserveDurableAdmissionCapacity`, gated so a superseded reservation publishes nothing. Assertion
  `task-admitted-one-live-publish-point` re-run: `ok`.
- The orchestrator publishes no `task.admitted` at all: all seven `admissionMode` literals left in
  `guardrails.service.ts` (`:906 :1058 :1070 :1084 :1432 :2914`) are `'durable'`.
- The Migration's specific claim also holds: no in-flight admission promise survives for a second
  caller to join, so the dropped "repeated in-flight admission publishes once" scenario has no
  subject left.
- Corroborated by type narrowing rather than by convention:
  `packages/contracts/src/task-provisioning-diagnostics.ts:51-52` is now `z.enum(['durable'])`, so
  constructing `admissionMode: 'legacy'` is a compile error.

### 4. `guardrails/tasksuperseded-is-published-once-per-observation-at-three-declared-producer-boundaries` — MET (retired correctly)

- Delta: `specs/guardrails/spec.md:547-554` (REMOVED, file ends at 554) → `:209-258` (ADDED, "two declared producer boundaries").
- Live count re-measured: `grep -rn "domainEventEnvelope('task.superseded'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`
  → exactly **2** sites, `tasks.service.ts:2081` (`observationPoint: 'durable_capacity_reservation'`)
  and `:2361` (`'durable_admission_transition'`). Assertion `task-superseded-two-live-publish-points`
  re-run: `ok`.
- No non-test file anywhere assigns `observationPoint: 'inline_pipeline_run'`; the member remains
  declared at `packages/contracts/src/domain-event.ts:206` exactly as the ADDED requirement's
  carve-out demands. Assertion `retired-discriminants-unproduced-but-still-declared` re-run: `ok`.
- Minor gap, non-blocking: comments at `tasks.service.ts:2074` ("observation point 1") and `:2346`
  ("2 of 3") still carry the retired denominator. Folded into re-opened task 6.1.

## Gap finding — no requirement lacks a traceable implementation

Audited every requirement in this change's `specs/` against the working tree. With 21/21
`spec-assert.mjs` assertions passing, the two requirements not covered by an assertion were checked
by hand: the runner-minutes seam (getter + backing member structure) and the constructor's
11-parameter signature, the latter re-measured live with `node scripts/guardrails-construction-sites.mjs`.

- `apps/api/src/inline-admission/` is deleted; zero symbols reach it from anywhere in source, and no
  file re-declares the reverse-callback port's member set under any other name.
- Publish-site counts hold at 2 / 1 / 1 / 2 (`TaskRunStarted` / `SandboxProvisioned` / `TaskAdmitted` /
  `TaskSuperseded`), with `legacy_capacity` and `inline_pipeline_run` still declared but unproduced.
- `admission-mode-policy.ts` implements the D1 total mapping — no refusal, no 503, one-member union
  (`AdmissionMode = 'durable-v2'`), with totality enforced by
  `Readonly<Record<AdmissionCapabilityOutcome, AdmissionMode>>` rather than by review. One prose
  slip found alongside it and folded into task 6.1: the header re-authored by this commit
  (`:5-6,20-23`) says "twelve outcomes"/"ten closed reasons", while
  `TaskAdmissionV2GateClosedReasonSchema` declares nine — 11 outcomes, 11 keys. The mapping is
  correct; only its own count of itself is not.
- The enum narrowing plus the DELETE-only, self-documenting irreversible migration
  (`20260806120000_delete_legacy_admission_diagnostic_rows`) matches D2.
- `scripts/ratchets/r7.json` / `r11.json` carry the three distinct movements: 8 deleted path-keyed
  entries, runner-minutes 5→4, diagnostics recorder/writeGate unmoved at 2+2.
- The `domain-event-bus` meta-requirement about re-pinning via REMOVED+ADDED rather than MODIFIED is
  itself satisfied by the delta's own section structure.

**No requirement in this change's specs directory lacks a traceable implementation.** The single
re-opened defect is not a missing implementation — it is a measuring instrument that reports the
wrong number, described in full in task 6.1.

## Scope findings — code in the diff that no requirement describes

These are recorded, not routed. Neither is undeclared **public** impact: `PostCommitAdmissionResult`
is an internal type in `apps/api/src/tasks/tasks.service.ts`, both consumers are internal, and
`POST /v1/tasks` still returns 201 (D1 admits unconditionally rather than refusing), so
`surface-impact.json`'s `publicV1` declaration remains accurate and its `protocolDifferences: []`
remains a true exclusion.

1. `apps/api/src/tasks/tasks.service.ts:206,1514-1526` — `admitCreatedTask`'s no-admission-work
   branch now returns a new named outcome `'fail-closed'` (replacing the old `'legacy-admitted'`
   success outcome) with its own warning log text. No requirement in `specs/` (guardrails,
   domain-event-bus, task-provisioning-diagnostics) describes this post-commit-dispatch fail-closed
   contract or the narrowed `PostCommitAdmissionResult` union. It IS declared in
   `surface-impact.json` under `internalOnly.scope` ("准入行为：mode 分支移除…无条件走 durable（D1）")
   with `runtimeWireBehavior: "changed"`, which is why this is scope rather than undeclared impact.
2. `apps/api/src/scheduled-tasks/scheduled-tasks.service.ts:1222,1404` — downstream behaviour change
   in a file the change does not otherwise modify: callers now short-circuit on
   `outcome === 'fail-closed'` for what used to be the legacy-admitted case, skipping the generic
   task-status recovery check entirely. This ripple from the new return semantics is covered by no
   requirement.
3. Observed while tracing (2): because `PostCommitAdmissionResult` is now a two-member union, the
   recovery block after `scheduled-tasks.service.ts:1222` (`findUnique` → `release` → `recovered`)
   is unreachable — `outcome` narrows to `never` past the two guards. Dead rather than wrong, but it
   is the residue of the removed third outcome and a candidate for the next cleanup cut.

---

## Verify pass 2 — HEAD `28b9d1d`

Tree verified: branch `refactor/retire-legacy-inline-admission`, HEAD `28b9d1d`
("fix(guardrails): recount the construction-site figures with a fixed instrument"), working tree
clean apart from an unrelated untracked change directory (`openspec/changes/extract-runner-minutes-ledger/`).

Executable baseline re-run live during this adjudication, not carried over from pass 1:

- `node scripts/spec-assert.mjs retire-legacy-inline-admission` → **23/23 passed**, 11 requirements
  decided without an LLM pass. The two assertions added since pass 1
  (`construction-site-figures-live`, `construction-counter-agrees-with-typescript-ast`) are the ones
  task 6.1 introduced so the constructor requirement is command-decided rather than lens-decided.
- `node scripts/openspec-metadata.mjs validate-change retire-legacy-inline-admission --phase verify`
  → validated, 16 tasks.
- `node scripts/context-layout-check-v2.mjs` → every class within its committed baseline.

### Adjudication summary (pass 2)

| Route | Count | Ids |
| --- | --- | --- |
| Re-opened as code tasks | 0 | — |
| Spec defects (design.md Open Questions) | 0 | — |
| Archive-blocking spec defects | 0 | — |
| Re-classified MET | 4 | the four `## REMOVED Requirements` headings, below |

Pass 1's single re-opened defect (`guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched`,
task 6.1) landed in `28b9d1d` and is no longer open: the fixed counter and the TypeScript-AST
cross-check now agree digit for digit, and both are gate-enforced.

### Re-classified MET (pass 2)

Pass 2's four raw-unmet findings are the same four `## REMOVED Requirements` headings pass 1
adjudicated, refuted the same way by construction: each heading pins a count (`three`, `both`,
`both`, `three`) that this change exists to retire, so a skeptic exercising the heading text against
the retired tree necessarily fails it. Each was re-traced independently against the live tree at
`28b9d1d` — the test is whether the removal's stated Reason is true and whether the ADDED
replacement it migrates to is actually implemented. All four are.

#### 1. `guardrails/taskrunstarted-is-published-at-exactly-three-declared-points` — MET (retired correctly)

- Delta: `specs/guardrails/spec.md:547-556` (REMOVED) → `:86-130` (ADDED, "exactly two declared points").
- Re-measured live: `grep -rn "domainEventEnvelope('task.run_started'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`
  → exactly **2** sites, `guardrails.service.ts:1755` (`startPoint: 'readoption'`) and `:2912`
  (`startPoint: 'durable_arm'`, `admissionMode: 'durable'`).
- Reason true: `startRunningAfterCapacity` has zero occurrences in `apps/api/src` — deleted with the
  chain, not renamed. `legacy_capacity` survives only as a still-declared discriminant
  (`packages/contracts/src/domain-event.ts:189-191`), exactly as the ADDED requirement's carve-out
  demands.
- ADDED scenarios re-traced: readoption publishes once, adjacent to the surviving
  `runnerMinutes.recordStart` (`:1742-1757`); the durable path publishes once, after **both**
  `durableRuntimeArmed` early-returns (`:2892`, `:2901`), so re-arming cannot publish twice.
- Pass 1's flagged comment drift is closed: `:1747` now reads "Run-start publish point 1 of 2" and
  `:2906` "2 of 2".
- Assertion `task-run-started-two-live-publish-points` re-run: `ok`.

#### 2. `guardrails/sandboxprovisioned-is-published-on-both-provisioning-paths-after-the-provider-boundary-succeeds` — MET (retired correctly)

- Delta: `specs/guardrails/spec.md:557-565` (REMOVED, Reason + Migration only, **zero** `#### Scenario`
  children — there is no behavioural scenario attached to the retired heading to satisfy) → `:131-176`
  (ADDED, "the one surviving provisioning path").
- Re-measured live: `grep -rn "this.publishSandboxProvisioned(" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`
  → exactly **1** call site, `guardrails.service.ts:1260`. The event type string `'sandbox.provisioned'`
  is constructed in exactly one place, inside the payload builder itself, so no other file can emit it.
- ADDED ordering scenarios re-traced in source order: `provider.provision(...)` at `:1229` →
  ownership re-check throwing `TaskAdmissionLeaseLostError` at `:1231-1236` (a superseded fence exits
  before the publish and emits nothing) → `lease.authorize()` → connection registered at `:1248` →
  publish at `:1260-1265`. A provision that throws, is cancelled, or unwinds never reaches `:1260`.
- `admissionMode: 'durable'` is fixed inside the payload builder (`:901-911`), which takes no
  `admissionMode` argument — matching "a discriminator no caller can vary is not an argument".
- `apps/api/src/inline-admission/` does not exist; the second path is gone, not dormant.
- Assertion `sandbox-provisioned-one-live-publisher` re-run: `ok`.

#### 3. `guardrails/taskadmitted-is-published-on-both-admission-paths` — MET (retired correctly)

- Delta: `specs/guardrails/spec.md:567-574` (REMOVED) → `:177-207` (ADDED, "the one surviving
  admission path").
- Re-measured live: `grep -rn "domainEventEnvelope('task.admitted'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`
  → exactly **1** site, `tasks.service.ts:2067`, inside `reserveDurableAdmissionCapacity`, gated on
  `transitioned && result.outcome !== 'superseded'` (`:2047`) — the same condition the audit write
  uses, so event and audit trail cannot disagree. A superseded reservation instead publishes only
  `task.superseded` (`:2073-2085`).
- The Migration's specific claim re-checked: no admission in-flight promise map survives anywhere in
  `tasks.service.ts` / `guardrails.service.ts` for a second caller to join, so the dropped
  "repeated in-flight admission publishes once" scenario has no subject left. (`readoptionsInFlight`,
  `guardrails.service.ts:1643`, is sandbox readoption — an unrelated concern.)
- Corroborated by the type system rather than by convention:
  `packages/contracts/src/task-provisioning-diagnostics.ts:51-53` is `z.enum(['durable'])`, so
  `admissionMode: 'legacy'` is a compile error.
- Assertion `task-admitted-one-live-publish-point` re-run: `ok`.

#### 4. `guardrails/tasksuperseded-is-published-once-per-observation-at-three-declared-producer-boundaries` — MET (retired correctly)

- Delta: `specs/guardrails/spec.md:576-583` (REMOVED) → `:209-258` (ADDED, "two declared producer
  boundaries").
- Re-measured live: `grep -rn "domainEventEnvelope('task.superseded'" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'`
  → exactly **2** sites, `tasks.service.ts:2081` (`observationPoint: 'durable_capacity_reservation'`)
  and `:2361` (`'durable_admission_transition'`, inside `observeAdmissionSupersession`, written as one
  method with one return so both routes publish identically and at most once per call).
- No non-test file anywhere assigns `observationPoint: 'inline_pipeline_run'`; the member remains
  declared at `packages/contracts/src/domain-event.ts:203-206`, as the carve-out requires.
- "No superseder is fabricated" re-traced: both payloads carry only task id, fence token, observation
  point (plus `observedStatus` at the transition boundary) — no superseder field exists to fabricate.
- Pass 1's flagged comment drift is closed: `:2074` now reads "observation point 1 of 2" and `:2346`
  "observation point 2 of 2".
- Assertions `task-superseded-two-live-publish-points` and
  `retired-discriminants-unproduced-but-still-declared` re-run: `ok`.

#### Residual minor gap found in pass 2 — recorded, non-blocking

Task 6.1 enumerated four stale comment denominators and fixed all four. Two more of the same defect
class sit at the two publish points that went from two paths to **one**, and were outside that
enumeration:

- `apps/api/src/guardrails/guardrails.service.ts:1249` — "Durable `SandboxProvisioned` …, 1 of the 2
  provisioning paths". One path survives.
- `apps/api/src/tasks/tasks.service.ts:2055` — "Durable `TaskAdmitted` …, 1 of the 2 admission
  paths". One path survives.

Both are prose inside a passing code path. They change no count the requirements assert, no type, and
no test: the live-site counts (1 and 1) are measured by `spec-assert.mjs` from the source itself, not
from these comments. Requirements 2 and 3 are therefore met as written with a minor gap that does not
block their primary scenarios — recorded here rather than re-opened.

**Closed in this change, not deferred** (commit `fix(guardrails): name the surviving path in the last two retired denominators` — cited by subject, not hash: a commit cannot carry its own hash, and the one written here before committing was a guess). Leaving two instances of a defect class whose
other four were fixed in the same cut is the drift this epic keeps paying for, and the fix is two
comments. Both now name the surviving path instead of a retired denominator
(`guardrails.service.ts:1249` "the one surviving provisioning path", `tasks.service.ts:2055` "the one
surviving admission path"). A tree-wide re-scan for the same pattern afterwards returns only
`1 of 2` / `2 of 2` at the run-start and superseded points, both of which are live counts. Scope
finding 6 below is a separate matter and remains for a later cut.

### Gap finding (pass 2) — no requirement lacks a traceable implementation

Re-audited independently rather than by trusting pass 1's conclusion, and reproduced it:

- 23/23 `spec-assert.mjs` assertions pass (pass 1 recorded 21/21; the two additions cover task 6.1's
  instrument fix).
- The one requirement with no `assertions.json` entry — the runner-minutes seam ("In place and
  unchanged" governs it) — was read by hand: the `private get runnerMinutes()` accessor over the
  `ownedRunnerMinutes` / `detachedRunnerMinutes` backing members exists exactly as described
  (`guardrails.service.ts:601-617`).
- `scripts/ratchets/r11.json` floors re-read one by one: `this.runnerMinutes` 4,
  `provisioningDiagnosticRecorder` 2, `provisioningDiagnosticWriteGate` 2, `this.transcripts` 1,
  `metrics-projection` / `CapacityProjectionPort` 2 — matching the three-collaborator-group
  requirement's pinned floors.
- `scripts/ratchets/r7.json` carries zero `inline-admission` occurrences; `context-layout-check-v2`
  passes; `apps/api/src/inline-admission/` does not exist; the DELETE-only migration
  `apps/api/prisma/migrations/20260806120000_delete_legacy_admission_diagnostic_rows/migration.sql`
  is present.

**No requirement in this change's specs directory lacks a traceable implementation.**

### Scope findings (pass 2) — code in the diff that no requirement describes

Recorded, not routed. None is undeclared **public** impact: `PostCommitAdmissionResult` is an internal
type in `apps/api/src/tasks/tasks.service.ts` with two internal consumers, `POST /v1/tasks` still
returns 201 (D1 admits unconditionally rather than refusing), and the boot-recovery change is a
process-local startup step. `surface-impact.json`'s `publicV1` declaration therefore remains accurate
and its `protocolDifferences: []` remains a true exclusion.

1. `apps/api/src/tasks/tasks.service.ts:206` — `PostCommitAdmissionResult` narrowed to
   `'durable-woken' | 'fail-closed'`; the new `'fail-closed'` outcome replaces the old
   legacy-admission fallback. No requirement in `specs/` describes this post-commit-dispatch contract
   or the narrowed union. Declared in `surface-impact.json` under `internalOnly.scope`
   ("准入行为：mode 分支移除…无条件走 durable（D1）") with `runtimeWireBehavior: "changed"`, which is
   why this is scope rather than undeclared impact.
2. `apps/api/src/tasks/tasks.service.ts:1514-1526` — `admitCreatedTask`'s fail-closed branch writes
   the creation audit, then logs a bespoke warning and returns `'fail-closed'` for a committed row
   with no durable admission work. New behaviour, no backing requirement or scenario.
3. `apps/api/src/scheduled-tasks/scheduled-tasks.service.ts:1222` — downstream ripple in a file the
   change does not otherwise modify: the recovery loop now `continue`s on `outcome === 'fail-closed'`,
   skipping the generic task-status recovery check it ran for the old legacy-admitted case.
4. `apps/api/src/scheduled-tasks/scheduled-tasks.service.ts:1404` — second ripple: another caller
   returns early on `'fail-closed'`, dropping the lease/claim release path for that case.
5. `apps/api/src/tasks/tasks.service.ts:582-596` — the public `reofferQueuedOnStartup()` method and
   the FIFO boot re-offer step it implemented are deleted, and `admit()` is dropped from the
   `IGuardrailsService` interface `TasksService` depends on. The removal is self-documented in the
   startup coordinator's docstring ("There is no boot re-offer step: re-offering pending work into
   the process-local semaphore fed the retired in-request pipeline, and pending durable work is
   recovered by step 4's claim query"), and `reofferQueuedOnStartup` has zero remaining references
   anywhere in `apps/api/src` — but no requirement in the three specs covers startup/boot recovery
   semantics, `admit()`, or the removal of the re-offer step. The only requirement about deleting
   orphaned methods is scoped to `GuardrailsService`'s **private** methods.
6. `apps/api/src/tasks/tasks-pending-recovery.spec.ts` (deleted, 100 lines) — the test whose entire
   subject was the boot re-offer behaviour (FIFO re-offer with owner attribution) is deleted with no
   replacement scenario in `specs/`, corroborating that (5) is an unspecified behaviour change rather
   than a spec-driven deletion.
7. Observed while tracing (3): with `PostCommitAdmissionResult` now a two-member union, the recovery
   block after `scheduled-tasks.service.ts:1222` (`findUnique` → `release` → `recovered`) is
   unreachable — `outcome` narrows to `never` past the two guards. Dead rather than wrong, and the
   residue of the removed third outcome.

---

## Verify pass 3 — HEAD `8064dd2`

Tree verified: branch `refactor/retire-legacy-inline-admission`, HEAD `8064dd2`
("docs(openspec): re-pin the characterization baseline this retirement invalidated"), working tree
clean apart from the unrelated untracked change directory
(`openspec/changes/extract-runner-minutes-ledger/`).

Executable baseline re-run live during this adjudication:

- `node scripts/spec-assert.mjs retire-legacy-inline-admission` → **26/26 passed**, 12 requirements
  decided without an LLM pass. (Pass 2 recorded 23/23; the three additions came with task 7.1's
  characterization re-pin: `characterization-baseline-live`, `characterization-per-file-distribution`,
  `audit-hotspot-lines-unmoved-except-retired`.)

### Adjudication summary (pass 3)

| Route | Count | Ids |
| --- | --- | --- |
| Re-opened as code tasks | 1 | `guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization` |
| Spec defects (design.md Open Questions) | 0 | — |
| Archive-blocking spec defects | 0 | — |
| Re-classified MET | 1 | `guardrails/sandboxprovisioned-is-published-on-both-provisioning-paths-after-the-provider-boundary-succeeds` |

### Re-classified MET (pass 3)

#### `guardrails/sandboxprovisioned-is-published-on-both-provisioning-paths-after-the-provider-boundary-succeeds` — MET (retired correctly)

The skeptic's refutation is correct on its own terms and irrelevant to the route: the heading pins
`both` — a count of two — and this change exists to retire the second path, so probing the heading
text against the retired tree necessarily fails. That is the removal working, not a defect. Re-traced
end-to-end at `8064dd2` rather than carried over from pass 2:

- The heading lives in `## REMOVED Requirements` (`specs/guardrails/spec.md:661-669`, section starts
  at `:649`) with Reason + Migration only and **zero** `#### Scenario` children — there is no live
  behavioural scenario attached to it to satisfy.
- Its Reason is true by measurement: `ls apps/api/src/inline-admission` → *No such file or directory*;
  `grep -rn "publishSandboxProvisioned" apps/api/src --include='*.ts' | grep -v '\.spec\.ts'` returns
  the declaration (`guardrails.service.ts:901`) plus exactly **one** caller (`:1260`). The second path
  is gone, not dormant.
- Its Migration target is implemented. The ADDED requirement ("SandboxProvisioned is published on the
  one surviving provisioning path after the provider boundary succeeds") and all four of its scenarios
  re-trace in source order: `provider.provision(...)` at `:1229` → ownership re-check throwing
  `TaskAdmissionLeaseLostError` at `:1231-1236` (a superseded fence exits before the publish) →
  `lease.authorize()` / `runtime_setup` / `readiness` checkpoints (`:1237-1246`) → connection
  registered at `:1248` → publish at `:1260-1265`, whose payload is assembled only from
  `{ taskId, connection, selectedRun, plan: provisionPlan }` — values already in hand at that seam, no
  new provider call, no new database read, no new resolver. `admissionMode: 'durable'` is fixed inside
  the payload builder (`:901-911`), which takes no `admissionMode` argument.
- Assertion `sandbox-provisioned-one-live-publisher` (`assertions.json:261-275`, `stdoutEquals: "1"`)
  re-run live: `ok`.

### Re-opened as a code task (pass 3)

`guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization` — **UNMET**,
re-opened as task 6.2. This requirement entered the change's `specs/` only at HEAD `8064dd2`, as the
`## MODIFIED Requirements` block task 7.1 wrote, so passes 1 and 2 could not have adjudicated it: at
their HEADs it was a live-spec requirement outside the change's delta, which is exactly the blind
spot task 7.1's own closing note names. This is the first pass with it in field of view.

It is a code/artifact defect, not an ambiguous requirement: the failing scenario is precisely
testable, and it fails.

- The requirement's deletion clause is unconditional and unscoped: "Such a deletion SHALL be
  classified **(c) subject retired** and SHALL name the `## REMOVED Requirements` heading (or the
  retiring requirement) that warrants it… A (c) entry without a warrant is indistinguishable from
  erosion and SHALL be treated as one." Its scenario "Every rewritten assertion carries a classified
  ledger entry" (`specs/guardrails/spec.md:629-634`) applies to "any assertion **in the repository**".
- `git diff --diff-filter=D --name-only main...HEAD` lists three deleted `*.spec.ts` outside
  `apps/api/src/guardrails/`: `inline-admission/inline-admission-domain-event-publishing.spec.ts`
  (−245), `tasks/tasks-legacy-request-lifetime.spec.ts` (−1518), `tasks/tasks-pending-recovery.spec.ts`
  (−100). Ledger entries 7.2 (a) and 7.3 (c) name only the two guardrails files.
- The first two have a warrant reachable in the ledger (tasks 3.1 and 3.2, both naming the
  retired-whole requirement) but no classified (c) entry recording the three required things.
- `tasks-pending-recovery.spec.ts` is the real gap: 2 tests / 6 assertions pinning the FIFO boot
  re-offer (verified with `git show main:…`), named by no task in `tasks.md` (`grep` returns only this
  report's own scope finding 6), and pass 2 already recorded that no requirement in `specs/` covers
  the removal of `reofferQueuedOnStartup()` / `admit()`. Under this requirement, an unwarranted
  deletion is erosion — so the warrant has to be decided, not asserted. Task 6.2 states the candidate
  (the retired-whole requirement plus the startup coordinator docstring at `tasks.service.ts:582-584`)
  and the alternative if it does not hold under trace.
- Routed to code rather than to Open Questions because nothing here needs a design decision that the
  change has not already taken: the ledger form is fixed by the requirement, and the warrant is a
  matter of tracing what the deleted tests pinned against what step 4's claim query still pins.

### Gap finding (pass 3) — no requirement lacks a traceable implementation

Re-audited independently and reproduced pass 2's conclusion. On this tree: 26/26 `spec-assert.mjs`
assertions pass; `apps/api/src/inline-admission/` is absent; live publish-site counts re-measured as
**2 / 1 / 1 / 2** (`task.run_started` / `publishSandboxProvisioned` / `task.admitted` /
`task.superseded`); the runner-minutes getter over its two backing members exists at
`guardrails.service.ts:588-616`; the DELETE-only migration
`20260806120000_delete_legacy_admission_diagnostic_rows` is present; the enum is narrowed to
`z.enum(['durable'])` in `packages/contracts/src/task-provisioning-diagnostics.ts`;
`admission-mode-policy.ts` implements the total one-member mapping; and no reverse-callback-port
symbol survives outside the deleted directory (the surviving `onAdmit`/`onQueue`/`onRefuse` matches
are unrelated semaphore/websocket code).

**Every requirement in this change's `specs/` has a traceable implementation.** The re-opened defect
is not a missing implementation — it is a missing ledger entry for three deletions the requirement
governs, described in full in task 6.2.

### Scope findings (pass 3) — code in the diff that no requirement describes

Recorded, not routed. None is undeclared **public** impact. `PostCommitAdmissionResult` is an
internal type in `apps/api/src/tasks/tasks.service.ts` with two internal consumers; `POST /v1/tasks`
still returns 201 (D1 admits unconditionally rather than refusing); the boot-recovery change is a
process-local startup step. `surface-impact.json`'s `publicV1` declaration therefore remains accurate,
and its `protocolDifferences: []` remains a **true** exclusion for the reason that file states at
length: the empty array is the REST↔MCP projection-difference channel that
`scripts/openspec-metadata.mjs` reconciles against `PUBLIC_V1_OPERATIONS[…].mcp.differences`, and
`tasks.provisioningDiagnostics` declares `NO_MCP_DIFFERENCES` while the enum narrowing lands on both
projections equally — an earlier `'response-enum-narrowed'` entry there was a category error already
caught and corrected by a live run of `scripts/public-surface-adversarial.mjs verify`.

Items 1–7 are carried forward from pass 2 unchanged (`PostCommitAdmissionResult` narrowed to
`'durable-woken' | 'fail-closed'`; `admitCreatedTask`'s new fail-closed branch; the two
`scheduled-tasks.service.ts` ripples at `:1222` and `:1404`; the now-unreachable `findUnique` →
`release` → `recovered` block past those guards; the deletion of `reofferQueuedOnStartup()` and of
`admit()` from `IGuardrailsService`; and the deletion of `tasks-pending-recovery.spec.ts`). Item 6
has since been **partly routed**: the deleted test is now the subject of re-opened task 6.2, while the
unspecified boot-recovery behaviour change itself remains a scope finding.

New in pass 3:

8. `apps/api/src/tasks/startup-recovery.test.mjs:12-13,241,329,504-505,529,675,713` — orphaned test
   mirror. The file's own docstring calls it a "FAITHFUL mirror" of the
   `onApplicationBootstrap` / `readoptSurvivorsOnStartup` / `reclaimOrphanedOnStartup` /
   `reofferQueuedOnStartup` logic of `tasks.service.ts`, and its fake guardrails service mirrors
   `admit`. Two of those production seams no longer exist —
   `grep -rn "reofferQueuedOnStartup" apps/api/src --include='*.ts'` returns zero — so the harness now
   models behaviour that is nowhere in production, and asserts on it (`:675` "persisted guardrail
   params are handed to admit()", `:713` "no guardrails -> 0 re-offered"). The docstring's own escape
   hatch ("The production classes are covered separately by `tasks-startup-durable-recovery.spec.ts`")
   is false for this seam: that spec only pushes dead `'legacy-reoffer'` event labels (`:425`, `:616`)
   that no assertion reads. Not mentioned by any task or requirement; folded into task 6.2's "while
   here" clause rather than routed on its own, since it is the same removal's residue.
