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
