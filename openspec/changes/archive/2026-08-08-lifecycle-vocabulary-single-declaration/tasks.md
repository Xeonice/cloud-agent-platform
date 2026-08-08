<!-- Track-annotated tasks. `## N. Track: <kebab-name> (depends: <track>|none)`.

     BUDGET: 7 requirements, 16 tasks — ratio 2.29, under the 2.5 cap. Every defence that a command
     can decide lives in assertions.json as one executable line, not here as a paragraph.

     WHAT WAS MEASURED AT PROPOSE TIME, AND WHAT IT CHANGED.

       simulate-then-measure (edits applied, gate run, tree restored — `git status` clean afterwards):
         classification rule + rename + 4 import updates → unclassified-file 129 → 128, and
         cross-context-import 129 / layer-direction 2 / prisma-outside-store 59 ALL UNCHANGED.
         prismaPlacement composition exemption → prisma-outside-store 59 → 56, exactly the three
         module files. Both leave stale baseline entries the gate reports — 4 in total — which is
         why task 5.3 exists and why it must land in the same commit.

       the restatement count was WRONG TWICE and both errors are on the record:
         the research brief said 12 files; re-measuring under its own stated exclusions gives 13,
         and its exclusion list omitted `*.test.mjs` while claiming to exclude tests. Corrected to
         7 files. Then the per-file convention itself proved to be the wrong unit: counting every
         non-overlapping window gives 15 SITES, and the 8 it hid include FOUR MORE inside
         `guardrails.service.ts` — the file that matters most here. The burn-down unit is 15 sites.

       the R11 risk in design.md's first draft was overstated, and correcting it is what let
       track 2 exist at all: `scripts/ratchets/comparator.mjs:16` and `:170-187` compare COUNT only
       — `samples[]` are documentation. Line-number drift does not red the gate. Adding or removing
       a `this.<collaborator>` reference does, and this change does neither.

     FILE OWNERSHIP (disjoint by construction — no file is written by two tracks):
       canonical-and-subset   packages/contracts/src/task.ts
                              apps/api/src/task-lifecycle/task-lifecycle.ts → .domain.ts
                              apps/api/src/tasks/tasks.service.ts
                              apps/api/src/task-operations/task-operations.port.ts
                              apps/api/src/task-admission/task-admission.worker.ts  ⚠ import path ONLY
                              apps/api/src/tasks/tasks-detached-clone-surfaces.spec.ts
                              apps/api/src/tasks/tasks-transition-cas.spec.ts
       guardrails-restatements apps/api/src/guardrails/guardrails.service.ts
                              scripts/ratchets/r11.json
       admission-store-sql    apps/api/src/task-admission/prisma-task-admission.store.ts
       lifecycle-test         apps/api/src/tasks/task-lifecycle.test.mjs
       layout-manifest        docs/refactor/contexts-manifest.json
                              scripts/context-layout-check-v2.mjs (+ its self-test)
                              scripts/ratchets/r7.json
       migration-discipline   docs/refactor/04-rules-registry.md
                              openspec/schemas/spec-driven/templates/proposal.md
       gates                  integration only

     ORDER. `admission-store-sql` and `migration-discipline` need nothing and start immediately.
     `guardrails-restatements` needs the contracts type from 1.1. `lifecycle-test` needs the
     post-rename import path from 1.5. `layout-manifest` needs the renamed tree before it can
     measure which baseline entries went stale.

     WHAT APPLY MEASURED, AND WHERE IT CONTRADICTED THE PLAN.

       ✗ the cross-context justification was FALSE. `contexts-manifest.json` puts `tasks`,
         `task-operations`, `task-lifecycle` AND `guardrails` in one context, `task-execution`, so
         the import this change forbids would have produced no finding at all. The rule is kept on
         a different footing (the vocabulary belongs to contracts) and every artifact that carried
         the false reason is corrected in place rather than overwritten.

       ✗ the admission-subset restatement was UNDERCOUNTED, the same way the terminal one was.
         Creating the named target type exposed 11 more inline positions the propose-phase grep
         never looked for. Task 1.6 exists for that; one position is exempt and says why.

       ✗ `r11.json` samples were ALREADY stale on the pre-change tree — recorded 1197/2063/2067/…,
         actually 1195/1985/1989/…, not one matching. Task 2.2 refreshed all six entries using the
         gate's OWN `measure()` rather than a hand grep, so the samples cannot disagree with the
         counting convention that decides the gate.

       ✓ predictions that held: restatement sites 15 → 5 across 4 files (the five survivors are
         exactly the two canonical, the adjacency table, and the two named false positives);
         `unclassified-file` 129 → 128; `prisma-outside-store` 59 → 56; `cross-context-import` 129
         and `layer-direction` 2 unmoved; R11 9/4/2/2/1/2 unmoved; construction sites 20 16 11 10
         6 5 unmoved.

       ONE TEST CHANGED AND ONE DID NOT. `prisma-task-admission.store.spec.ts` asserted the four
       terminal literals appear IN THE QUERY TEXT; parameterising them broke both that regex and
       the exact-parameters assertion. It is RE-EXPRESSED, not relaxed: the shape check pins that
       both comparisons stay 4-ary and the value check now pins WHICH four reach the database —
       something the old text match could not do. Proved non-vacuous by mutation (binding three
       statuses instead of four reds it). `guardrails.service.spec.ts` was NOT touched: the live
       guardrails spec pins six reflective identifiers by line number, so an added import there
       would falsify a requirement this change never opens.

       A LIVE SPEC THIS CHANGE FALSIFIED WITHOUT OPENING IT. Scanning the live specs before archive
       — the one thing verify structurally cannot do, since it enumerates only this change's own
       `specs/` — found `context-layout-report`'s first requirement stating the Prisma exemption as
       the SHARED-KERNEL exemption specifically, in prose and in its scenario's `WHEN`. A
       `*.module.ts` DI factory satisfies that `WHEN` and is no longer reported, so the scenario was
       false. The propose-phase decision to express the composition exemption as ADDED rather than
       MODIFIED had weighed the wholesale-replacement hazard and missed this: only-adding does not
       avoid the risk, it produces two live requirements that contradict each other. Resolved by
       doing BOTH — the requirement is MODIFIED with all three scenarios carried (heading verified
       byte-identical, scenario set verified equal, so nothing is silently dropped) and the ADDED
       requirement stays to govern the exemption's narrowness. Everything else held: v1 gate
       byte-identical, guardrails 91 tests across 6 files at 54+18+10+3+3+3, 8 `.test.mjs`, audit
       hotspots 46/61/5, construction sites 20 16 11 10 6 5, both runner-minutes r7 entries present.

       THE ONE REMAINING RED IS NOT THIS CHANGE'S. `agent-runtime/headless-execution.spec.ts`
       (real tmux, times out waiting for an argv file) fails on the integrated tree. Its compiled
       require closure is 10 modules and NONE of them is a module this change edits — computed,
       not assumed. `sandbox`'s `terminal-session-autostart.test.mjs` also flaked once in three
       runs (1 red, 2 green) and is a recorded pre-existing intermittent in a package this change
       does not touch.

     WHAT VERIFY FOUND, AND WHAT IT COST ME TO HAVE BEEN WRONG ABOUT IT. Before the run I said the
     lenses would see nothing, because R12 decided all 8 requirements and decided requirements
     short-circuit past the adversarial path. That was wrong twice over: the lenses ran anyway, and
     one of them produced the only real defect in this apply — the surviving copy of the terminal set
     in `startup-recovery.test.mjs`, confirmed by an independent adjudicator. Twenty-four passing
     assertions did not catch it, because assertions check what someone thought to check. Task 1.7
     carries the fix and the widened check.

     A second, non-blocking finding: `isTerminal` was upgraded to a type guard with no requirement
     backing it. It is load-bearing (the orchestrator's two narrowing sites are the reason its own
     predicate existed), so it earns a scenario rather than a reversal.

     The run itself died at the LAST step — `route:findings` got `403 Request not allowed`, and the
     script then crashed dereferencing the null it returned. 13 of 14 agents completed; the findings
     were recovered from the journal and written back here by hand, which is what the crashed step
     would have done.

     SCOPE JUDGEMENT, stated because it is close to a line. Editing
     `scripts/context-layout-check-v2.mjs` is NOT a harness edit of the kind the scope rule forbids:
     that script is this change's SUBJECT, the edit is one line teaching it to read a new manifest
     key, and the manifest — not the script — remains the single declaration. Editing
     `openspec/schemas/spec-driven/templates/proposal.md` is the executor `04-rules-registry.md` §E
     already names for this rule; nothing compiles or fixtures that template (only
     `.claude/workflows/README.md` mentions the path). Neither touches spec-assert or the workflows. -->

## 1. Track: canonical-and-subset (depends: none)

- [x] 1.1 Export a named terminal-status TYPE from the contracts package, derived from the canonical array rather than written out. It belongs beside the set because the set is a vocabulary this package owns and declaring the type in a consumer would put a second NAME for that vocabulary where the vocabulary is not — the shape task 1.2 removes. (An earlier draft justified this by a context boundary between guardrails and task-lifecycle; there is none — they share the `task-execution` context — and that reason is struck.) This is an additive export: nothing is renamed, narrowed, or removed.
  - requirements: ["task-lifecycle-vocabulary/the-terminal-status-vocabulary-has-exactly-one-canonical-declaration"]
  - surfaces: ["contracts"]
  - verify: "spec-assertions"
- [x] 1.2 Delete the api-side second declaration of the terminal set and make the module's terminal predicate consume the contracts array. Do not leave a re-export under the old name: an alias for the same set reinstates the two-name problem while looking like the fix. Take care that the identically-named constant in the device-login service is a DIFFERENT enum and must not be touched.
  - requirements: ["task-lifecycle-vocabulary/the-terminal-status-vocabulary-has-exactly-one-canonical-declaration"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 1.3 Derive both Prisma `in` arrays over task status from the canonical set instead of listing the four literals. Both sit in the same query builder and are two of the nine real restatements; deriving them removes the literals from the source, which is what the site count measures.
  - requirements: ["task-lifecycle-vocabulary/restatements-of-the-terminal-vocabulary-are-counted-per-site-and-the-convention-s-false-positives-are-named"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 1.4 Declare the admission-owned transition subset once as an exported predicate, and make the prose comment and both `Extract<>` type restatements consume it. Leave the admission worker's existing delegation untouched — it is already a correct consumer, and moving a correct consumer is churn the gates cannot tell apart from progress.
  - requirements: ["task-lifecycle-vocabulary/the-admission-transition-subset-is-declared-once-and-consumed-not-restated"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 1.5 Rename the lifecycle module to carry the declared domain suffix and update its import specifiers. Measured at propose time as four importers; by the time this ran it was SEVEN, because tasks 1.4 and 1.6 added three of them — the figure is corrected rather than left standing. `guardrails.service.ts` is still not among them, so this task cannot disturb the dependency budget. The suffix must be the one the manifest rule in 5.1 declares; if the two disagree the file lands back in the unclassified class and the gate says so.
  - requirements: ["context-layout-report/the-domain-layer-is-nameable-by-a-declared-suffix-and-naming-it-shrinks-the-unclassified-class"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 1.6 Make every remaining inline restatement of the admission TARGET vocabulary derive from the same table. Discovered while doing 1.4: creating the named type exposed 11 more `Extract<TaskStatus, 'queued' | 'running'>` positions that the propose-phase measurement never counted, because it only looked for the three-member form. This is the same undercount shape as the terminal restatements (7 files hiding 15 sites) and is corrected the same way — by measuring rather than by trusting the earlier figure. ONE position is deliberately left: `guardrails.service.ts`'s frozen sibling spec, because the live guardrails spec pins six reflective assertion identifiers by LINE NUMBER and adding an import there would shift every one of them, falsifying a requirement this change never touches. That exemption is the reason it is named here rather than silently skipped.
  - requirements: ["task-lifecycle-vocabulary/the-admission-transition-subset-is-declared-once-and-consumed-not-restated"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 1.7 REOPENED BY VERIFY. Remove the copy of the terminal set that survives in a test file, and fix the checks that could not see it. `startup-recovery.test.mjs` declared its own `TERMINAL_TASK_STATUSES` — same name, byte-identical members, no import — which falsifies this requirement's own scenario about consumers reaching the declaration by import. Two assertions missed it and their blind spots OVERLAPPED: one keyed on `export const` (this copy has no `export`), the other counts sites under a convention that excludes `*.test.mjs`. The fix is therefore both: import the set in that test, AND replace the name-keyed grep with a scan for the DECLARATION SHAPE across every source file including tests — proven non-vacuous by re-introducing a differently-named copy and watching it red. Measured after: exactly one such declaration tree-wide.
  - requirements: ["task-lifecycle-vocabulary/the-terminal-status-vocabulary-has-exactly-one-canonical-declaration"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 2. Track: guardrails-restatements (depends: canonical-and-subset)

- [x] 2.1 Replace all five terminal-set restatements in the orchestrator — two type unions, two equality chains, and a locally redeclared terminal predicate — with consumption of the contracts declaration this file already imports. Each piece comes from its OWNER: the vocabulary from contracts, which this file already imports, and the terminal PREDICATE from the lifecycle module — which leaves one predicate in the repository instead of two. (Two earlier drafts of this task forbade importing the lifecycle module on boundary grounds; both were wrong. The modules share the `task-execution` context and application→domain is the legal direction, measured: all four finding classes are unmoved by the import.) Delete the local predicate rather than leaving it delegating.
  - requirements: ["task-lifecycle-vocabulary/restatements-of-the-terminal-vocabulary-are-counted-per-site-and-the-convention-s-false-positives-are-named", "task-lifecycle-vocabulary/the-terminal-status-vocabulary-has-exactly-one-canonical-declaration"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 2.2 Refresh the dependency-budget samples for this file to the lines they now sit on. The counts must not move and an assertion decides that; the samples are documentation the comparator does not read, and leaving them stale is how a future reader concludes a reference vanished when only a line number did. The nine audit line numbers recorded in the archived guardrails spec are explicitly scoped to that change's pre-change tree — they are a historical statement and drift here does not falsify them.
  - requirements: ["task-lifecycle-vocabulary/restatements-of-the-terminal-vocabulary-are-counted-per-site-and-the-convention-s-false-positives-are-named"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 3. Track: admission-store-sql (depends: none)

- [x] 3.1 Derive both raw-SQL terminal lists in the admission store from the canonical set instead of writing the four literals into the query text. If the query builder cannot interpolate a list safely at either position, keep the literals and name that position in this change's description as a declared exemption with the reason — an undeclared literal and a declared one look identical to the next reader, and only one of them is honest.
  - requirements: ["task-lifecycle-vocabulary/restatements-of-the-terminal-vocabulary-are-counted-per-site-and-the-convention-s-false-positives-are-named"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 4. Track: lifecycle-test (depends: canonical-and-subset)

- [x] 4.1 Wire the lifecycle test to the module it tests: import the real transition table and terminal set, and delete the copies it keeps. Prove the wiring by removing one edge from the real table, watching the test fail, and restoring it — a test that passes both before and after that mutation has not been wired, it has been rearranged. If, once wired, its assertions turn out to duplicate an existing suite exactly, retiring it is permitted, but the duplication must be MEASURED and the measurement recorded here; retiring first and measuring never is how coverage disappears behind a completed checkbox.
  - requirements: ["task-lifecycle-vocabulary/the-test-guarding-the-lifecycle-vocabulary-fails-when-the-vocabulary-changes"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 5. Track: layout-manifest (depends: canonical-and-subset)

- [x] 5.1 Add the domain classification rule to the manifest's ordered rule table. The interpreter matches path suffixes only — proved by reading it, and by the existing bootstrap rule that spans a path-segment boundary yet still anchors at the end — so a directory rule is not expressible and teaching the interpreter one would change the classification MECHANISM rather than its data. Add a row, not a rule kind.
  - requirements: ["context-layout-report/the-domain-layer-is-nameable-by-a-declared-suffix-and-naming-it-shrinks-the-unclassified-class"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 5.2 Declare the Prisma-placement composition exemption in the manifest and make the script honour it by reusing the composition predicate it ALREADY computes for the cross-context rule — not a second predicate that happens to agree today. Add a self-test case covering both directions: a composition file wiring Prisma is exempt, an ordinary file is not.
  - requirements: ["context-layout-report/the-prisma-placement-check-exempts-di-composition-declared-and-narrow", "context-layout-report/a-layout-v2-script-performs-three-check-classes-from-the-contexts-manifest"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 5.3 Delete exactly the baseline entries the two rules retire — three Prisma-placement entries on module files and one unclassified-file entry — in this same commit, and run the gate to show that no other finding class moved. The comparator fails a measurement BELOW its baseline exactly as it fails one above, so leaving a stale entry is not a harmless omission; and a class that falls while another rises is a trade rather than a reduction, which is why the other three are checked rather than assumed.
  - requirements: ["context-layout-report/the-domain-layer-is-nameable-by-a-declared-suffix-and-naming-it-shrinks-the-unclassified-class", "context-layout-report/the-prisma-placement-check-exempts-di-composition-declared-and-narrow"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 6. Track: migration-discipline (depends: none)

- [x] 6.1 Write the additive-only definition into the rules registry entry that already names its enforcers: DDL must be additive — no dropped column, no dropped table, no new NOT NULL on an existing column — while DML is permitted provided the migration declares its irreversibility in the migration file itself. Record why the loose reading was chosen: the strict one would condemn two migrations already merged, one of which had volunteered that declaration unprompted.
  - requirements: ["task-lifecycle-vocabulary/migration-discipline-is-defined-in-writing-before-it-is-enforced"]
  - surfaces: ["docs"]
  - verify: "docs"
- [x] 6.2 Add the clause to the change template so a change carrying a migration states which part of the definition it lands on. State plainly in the registry that the two CI compatibility jobs it names are not required checks today and that the N-1 fixture is pinned well behind the current release — this change writes a definition and does not make it enforced, and recording that keeps the entry from being read as a guarantee.
  - requirements: ["task-lifecycle-vocabulary/migration-discipline-is-defined-in-writing-before-it-is-enforced"]
  - surfaces: ["openspec"]
  - verify: "docs"

## 7. Track: gates (depends: canonical-and-subset, guardrails-restatements, admission-store-sql, lifecycle-test, layout-manifest, migration-discipline)

- [x] 7.1 Replace every `[predicted]` figure in the specs and design with the measured one, using the commands those artifacts name. Two predictions are outstanding: the restatement site count and the finding-class deltas. A prediction that survives into the archive unmeasured is indistinguishable from a measurement, and this epic has archived one before.
  - requirements: ["task-lifecycle-vocabulary/restatements-of-the-terminal-vocabulary-are-counted-per-site-and-the-convention-s-false-positives-are-named"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 7.2 Run the gate set this change can move — api typecheck, lint and tests, the layout v2 check, both ratchets, the module composition check, and the public-surface adversarial verify for the additive contracts export. The contracts edit is why the last one is not optional: this repository has already had four verify passes miss a public-surface claim that lived only in prose.
  - requirements: ["task-lifecycle-vocabulary/the-terminal-status-vocabulary-has-exactly-one-canonical-declaration", "context-layout-report/the-prisma-placement-check-exempts-di-composition-declared-and-narrow"]
  - surfaces: ["contracts", "ci"]
  - verify: "workflow-gates"

## 8. Track: verify-reopened (depends: none)

- [x] 8.2 REOPENED BY VERIFY (round 3 resume). Remove the terminal-subset switch in the contracts session-history module, and widen the carrier definition to see that shape. `replayPresentationState` named the four terminal statuses as case labels and let a `default` absorb the other four — a hand-written statement of which statuses are terminal, sitting three lines above an `isReplayableStatus` that derives the same fact from the canonical set. Make it exhaustive over all eight members with the non-terminal arms returning exactly what the default returned, so runtime behaviour is byte-identical (verified: all 8 inputs map to the same outputs as before) while a ninth status now fails to compile (verified by injecting one: `session-history.ts:201` errors). Then widen the assertion's carrier definition to form (iii) and cluster case labels by SWITCH BRACE MATCHING rather than line proximity — a proximity heuristic is fooled by a long comment inside the switch, which splits one total mapping into what looks like a terminal-subset one, and this task's own fix introduced exactly such a comment.
  - requirements: ["task-lifecycle-vocabulary/the-terminal-status-vocabulary-has-exactly-one-canonical-declaration"]
  - surfaces: ["contracts"]
  - verify: "spec-assertions"

- [x] 8.3 REOPENED BY VERIFY (round 4). Make the last type-union restatement consume the canonical type, and widen the carrier definition to form (iv). `guardrails-durable-launch-decision.spec.ts:389` typed a test helper's parameter as the four terminal literals spelled out — the SAME shape this change removed twice from `guardrails.service.ts`, and which the requirement's own "Real restatements — 9 sites" paragraph counts as a restatement. So the carrier definition contradicted the requirement text, and the contradiction was hidden by a defence ("a type union is erased at runtime, so it cannot decide terminality") that does not survive contact: erasure changes WHEN a copy is read, not whether it exists. Two adjudicators split on this exact site — one confirmed the refutation, one rejected it by citing that defence — and the confirming one was right. ⚠ This file is one of the three audit hotspots the live guardrails spec constrains, so the edit was bounded and then MEASURED: its `audit` line count is 46 before and after (the pinned figure), its `test(` count is 54 before and after, and it runs 55/55. Tree-wide type-union carriers: 1 → 0, leaving only the canonical.
  - requirements: ["task-lifecycle-vocabulary/the-terminal-status-vocabulary-has-exactly-one-canonical-declaration"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

- [x] 8.1 Finish the test-file sweep the canonical-declaration requirement promises, and fix the assertion that certified it. The scenario "No copy of the set survives in a test either" is FALSE on the integrated tree, and the assertion that guards it (`one-canonical-terminal-declaration`) returns `1` anyway because it is blind in exactly the two directions the requirement's own ⚠ paragraph claims it closed.
  - requirements: ["task-lifecycle-vocabulary/the-terminal-status-vocabulary-has-exactly-one-canonical-declaration"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"


  **Two survivors, both found by re-scanning under the requirement's stated convention rather than under the assertion's regex.**

  1. `apps/api/src/tasks/tasks-durable-admission-crash-matrix.spec.ts:782` declares
     `function isTerminalTaskStatus(status: TaskStatus): boolean` as a four-literal equality chain,
     used at `:381`. This is the SAME symbol name and the SAME shape this change just deleted from
     `guardrails.service.ts:3613` (counted there as one of the nine real restatements) and from
     `startup-recovery.test.mjs:117` (the copy adversarial review found). It is inside `apps/api`,
     i.e. inside the scope the requirement's own SHALL names, and it can drift from the vocabulary
     while staying green.
  2. `apps/web/e2e/scheduled-tasks/scheduled-tasks.spec.ts:148` declares
     `const TERMINAL_TASK_STATUSES = new Set<TaskWire["status"]>([…four literals…])` — a set-shaped
     copy under the SAME NAME as the canonical one, in a test file.

  **Why the assertion did not see either.** Its regex matches only `(export )?(const|let|var) NAME =
  [` / `= new Set<…>([`, and it searches only for SINGLE-quoted literals. Survivor 1 is a `function`,
  so the const/let/var anchor misses it; survivor 2 is double-quoted (`apps/web` house style), so the
  literal list misses it. Both blind spots are name-independent shape blind spots — which is precisely
  what the requirement text says the check must not have ("scans for the DECLARATION SHAPE across every
  source file including tests, and does not key on a symbol name").

  **What to do.** (a) Make survivor 1 consume the canonical vocabulary — import `isTerminal` from
  `@/task-lifecycle/task-lifecycle.domain` or `TERMINAL_TASK_STATUSES` from `@cap-console/contracts`,
  the same way `startup-recovery.test.mjs` was fixed. (b) Decide survivor 2 explicitly rather than by
  omission: either have the `apps/web` e2e harness derive from contracts, or record it as a named
  exemption with the reason (the e2e suite types against its own `TaskWire`, not the contracts
  `TaskStatus`) — and if it is exempted, say so in the requirement so the scenario stops asserting
  something false about the tree. (c) Widen the assertion so it would have failed: accept `function`
  declarations and both quote styles, and re-record the expected count against whatever (a) and (b)
  settle on. An assertion that passes only because it cannot see the failure mode it was written for
  is the same defect class this change exists to remove.

  ⚠ Do NOT "fix" this by narrowing the scenario's scan to production files. The scenario's whole reason
  for existing is that a production-only count could not see `startup-recovery.test.mjs`; narrowing it
  would delete the finding rather than the duplicate.

  **Two objections pre-empted, both checked rather than assumed.** (i) *"These are deliberate fakes that
  must model the vocabulary independently."* — The `guardrails.service.spec.ts` exemption that task 1.6
  names is real and load-bearing (that file is frozen at zero diff by
  `openspec/specs/runner-minutes-accounting/spec.md:11` and pinned by line number throughout
  `openspec/specs/guardrails/spec.md`). Neither survivor has any such protection: `grep -rn` over
  `openspec/specs/` returns **zero** references to `tasks-durable-admission-crash-matrix.spec.ts` or to
  `scheduled-tasks.spec.ts`. (ii) *"Importing would add coupling."* — Survivor 1's file already imports
  `@cap-console/contracts` at `:4` and eight `@/…` production modules including `GuardrailsService`;
  adding the vocabulary import creates no edge that is not already there.
