# Verification report — retire-legacy-inline-admission

Tree verified: branch `refactor/retire-legacy-inline-admission`, HEAD `3619b08`
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
