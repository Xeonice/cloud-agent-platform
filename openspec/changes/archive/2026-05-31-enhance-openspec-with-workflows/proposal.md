## Why

The current OpenSpec flow is single-agent and strictly serial: `propose` generates artifacts one by one, and `apply` implements tasks in a `for` loop. At our scale — changes routinely carry 60-80 tasks — `apply` is painfully slow, and `propose` produces shallow proposals because no real research feeds it. Claude Code's Workflow capability (multi-agent orchestration, worktree isolation, adversarial verification) is now available on our plan, and it lands exactly where OpenSpec is weakest: wide, parallelizable, and verifiable work. We want to inject it without disturbing OpenSpec's backbone.

## What Changes

- **Deep research before proposing**: a multi-route research fan-out (web + codebase scan + prior-change archive) runs before `proposal.md`, producing a `research-brief.md` and — critically — **testable Given-When-Then scenarios** in the specs, so downstream verification has teeth.
- **Track-structured tasks**: `tasks.md` gains explicit `Track` grouping with `depends` metadata. `propose` produces a best-effort draft; `apply` corrects it against real file coupling.
- **Track-based parallel apply**: `apply` partitions tasks into independent tracks, runs each track in its own git worktree in parallel (≤16 concurrent), then an integration barrier merges tracks, resolves shared-file conflicts, runs build/tests, and repairs failures. Resume is idempotent via the `[x]` ledger.
- **Adversarial spec verification (new phase)**: a `verify` step proves each spec REQUIREMENT is satisfied using static triage + dynamic checks only on high-risk requirements, via refutation by perspective-diverse skeptics. Findings route three ways: confirmed-unmet → reopen tasks; spec-defect → flag design/specs; confirmed-met → ledger. `verify` becomes a **gate before `archive`**.
- **Backbone untouched (non-goal / explicit boundary)**: the `openspec` CLI, the `spec-driven` schema, the dependency graph, and "artifacts are the source of truth" are NOT modified. Workflow is an *executor and verifier* of specs, never a *decision-maker* over them.

## Capabilities

### New Capabilities
- `deep-research-proposal`: Multi-route research fan-out feeding richer proposals and testable spec scenarios, with Track-annotated draft tasks.
- `parallel-track-apply`: Track-partitioned, worktree-isolated parallel implementation with integration merge, build verification, repair loop, and idempotent resume.
- `adversarial-spec-verify`: Static-triage + high-risk-dynamic adversarial verification of spec requirements, with three-way findings routing and an archive gate.

### Modified Capabilities
<!-- None: the spec-driven schema and openspec CLI are intentionally left unchanged. These enhancements are layered as Workflow scripts + skill delegation + config.yaml rules, not schema modifications. -->

## Impact

- **New files**: `.claude/workflows/opsx-propose-deep.js`, `.claude/workflows/opsx-apply-tracks.js`, `.claude/workflows/opsx-verify.js` (the orchestration engines).
- **Customization via forked schema (NOT skill forks)**: `openspec schema fork spec-driven` overrides the built-in schema project-locally at `openspec/schemas/spec-driven/`. We edit only its `instruction` texts and the `tasks` template: proposal instruction gains a research step, tasks instruction/template gain the Track format, and `apply.instruction` gains the parallel-delegation + verify-gate two-stage flow. The four stock OpenSpec skills are **left untouched** — they read these instructions from the schema and execute them.
- **No artifact-graph change**: `research-brief.md` and `verification-report.md` are side-car files written into the change directory; no new schema artifact is added, so existing/in-flight changes still validate.
- **Verify is folded into apply** (STAGE 2 of `apply.instruction`), because the schema has no archive/post-apply hook; the archive skill is not modified.
- **Dependencies**: Claude Code Workflow capability (Max/Team/Enterprise; available on our 20x plan), git worktree support, a runnable build/test command for the target project.
- **Constraints**: concurrency capped at 16 / 1000 total agents per run; cost scales with change size — workflows trigger only above a task threshold, with serial fallback below. The workflow-delegation in `apply.instruction` is advisory prompt text (the schema offers no hard execution hook), so it depends on the executing agent honoring it.
