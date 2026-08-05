<!-- Track-annotated tasks. `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.

     BUDGET: 6 requirements, 15 tasks — ratio 2.5, at the cap the tasks instruction sets.
     The previous cut ran 14 requirements / 73 tasks (ratio 5.2) and took three verify rounds; the
     widest archived cut ran 33 requirements / 31 tasks (ratio 0.9) and took one. The defences that
     inflated that ratio live in assertions.json here instead — one executable line each, decided by
     R12 before verify starts, rather than prose a human and every lens re-read each round.

     PARTITION CORRECTED after scanning the tree. Two draft assignments were wrong and one task was
     in the wrong track; the rest of the draft's reasoning survives.

     Write sets (tracks 1-3 are DISJOINT at file granularity, which is why they run in one wave):

       1 diagnostics-owner       apps/api/src/task-provisioning-diagnostics/**  ONLY
                                 — the new owner + `*.port.ts` + its tests register in the EXISTING
                                   task-provisioning-diagnostics.module.ts, which app.module.ts
                                   already imports, so app.module.ts stays out of this track.
       2 transcript-relocation   the new transcript directory (new files) +
                                 apps/api/src/tasks/session-transcript.service.ts (deleted) +
                                 apps/api/src/tasks/session-transcript.service.test.mjs (deleted) +
                                 apps/api/src/tasks/tasks.module.ts +
                                 apps/api/src/tasks/session-cast.controller.ts +
                                 apps/api/src/v1/v1.module.ts + apps/api/src/mcp/mcp.module.ts +
                                 apps/api/src/guardrails/guardrails.module.ts +
                                 apps/api/src/app.module.ts + docs/refactor/contexts-manifest.json
       3 projection-owner        apps/api/src/runner-metrics/**  ONLY
                                 — the projection owner is provided by the EXISTING
                                   runner-minutes.module.ts (app.module.ts and metrics.module.ts
                                   already import it), so no new module registration is needed and
                                   app.module.ts stays out of this track.
       4 integration             apps/api/src/guardrails/guardrails.service.ts +
                                 apps/api/src/metrics/** + scripts/ratchets/** +
                                 apps/api/src/tasks/tasks-durable-admission-cleanup-coordination.story.spec.ts +
                                 apps/api/src/runner-metrics/runner-minutes-ownership.integration.test.mjs +
                                 this change's specs/

     THREE CORRECTIONS to the draft partition, each from a live scan:

     (a) `scripts/ratchets/r7.json` is NOT track 2's. The draft left the r7 re-keying task inside
         transcript-relocation while also declaring `scripts/ratchets/**` a track-4-only write set.
         Both are true only if the r7 task moves: the orchestrator edit changes
         `cross-context-import:apps/api/src/guardrails/guardrails.service.ts` (live count 8 — the
         type-only `@/runner-metrics/metrics-projection` import leaves, the transcript port import
         may arrive) and the metrics edit changes
         `cross-context-import:apps/api/src/metrics/metrics.service.ts` (live count 2 → 1, because
         `semaphoreProjection()` is metrics.service.ts's ONLY use of `this.guardrails`, so the
         `@/guardrails/guardrails.service` import goes with it). Three tracks writing one JSON file
         is the collision the draft's own rule forbids, so ALL ratchet baselines — r7 and r11 alike —
         are written once, in the integration track, after the source edits that move their counts.

     (b) `apps/api/src/guardrails/guardrails.module.ts` is track 2's, not track 4's. The moved
         service is imported there at `:11`, so track 2 must edit the file to keep the tree
         compiling; the composition-side half of "inject the port non-optionally with a no-op
         standing in" (drop `optional: true` on TRANSCRIPT_SERVICE_TOKEN, bind a no-op default,
         drop the forwardRef(TasksModule) edge) belongs with that same edit. Task 4.1 is then
         guardrails.service.ts and nothing else — which is what its own text already says.

     (c) The transcript ORDERING assertion (draft 5.1) moves into track 2 as 2.3. The guarantee it
         pins already holds pre-change (`await this.captureTranscript(taskId)` precedes the stop-only
         `teardownSandbox` today), so writing it in track 2 makes it a REGRESSION guard over 4.1
         rather than a post-hoc description of it — the same discipline 3.2 applies to the metrics
         response. Its file must land OUTSIDE `apps/api/src/guardrails/`: that directory's
         135 `test()` / 6 `*.spec.ts` / 8 `.test.mjs` baseline is frozen, and a new `.test.mjs` there
         would break the 8 before any lens read it. The new transcript directory is its home.

     Single-writer files, and why they are the integration track's alone:
       - `guardrails.service.ts` — all three groups edit it;
       - `r11-dependency-budget.test.mjs` — ONE `assert.deepEqual` at :71-81 covers all six entries
         and `COLLABORATORS.length === 6` sits at :85, so parallel tracks would collide in one hunk;
       - `r11.json` / `r11-dependency-budget.mjs` / `r7.json` — see (a);
       - `metrics.module.ts` and the four test doubles that stub `semaphoreProjection` — the
         identifier must reach zero across the whole tree in one pass (live sites:
         metrics.module.ts:70, metrics.service.ts:69, metrics.verify.test.mjs:467/:540,
         task-resource.test.mjs:130, terminal-diagnostics-metrics.service.spec.ts:65,
         tasks-durable-admission-cleanup-coordination.story.spec.ts:601/:602/:699, and the LOCAL
         helper of the same name at runner-minutes-ownership.integration.test.mjs:96 — the
         `projection-forwarder-gone` assertion greps all of `apps/api/src`, so that helper counts).

     MEASURED on this tree (command: `measureSource` from scripts/ratchets/r11-dependency-budget.mjs):
       recorder 4 @ :691 :768 :2997 :3065   gate 4 @ :694 :769 :2996 :3064
       transcripts 2 @ :2157 :2159          metrics-projection 2 @ :108 :3908
     These match the draft header and are LIVE as of this partition pass. What is stale is
     `r11.json`'s `samples` (:544/:589/:2648/:2716, :1841/:1843, :94/:3536) — the comparator keys on
     `count` only, so those never went red. Re-measure in task 1.1 rather than trusting any of them. -->

## 1. Track: diagnostics-owner (depends: none)

- [x] 1.1 Re-measure the starting position with the gate's own `measureSource` over `guardrails.service.ts` and record all four counts with their live line numbers. Do not copy them from this file or from the archived range-B artifact — both were written before the tree moved.
  - requirements: ["guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 1.2 Create the diagnostics owner under `apps/api/src/task-provisioning-diagnostics/` with a `*.port.ts` + DI token, moving `tryBeginProvisioningDiagnostics` and `tryResumeProvisioningDiagnostics` whole. The gate check becomes internal: a closed, absent, or throwing gate returns the same "no observer" result the orchestrator computed for itself, so callers cannot tell an open gate from a closed one. Preserve the write timeout and the swallow-and-continue behaviour exactly.
  - requirements: ["task-provisioning-diagnostics/a-closed-diagnostics-write-gate-is-an-injected-no-op-not-a-branch-at-every-call-site"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 1.3 Cover the three closed-gate paths (closed, absent, throwing) and both open-gate paths (begin, resume) against the owner directly, asserting the pre-move outcomes. Add no test under `apps/api/src/guardrails/` — that directory's 135 `test()` / 6 `*.spec.ts` / 8 `.test.mjs` baseline is frozen by a standing requirement.
  - requirements: ["task-provisioning-diagnostics/a-closed-diagnostics-write-gate-is-an-injected-no-op-not-a-branch-at-every-call-site"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 2. Track: transcript-relocation (depends: none)

- [x] 2.1 Move the transcript capture service out of `apps/api/src/tasks/` into its own directory behind a `*.port.ts` + token, and declare that directory in `docs/refactor/contexts-manifest.json` in the SAME commit — an undeclared top-level directory is a hard `exit 1` in the layout gate, not a finding.
  - requirements: ["session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 2.2 Re-provide every token the moved service injects. The runtime-registry token is provided by `tasks.module.ts` but absent from its `exports`, and the moved service injects it NON-optionally, so a miss here is a startup-time DI resolution failure rather than a runtime undefined. Boot the application context to prove it resolves.
  - requirements: ["session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 2.3 Write the ordering assertion for transcript capture: drive a terminal transition with capture made artificially slow, assert capture COMPLETED before teardown was invoked, then run the same assertion against a non-awaited implementation and confirm it FAILS. An assertion that passes against both is not testing the guarantee. Land the file in the new transcript directory, never under `apps/api/src/guardrails/` — the assertion must pass BEFORE task 4.1 edits the orchestrator and unchanged after it.
  - requirements: ["session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 3. Track: projection-owner (depends: none)

- [x] 3.1 Create the capacity-projection owner under `apps/api/src/runner-metrics/` with a `*.port.ts` + DI token, mirroring the runner-minutes owner this directory already holds. Provide it from the existing `runner-minutes.module.ts` so no new module registration reaches `app.module.ts`. Add no logging, persistence, timers, or error handling the projection did not already have.
  - requirements: ["resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 3.2 Pin the metrics response before the move: assert deep equality on the complete capacity and occupancy blocks over a fixed state with a frozen clock, loading the real compiled implementation the way the existing metrics verification test does — not a hand-written mirror. Land the file under `apps/api/src/runner-metrics/` and drive it through the projection owner and the compiled `projectCapacity` / `buildSlotOccupancy`, not through `MetricsService`'s constructor, which task 4.2 changes. This test must pass unmodified after the move.
  - requirements: ["resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 4. Track: integration (depends: diagnostics-owner, transcript-relocation, projection-owner)

- [x] 4.1 In `guardrails.service.ts`, land all three edits: delete the two diagnostics wrapper methods (their four local aliases leave with them); make the transcript port non-optional so the presence guard disappears while the AWAITED capture call stays byte-identical at its seam; and delete the projection accessor together with its type-only import. Touch neither the constructor signature nor the legacy pass-through that keeps both diagnostics parameters live. This is the ONLY task that writes this file, and it writes no other production file — the composition half of the transcript port landed in track 2's `guardrails.module.ts` edit.
  - requirements: ["guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor", "guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.2 Point the metrics consumer at the projection port directly and restate every test double that stubbed the deleted accessor, so the identifier disappears from the tree entirely rather than surviving in a fake. The live sites are `metrics.service.ts:69`, `metrics.module.ts:70`, `metrics.verify.test.mjs:467`/`:540`, `task-resource.test.mjs:130`, `terminal-diagnostics-metrics.service.spec.ts:65`, `tasks-durable-admission-cleanup-coordination.story.spec.ts:601`/`:602`/`:699`, and the LOCAL helper of the same name at `runner-minutes-ownership.integration.test.mjs:96` — the assertion greps all of `apps/api/src`, so a same-named local helper is a red. Write no comment anywhere containing a measured symbol's literal text — the counter reads raw source and does not strip comments.
  - requirements: ["resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.3 Handle the two ratchet consequences of a path-keyed move: the reverse import from the tasks-side controller becomes cross-context and RAISES that file's r7 count (the comparator is fail-closed upward), and the moved service's own r7 entries must be re-keyed — old keys deleted, new keys seeded, in the same commit. A stale entry and a zero-count entry are equally red. Re-count `cross-context-import:apps/api/src/guardrails/guardrails.service.ts` (was 8) and `cross-context-import:apps/api/src/metrics/metrics.service.ts` (was 2) in this same pass — tasks 4.1 and 4.2 moved both, and the comparator is fail-closed downward too.
  - requirements: ["session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.4 Reduce the two diagnostics entries to 2 and the transcripts entry to 1, refreshing each entry's `samples` to the surviving references at their post-change line numbers and writing the arithmetic plus the floor's cause into each `change` field. Delete the metrics-projection entry outright, drop the gate's collaborator declaration from six to five, and move its hard-coded expectation in the same commit.
  - requirements: ["domain-event-bus/two-budget-entries-are-reduced-and-one-is-deleted-in-the-same-commit-and-by-different-rules"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.5 Correct the construction-site count in the guardrails delta's MODIFIED requirement against a live count, and confirm the two untouched budget entries are byte-identical to their form at the start of this change.
  - requirements: ["guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched", "domain-event-bus/two-budget-entries-are-reduced-and-one-is-deleted-in-the-same-commit-and-by-different-rules"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.6 Run `node scripts/spec-assert.mjs collapse-three-collaborator-groups` and record which requirements it decides. Every assertion must pass and the decided set must cover the command-decidable requirements; a requirement left undecided costs an LLM verification pass, so treat a gap as a missing assertion rather than as acceptable.
  - requirements: ["guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [x] 4.7 Run the gate set on the integrated tree and record each result: dependency budget, context layout v2, module layout, test discovery, script suites, the API package suite, typecheck, and the adversarial public-surface verifier. Confirm the guardrails characterization baseline is still 135 / 6 / 8 and that the change's diff contains no file under `apps/api/src/guardrails/*.spec.ts`, no `packages/contracts/`, and no harness or tooling file.
  - requirements: ["guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor", "resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder"]
  - surfaces: ["developer-workflow", "public-v1"]
  - verify: "workflow-gates"
