<!-- Tracks 2 and 3 touch disjoint things (markdown vs a workflow file) and can run
     in parallel. Track 1 supplies the facts both write down; Track 4 gates on both.
     Track 3 is the only one that can silently reduce coverage — its verification is
     deliberately heavier than its implementation. -->

## 1. Track: facts (depends: none)

- [x] 1.1 For each of the four subtrees, derive from source what its instruction file must state: its package name, what it depends on, what depends on it, and the commands that verify a change to it. Derived, not recalled — a file that names a command that does not exist is worse than no file.
  - requirements: ["agent-workspace-scoping/each-major-subtree-shall-carry-instructions-that-bound-its-own-scope"]
  - surfaces: ["docs"]
  - verify: "docs"
- [x] 1.2 Derive the product layout from source: every workspace package, which produce deployment artifacts, which are optional and how they are enabled, and what an operator minimally runs. The optionality of the console comes from the compose profile, not from memory.
  - requirements: ["repo-layout-docs/the-product-layout-shall-be-documented-alongside-the-tooling-layout"]
  - surfaces: ["docs"]
  - verify: "docs"
- [x] 1.3 Record the current CI cost per job and classify each job's subject as api/database-only or repository-wide. This classification is what Track 3 conditions on and what task 4.3 checks against.
  - requirements: ["monorepo-foundation/ci-jobs-shall-run-when-a-change-can-affect-them"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"

## 2. Track: scoping (depends: facts)

- [x] 2.1 Write the four directory-scoped instruction files, each stating the four things design D2 requires: what the subtree is, what it may and may not depend on, where commonly-searched cross-subtree concerns actually live, and how to verify a change.
  - requirements: ["agent-workspace-scoping/each-major-subtree-shall-carry-instructions-that-bound-its-own-scope"]
  - surfaces: ["docs"]
  - verify: "docs"
- [x] 2.2 Confirm no root-level agent instruction file exists or is added (design D1), and that no file duplicates architecture that specs already carry.
  - requirements: ["agent-workspace-scoping/each-major-subtree-shall-carry-instructions-that-bound-its-own-scope"]
  - surfaces: ["docs"]
  - verify: "docs"
- [x] 2.3 Verify every path and command named in the four files actually resolves: run each verification command, and confirm each referenced path exists.
  - requirements: ["agent-workspace-scoping/each-major-subtree-shall-carry-instructions-that-bound-its-own-scope"]
  - surfaces: ["docs"]
  - verify: "docs"
- [x] 2.4 Write `docs/product-layout.md` from the 1.2 facts, and cross-link it with `docs/repo-layout.md` in both directions, each stating which question it answers.
  - requirements: ["repo-layout-docs/the-product-layout-shall-be-documented-alongside-the-tooling-layout"]
  - surfaces: ["docs"]
  - verify: "docs"

## 3. Track: ci-conditions (depends: facts)

- [x] 3.1 Add conditions to the four jobs classified in 1.3 as api/database-only, leaving the repository-wide jobs unconditional (design D5).
  - requirements: ["monorepo-foundation/ci-jobs-shall-run-when-a-change-can-affect-them"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 3.2 Check the branch protection configuration for `main` and confirm a skipped job does not become a permanently-pending required check. If it does, resolve that before proceeding — a required check that never reports is worse than a job that always runs.
  - requirements: ["monorepo-foundation/ci-jobs-shall-run-when-a-change-can-affect-them"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 3.3 Prove the wiring locally, as far as local evidence reaches: a runnable gate asserting that each conditioned job gates on the shared filter, that the filter publishes the output its consumers read, that a shallow checkout or null base SHA fails OPEN rather than skipping every gate, and that the path pattern classifies representative backend and inert paths correctly.
  - requirements: ["monorepo-foundation/ci-jobs-shall-run-when-a-change-can-affect-them"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [ ] 3.4 **Deferred — needs a pull request, not just a push.** `ci.yml` triggers on
  - requirements: ["monorepo-foundation/ci-jobs-shall-run-when-a-change-can-affect-them"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  `pull_request` and on `push` to `main` only, so pushing this branch does not
  exercise the conditions. Design D4 sets the bar at an observed run and an
  observed skip per conditioned job, because what has to be seen is GitHub's own
  handling of a skipped job.

  When a pull request for this branch exists:

  1. Confirm `task-model-n-minus-one-compat`, `task-admission-migration-compatibility`
     and `boot-smoke` all **run** — this branch touches `apps/api` and `packages/`,
     so `backend` resolves true and nothing should be skipped.
  2. Push a docs-only commit (a line in `docs/product-layout.md` is enough) and
     confirm those three report **skipped**.
  3. Confirm `public-surface-parity` and `typecheck + lint + test` report a real
     conclusion in **both** cases. They are required checks; a skip there blocks
     the merge permanently, which is the failure this task exists to rule out.
  4. Record the observed runner-minutes against the 3.4 min predicted in
     `facts.md` §3.

  Until 1–3 are observed the conditions are wired but unproven. `scripts/ci-job-conditions.test.mjs`
  guards the wiring; it cannot guard GitHub's semantics.

## 4. Track: verification (depends: scoping, ci-conditions)

- [x] 4.1 Run the repository gates and the full api, contracts, and web verification, confirming this change altered nothing that executes.
  - requirements: ["monorepo-foundation/ci-jobs-shall-run-when-a-change-can-affect-them"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.2 Confirm no existing test or spec file was modified — this change adds documentation and CI conditions and should touch neither.
  - requirements: ["agent-workspace-scoping/each-major-subtree-shall-carry-instructions-that-bound-its-own-scope"]
  - surfaces: ["developer-workflow"]
  - verify: "docs"
- [x] 4.3 Compare the observed CI job set for a docs-only change against the 1.3 classification, and record the runner-minutes saved. If the saving is materially smaller than 1.3 predicted, the classification was wrong and is corrected rather than the number restated.
  - requirements: ["monorepo-foundation/ci-jobs-shall-run-when-a-change-can-affect-them"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 4.4 Record what this change did and did not address, as the evidence the epic asked for: the epic's later phases are to be re-evaluated against it rather than against the original assumption.
  - requirements: ["repo-layout-docs/the-product-layout-shall-be-documented-alongside-the-tooling-layout"]
  - surfaces: ["docs"]
  - verify: "docs"
