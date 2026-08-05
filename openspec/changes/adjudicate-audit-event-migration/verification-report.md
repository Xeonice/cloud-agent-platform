# Verification report — `adjudicate-audit-event-migration`

Adversarial verification with three-way routing (UNMET → re-opened code task ·
SPEC-DEFECT → `design.md` Open Questions · MET → folded here). Every verdict below
was **re-traced against the working tree**, not copied from the skeptic pass and not
copied from the apply log.

Two verification passes have run against this change. Pass 1 (2026-08-02) re-opened
one cross-artifact contradiction as task 7.1. Pass 2 (2026-08-05) re-verified that
fix and re-adjudicated the raw-unmet set from scratch.

---

# Pass 2 — 2026-08-05 (current)

## Adjudicated tally

| Route | Count | Ids |
|---|---|---|
| Re-opened as code tasks (UNMET) | **0** | — |
| Routed to `design.md` Open Questions (SPEC-DEFECT) | **0** | — |
| Archive-blocking spec defects (public impact / false exclusion) | **0** | — |
| Reclassified MET (raw-unmet, re-traces end-to-end) | **5** | the five listed below |

The skeptic pass produced **5 raw-unmet requirements** and **0 mandatory public
findings**. All 5 re-trace as satisfied on this tree. The tally above is this pass's
adjudication, not the raw skeptic count. Pass 1's single re-opened task (7.1) was
independently confirmed **fixed** on this tree — see "Pass 1 carry-over" below.

## Gates actually executed on this tree during pass 2

Every row below was run by this pass; none is quoted from pass 1.

| Gate | Result |
|---|---|
| `grep -n 'this\.audit' apps/api/src/guardrails/guardrails.service.ts` | 9 refs — `1197, 2063, 2067, 2770, 3529, 3778, 3787, 3806, 3815` (identical to `adjudication.md` §0/§1 and to `r11.json` `samples`) |
| `node scripts/ratchets/r11-dependency-budget.mjs` | exit 0 — `this.audit: 9`, `this.runnerMinutes: 6`, `provisioningDiagnosticRecorder: 4`, `provisioningDiagnosticWriteGate: 4`, `this.transcripts: 2`, `metrics-projection: 2`; "every collaborator exactly at its baselined count" |
| `pnpm exec tsc --noEmit -p tsconfig.json` (apps/api) | exit 0, zero diagnostics — so every `@ts-expect-error` negative in `domain-event-bus.typecheck.ts` still self-invalidates (the compiler-enforced `blocking-strict` subscriber guard holds) |
| `node --test dist/guardrails/*.spec.js` | **137 pass / 0 fail** across the 6 spec files (`dist` mtime `Aug 5 07:50` is newer than every `src` counterpart — not a stale run) |
| `node scripts/run-suite.mjs "src/guardrails/*.test.mjs"` | **8 / 8 scripts pass** (incl. `delivery-results-surfaced-and-audited.test.mjs`, `semaphore.test.mjs`) |
| `node --test dist/task-admission/provisioning-stage-ownership.spec.js` | **5 pass / 0 fail** (the executable per-stage ownership proof) |
| `node --test dist/domain-events/*.spec.js` | **28 pass / 0 fail** (incl. the exact-subscriber-set table test) |
| `node scripts/test-discovery-check.mjs` | exit 0 — 485 test files, all discovered by a runner |
| `openspec validate adjudicate-audit-event-migration --strict` | `Change 'adjudicate-audit-event-migration' is valid` |
| `node scripts/public-surface-adversarial.mjs verify adjudicate-audit-event-migration --phase verify` | exit 0, all checks `passed: true`, **`findings: []`** — `sidecar`, `registry`, `restMetadata`, `mcpSdkMetadata`, `behavior` |

Live characterization baseline, re-measured this pass:

```
apps/api/src/guardrails/*.spec.ts  → 6 files, 135 test()
   guardrails.service.spec.ts 57 · guardrails-durable-launch-decision.spec.ts 54
   guardrails-domain-event-publishing.spec.ts 15 · guardrails-branch-policy.spec.ts 3
   semaphore-restore.spec.ts 3 · transfer-progress-throttle.spec.ts 3
apps/api/src/guardrails/*.test.mjs → 8 files
```

Diff shape confirmed by `git status` / `git diff --stat`: this change touches
`apps/api/src/domain-events/README.md`, `apps/api/src/domain-events/domain-event-bus.service.spec.ts`,
`deploy/DEPLOY.md`, `docs/refactor-master-plan.md`, `scripts/ratchets/r11.json`, adds
`apps/api/src/task-admission/provisioning-stage-ownership.spec.ts`, and adds its own change
directory. **Zero files under `apps/api/src/guardrails/` appear in the diff** — including all
three named audit hotspots. `git diff --stat HEAD -- packages/contracts apps/api/prisma scripts/quick-deploy.sh`
is empty: zero contract edits, zero schema edits, zero new migration directories, zero deploy-script
edits, no new deploy runbook.

`tasks.md`: **50 / 50 checked, zero open items**, across 7 tracks (`preflight-and-coverage-proof`,
`domain-events-guards`, `adjudication-artifact`, `guardrails-source`,
`budget-and-registry-reconciliation`, `gates-and-verification`, `verify-reopened`). This pass
appended nothing.

---

## Requirement-by-requirement adjudication — the 5 reclassified MET

### 1. `domain-event-bus/the-non-event-admission-rule-declares-three-named-refusal-criteria` — **MET**

`specs/domain-event-bus/spec.md:3-37` declares **exactly three** named criteria
(`acknowledgement-required`, `information-missing`, `no-decoupling-gain`), each stated as a
property of the collaboration (return semantics / payload sufficiency / I/O ownership) with a
named worked example, and names the industry term *passive-aggressive event* verbatim
(`spec.md:7`). Re-traced each scenario against real code rather than against the artifact's prose:

- **Criterion 1 (result-branching).** `audit-recorder.port.ts:57-62` and `:68` declare
  `recordProvisioningFailure(...): Promise<boolean>` and `recordTaskCancellation(...): Promise<boolean>`
  (read live this pass, with the port doc-comments that state "Returns false when either durable row
  could not be confirmed"); `guardrails.service.ts:3787-3801` / `:3815-3824` read the value into
  `recorded` and branch (`if (recorded) return;` else `throw TaskAdmissionCoordinationError('checkpoint', …)`).
  The recorded reason is the `publish`-returns-`void` hop, not the collaborator's name.
- **Criterion 2 (`recordForceFailed`).** Re-checked field-by-field against the five payload schemas in
  `packages/contracts/src/domain-event.ts:258-334`. `TaskAdmittedEventSchema` carries
  `admissionMode`/`outcome`/`fenceToken`; `SandboxProvisionedEventSchema` carries
  `admissionMode`/`providerFamily`/`sandbox`/`environment`; `TaskRunStartedEventSchema` carries
  `startPoint`/`admissionMode?`; `TaskSettledEventSchema` carries **only** `status`;
  `TaskSupersededEventSchema` carries `observationPoint`/`fenceToken?`/`observedStatus?`. No payload
  carries a `cause` field or the local-CAS attribution (`grep -n "cause"` over the file returns only
  prose in comments). Both negative assertions exist verbatim and pass —
  `guardrails.service.spec.ts:1367` `assert.equal(forceFailureAuditCalls, 0, variant);` and `:2302`
  `assert.equal(forceFailAudits, 0);`.
- **Criterion 3 (`recordExited`).** Producer-side I/O confirmed in `recordExitDetail`
  (`guardrails.service.ts:2043-2071`), whose `tail` argument comes from `gateway.readSessionLogTail`.
- **Exactly one criterion per CALL row.** Re-derived from `adjudication.md` §1's table directly (not
  read off §4's self-check): R1 `information-missing`, R2/R3 `no-decoupling-gain`,
  R4/R5 `information-missing`, R6–R9 `acknowledgement-required`. 9 rows, 9 criteria, zero blank, zero
  double.
- **Declared once.** `grep -rn` for the three criterion names outside `node_modules`/`dist` hits only
  this change's own artifacts plus `apps/api/src/domain-events/README.md`, which states it references
  the capability spec and does not restate it.

### 2. `domain-event-bus/audit-durability-is-classified-into-two-named-tiers` — **MET**

`specs/domain-event-bus/spec.md:38-71` names exactly two tiers. Re-traced:

- **One tier per row:** 9/9 (`batch` R1–R5, `blocking-strict` R6–R9), zero rows with both or neither.
- **`blocking-strict` set = the two acknowledgement collaborations:** exactly the four references of
  `recordProvisioningFailure` (guard `:3778` + call `:3787`) and `recordTaskCancellation`
  (guard `:3806` + call `:3815`). No `batch` row returns a value the caller reads — the five `batch`
  methods are declared `Promise<void>` in `audit-recorder.port.ts`.
- **Compiler-enforced boundary:** `domain-event-bus.typecheck.ts:84-91` (read live this pass) passes
  `audit.recordProvisioningFailure` bare, the same method parameter-adapted, and a
  `recordTaskCancellation` handler to `bus.subscribe` under `@ts-expect-error`; a fourth negative
  covers `writeGate.isEnabled`. `tsc --noEmit -p tsconfig.json` exits 0 with zero diagnostics, so
  none of those directives is unused — i.e. every rejection is still real. A prior dynamic probe
  confirmed the non-vacuity in the other direction: removing the directive produces
  `TS2345 … not assignable to 'VoidOnlyDomainEventHandler'`.
- **Reclaimable-on-failure:** `task-admission.worker.spec.ts:1099`
  `test('pending cancellation audit leaves terminal work leased and reclaimable', …)` exists and is
  part of the green admission-worker suite; the guardrails path that throws
  `TaskAdmissionCoordinationError('checkpoint', …)` is at `guardrails.service.ts:3778-3824`.
- **Declared once:** repo-wide `grep -rn "blocking-strict"` (excluding `node_modules`/`dist`) hits only
  this change's own artifacts (`spec.md`, `adjudication.md`, `tasks.md`, `research-brief.md`, this
  report) plus `apps/api/src/domain-events/README.md:49-52`, which points at the capability spec and
  says verbatim "This file references the names; it does not restate the definitions." Zero
  occurrences in `apps/api/src/domain-events/*.ts` or `scripts/ratchets/r11.json` — the tier boundary
  is enforced structurally by the compiler, not duplicated as a string.

### 3. `domain-event-bus/a-removed-synchronous-call-shall-have-a-provably-reachable-owner` — **MET**

Zero calls were removed this cycle, so the "removal ships with an executable proof" clause is
satisfied vacuously — and substantively, because the single removal candidate got a real proof and
was correctly *retained*:

- `apps/api/src/task-admission/provisioning-stage-ownership.spec.ts` drives the production chain
  (`TaskAdmissionWorker` → `FencedTaskAdmissionProcessor` → `GuardrailsService.processDurableAdmission`
  → real lease controls, provider stubbed) and reads the stage census from the real provider sources
  rather than restating a list — **5/5 pass, re-run this pass**.
- `guardrails.service.ts:1197` is physically present; live `this.audit` count is 9; `r11.json`
  `count: 9` with the ratchet green — i.e. the retained reference stays counted in the budget baseline,
  exactly as the "unowned call site is retained" scenario requires.
- `adjudication.md` §1 records R1 as **CALL** with criterion `information-missing` and leaves the
  REMOVED-only "proven other owner" cell as `—` rather than fabricating one. §2.5 records the measured
  per-stage table and the two independent grounds for retention (ownership conditional on the attempt
  succeeding; the untouchable hotspot assertion at `guardrails-durable-launch-decision.spec.ts:1804-1859`).
- **Bidirectional reconciliation:** all 9 rows carry both the outbound collaborator and named inbound
  dependents; spot-checked live — `task-admission.worker.spec.ts:1099`/`:1342`,
  `guardrails.service.spec.ts:1367`/`:2302`, and `delivery-results-surfaced-and-audited.test.mjs:192`
  (the hand-written `this.audit?.recordChangeRequest(taskId, { url, number, reused })` mirror) all
  exist at the cited lines.
- §2.5 also carries a forward reconciliation instruction ("the artifact is wrong before the ratchet is,
  in that order") that makes a future split between the artifact and the tree visible at integration.

### 4. `guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact` — **MET**

`adjudication.md` holds exactly 9 rows, one per live symbol reference, and every row carries
`file:line` · collaborator/guard · declared return type · caller-reads-result · tier · verdict ·
covering event type (EVENT only) · refusal criterion (CALL only) · proven owner (REMOVED only) ·
inbound dependents. Re-traced:

- **Row set == live grep set == `r11.json` `samples` set** — byte-identical 9 lines, confirmed by
  reading `r11.json` through `json.load` rather than by eye.
- No blank verdict / tier / criterion; rows not marked `REMOVED` = 9 = live count = ratchet count.
- Zero `EVENT` rows, each recorded against the field no catalog payload carries — verified against the
  real envelope (`eventId`, `occurredAt`, `type`, `taskId`, `DomainEventEnvelopeSchema:129`) and the
  five payload schemas.
- Inbound direction present for the two acknowledgement rows (terminal admission recovery at
  `guardrails.service.ts:1459`/`:1529` → `TaskAdmissionCoordinationError('checkpoint')` → work row stays
  leased, plus the worker spec that asserts it) and for the delivery row (the inline mirror that
  "cannot fail on its own").

### 5. `guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization` — **MET**

- **Baseline matches the tree:** re-counted live this pass — 6 `*.spec.ts` / 135 `test()` with the
  exact 57+54+15+3+3+3 distribution, and 8 `.test.mjs`. The executed run reports **137** passing tests
  rather than 135 because two files register parameterized `test()` calls inside `for` loops —
  per-file runtime counts measured this pass are `guardrails-branch-policy.spec.ts` 3 static → **4**
  runtime (the `for (const anomalousWorkspace of [null, undefined])` loop at `:90`) and
  `guardrails-durable-launch-decision.spec.ts` 54 static → **55** runtime; the other four files match
  1:1 (57 / 15 / 3 / 3). The spec pins a static `test()` call-site count, which matches exactly. Both
  suites green (137/137 and 8/8).
- **The three hotspots are unmodified:** `git status --short -- apps/api/src/guardrails/` is **empty**;
  `guardrails-durable-launch-decision.spec.ts`, `delivery-results-surfaced-and-audited.test.mjs` and
  `guardrails.service.spec.ts` do not appear in the diff at all, and all three pass.
- **Negative force-fail assertions hold:** `guardrails.service.spec.ts:1367` and `:2302` present,
  unmodified, and inside the green run.
- **Ledger:** `adjudication.md` §3 is "Zero entries" with the required template retained for future
  use — consistent with a diff that rewrites zero assertions anywhere in the repository.
- **Inline source mirror moves with its subject:** R4's handling is unchanged this cycle, so the mirror
  is correctly untouched.
- **Source-text-scanning strength preserved:** the wiring and audit text-scanning scripts run green
  with their per-file assertions intact; `node scripts/test-discovery-check.mjs` exits 0 over 485 test
  files, so nothing this change added escapes a runner.
- **Hygiene confirmed clean this pass:** `ls apps/api/src/guardrails/ | grep -i groundtruth` returns
  nothing — the stray refutation spec that pass 1 had to evict is gone, and pass 2's own ground-truth
  probes were written to the session scratchpad, never into the pinned directory.

---

## Pass 1 carry-over — the one re-opened task, verified fixed

### `guardrails/an-audit-call-is-removed-only-under-a-proven-per-stage-owner-and-at-most-one-is-removed` — **closed**

Pass 1 found that `surface-impact.json` → `surfaces.internalOnly.scope`, clause ③, still asserted the
*refuted* rationale 「结论为 PROOF-FAIL（… readiness 无 admission worker checkpoint 所有者）」 as the
recorded basis of the central retention decision, after task 6.10 had corrected the same claim in
`scripts/ratchets/r11.json` and `deploy/DEPLOY.md` §14 but missed the sidecar — the third copy.

Verified fixed on this tree (pass 2): `grep -n "PROOF-FAIL"` over `surface-impact.json` returns **zero
matches**, and clause ③ now reads, matching `adjudication.md` §2.5 in substance, that all four reported
stages (`aio:readiness`, `aio:runtime_setup`, `boxlite:readiness`, `boxlite:runtime_setup`) **do** have
an admission-worker checkpoint owner under the same dedupe identity
(`guardrails.service.ts:1245`/`:1247` → `task-admission.worker.ts:612`), and that `:1197` is retained
because three of those owner rows project only **after** `provision(...)` returns. `tasks.md` 7.1 is
`[x]` with its evidence line. The verdict itself (CALL / 9→9 / `REMOVED` = 0) is unchanged, no
`surfaces.*.status` value moved, and
`node scripts/public-surface-adversarial.mjs verify … --phase verify` still returns `findings: []`.

---

## Routed to `design.md` Open Questions (SPEC-DEFECT) — 0

No requirement in this change was found ambiguous, untestable, or self-contradictory. Every scenario in
all three spec deltas resolves to something checkable on the tree — a grep-able count, a compiler
diagnostic, a named test, or a diff shape — and each was checked. `design.md` was not edited by either
pass.

## Archive-blocking spec defects — 0

No undeclared public impact and no false protocol exclusion. The sidecar declares
`publicV1`/`mcp`/`openapi`/`apiPlayground` all `unchanged` with `protocolDifferences: []`, and the
adversarial gate agrees: `sidecar`, `registry`, `restMetadata`, `mcpSdkMetadata` and `behavior` all
`passed: true` with an empty `findings` array. Independently corroborated by the diff itself —
`git diff --stat HEAD -- packages/contracts apps/api/prisma scripts/quick-deploy.sh` is empty, and the
change adds, changes, or removes zero `/v1` operations. The exclusion claims are true, so nothing
blocks archive on the public-surface rule.

---

## Gap findings

**None.** Everything traces cleanly. Based on independent verification against the working tree (spec
files, code call sites, `adjudication.md` rows, the `r11.json` ratchet, `DEPLOY.md` registration, the
domain-event envelope schema, subscriber module wiring, and the guardrails test suite all present and
matching the specs), no requirement in this change's specs is missing a traceable implementation.

```json
[]
```

**Verification detail** — all 15 requirements across the three spec files were checked against actual
repo state, not just against `tasks.md` / this report's own earlier claims:

- **`audit-history`** — all 3 requirements trace to
  `apps/api/src/task-admission/provisioning-stage-ownership.spec.ts`, the synchronous-dispatch gate
  evidence, and the envelope schema in `packages/contracts/src/domain-event.ts` (exactly `eventId` /
  `occurredAt` / `type` / `taskId`, confirmed live).
- **`domain-event-bus`** — all 8 requirements trace to
  `apps/api/src/domain-events/domain-event-bus.service.spec.ts` (table-driven exact-set test present),
  `domain-event-bus.typecheck.ts` negatives, `apps/api/src/domain-events/domain-events.module.ts`
  (`DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS`, no `DiscoveryService` / `MetadataScanner`),
  `scripts/ratchets/r11.json` (live counts matching baseline), and `deploy/DEPLOY.md` §14 toggle
  registration.
- **`guardrails`** — all 4 requirements trace to
  `openspec/changes/adjudicate-audit-event-migration/adjudication.md` (398 lines, 9 adjudicated rows
  confirmed live), the live 9 `this.audit` references in `apps/api/src/guardrails/guardrails.service.ts`
  at the exact cited lines, the retained private `recordAudit` helper (3 call sites), and the 6
  `*.spec.ts` + 8 `*.test.mjs` characterization suite present unmodified.

## Scope findings — 4 (implemented content with no covering requirement)

```json
[
  {
    "description": "Pre-scan of `this.runnerMinutes`, `provisioningDiagnosticRecorder`/`provisioningDiagnosticWriteGate`, `this.transcripts` against the 3 refusal criteria, issuing LIKELY-CALL verdicts and a route-change recommendation (event-migration → application-service extraction) for cuts 3-5.",
    "file": "openspec/changes/adjudicate-audit-event-migration/adjudication.md:301-398"
  },
  {
    "description": "Artifact itself declares this section maps to no spec requirement (\"本节不写进任何 spec requirement\"), confirming §5 is undocumented scope.",
    "file": "openspec/changes/adjudicate-audit-event-migration/adjudication.md:397"
  },
  {
    "description": "New pointer line in the master refactor plan directing future phase-4 proposals to adjudication.md §5's route-calibration conclusion; no requirement in specs/ calls for touching this file at all.",
    "file": "docs/refactor-master-plan.md:141"
  },
  {
    "description": "Test asserts an in-provision-vs-after-provision-returns timing distinction and pins a measured residual stage list (`aio:readiness`, `aio:runtime_setup`, `boxlite:readiness`); the audit-history \"declared owner\" requirement's scenarios only require a row eventually exist, never that it exist during the provisioning window — this timing criterion is the actual retention ground but has no matching requirement text.",
    "file": "apps/api/src/task-admission/provisioning-stage-ownership.spec.ts:604-654"
  }
]
```

Findings 1–3 are additive documentation with no runtime surface and no gate cost; finding 2 is the
artifact's own honest self-declaration that §5 is out of spec scope, which is why it is recorded rather
than treated as a concealment.

Finding 4 is the substantive one. The removal condition as written in
`guardrails/an-audit-call-is-removed-only-under-a-proven-per-stage-owner-and-at-most-one-is-removed`
was *satisfied* on a completed run — every reported stage does have a worker-owned row under the same
dedupe identity — yet the hint was correctly retained on a timing ground the requirement does not
express. It is **not routed as a spec defect**, for two independently sufficient reasons:

1. The requirement's quantifier is over every reported stage of every attempt, not only completed
   attempts. An attempt that throws inside `provision(...)`, is cancelled, unwinds for a detaching
   workspace transfer, or loses the post-provision ownership re-check never reaches `:1245`/`:1247`,
   so three family:stage pairs would have **no** worker-owned row. Read that way — the reading
   `adjudication.md` §2.5 actually applies — the requirement's own "if any reported stage has no such
   worker-owned row, the hint SHALL be retained" clause fires, and retention is exactly what the
   requirement orders.
2. The delivered behaviour (retain · `CALL` · count 9 · `REMOVED` = 0) is identical under both
   readings, so nothing about the shipped tree turns on the ambiguity.

The risk it names is forward-looking: a future phase-4 cut that reads only the requirement text, on a
completed-run proof alone, could conclude the hint is removable. Worth folding the in-provision timing
dimension into the requirement when the next cut touches it — recorded here as scope, not re-opened as
a task and not routed to Open Questions, because the requirement is neither untestable nor
contradictory on this tree.

---

## Verification-pass hygiene and pre-archive preconditions

These are conditions of the **working tree**, not defects in the change's implementation. All three
must be resolved before this change is committed or archived.

1. **Pass 1: a dynamic-refutation pass left a spec file inside the pinned directory — resolved.**
   `apps/api/src/guardrails/groundtruth-publish-does-not-disturb-lifecycle.spec.ts` had made
   `apps/api/src/guardrails/` hold 7 `*.spec.ts` / 136 `test()`, directly violating the
   `135 test() / 6 *.spec.ts` baseline the characterization requirement pins — i.e. the act of
   verifying the change would have broken it. The file was moved to the session scratchpad and its
   stale `dist/` output deleted. Confirmed still clean in pass 2: 6 files / 135 `test()` / 8 `.test.mjs`,
   and no `groundtruth*` file under `apps/api/src/guardrails/`.

2. **Pass 2: an untracked, un-ignored build directory is left in the tree — needs cleanup.**
   `apps/api/dist_check_tmp/` (13 MB, 469 × `.js`/`.d.ts`/`.map` plus a `.tsbuildinfo`) is a typecheck
   scratch output from an earlier pass. `git check-ignore` reports it is **not** ignored, so it would be
   swept into a `git add -A`. It does not affect any gate — it holds no `*.spec.ts` sources, the
   characterization baseline globs only `apps/api/src/guardrails/`, and
   `node scripts/test-discovery-check.mjs` exits 0 with it present — but it must be deleted before the
   commit.

3. **The first cut is un-archived in this worktree (concurrent-session pollution) — still present.**
   `git status` shows `openspec/changes/archive/2026-08-01-add-domain-event-bus/**` and
   `openspec/specs/domain-event-bus/spec.md` deleted, `openspec/specs/guardrails/spec.md` modified, and
   `openspec/changes/add-domain-event-bus/` restored as an untracked active change. At `HEAD` everything
   is correctly archived — verified this pass:
   `git show HEAD:openspec/specs/domain-event-bus/spec.md` holds **17** requirements, and
   `git show HEAD:openspec/specs/guardrails/spec.md` holds both anchors this change's
   `## MODIFIED Requirements` target, at `:657` (*Guardrails publishes domain events without changing
   lifecycle behavior*) and `:823` (*Existing guardrails behavior is proven unchanged by
   characterization*).

   Consequence if archived from the worktree as-is: this change's MODIFIED deltas for
   `domain-event-bus` (3 requirements) and `guardrails` (2 requirements) would have **no anchor**, and
   `apps/api/src/domain-events/README.md:49-52`'s pointer to `openspec/specs/domain-event-bus/spec.md`
   as "the single place that defines them" would dangle. `openspec validate --strict` does not catch
   this (it passed).

   Not attributable to `adjudicate-audit-event-migration`: task 1.1's precondition and `design.md` Q5
   are both correct against `HEAD`. Resolve by letting the concurrent session finish re-archiving the
   first cut, or by restoring `openspec/` from `HEAD`, before committing this change.

---

## Task ledger

`tasks.md` stands at **50 / 50** checked with zero open items across 7 tracks. Pass 1 appended the
`## 7. Track: verify-reopened (depends: none)` section with a single item (7.1, the sidecar
contradiction), which has since been implemented and is verified corrected above. Pass 2 re-opened
nothing, marked nothing complete, and appended no task.
