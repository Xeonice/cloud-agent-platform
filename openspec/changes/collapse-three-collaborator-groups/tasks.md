<!-- Track-annotated tasks. `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.

     BUDGET: 6 requirements, 15 tasks — ratio 2.5, at the cap the tasks instruction sets.
     The previous cut ran 14 requirements / 73 tasks (ratio 5.2) and took three verify rounds; the
     widest archived cut ran 33 requirements / 31 tasks (ratio 0.9) and took one. The defences that
     inflated that ratio live in assertions.json here instead — one executable line each, decided by
     R12 before verify starts, rather than prose a human and every lens re-read each round.

     Write sets (disjoint across tracks 1-3, which is why they run in one wave):
       1 apps/api/src/task-provisioning-diagnostics/**  (new owner + port)
       2 the transcript service's new directory + contexts-manifest.json + apps/api/src/tasks/tasks.module.ts
       3 apps/api/src/runner-metrics/**                 (projection owner + port)
       4 guardrails.service.ts, metrics.service.ts, guardrails.module.ts, scripts/ratchets/**
       5 integration
     Track 4 is deliberately the only writer of the orchestrator and the ratchets: all three groups
     edit `guardrails.service.ts`, and `r11-dependency-budget.test.mjs` holds ONE `assert.deepEqual`
     covering all six entries, so parallel tracks would collide inside a single hunk.

     MEASURED at propose time (command: `measureSource` from scripts/ratchets/r11-dependency-budget.mjs):
       recorder 4 @ :691 :768 :2997 :3065   gate 4 @ :694 :769 :2996 :3064
       transcripts 2 @ :2157 :2159          metrics-projection 2 @ :108 :3908
     Line numbers ALL moved when the previous cut grew this file by 42 lines — the range-B artifact's
     numbers (:654 :731 :2110 :3861) are stale. Re-measure in task 1.1 rather than trusting either. -->

## 1. Track: diagnostics-owner (depends: none)

- [ ] 1.1 Re-measure the starting position with the gate's own `measureSource` over `guardrails.service.ts` and record all four counts with their live line numbers. Do not copy them from this file or from the archived range-B artifact — both were written before the tree moved.
  - requirements: ["guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 1.2 Create the diagnostics owner under `apps/api/src/task-provisioning-diagnostics/` with a `*.port.ts` + DI token, moving `tryBeginProvisioningDiagnostics` and `tryResumeProvisioningDiagnostics` whole. The gate check becomes internal: a closed, absent, or throwing gate returns the same "no observer" result the orchestrator computed for itself, so callers cannot tell an open gate from a closed one. Preserve the write timeout and the swallow-and-continue behaviour exactly.
  - requirements: ["task-provisioning-diagnostics/a-closed-diagnostics-write-gate-is-an-injected-no-op-not-a-branch-at-every-call-site"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 1.3 Cover the three closed-gate paths (closed, absent, throwing) and both open-gate paths (begin, resume) against the owner directly, asserting the pre-move outcomes. Add no test under `apps/api/src/guardrails/` — that directory's 135 `test()` / 6 `*.spec.ts` / 8 `.test.mjs` baseline is frozen by a standing requirement.
  - requirements: ["task-provisioning-diagnostics/a-closed-diagnostics-write-gate-is-an-injected-no-op-not-a-branch-at-every-call-site"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 2. Track: transcript-relocation (depends: none)

- [ ] 2.1 Move the transcript capture service out of `apps/api/src/tasks/` into its own directory behind a `*.port.ts` + token, and declare that directory in `docs/refactor/contexts-manifest.json` in the SAME commit — an undeclared top-level directory is a hard `exit 1` in the layout gate, not a finding.
  - requirements: ["session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 2.2 Re-provide every token the moved service injects. The runtime-registry token is provided by `tasks.module.ts` but absent from its `exports`, and the moved service injects it NON-optionally, so a miss here is a startup-time DI resolution failure rather than a runtime undefined. Boot the application context to prove it resolves.
  - requirements: ["session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 2.3 Handle the two ratchet consequences of a path-keyed move: the reverse import from the tasks-side controller becomes cross-context and RAISES that file's r7 count (the comparator is fail-closed upward), and the moved service's own r7 entries must be re-keyed — old keys deleted, new keys seeded, in the same commit. A stale entry and a zero-count entry are equally red.
  - requirements: ["session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 3. Track: projection-owner (depends: none)

- [ ] 3.1 Create the capacity-projection owner under `apps/api/src/runner-metrics/` with a `*.port.ts` + DI token, mirroring the runner-minutes owner this directory already holds. Add no logging, persistence, timers, or error handling the projection did not already have.
  - requirements: ["resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 3.2 Pin the metrics response before the move: assert deep equality on the complete capacity and occupancy blocks over a fixed state with a frozen clock, loading the real compiled implementation the way the existing metrics verification test does — not a hand-written mirror. This test must pass unmodified after the move.
  - requirements: ["resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 4. Track: orchestrator-and-ratchets (depends: diagnostics-owner, transcript-relocation, projection-owner)

- [ ] 4.1 In `guardrails.service.ts`, land all three edits: delete the two diagnostics wrapper methods (their four local aliases leave with them); make the transcript port non-optional so the presence guard disappears while the AWAITED capture call stays byte-identical at its seam; and delete the projection accessor together with its type-only import. Touch neither the constructor signature nor the legacy pass-through that keeps both diagnostics parameters live.
  - requirements: ["guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor", "guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 4.2 Point the metrics consumer at the projection port directly and restate every test double that stubbed the deleted accessor, so the identifier disappears from the tree entirely rather than surviving in a fake. Write no comment anywhere containing a measured symbol's literal text — the counter reads raw source and does not strip comments.
  - requirements: ["resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 4.3 Reduce the two diagnostics entries to 2 and the transcripts entry to 1, refreshing each entry's `samples` to the surviving references at their post-change line numbers and writing the arithmetic plus the floor's cause into each `change` field. Delete the metrics-projection entry outright, drop the gate's collaborator declaration from six to five, and move its hard-coded expectation in the same commit.
  - requirements: ["domain-event-bus/two-budget-entries-are-reduced-and-one-is-deleted-in-the-same-commit-and-by-different-rules"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 4.4 Correct the construction-site count in the guardrails delta's MODIFIED requirement against a live count, and confirm the two untouched budget entries are byte-identical to their form at the start of this change.
  - requirements: ["guardrails/the-orchestrator-constructor-and-its-positional-construction-sites-are-untouched", "domain-event-bus/two-budget-entries-are-reduced-and-one-is-deleted-in-the-same-commit-and-by-different-rules"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 5. Track: gates-and-verification (depends: diagnostics-owner, transcript-relocation, projection-owner, orchestrator-and-ratchets)

- [ ] 5.1 Write the ordering assertion for transcript capture: drive a terminal transition with capture made artificially slow, assert capture COMPLETED before teardown was invoked, then run the same assertion against a non-awaited implementation and confirm it FAILS. An assertion that passes against both is not testing the guarantee.
  - requirements: ["session-transcript-persistence/transcript-capture-moves-out-of-the-tasks-context-without-moving-its-happens-before"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 5.2 Run `node scripts/spec-assert.mjs collapse-three-collaborator-groups` and record which requirements it decides. Every assertion must pass and the decided set must cover the command-decidable requirements; a requirement left undecided costs an LLM verification pass, so treat a gap as a missing assertion rather than as acceptable.
  - requirements: ["guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"
- [ ] 5.3 Run the gate set on the integrated tree and record each result: dependency budget, context layout v2, module layout, test discovery, script suites, the API package suite, typecheck, and the adversarial public-surface verifier. Confirm the guardrails characterization baseline is still 135 / 6 / 8 and that the change's diff contains no file under `apps/api/src/guardrails/*.spec.ts`, no `packages/contracts/`, and no harness or tooling file.
  - requirements: ["guardrails/three-collaborator-groups-leave-the-orchestrator-together-each-at-its-own-measured-floor", "resource-metrics/capacity-projection-is-owned-in-platform-ops-and-read-directly-with-no-orchestrator-forwarder"]
  - surfaces: ["developer-workflow", "public-v1"]
  - verify: "workflow-gates"
