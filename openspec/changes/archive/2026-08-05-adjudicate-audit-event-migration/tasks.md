<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.
     CORRECTED partition (verified against real file coupling on this tree):
       wave 1: 1 preflight-and-coverage-proof ∥ 2 domain-events-guards
       wave 2: 3 adjudication-artifact ∥ 4 guardrails-source   (both after 1)
       wave 3: 5 budget-and-registry-reconciliation             (after 4; may overlap 3)
       wave 4: 6 gates-and-verification                         (integration, serial, after all)
     Every write set below is disjoint. Two corrections vs. the draft:
       - old 2.7 (repo-wide `blocking-strict` grep) moved to the integration track: it asserts
         over repo state that tracks 2 AND 3 both mutate, so it cannot run inside track 2.
       - track 5 no longer depends on track 3: the REMOVED count it needs comes from track 1's
         verdict (task 1.8) via track 4, not from the adjudication table. The cross-artifact
         reconciliation stays where it belongs — integration task 6.10. -->

## 1. Track: preflight-and-coverage-proof (depends: none)

<!-- Writes: apps/api/src/task-admission/provisioning-stage-ownership.spec.ts (new; a `.spec.ts`
     in that directory matches an existing file→layer rule, so it produces no r7 key — verified:
     r7.json's task-admission entries are all non-spec files).
     Reads only: guardrails.service.ts, task-admission.worker.ts, both providers, r11.json.
     Produces the removal verdict for guardrails.service.ts:1197 that tracks 3/4/5 consume.
     Design D5/D6/D11. -->

- [x] 1.1 Run `ls openspec/specs/domain-event-bus/spec.md` (D11): record whether the first-cut archive PR has landed. If absent, record that the `## MODIFIED Requirements` in `specs/domain-event-bus/spec.md` and `specs/guardrails/spec.md` have no anchor and that `chore/archive-domain-event-bus` must merge before this change — do not convert MODIFIED to ADDED to work around it.
  - requirements: ["domain-event-bus/audit-durability-is-classified-into-two-named-tiers"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.2 Re-measure live on this tree: `grep -n 'this\.audit' apps/api/src/guardrails/guardrails.service.ts` (expect 9 refs at 1197/2063/2067/2770/3529/3778/3787/3806/3815) and `node scripts/ratchets/r11-dependency-budget.mjs` (expect `this.audit` count 9). Record the exact 9 `file:line` + line text for tracks 3 and 5; note that `scripts/ratchets/r11.json` `samples` are two generations stale.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.3 Measure and record the guardrails characterization baseline used by the spec: `test()` count across `apps/api/src/guardrails/*.spec.ts` (expect 135 over 6 files, 57+54+15+3+3+3) and `.test.mjs` count (expect 8). Record separately; this is the tripwire for tracks 4 and 6.
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.4 Enumerate, by reading source, every provisioning stage each provider family reports through `onProvisioningProgress` (at minimum `packages/sandbox-provider-aio/src/aio-provider.ts` `readiness`/`runtime_setup`, `packages/sandbox-provider-boxlite/src/boxlite-provider.ts` `readiness`/`workspace_transfer`/`runtime_setup`) and every stage reachable at an admission-worker checkpoint (`apps/api/src/task-admission/task-admission.worker.ts` claim stage + `parsedStage` from `beforeProvisioningBoundary`). Record the two sets and their difference.
  - requirements: ["audit-history/every-provisioning-stage-row-has-a-declared-owner"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.5 Write the executable per-stage ownership proof at `apps/api/src/task-admission/provisioning-stage-ownership.spec.ts`: drive the provider composite, capture the stage sequences of both callbacks, and assert `stages(onProvisioningProgress) ⊆ stages(beforeProvisioningBoundary → lease.checkpoint → worker advanceStage)`, plus per-checkpoint-stage assertion that the `task.provisioning:{taskId}:{attempt}:{stage}` row is still written by the worker with the hint absent. Failure output must name the uncovered stage.
  - requirements: ["audit-history/every-provisioning-stage-row-has-a-declared-owner", "domain-event-bus/a-removed-synchronous-call-shall-have-a-provably-reachable-owner"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.6 Assert the dedupe-identity requirement in the same spec: when the worker checkpoint and the composite hint both fire for the same `{taskId, attempt, stage}`, exactly one audit row exists (no duplicate from the second writer).
  - requirements: ["audit-history/every-provisioning-stage-row-has-a-declared-owner"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.7 Run the proof and record the verdict as PROOF-PASS or PROOF-FAIL with the named uncovered stages. Do not weaken, narrow, or stub the proof to make it pass — design D5 expects PROOF-FAIL (`readiness` likely has no worker owner) and the specs carry both branches.
  - requirements: ["guardrails/an-audit-call-is-removed-only-under-a-proven-per-stage-owner-and-at-most-one-is-removed"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.8 Publish the track handoff: the removal verdict for `guardrails.service.ts:1197` (REMOVED + proven owner, or CALL + refusal criterion), the resulting `this.audit` count (8 or 9), and the measured line list from 1.2.
  - requirements: ["guardrails/an-audit-call-is-removed-only-under-a-proven-per-stage-owner-and-at-most-one-is-removed"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 2. Track: domain-events-guards (depends: none)

<!-- Writes: apps/api/src/domain-events/domain-event-bus.service.spec.ts,
     apps/api/src/domain-events/domain-event-bus.typecheck.ts (measured: all three negatives
     D4 names already exist at :85/:88/:91, so this is expected to be a no-op read),
     apps/api/src/domain-events/README.md.
     Reads only: domain-events.module.ts:33, packages/contracts/src/domain-event.ts.
     Design D3/D4/D7. No new files in this directory (C10 unclassified-file / r7 risk).
     The draft's 2.7 left this track: see integration task 6.1. -->

- [x] 2.1 Extend `apps/api/src/domain-events/domain-event-bus.service.spec.ts` (do NOT create a new file) with a table-driven test whose keys are derived from the exported `DOMAIN_EVENT_TYPES` literal (from `@cap/contracts`), asserting the table's key set equals the exported type set so a sixth event type without a row fails.
  - requirements: ["domain-event-bus/each-event-type-s-registered-subscriber-set-is-asserted-as-an-exact-set"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.2 In the same test, assert per event type the **exact set** (set equality, not count, not superset) of registered subscriber names read from `DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS` (`apps/api/src/domain-events/domain-events.module.ts:33`); expected set is empty for all five types on this tree.
  - requirements: ["domain-event-bus/each-event-type-s-registered-subscriber-set-is-asserted-as-an-exact-set"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.3 Verify both failure directions by temporary local mutation (revert after): adding an unlisted registration turns it red naming the event type and unexpected subscriber; removing a listed registration turns it red naming the missing subscriber. Keep the existing `test('this change registers zero subscribers')` intact.
  - requirements: ["domain-event-bus/each-event-type-s-registered-subscriber-set-is-asserted-as-an-exact-set", "domain-event-bus/subscribers-are-registered-explicitly-and-only-registered-subscribers-run"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.4 Audit `apps/api/src/domain-events/domain-event-bus.typecheck.ts` against the `blocking-strict` scenario: confirm `recordProvisioningFailure` (bare + parameter-adapted) and the `recordTaskCancellation` handler are `@ts-expect-error` negatives; add only what is missing, keeping the self-invalidating property (an expect-error that stops erroring must itself fail).
  - requirements: ["domain-event-bus/the-non-event-admission-rule-declares-three-named-refusal-criteria"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.5 Run `pnpm --filter @cap/api typecheck` (or the repo's tsc gate) and confirm the fixture still compiles with every `@ts-expect-error` consumed — this is the compiler-enforced tier boundary, replacing any new gate.
  - requirements: ["domain-event-bus/the-non-event-admission-rule-declares-three-named-refusal-criteria"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.6 Add a one-line pointer in `apps/api/src/domain-events/README.md` stating that the `batch` / `blocking-strict` tier names are normatively defined in the `domain-event-bus` capability spec. Do not restate the definitions here (spec: exactly one file defines them).
  - requirements: ["domain-event-bus/audit-durability-is-classified-into-two-named-tiers"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 3. Track: adjudication-artifact (depends: preflight-and-coverage-proof)

<!-- Writes: openspec/changes/adjudicate-audit-event-migration/adjudication.md (new, sole writer)
     and one pointer line in docs/refactor-master-plan.md (task 3.11, sole writer repo-wide).
     Runs in parallel with track 4 and track 5 — disjoint write sets, verified.
     Design D2 — never write these verdicts into guardrails.service.ts comments. -->

- [x] 3.1 Create `openspec/changes/adjudicate-audit-event-migration/adjudication.md` with a table of **exactly 9 rows**, one per `this.audit` symbol reference measured in task 1.2, with columns: `file:line` | collaborator method (or the guard it forms) | declared return type | caller reads/branches on result | tier (`batch`\|`blocking-strict`) | verdict (`CALL`\|`EVENT`\|`REMOVED`) | covering event type (EVENT only) | refusal criterion (CALL only) | proven other owner (REMOVED only) | inbound dependents.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.2 Fill the four `blocking-strict` rows — `:3778` and `:3806` (`if (!this.audit)` guards) plus `:3787` `recordProvisioningFailure` and `:3815` `recordTaskCancellation`, both `Promise<boolean>` read by the caller — as `CALL` / `acknowledgement-required`, and name the industry term *passive-aggressive event*.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact", "domain-event-bus/the-non-event-admission-rule-declares-three-named-refusal-criteria"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.3 Record the inbound direction for those four rows: terminal admission recovery throwing `TaskAdmissionCoordinationError('checkpoint', …)` so the running work row stays leased and reclaimable, plus the existing test that asserts it (locate it by grep, cite `file:line`).
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.4 Fill the `recordExited` rows `:2063` (`if (this.audit)` guard) and `:2067` as `batch` / `CALL` / `no-decoupling-gain`, recording that `tail` comes from a producer-side `gateway.readSessionLogTail` call so carrying it in a payload only moves the coupling.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact", "domain-event-bus/the-non-event-admission-rule-declares-three-named-refusal-criteria"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.5 Fill `:3529` `recordForceFailed` as `batch` / `CALL` / `information-missing`, recording field-by-field against all five catalog payloads that neither the `force_failed:${cause}` cause nor the local-CAS callback attribution is carried.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact", "domain-event-bus/the-non-event-admission-rule-declares-three-named-refusal-criteria"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.6 Fill `:2770` `recordChangeRequest` as `batch` / `CALL` with its criterion (missing `url`/`number`/`reused`), and name as inbound dependent the hand-written inline source mirror `apps/api/src/guardrails/delivery-results-surfaced-and-audited.test.mjs`, explicitly noting it cannot fail on its own if the call's handling changes.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.7 Fill `:1197` `recordProvisioningProgress` from track 1's verdict: PROOF-FAIL → `batch` / `CALL` with its criterion and the named uncovered stage(s); PROOF-PASS → `REMOVED` with the admission worker named as the proven other owner and the proof spec cited by path.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact", "guardrails/an-audit-call-is-removed-only-under-a-proven-per-stage-owner-and-at-most-one-is-removed"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.8 Add the assertion-rewrite ledger section. Expected content is "zero entries"; any entry must be classified (a) implementation detail or (b) real requirement, and record all three of: the order the original assertion pinned, why it no longer holds, and the invariant the replacement pins.
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.9 Self-check the artifact against the specs: every `CALL` row cites exactly **one** of `acknowledgement-required` / `information-missing` / `no-decoupling-gain`; every row carries exactly one tier; zero blank verdicts; the `blocking-strict` set is exactly the four references of the two acknowledgement methods; zero rows are `EVENT`. Record the row count and the REMOVED count for the integration cross-check (task 6.10) — track 5 takes its own REMOVED count from track 1's verdict (task 1.8), not from this table.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"

- [x] 3.10 【用户拍板新增·路线校准】在 `adjudication.md` 末尾加「阶段 4 剩余三组预扫」一节，对 `guardrails.service.ts` 里的 `this.runnerMinutes`(6)、`provisioningDiagnosticRecorder`(4) + `provisioningDiagnosticWriteGate`(4)、`this.transcripts`(2) 三组逐组用**同一套三判据**（需要回执 / 信息缺失 / 事件化不减耦）出初判：每组记录 ① 现场调用点 file:line 与返回类型 ② 其语义需要的字段在五个已发布事件 payload 中是否存在 ③ 是否存在控制流归属或 IO 依赖导致「补齐字段也不减耦」④ 初判结论（LIKELY-EVENTABLE / LIKELY-CALL / NEEDS-DEEPER-STUDY）与一句理由。
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 3.11 【用户拍板新增·路线校准】在同一节写一句**路线结论**：若三组中有两组或以上为 LIKELY-CALL，则明确记载「阶段 4 达成 guardrails <2,000 行与解 forwardRef 环的路径应从『事件化』改为『直接抽 application service』，第 3–5 刀的 propose 必须以本节为输入」；否则记载「事件化路线对剩余三组仍成立」。本节**不写进任何 spec requirement**（初判不是裁定），只作为下一刀 propose 的证据输入；并在 `docs/refactor-master-plan.md` 阶段 4 段落加一行指针指向本节。
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"

## 4. Track: guardrails-source (depends: preflight-and-coverage-proof)

<!-- Writes: apps/api/src/guardrails/guardrails.service.ts — and ONLY under PROOF-PASS (task 4.2).
     Sole writer of anything under apps/api/src/guardrails/**; tasks 4.4-4.7 are read-only
     assertions over the measured baseline (verified live: 135 test() over 6 *.spec.ts —
     57+54+15+3+3+3 — and 8 *.test.mjs).
     Under PROOF-FAIL this track makes zero source edits — that is a valid outcome. -->

- [x] 4.1 Branch on track 1's verdict. PROOF-FAIL → make **no** edit to `guardrails.service.ts`; record "retained, 9→9" and skip to 4.4. PROOF-PASS → continue.
  - requirements: ["guardrails/an-audit-call-is-removed-only-under-a-proven-per-stage-owner-and-at-most-one-is-removed"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.2 (PROOF-PASS only) Delete the provider-composite `this.audit?.recordProvisioningProgress(` hint at `guardrails.service.ts:1197` and nothing else: the `this.audit`-filtered diff must show at most one deletion hunk and zero modification hunks, with the other eight references byte-identical.
  - requirements: ["guardrails/an-audit-call-is-removed-only-under-a-proven-per-stage-owner-and-at-most-one-is-removed"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  > 不适用（PROOF 结论为保留调用）：per-stage 覆盖证明推翻 D5 预测——每个 reported stage 都有 worker checkpoint owner，但 owner 行只在 `provision(...)` 返回后投影，删除 `:1197` 会清空 in-provision 窗口。裁定为 CALL / 保留，故本任务的前置条件（PROOF-PASS）不成立，无改动。
- [x] 4.3 (PROOF-PASS only) Confirm the removal is unconditional — grep the tree for any branch that re-invokes the removed call when the cutover toggle is closed; zero matches (no second live path; escape hatch is version rollback).
  - requirements: ["guardrails/an-audit-call-is-removed-only-under-a-proven-per-stage-owner-and-at-most-one-is-removed"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  > 不适用（同 4.2）：无删除动作，无需确认删除的无条件性。
- [x] 4.4 Confirm the private `recordAudit` helper is retained and still has ≥3 call sites (`:2066`, `:2769`, `:3528` pre-change numbering) so no uncalled private method is left behind.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.5 If any comment was added near a publish point, grep the added lines for quoted catalog event names (`'task.settled'` etc.) — zero matches, so the whole-file occurrence counts asserted by `guardrails-domain-event-publishing.spec.ts` stay pinned.
  - requirements: ["guardrails/guardrails-publishes-domain-events-without-changing-lifecycle-behavior"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.6 Re-run the guardrails characterization baseline from task 1.3 and confirm it is unchanged (135 `test()` / 6 `*.spec.ts` / 8 `.test.mjs`, all passing) and that no test file was added to `apps/api/src/guardrails/`.
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.7 Confirm the three audit hotspots appear **zero times** in this change's diff and pass unmodified: `guardrails-durable-launch-decision.spec.ts` (46 audit assertions), `delivery-results-surfaced-and-audited.test.mjs` (61), `guardrails.service.spec.ts` (14). If any requires an edit, stop — behaviour was altered and the change is wrong, not the test.
  - requirements: ["guardrails/guardrails-publishes-domain-events-without-changing-lifecycle-behavior"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 5. Track: budget-and-registry-reconciliation (depends: guardrails-source)

<!-- Writes: scripts/ratchets/r11.json, deploy/DEPLOY.md,
     openspec/changes/adjudicate-audit-event-migration/surface-impact.json. Sole writer of all three.
     Dependency corrected: the draft also depended on adjudication-artifact, but nothing here reads
     the adjudication table — the REMOVED count (0 or 1) comes from track 1's verdict through
     track 4's actual edit. Dropping that edge lets track 3 and track 5 run concurrently.
     ⚠ DO NOT edit `scripts/ratchets/r11-dependency-budget.test.mjs` from this track. Its
     `:72` hardcodes a live re-count of `9` for `this.audit`, so under PROOF-PASS it goes red the
     moment 5.1 lands 8. That repair is integration-owned (task 6.2/6.9) to keep the file
     single-writer. -->

- [x] 5.1 Update `scripts/ratchets/r11.json` `guardrails-symbol-reference:this.audit`: set `count` to the live measured value (9 under PROOF-FAIL, 8 under PROOF-PASS); keep `symbol` exactly `this.audit` (renaming is a forged burn-down); keep the entry rather than deleting it while the count is above zero.
  - requirements: ["domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.2 Refresh that entry's `samples` unconditionally — the current values (988/1794/2483/3204/3453/3462/3481/3490) are two generations stale — using the live `file:line` list from task 1.2 minus any removed reference.
  - requirements: ["domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.3 Append this cut's accounting to the entry's `change` field: the delta from the seed of 9 equals the number of adjudication rows marked REMOVED (0 or 1), no other collaborator's count changed, and the symbol string is unchanged.
  - requirements: ["domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.4 Rewrite the `CAP_DOMAIN_EVENT_PUBLISHING_ENABLED` registration in `deploy/DEPLOY.md` §14 (rows/prose near `:851` and `:876-880`) to be factually true of this tree: registered subscribers = 0 (equals the bound array length), direct calls removed = the REMOVED count, and a sentence recording that this cut adjudicated 9 references.
  - requirements: ["domain-event-bus/the-cutover-toggle-is-registered-with-an-owner-and-a-retirement-condition"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 5.5 (PROOF-PASS only) Withdraw the byte-identical claim in that same registration: state what closing the toggle does **not** restore, name the removed call and its new owner (the admission worker checkpoint), and record that the escape hatch is now a version rollback.
  - requirements: ["domain-event-bus/the-cutover-toggle-is-registered-with-an-owner-and-a-retirement-condition"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 5.6 Confirm the registered-toggle table in `deploy/DEPLOY.md` still has exactly **one** row, and that this change adds no deploy runbook file and no edit to `scripts/quick-deploy.sh` or the compose files.
  - requirements: ["domain-event-bus/the-cutover-toggle-is-registered-with-an-owner-and-a-retirement-condition"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 5.7 Rewrite `openspec/changes/adjudicate-audit-event-migration/surface-impact.json` `internalOnly.scope`, which currently claims a new subscriber under `apps/api/src/audit/`, a new cutover toggle, and an R11 drop to the acknowledgement-call count — none of which hold in this scope. Keep `publicV1`/`mcp`/`openapi`/`apiPlayground` as `unchanged` and keep `runtimeWireBehavior: "unchanged"`.
  - requirements: ["domain-event-bus/migrating-an-audit-write-shall-not-make-it-asynchronous-queued-or-deferred"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 6. Track: gates-and-verification (depends: preflight-and-coverage-proof, domain-events-guards, adjudication-artifact, guardrails-source, budget-and-registry-reconciliation)

<!-- INTEGRATION TRACK — runs serially after every parallel track. Writes no product file of its
     own; runs the live gate list from the design's Migration Plan and repairs only what it breaks.
     Owns (repair only, and only if a gate turns it red):
       scripts/ratchets/r11-dependency-budget.test.mjs — `:72` hardcodes the live re-count
       `{this.audit: 9, this.runnerMinutes: 6, provisioningDiagnosticRecorder: 4,
       provisioningDiagnosticWriteGate: 4, this.transcripts: 2, metrics-projection: 2}`; under
       PROOF-PASS the first entry must become 8 in the same commit as r11.json.
     Also carries 6.1, the repo-wide `blocking-strict` grep pulled out of track 2: it asserts over
     text that track 2 (README pointer) and track 3 (adjudication table) both write, so it is only
     meaningful once both have landed.
     Gates are run, never predicted. -->

- [x] 6.1 Grep the repo for `blocking-strict` and confirm the only defining occurrence is the capability spec delta; every other occurrence is a reference. (Measured pre-apply: the term appears only inside this change's own artifacts — proposal / design / research-brief / tasks / specs — so the new references are track 2's `domain-events/README.md` pointer and track 3's `adjudication.md` tier column.)
  - requirements: ["domain-event-bus/audit-durability-is-classified-into-two-named-tiers"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  > 证据（主控整合后实跑）：`grep -rn "blocking-strict"` 在非 change 目录内唯一命中 `apps/api/src/domain-events/README.md:49`，且该处是**指针**（"defined normatively in the domain-event-bus capability spec … This file references the names; it does not restate the definitions"），规范定义在 capability spec 中，满足「exactly one file defines them」。
- [x] 6.2 Run `node scripts/ratchets/r11-dependency-budget.mjs` and confirm exit 0 with the live count equal to the recorded baseline in both directions (a stale higher baseline must also be red). Then run `scripts/ratchets/r11-dependency-budget.test.mjs`: under PROOF-PASS its `:72` live-re-count assertion of `9` must be moved to `8` here, in the same commit as r11.json — leaving it stale is the same forged burn-down D8 forbids.
  - requirements: ["domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 6.3 Run `node scripts/context-layout-check-v2.mjs` and `node scripts/api-module-layout-check.mjs`; confirm zero `unclassified-file` findings and zero new keys in `scripts/ratchets/r7.json` from the new `apps/api/src/task-admission/` spec file.
  - requirements: ["guardrails/guardrails-publishes-domain-events-without-changing-lifecycle-behavior"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 6.4 Run `node scripts/test-discovery-check.mjs` and confirm the new proof spec is discovered by glob without any allow-list registration.
  - requirements: ["domain-event-bus/each-event-type-s-registered-subscriber-set-is-asserted-as-an-exact-set"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  > 证据（主控整合后实跑）：`node scripts/test-discovery-check.mjs` → `test-discovery: 485 test files, all discovered by a runner`，exit 0；本 change 新增的 `provisioning-stage-ownership.spec.ts` 已被 runner 发现。
- [x] 6.5 Run `node scripts/public-surface-adversarial.mjs` for real (the sidecar declaring `unchanged` does not excuse skipping it) and confirm it passes.
  - requirements: ["domain-event-bus/migrating-an-audit-write-shall-not-make-it-asynchronous-queued-or-deferred"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 6.6 Run `apps/api/src/sandbox/sandbox-host-harness-wiring.test.mjs` and the audit text-scanning scripts (`apps/api/src/audit/audit.verify.test.mjs`, `apps/api/src/audit/audit-exit-reason.test.mjs`); if a source-text-scanning test must be updated because a file it scans changed, keep its per-file assertions rather than relaxing them to an aggregate total.
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 6.7 Grep the audit write paths this change touches for `setTimeout`, `setImmediate`, `process.nextTick`, and enqueue/queue helpers — zero matches (no audit write may become async, queued, batched across ticks, or staged).
  - requirements: ["audit-history/audit-rows-are-captured-synchronously-inside-the-operation-that-caused-them", "domain-event-bus/migrating-an-audit-write-shall-not-make-it-asynchronous-queued-or-deferred"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 6.8 Inspect the full diff: zero edits to `apps/api/prisma/schema.prisma`, zero new migration directories, zero edits under `packages/contracts/**`, zero code path that persists a published event, and zero `DiscoveryService` / `MetadataScanner` / `@nestjs/cqrs` / `@nestjs/event-emitter` references or package.json entries.
  - requirements: ["audit-history/audit-rows-are-captured-synchronously-inside-the-operation-that-caused-them"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 6.9 Run the full `apps/api` test suite plus repo typecheck/lint and confirm green.
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 6.10 Cross-check the three counting claims against the tree one last time: adjudication rows = 9; rows not marked REMOVED = live `this.audit` count = r11 `count`; DEPLOY registration's claimed subscriber count = length of `DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS` = 0.
  - requirements: ["guardrails/every-guardrails-audit-symbol-reference-is-adjudicated-in-a-durable-artifact", "domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  > 证据（主控整合后执行）：三项计数对账通过——裁定表 9 行 / 未标 REMOVED 行数 9 = 活树 `this.audit` 计数 9 = `r11.json` count 9；`DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS` 长度 0 与 DEPLOY 登记声明的 0 一致。**并收口一处跨产物矛盾**：`r11.json` 与 `deploy/DEPLOY.md` 原记「PROOF-FAIL（readiness 无 admission worker 所有者）」，与 `adjudication.md` §2.5 及可执行证明的实测结论相反——实测证明 aio/boxlite 的 readiness 与 runtime_setup **都有** worker checkpoint owner（`guardrails.service.ts:1247/1245` → `task-admission.worker.ts:612`），保留 `:1197` 的真实理由是这些 owner 行只在 `provision(...)` 返回后投影、删除会清空 in-provision 窗口。两处措辞已按实测改写，裁定结论（CALL / 9→9）不变。

## 7. Track: verify-reopened (depends: none)

<!-- Opened by the verify pass (2026-08-02) after re-tracing every raw-unmet requirement against the
     tree. All six raw-unmet requirements re-traced as MET; this is the one real defect the pass found
     on its own. Evidence and full reasoning: verification-report.md. -->

- [x] 7.1 Correct `surface-impact.json` → `surfaces.internalOnly.scope` clause ③: it still records the *refuted* rationale 「结论为 PROOF-FAIL（… readiness 无 admission worker checkpoint 所有者）」 as the basis for retaining `guardrails.service.ts:1197`. The change's own executable proof (`apps/api/src/task-admission/provisioning-stage-ownership.spec.ts`, 5/5 green) measured the opposite: `aio:readiness` / `aio:runtime_setup` / `boxlite:readiness` / `boxlite:runtime_setup` **all** have an admission-worker checkpoint owner under the same dedupe identity (`guardrails.service.ts:1245`/`:1247` → `task-admission.worker.ts:612`); the real retention ground is that three of those four owner rows are projected only **after** `provision(...)` returns, so removing the hint empties the in-provision window and turns the untouchable hotspot `guardrails-durable-launch-decision.spec.ts:1804-1859` red. Task 6.10 already closed this same contradiction in `scripts/ratchets/r11.json` and `deploy/DEPLOY.md` §14 (both verified corrected) but missed the sidecar — the third place the claim is written. Rewrite the clause to match `adjudication.md` §2.5 verbatim in substance; do **not** change the verdict (CALL / 9→9 / `REMOVED` = 0) or any `surfaces.*.status` value, and re-run `node scripts/public-surface-adversarial.mjs verify adjudicate-audit-event-migration --phase verify` afterwards (it currently returns `findings: []` and must stay that way).
  - requirements: ["guardrails/an-audit-call-is-removed-only-under-a-proven-per-stage-owner-and-at-most-one-is-removed"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  > 证据（主控，2026-08-02）：`surface-impact.json` → `surfaces.internalOnly.scope` clause ③ 已按 `adjudication.md` §2.5 的实测结论重写——四个 reported stage 全部有 admission worker checkpoint 所有者（同 dedupe 身份，`guardrails.service.ts:1245`/`:1247` → `task-admission.worker.ts:612`），保留 `:1197` 的真实理由是其中三行 owner 只在 `provision(...)` 返回后投影、删除会清空 in-provision 窗口。裁定结论（CALL / 9→9 / REMOVED=0）与全部 `surfaces.*.status` 值均未改动。改后重跑 `node scripts/public-surface-adversarial.mjs verify adjudicate-audit-event-migration` → `passed: true, findings: []`，保持不变。这是该矛盾的第三份副本（前两份 `scripts/ratchets/r11.json` 与 `deploy/DEPLOY.md` §14 已由 6.10 收口）。
