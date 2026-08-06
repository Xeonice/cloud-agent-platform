<!-- Track-annotated tasks. `## N. Track: <kebab-name> (depends: <track>|none)`.

     BUDGET: 6 requirements, 15 tasks — ratio 2.5, at the cap. Defences live in assertions.json as
     one executable line each, not as prose tasks a human and every lens re-read every round.

     THIS CUT IS FOUR THINGS AT ONCE. The draft split the tracks along those four seams
     (contract-and-data / retirement / ratchets-and-specs / gates). A file-level scan showed that
     seam CROSSES ITSELF at one file, so the partition below is re-cut along file ownership while
     keeping the same four kinds of risk visible:

       measured collision — `apps/api/src/guardrails/guardrails.service.ts` (plus its two spec
       files) is written by BOTH draft Track 1 (1.2 "follow the type errors to every consumer":
       10 `'legacy'` sites at :784 :988 :1753 :1789 :2981 :3034 :3068 :3084 :3118) and draft
       Track 2 (2.1/2.2/2.3 delete the adapter literal, the orphaned methods, and the legacy
       admission chain). Every one of those enum sites lives INSIDE code 2.1–2.3 deletes, so the
       collision is resolved by ownership rather than by isolation: the orchestrator, the tasks
       context, and the admission-mode policy belong to `retirement` ALONE. `contract-narrowing`
       owns the enum's declaration side and its diagnostics/contracts consumers ONLY, and SHALL
       NOT edit `apps/api/src/guardrails/**`, `apps/api/src/tasks/**`, or
       `apps/api/src/task-admission/**` — the type errors it raises there are answered by
       deletion in `retirement`, not by rewriting.

       second collision — `scripts/ratchets/r11-dependency-budget.test.mjs` hard-codes
       `this.runnerMinutes: 5` (:70) AND carries the "legacy inline-admission pass-through"
       comment (:79) that the retirement's symbol sweep must scrub. Both edits belong to
       `ratchets-and-specs`; `retirement` SHALL NOT touch `scripts/`.

       isolated — 5.1 (draft 1.3) needs the migration (data-migration) AND the narrowed enum
       (contract-narrowing) at once, and its two candidate homes
       (`apps/api/prisma/task-admission-migration.test.mjs`, the diagnostics service spec) sit in
       two different tracks. It runs in integration.

     RENUMBERED at integration. Task ids above are the DRAFT numbering; the ids on the task lines
     below are the final ones. `scripts/openspec-metadata.mjs:428` requires every task id to be
     `<track number>.<n>`, so re-cutting the partition renumbered the tasks with it:
       draft 1.2 → 1.1 · 1.1 → 2.1 · 2.1–2.4 → 3.1–3.4 · 3.1–3.5 → 4.1–4.5 ·
       1.3 → 5.1 · 4.1–4.3 → 5.2–5.4

     ORDER: `contract-narrowing`, `data-migration`, and `retirement` are file-disjoint and run in
     parallel. `ratchets-and-specs` is measurement-bound and MUST see the retired tree, so it
     depends on `retirement`. `gates` integrates.

     FILE OWNERSHIP (disjoint by construction):
       contract-narrowing  packages/contracts/src/task-provisioning-diagnostics.ts
                           packages/contracts/src/domain-event.ts (+ domain-event.test.mjs)
                           packages/sandbox-core/src/provisioning-diagnostics.ts  ⚠ vocabulary
                             parity: scripts/sandbox-core-vocabulary-parity.mjs:68-71 pins this
                             array against the contracts schema — narrow BOTH or the gate reds
                           apps/api/src/task-provisioning-diagnostics/**
       data-migration      apps/api/prisma/migrations/<new>/migration.sql
       retirement          apps/api/src/inline-admission/** (deleted whole)
                           apps/api/src/guardrails/**
                           apps/api/src/tasks/**
                           apps/api/src/task-admission/**
                           apps/api/src/sandbox/sandbox-host-harness-wiring.test.mjs
                           apps/api/src/public-surface/**
       ratchets-and-specs  scripts/ratchets/r7.json, r11.json, r11-dependency-budget.test.mjs
                           openspec/changes/retire-legacy-inline-admission/specs/**
       gates               integration only — 5.1 (draft 1.3) plus the three gate tasks

     MEASURED at propose time (commands in assertions.json):
       apps/api/src/inline-admission/ = 5 files / 1585 lines (wc -l physical; 1340 production, 245 test)
       forward: 2 imports, 1 field, 20-key adapter literal, 11 call sites into 10 port members
       reverse: 20 members / 59 call sites, all inside the pipeline file
       enum: packages/contracts/src/task-provisioning-diagnostics.ts:37-39 = ['legacy','durable']
       persisted: apps/api/prisma/schema.prisma:517 and :566, column is String not a DB enum

     MEASURED at partition time:
       inline-admission referenced outside its own directory by exactly 5 files:
         apps/api/src/guardrails/guardrails.service.ts (:102 :103 :570 :752 + 11 call sites)
         apps/api/src/guardrails/guardrails-domain-event-publishing.spec.ts (:499)
         apps/api/src/sandbox/sandbox-host-harness-wiring.test.mjs (:105 :110)
         scripts/ratchets/r7.json (8 entries: 4 cross-context, 1 prisma-outside-store, 3 unclassified)
         scripts/ratchets/r11-dependency-budget.test.mjs (:79, comment only)
       runnerMinutes write references today = 5 (:1934 :2429 :3027 :3338 :3360); :3027 sits in
         `startRunningAfterCapacity`, which the legacy chain deletion removes → 4
       publish-point counts stale after retirement, all in openspec/specs/guardrails/spec.md:
         :720 (three run-start points), :773 (both provisioning paths), :802 (both admission
         paths), :826 (three supersession boundaries); :720 and :826 carry the count IN THE
         HEADING → REMOVED + ADDED, not MODIFIED
       positional construction sites (task 4.5, draft 3.5) are recounted with scripts/guardrails-construction-sites.mjs;
         the pinned figures live at openspec/specs/guardrails/spec.md:1064-1084 (24 across 17, 20 heavy) -->

## 1. Track: contract-narrowing (depends: none)

- [x] 1.1 Narrow the published enum to its durable member, in the diagnostics contract and in the domain-event contract that re-exports it. Follow the type errors to every consumer rather than grepping for the literal — a consumer that pattern-matches on the union will fail to compile, and that is the signal worth having.
  - requirements: ["task-provisioning-diagnostics/narrowing-the-admission-mode-enum-is-a-data-change-not-only-a-contract-change"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "spec-assertions"

## 2. Track: data-migration (depends: none)

- [x] 2.1 Write the migration that DELETES rows whose admission mode records legacy admission, on both tables carrying the column. Do not rewrite them to the surviving value — that would assert those tasks were admitted durably when they were not, and this table exists to answer which path a task took. State the irreversibility in the migration itself, where an operator running it will read it.
  - requirements: ["task-provisioning-diagnostics/narrowing-the-admission-mode-enum-is-a-data-change-not-only-a-contract-change"]
  - surfaces: ["contracts"]
  - verify: "spec-assertions"

## 3. Track: retirement (depends: none)

- [x] 3.1 Delete the pipeline directory whole — all five files. Then delete the orchestrator's forward seam: both imports, the field, the adapter object literal, and every call site into the entry port.
  - requirements: ["guardrails/the-legacy-inline-admission-pipeline-is-retired-whole-and-nothing-survives-to-re-enter-the-orchestrator"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 3.2 Delete the two private orchestrator methods the adapter orphans, and the tests whose only subject was one of them. Do not keep a method alive to keep a test compiling — that inverts which one is the defect. Take care not to delete the near-namesake the durable launch path calls.
  - requirements: ["guardrails/the-legacy-inline-admission-pipeline-is-retired-whole-and-nothing-survives-to-re-enter-the-orchestrator"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 3.3 Remove the admission-mode branch so every accepted task enters durable admission, and delete the three orchestrator hops of the legacy admission chain. Do NOT remove the concurrency semaphore: the durable path uses it too. Verify by exercising acceptance with the capability gate closed, absent, and reporting an expired attestation — all three must reach a running sandbox, and none may return 503.
  - requirements: ["guardrails/admission-mode-is-chosen-by-an-explicit-total-policy-over-the-capability-gate"]
  - surfaces: ["public-v1", "developer-workflow"]
  - verify: "spec-assertions"
- [x] 3.4 Confirm the reverse direction is gone rather than re-declared: no call through the orchestrator callback port survives, and no file declares that port's member set under any name.
  - requirements: ["guardrails/the-legacy-inline-admission-pipeline-is-retired-whole-and-nothing-survives-to-re-enter-the-orchestrator"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 4. Track: ratchets-and-specs (depends: retirement)

- [x] 4.1 Delete the ratchet entries whose keys name paths inside the retired directory, and confirm every deletion is justified by a vanished path rather than by a count reaching zero. No entry keyed on a surviving file may be removed in this commit.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.2 Lower the runner-minutes entry by the one write reference the retirement deleted, keeping the entry, its symbol, and refreshing its samples to the surviving sites. Write into its record that the delta equals the deleted reference and that the symbol string is unchanged, so the movement reads as a deletion rather than a rename.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.3 Leave the two provisioning-diagnostics entries untouched and prove they are unmoved by running the gate's own measurement, not by reasoning. Correct their records where they currently promise a fall after retirement.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name", "guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.4 Re-pin every publish-point count a retired path made stale, by COUNTING the live sites rather than subtracting one. Where the count sits in a requirement's heading, express the change as a removal plus an addition — a modification is matched by heading text and would silently fail to apply.
  - requirements: ["domain-event-bus/publish-point-counts-that-name-a-retired-path-are-re-pinned-by-measurement"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.5 Re-count the positional construction sites the constructor requirement pins and correct the recorded number, since deleting the legacy specs removes several. Recount live rather than adjusting the recorded figure — that figure has drifted twice already in this epic.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 5. Track: gates (depends: contract-narrowing, data-migration, retirement, ratchets-and-specs)

- [x] 5.1 Prove the read path can no longer meet a value its validator rejects: exercise a diagnostics read over data written before the migration and confirm it parses, and confirm no row on either table holds a value outside the narrowed enum.
  - requirements: ["task-provisioning-diagnostics/narrowing-the-admission-mode-enum-is-a-data-change-not-only-a-contract-change"]
  - surfaces: ["contracts"]
  - verify: "spec-assertions"
- [x] 5.2 Run `node scripts/spec-assert.mjs retire-legacy-inline-admission` and record which requirements it decides. A requirement left undecided costs an LLM verification pass; treat a gap as a missing assertion rather than as acceptable.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 5.3 Run the gate set on the integrated tree and record each result: dependency budget, context layout, module layout, test discovery, script suites, the API package suite, typecheck, and the adversarial public-surface verifier. The surface verifier must be RUN, not asserted — this change genuinely narrows a published enum, so a declaration alone proves nothing.
  - requirements: ["task-provisioning-diagnostics/narrowing-the-admission-mode-enum-is-a-data-change-not-only-a-contract-change"]
  - surfaces: ["public-v1", "mcp", "openapi", "developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.4 Audit the diff for what must NOT be in it: no harness or tooling file, no test under the frozen guardrails directory other than the ones whose subject this change deleted, and no rewrite of a stored admission mode to the surviving value. Confirm the user-supplied premise about production traffic is attributed as such everywhere it appears.
  - requirements: ["guardrails/the-legacy-inline-admission-pipeline-is-retired-whole-and-nothing-survives-to-re-enter-the-orchestrator"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 6. Track: verify-reopened (depends: none)

- [x] 6.1 Fix the argument counter in `scripts/guardrails-construction-sites.mjs` and re-pin the three heavy-site figures it feeds into the constructor requirement. The counter seeds `args = 1` and increments on every depth-1 comma without ever discounting a trailing comma before `)`, so in this Prettier-formatted repo every multi-line construction site is counted ONE argument too many. The first three figures survive the bug (site and file counts do not read the argument count), but the last three do not: a trailing-comma-aware count and an independent TypeScript-AST count (`ts.isNewExpression` → `node.arguments.length`) BOTH return `20 16 11 10 6 5`, not the recorded `20 16 11 16 12 8`. Re-pin heavy/heavyOutside/heavyOutsideFiles to 10/6/5 in the requirement body at `specs/guardrails/spec.md:475-483` and in its "The recorded site counts match a live count" scenario at `:509-514`. Correct the prose in the same pass: the requirement names "the six that pass exactly eight, whose final argument IS the transcripts value", but exactly ONE site passes eight arguments (`apps/api/src/session-transcripts/transcript-capture-ordering.test.mjs:143`, last argument `transcripts`); the six it means (`tasks-durable-admission-crash-matrix.spec.ts:843`, `tasks-durable-admission-cleanup.spec.ts:725/:775/:926`, `durable-admission-cross-surface.story.spec.ts:1151`, `generated-private-git-branch-refresh.story.spec.ts:333`) each pass SEVEN, ending at `prisma`, and take `transcripts` from the constructor default `NOOP_SESSION_TRANSCRIPT_CAPTURE`. Do not adjust the recorded figures by subtraction — recount, exactly as this requirement demands of everyone else. Fix the stale counts the retirement left in comments while here: `apps/api/src/guardrails/guardrails.service.ts:1747` ("Run-start publish point 1 of 3") and `:2906` ("3 of 3") now describe two points, and `apps/api/src/tasks/tasks.service.ts:2074` ("observation point 1") / `:2346` ("2 of 3") now describe two boundaries. Same sweep, same defect class: the header this commit re-authored at `apps/api/src/task-admission/admission-mode-policy.ts:5-6,20-23` says the mapping is "total over twelve outcomes" with "ten closed reasons" — `TaskAdmissionV2GateClosedReasonSchema` (`packages/contracts/src/task-admission-capability.ts:113-123`) declares NINE, so the union is 11 outcomes and `ADMISSION_MODE_BY_OUTCOME` has 11 keys. Totality itself is compiler-enforced and correct; only the count in the prose is wrong. **Done. Two corrections BEYOND this task's own text, found by re-measuring rather than by trusting it.** (a) The requirement said "all four deleted sites passed eleven arguments"; measured on `main` with the fixed counter and with the TS AST, each of the four passed **TEN** — eleven was the same trailing-comma inflation, so the task's own premise carried the bug it was written to fix. (b) The honest transition is therefore `14 / 10 / 6` → `10 / 6 / 5`, and `main` measured with the fixed instrument reads `24 17 12 14 10 6` where the archived requirement recorded `24 17 12 20 16 9` — the last three figures were wrong in BOTH changes, so this is an instrument correction, not a movement in the tree. Structural fix beyond re-pinning: the scenario asserted the spec against the very tool that wrote it. Added `--cross-check` (TypeScript AST, `ts.isNewExpression` → `node.arguments.length`) plus two R12 assertions (`construction-site-figures-live`, `construction-counter-agrees-with-typescript-ast`), so this requirement is command-decided instead of relying on a lens noticing. Negative control run: with the trailing-comma fix reverted, `--cross-check` reports `DISAGREE scan=[20 16 11 16 12 8] ast=[20 16 11 10 6 5]`, reproducing exactly the figures the spec had pinned. `scripts/guardrails-construction-sites.mjs` is not harness: it was authored by a domain change (`4f5c21c`), sits on zero gate chains, and is outside the set this change's own `no-harness-edits` assertion enumerates.
  - requirements: ["guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 6.2 Complete the deletion ledger for the three `*.spec.ts` files this change deleted OUTSIDE `apps/api/src/guardrails/`, which the ledger requirement covers repo-wide and which tasks 7.2/7.3 do not reach. The requirement task 7.1 re-stated (`specs/guardrails/spec.md:545-647`) says a deleted test whose subject a change retires "SHALL be classified **(c) subject retired** and SHALL name the `## REMOVED Requirements` heading (or the retiring requirement) that warrants it", and its scenario "Every rewritten assertion carries a classified ledger entry" (`:629-634`) is scoped to "any assertion **in the repository**", not to the guardrails directory. Ledger entries 7.2 and 7.3 cover only `guardrails-durable-launch-decision.spec.ts`, `guardrails.service.spec.ts`, and `guardrails-domain-event-publishing.spec.ts`. Three deletions are unledgered: `apps/api/src/inline-admission/inline-admission-domain-event-publishing.spec.ts` (−245), `apps/api/src/tasks/tasks-legacy-request-lifetime.spec.ts` (−1518), and `apps/api/src/tasks/tasks-pending-recovery.spec.ts` (−100). The first two have a warrant reachable in the ledger but not written as a classified (c) entry recording the three required things: task 3.1 deletes the pipeline directory whole (which contains the first) and task 3.2 deletes the tests whose only subject was an orphaned private method (the second), both naming `guardrails/the-legacy-inline-admission-pipeline-is-retired-whole-and-nothing-survives-to-re-enter-the-orchestrator` — write them up as (c) entries citing that requirement, naming what each pinned and why it no longer holds. The third is the real gap and must not be back-filled by assertion: `tasks-pending-recovery.spec.ts` held 2 tests and 6 assertions whose subject was the FIFO boot re-offer (`startup re-offers only direct pending tasks with durable owner attribution`, `startup re-offer excludes pending/queued tasks owned by durable admission work`, verified with `git show main:apps/api/src/tasks/tasks-pending-recovery.spec.ts`), it is named by NO task in this ledger, and this change's own verify pass 2 recorded (scope findings 5 and 6) that no requirement in `specs/` covers the removal of `TasksService.reofferQueuedOnStartup()` or of `admit()` from `IGuardrailsService`. Per the requirement, "A (c) entry without a warrant is indistinguishable from erosion and SHALL be treated as one", so decide the warrant rather than assert one: the candidate is the retired-whole requirement plus the startup coordinator's own docstring at `apps/api/src/tasks/tasks.service.ts:582-584` ("There is no boot re-offer step: re-offering pending work into the process-local semaphore fed the retired in-request pipeline, and pending durable work is recovered by step 4's claim query") — if that holds under trace, cite it in the (c) entry and say in the same entry which surviving mechanism now pins what the two deleted tests pinned (step 4's claim query and its existing coverage), so the deletion is traceable to a decision instead of to a convenience. If it does not hold under trace, the honest outcome is a requirement for boot recovery rather than a ledger entry. While here, clear the residue the same removal left in tests: `apps/api/src/tasks/startup-recovery.test.mjs` still inlines a "FAITHFUL mirror" of `reofferQueuedOnStartup`/`admit` (`:12-13, :241, :329, :504-505, :529, :675, :713`) reproducing production methods that no longer exist — `grep -rn "reofferQueuedOnStartup" apps/api/src --include='*.ts'` returns zero — and its docstring's claim that "the production classes are covered separately by `tasks-startup-durable-recovery.spec.ts`" is now false for this seam; that spec only pushes dead `'legacy-reoffer'` event labels (`:425`, `:616`) that nothing asserts on. Add a `spec-assert` assertion that decides this requirement by command rather than by a lens noticing: enumerate the deleted `*.spec.ts` paths in the change's diff and require each to appear in `tasks.md`, so the next unledgered deletion fails the gate instead of reaching a verify pass. **DONE — three (c) subject-retired entries.** (c1) `inline-admission/inline-admission-domain-event-publishing.spec.ts` (−245): pinned the publish behaviour OF the retired pipeline itself; warrant = ADDED `The legacy inline-admission pipeline is retired whole…` (the directory must not exist); no re-expression exists because the publisher is gone, and the surviving publish points are pinned instead by the four ADDED two-point/one-path requirements. (c2) `tasks/tasks-legacy-request-lifetime.spec.ts` (−1518): pinned the in-request admission request lifetime, i.e. the retired pipeline's own entry; same warrant; it also held 4 of the positional construction sites, which is why the constructor requirement's site count moved 24→20 rather than by subtraction. (c3) `tasks/tasks-pending-recovery.spec.ts` (−100, 2 tests / 6 assertions): pinned the FIFO boot re-offer with durable owner attribution. Warrant DECIDED BY TRACE, not asserted: the re-offer's only sink was `guardrails.admit()`, the retired pipeline's entry, so the step had nothing to offer into. The trace also REFUTED the continuity the startup docstring implied — the surviving claim query `ScheduledTasksService.recoverPendingAdmissions` reads through a schedule run that EXISTS while the deleted query required `scheduleRun: { is: null }`, so on the pending branch the populations are disjoint, and no surviving query recovers a `queued` row at all. Because that consequence was covered by no requirement (this change's own verify passes 2 and 3 recorded it twice as a scope finding), the warrant is not just the retirement: task 8.1 states it as a requirement so the deletion is traceable to a decision rather than to a convenience.
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 7. Track: characterization-baseline (depends: none)

- [x] 7.1 Re-pin the characterization baseline this retirement invalidated, and state its counting convention. The live spec pinned 135 `test()` cases across 6 files (57+54+15+3+3+3) and demanded ZERO diff in the three audit hotspots. Measured on this tree: **91** (54+18+10+3+3+3) across the same 6 files, and TWO of the three hotspots appear in this change's diff (`guardrails.service.spec.ts` +56/-2462, `guardrails-durable-launch-decision.spec.ts` +21/-30). Both figures were true on `main` and are false here, so archiving without this MODIFIED would have written a false baseline into the live spec — the same defect class task 6.1 fixed for the construction-site figures. Convention (stated because two true numbers exist): 91 counts source declarations via `grep -cE '^[[:space:]]*test\(' apps/api/src/guardrails/*.spec.ts`, the same convention that reproduces 135 against `main`; `node --test` reports 93 over the same six compiled files because two tests are loop-generated (`guardrails-branch-policy.spec.ts:90`, `guardrails-durable-launch-decision.spec.ts:3311`). 135-91=44 = 39 (`guardrails.service.spec.ts` 57->18) + 5 (`guardrails-domain-event-publishing.spec.ts` 15->10), both subject-retirements. Audit-assertion counts re-measured with the convention that reproduces 46/61/14 on `main` (lines containing `audit`, case-insensitive): now **46 / 61 / 5**. Scope verified: guardrails specs 93/93 pass and all 8 `.test.mjs` pass. NOTE this requirement was invisible to both verify passes because verify enumerates only the change's own `specs/` directory — a live-spec requirement that a change falsifies without modifying is outside its field of view.
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

- [x] 7.2 Ledger entry **(a)** for `guardrails-durable-launch-decision.spec.ts` (+21/-30). Pinned order/behaviour: `assert.deepEqual(promoted, ['legacy-waiter'])` pinned that the legacy reverse-callback `onAdmit` fired for a queued waiter when a slot freed, with `promoted` accumulated by an `onAdmit: async (taskId) => promoted.push(taskId)` stub. Why it no longer holds: `onAdmit` was a member of the 20-member reverse-callback port this change deletes whole; there is no callback left to fire. Invariant the replacement pins: `assert.equal(semaphore.queuedCount, 0, 'the mirrored slot was released')` — the observable RESULT (the slot is released) instead of the vanished collaborator call, which is exactly the (a) shape (implementation detail replaced by a result assertion). Strength is preserved rather than relaxed: the audit-line count is unmoved at 46 and the file still holds 54 declarations / 55 runtime tests.
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

- [x] 7.3 Ledger entry **(c) subject retired** for the deletions in `guardrails.service.spec.ts` (43 tests deleted, 4 added, 57->18) and `guardrails-domain-event-publishing.spec.ts` (15->10). Warrant: this change's own `## REMOVED Requirements` block — the four retired publish-point/admission-path headings — plus the ADDED requirement that retires the pipeline whole. What was pinned: the in-request `service.admit(...)` characterization (26 of the 43 deleted test titles name admit/legacy/queue/semaphore/promote) and the legacy publish points. Why no re-expression exists: (a) and (b) both presume the behaviour survives — (a) replaces the assertion, (b) re-expresses it against a new seam. A retired subject has neither, so classifying these as (b) would put a false 'was re-expressed against the new seam' in the ledger. This is why the requirement now carries a third class rather than forcing the fit. Nine audit lines left `guardrails.service.spec.ts` (14->5); all nine departed inside deleted legacy tests, none out of a surviving one — checked file-by-file, not inferred from the total.
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 8. Track: boot-recovery-contract (depends: none)

- [x] 8.1 State the boot-recovery behaviour change this retirement made but no requirement covered. Verify passes 2 and 3 both recorded it as a scope finding: `TasksService.reofferQueuedOnStartup()` and its FIFO boot re-offer are deleted, `admit()` is dropped from the `IGuardrailsService` interface `TasksService` depends on (present on `main`, absent now), and nothing in `specs/` said so. Population traced rather than assumed: the deleted query took `admissionWork: { is: null }` AND (`status: 'queued'` OR `status: 'pending'` with `scheduleRun: { is: null }`); the surviving `recoverPendingAdmissions` (`scheduled-tasks.service.ts:1177-1190`) takes `taskScheduleRun` at `status: 'created'` with non-null `taskId` whose task is `pending` with `admissionWork: { is: null }`. On the pending branch these are DISJOINT by construction, and no surviving query recovers a `queued` row — so the startup docstring's 'pending durable work is recovered by step 4's claim query' was true but read as continuity it does not have. Docstring corrected at `tasks.service.ts:580-591` to say the narrower thing. Tasks that DO hold durable admission work are unaffected (leased by the durable worker), so the existing `API exits after commit` scenario in the live spec is NOT falsified — checked, not assumed. Uncovered rows are handled by the fail-closed contract already in the code (`tasks.service.ts:1513-1526`): creation audit written, named `fail-closed` returned, warning logged. Nothing retries them; the premise that they do not exist in production is the user-supplied D4 premise. Dead arm removed in the same pass: with `PostCommitAdmissionResult` a two-member union, the `findUnique`→release→recovered block after `scheduled-tasks.service.ts:1222` was unreachable (`outcome` narrows to `never`). Replaced with `outcome satisfies 'fail-closed'` so a future third member breaks the build instead of silently reviving a fall-through — typecheck 39/39 confirms the narrowing holds.
  - requirements: ["repo-and-task-management/boot-recovery-re-offers-nothing-into-the-retired-pipeline-and-the-rows-it-used-to-pick-up-fail-closed"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

- [x] 8.2 Ledger for `apps/api/src/tasks/startup-recovery.test.mjs` — the hand-written no-transpile model that mirrored the deleted method and stayed GREEN against it. It was not in this change's diff and no gate caught it: its fake guardrails is self-contained, so the safety property (no symbol reaches the retired pipeline) was never violated — the defect is false coverage, not a live path. Found by the scenario written in task 8.1, not by a lens. Measured: `main` 19 `test(` declarations / 24 runtime tests / 1076 lines → now 13 / 18 / 918; the 5 loop-generated instances all survive (24−19 = 18−13 = 5). **(c) subject retired — 6 tests deleted**, each pinning only the re-offer: `restart with K queued… FIFO admits oldest`, `restart re-offers direct pending admissions…`, `restart leaves queued and pending tasks with durable admission work exclusively to the worker` (vacuous once nothing is re-offered), `no persisted ceiling: env seed stays effective for the re-offer`, `re-offered tasks restore persisted deadlineMs/idleTimeoutMs` (that concern survives via the readopt tests' `armed` map), `guardrails not wired: re-offer is a no-op returning 0`. **(a) implementation detail re-expressed — 5 tests rewritten**, each carrying a surviving concern alongside a re-offer observation: `ceiling-first` (persisted-over-env now asserted on `guardrails.ceiling` directly instead of counting admits — more direct, not weaker), `Phase 1 reclaim` (orphan reclaim kept; the reclaim-precedes-re-offer ordering went with the re-offer), `unfinished durable work is protected` (all durable-protection and canReap assertions kept; the ordering chain closes provider-reconcile→worker-start), `restoreRunning keeps all survivors…` (survivor restoration kept; the queue assertion went with `admit`), `persisted owner rows drive restart re-adoption…` (expected running set corrected from `['boxlite-alive','queued-owner']` to `['boxlite-alive']` — the second entry was a re-offer side effect, and the assertion's own message already said readoption never claimed it). Also removed: the harness's mirror method, its call in `onApplicationBootstrap`, and `FakeGuardrails.admit`/`queue` (modelling a member the production interface no longer declares). Header rewritten to say why. Re-run: 18/18 pass.
  - requirements: ["repo-and-task-management/boot-recovery-re-offers-nothing-into-the-retired-pipeline-and-the-rows-it-used-to-pick-up-fail-closed"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

- [x] 8.3 Ledger **(a)** for the scheduled-recovery test doubles, found by DELETING the residual arm rather than by reading it. The arm after `scheduled-tasks.service.ts:1222` typechecked as unreachable (`outcome` narrows to `never`), and verify recorded it as dead. It was not: `scheduled-tasks.service.spec.ts:824` returned `options.admissionOutcome ?? 'legacy-admitted'` — the RETIRED third member — through an `as unknown as TasksService` cast the compiler cannot see, so four tests were driving the arm while the type system called it dead. Removing the arm turned that false green red, which is the honest direction and the reason this is ledgered rather than reverted. Pinned order/behaviour: the four (`post-commit admission failure leaves one pending task for startup recovery`, `startup recovery admits created pending scheduled tasks once`, `competing recovery workers admit one pending scheduled task once`, `recovery drains more than one batch of pending scheduled tasks`) reached the removed arm and let it re-read the task status to decide `release`/`recovered`. Why it no longer holds: with the union at two members, success IS `durable-woken`, which releases and counts directly. Invariant the replacement pins: the stub default becomes `'durable-woken'` and every one of those assertions (recovered counts, `status === 'queued'`, idempotent second sweep) holds unchanged — the observable contract is identical, only the outcome name is real now. Three OTHER tests then failed, and their mapping is exact rather than convenient: `dispatch retains only the run admission lease when admission leaves the task pending`, `recovery retains its lease when admission resolves but leaves the task pending`, and `run-level admission leases do not block sibling recovery or the next cadence` all pin lease RETENTION for a task admission left pending — which under the new union is precisely `fail-closed`, and production's `fail-closed` path does `continue` WITHOUT releasing, i.e. the identical behaviour. They now pass `admissionOutcome: 'fail-closed'` and every assertion is unchanged. 58/58 pass. `apps/api/test/scheduled-tasks-e2e.mjs:183` carried the same stale return and was moved with them. Full suite back to baseline: 1628 pass / 1 fail, the one failure being the pre-existing real-tmux boundary case whose entire import closure is byte-identical to `main`.
  - requirements: ["repo-and-task-management/boot-recovery-re-offers-nothing-into-the-retired-pipeline-and-the-rows-it-used-to-pick-up-fail-closed"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
