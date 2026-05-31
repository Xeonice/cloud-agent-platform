<!-- Track-annotated tasks: each numbered group doubles as a parallel Track.
     `## N. Track: <name> (depends: ...)` is the draft partition for apply to correct. -->

## 1. Track: scaffolding (depends: none)

- [x] 1.1 Create `.claude/workflows/` directory
- [x] 1.2 Fork built-in schema to project (`openspec schema fork spec-driven spec-driven`) and bake `## N. Track: <name> (depends: ...)` format into its `tasks` instruction + template
- [x] 1.3 Set `APPLY_PARALLEL_THRESHOLD = 12` in `opsx-apply-tracks.js` and mirror the same number in the schema's `apply.instruction` text

## 2. Track: deep-research-proposal workflow (depends: scaffolding)

- [x] 2.1 Author `.claude/workflows/opsx-propose-deep.js` meta block and phases (Research / Synthesize / Artifacts)
- [x] 2.2 Implement parallel research fan-out: web route + codebase-scan route + archive-scan route (concurrent in one phase) — satisfies `deep-research-proposal` "research routes run in parallel"
- [x] 2.3 Synthesize routes into `research-brief.md` written to the change dir — satisfies "research brief is produced before proposal"
- [x] 2.4 Generate specs with testable Given-When-Then scenarios (reject non-observable criteria) — satisfies "generated scenarios are verifiable"
- [x] 2.5 Generate `tasks.md` with Track/`depends` draft metadata — satisfies "tasks carry track metadata"
- [x] 2.6 Assert workflow writes only artifact files (no CLI/schema mutation) — satisfies "no schema or CLI mutation"

## 3. Track: parallel-track-apply workflow (depends: scaffolding)

- [x] 3.1 Author `.claude/workflows/opsx-apply-tracks.js` meta and phases (Correct / Implement / Integrate / Verify-build)
- [x] 3.2 Implement track-correction agent: parse draft tracks, scan cross-track file coupling, rebalance, persist corrected partition back to `tasks.md` — satisfies "draft tracks are corrected against real coupling"
- [x] 3.3 Force shared-file tasks into a serial integration track — satisfies "shared-file tasks are isolated"
- [x] 3.4 Implement parallel track execution with `isolation: 'worktree'`, ≤16 concurrency, intra-track serial order — satisfies "tracks run in isolated worktrees" + "intra-track order preserved"
- [x] 3.5 Implement integration merge + shared-file conflict resolution
- [x] 3.6 Run project build/test after merge; never report success on red build — satisfies "build is verified after merge"
- [x] 3.7 Implement repair loop with bounded budget — satisfies "failures trigger repair loop"
- [x] 3.8 Implement idempotent resume from `[x]` ledger (skip completed, dispatch only incomplete tracks) — satisfies "completed tasks are not re-run"

## 4. Track: adversarial-spec-verify workflow (depends: scaffolding)

- [x] 4.1 Author `.claude/workflows/opsx-verify.js` meta and phases (Triage / Escalate / Route)
- [x] 4.2 Enumerate every requirement across `specs/**/spec.md` for the change — satisfies "every requirement is enumerated"
- [x] 4.3 Implement static-triage agent emitting {met, confidence, risk, evidence} per requirement
- [x] 4.4 Implement escalation routing: low-risk/high-confidence pass on one verdict; uncertain/high-risk escalate — satisfies "low-risk requirement passes on static verdict" + "high-risk requirement is dynamically verified"
- [x] 4.5 Implement diverse-lens skeptic panel (correctness/boundary/data-integrity/reproducibility/cross-track) prompted to refute; verified only on majority survival — satisfies "only survivors are marked verified" + "cross-track regression is checked"
- [x] 4.6 Implement dynamic check (write + run a scenario test) for escalated requirements
- [x] 4.7 Implement gap check and scope-creep check — satisfies "missing implementation is detected" + "out-of-scope behavior is flagged"
- [x] 4.8 Implement three-way routing: unmet→append `tasks.md`; spec-defect→flag design/specs; met→`verification-report.md` — satisfies "unmet requirement reopens a task" + "spec defect routes to design, not apply"

## 5. Track: schema customization wiring (depends: deep-research-proposal workflow, parallel-track-apply workflow, adversarial-spec-verify workflow)

<!-- Done via the forked schema's instruction texts — NO stock skill is forked (design D1). -->

- [x] 5.1 Edit schema `proposal` instruction to run the `opsx-propose-deep` research step and ground the proposal in the side-car `research-brief.md`
- [x] 5.2 Edit schema `apply.instruction` STAGE 1 to delegate to `opsx-apply-tracks` above the task threshold, serial fallback below — satisfies "small change uses serial path"
- [x] 5.3 Encode the capability probe + graceful serial fallback directly in the schema `apply.instruction`/`proposal` instruction text (no skill edit)

## 6. Track: verify gate folded into apply (depends: adversarial-spec-verify workflow)

<!-- Schema has no archive/post-apply hook, so verify is STAGE 2 of apply.instruction (design D11). -->

- [x] 6.1 Fold `opsx-verify` into schema `apply.instruction` as STAGE 2 (completion gate; archive skill untouched)
- [x] 6.2 Make the change "not done" while verify returns pass:false — STAGE 2 reopens unmet requirements as tasks and loops back to STAGE 1 — satisfies "archive blocked on unmet requirements" + "archive proceeds when verified"

## 7. Track: validation & docs (depends: skill delegation wiring, archive gate)

- [ ] 7.1 Dry-run the full loop (propose-deep → apply-tracks → verify → archive) on a small throwaway change
- [ ] 7.2 Validate resume by interrupting apply mid-run and re-invoking
- [x] 7.3 Document the three workflows and the Track format in the repo (README or skill notes)
