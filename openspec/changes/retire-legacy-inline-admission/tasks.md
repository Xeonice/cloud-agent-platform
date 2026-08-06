<!-- Track-annotated tasks. `## N. Track: <kebab-name> (depends: <track>|none)`.

     BUDGET: 6 requirements, 15 tasks — ratio 2.5, at the cap. Defences live in assertions.json as
     one executable line each, not as prose tasks a human and every lens re-read every round.

     THIS CUT IS FOUR THINGS AT ONCE and the tracks are split along those seams rather than along
     files, because the risks are different in kind:
       1 contract-and-data   the enum narrowing AND the irreversible migration — the only track that
                             can destroy information, and the only one whose rollback is a backup
       2 retirement          deleting the pipeline, both port directions, the orphaned methods
       3 ratchets-and-specs  the three ratchet movements + correcting the false floor claim
       4 gates               integration

     Track 1 goes FIRST and alone: if the migration is wrong, everything after it is moot, and it is
     the one step that cannot be undone by reverting the branch.

     MEASURED at propose time (commands in assertions.json):
       apps/api/src/inline-admission/ = 5 files / 1585 lines (wc -l physical; 1340 production, 245 test)
       forward: 2 imports, 1 field, 20-key adapter literal, 11 call sites into 10 port members
       reverse: 20 members / 59 call sites, all inside the pipeline file
       enum: packages/contracts/src/task-provisioning-diagnostics.ts:37-39 = ['legacy','durable']
       persisted: apps/api/prisma/schema.prisma:517 and :566, column is String not a DB enum -->

## 1. Track: contract-and-data (depends: none)

- [ ] 1.1 Write the migration that DELETES rows whose admission mode records legacy admission, on both tables carrying the column. Do not rewrite them to the surviving value — that would assert those tasks were admitted durably when they were not, and this table exists to answer which path a task took. State the irreversibility in the migration itself, where an operator running it will read it.
  - requirements: ["task-provisioning-diagnostics/narrowing-the-admission-mode-enum-is-a-data-change-not-only-a-contract-change"]
  - surfaces: ["contracts"]
  - verify: "spec-assertions"
- [ ] 1.2 Narrow the published enum to its durable member, in the diagnostics contract and in the domain-event contract that re-exports it. Follow the type errors to every consumer rather than grepping for the literal — a consumer that pattern-matches on the union will fail to compile, and that is the signal worth having.
  - requirements: ["task-provisioning-diagnostics/narrowing-the-admission-mode-enum-is-a-data-change-not-only-a-contract-change"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "spec-assertions"
- [ ] 1.3 Prove the read path can no longer meet a value its validator rejects: exercise a diagnostics read over data written before the migration and confirm it parses, and confirm no row on either table holds a value outside the narrowed enum.
  - requirements: ["task-provisioning-diagnostics/narrowing-the-admission-mode-enum-is-a-data-change-not-only-a-contract-change"]
  - surfaces: ["contracts"]
  - verify: "spec-assertions"

## 2. Track: retirement (depends: contract-and-data)

- [ ] 2.1 Delete the pipeline directory whole — all five files. Then delete the orchestrator's forward seam: both imports, the field, the adapter object literal, and every call site into the entry port.
  - requirements: ["guardrails/the-legacy-inline-admission-pipeline-is-retired-whole-and-nothing-survives-to-re-enter-the-orchestrator"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 2.2 Delete the two private orchestrator methods the adapter orphans, and the tests whose only subject was one of them. Do not keep a method alive to keep a test compiling — that inverts which one is the defect. Take care not to delete the near-namesake the durable launch path calls.
  - requirements: ["guardrails/the-legacy-inline-admission-pipeline-is-retired-whole-and-nothing-survives-to-re-enter-the-orchestrator"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 2.3 Remove the admission-mode branch so every accepted task enters durable admission, and delete the three orchestrator hops of the legacy admission chain. Do NOT remove the concurrency semaphore: the durable path uses it too. Verify by exercising acceptance with the capability gate closed, absent, and reporting an expired attestation — all three must reach a running sandbox, and none may return 503.
  - requirements: ["guardrails/admission-mode-is-chosen-by-an-explicit-total-policy-over-the-capability-gate"]
  - surfaces: ["public-v1", "developer-workflow"]
  - verify: "spec-assertions"
- [ ] 2.4 Confirm the reverse direction is gone rather than re-declared: no call through the orchestrator callback port survives, and no file declares that port's member set under any name.
  - requirements: ["guardrails/the-legacy-inline-admission-pipeline-is-retired-whole-and-nothing-survives-to-re-enter-the-orchestrator"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 3. Track: ratchets-and-specs (depends: retirement)

- [ ] 3.1 Delete the ratchet entries whose keys name paths inside the retired directory, and confirm every deletion is justified by a vanished path rather than by a count reaching zero. No entry keyed on a surviving file may be removed in this commit.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 3.2 Lower the runner-minutes entry by the one write reference the retirement deleted, keeping the entry, its symbol, and refreshing its samples to the surviving sites. Write into its record that the delta equals the deleted reference and that the symbol string is unchanged, so the movement reads as a deletion rather than a rename.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 3.3 Leave the two provisioning-diagnostics entries untouched and prove they are unmoved by running the gate's own measurement, not by reasoning. Correct their records where they currently promise a fall after retirement.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name", "guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 3.4 Re-pin every publish-point count a retired path made stale, by COUNTING the live sites rather than subtracting one. Where the count sits in a requirement's heading, express the change as a removal plus an addition — a modification is matched by heading text and would silently fail to apply.
  - requirements: ["domain-event-bus/publish-point-counts-that-name-a-retired-path-are-re-pinned-by-measurement"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 3.5 Re-count the positional construction sites the constructor requirement pins and correct the recorded number, since deleting the legacy specs removes several. Recount live rather than adjusting the recorded figure — that figure has drifted twice already in this epic.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 4. Track: gates (depends: contract-and-data, retirement, ratchets-and-specs)

- [ ] 4.1 Run `node scripts/spec-assert.mjs retire-legacy-inline-admission` and record which requirements it decides. A requirement left undecided costs an LLM verification pass; treat a gap as a missing assertion rather than as acceptable.
  - requirements: ["guardrails/the-three-ratchet-movements-this-retirement-causes-are-told-apart-by-name"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 4.2 Run the gate set on the integrated tree and record each result: dependency budget, context layout, module layout, test discovery, script suites, the API package suite, typecheck, and the adversarial public-surface verifier. The surface verifier must be RUN, not asserted — this change genuinely narrows a published enum, so a declaration alone proves nothing.
  - requirements: ["task-provisioning-diagnostics/narrowing-the-admission-mode-enum-is-a-data-change-not-only-a-contract-change"]
  - surfaces: ["public-v1", "mcp", "openapi", "developer-workflow"]
  - verify: "workflow-gates"
- [ ] 4.3 Audit the diff for what must NOT be in it: no harness or tooling file, no test under the frozen guardrails directory other than the ones whose subject this change deleted, and no rewrite of a stored admission mode to the surviving value. Confirm the user-supplied premise about production traffic is attributed as such everywhere it appears.
  - requirements: ["guardrails/the-legacy-inline-admission-pipeline-is-retired-whole-and-nothing-survives-to-re-enter-the-orchestrator"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
