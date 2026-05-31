## Context

OpenSpec (v1.2.0, `spec-driven` schema) drives our change process through four serial artifacts (proposal → design + specs → tasks) and two single-agent loops (`propose` generating artifacts, `apply` implementing tasks). The `openspec` CLI owns the dependency graph and artifact templates; artifact files are the source of truth.

Two pains at our scale:
1. **`apply` is serial** — a 60-80 task change is implemented one task at a time.
2. **`propose` is shallow** — no research feeds proposals, and `tasks.md` is a flat checklist with no structure to parallelize against.

Claude Code's Workflow capability (JS orchestration scripts in `.claude/workflows/*.js`; `agent()`/`parallel()`/`pipeline()`/`phase()`; `schema` for structured output; worktree isolation; adversarial verification; ≤16 concurrent / ≤1000 total agents) is available on our 20x plan. The design layers Workflow onto the three widest seams — research, implementation, verification — while leaving the CLI and schema untouched.

## Goals / Non-Goals

**Goals:**
- Cut `apply` wall-clock for large changes via track-based parallelism with safe merging.
- Deepen proposals with multi-route research, and emit testable specs so verification has a real contract.
- Add an adversarial verify phase that gates archive, making aggressive parallelism trustworthy.
- Keep artifacts authoritative and the process resumable.

**Non-Goals:**
- No changes to the `openspec` CLI, the `spec-driven` schema, or the artifact dependency graph.
- Workflow does not make spec decisions — it executes and verifies specs only.
- No replacement of the four skills; they remain the conversational entry points and delegate to workflows at fan-out points.
- Not targeting Pro-plan users (Workflow unavailable there); serial fallback covers that and small changes.

## Decisions

### D1. Customize via forked schema, never fork the skills
OpenSpec has two customization layers. The four `openspec-*` skills are **generic executors**: they call `openspec instructions <id>` and feed the returned text to the agent. The behavior of "propose/apply mode" lives in the **schema** (`openspec/schemas/<name>/schema.yaml`): per-artifact `instruction` text + templates + the `apply.instruction`. The official mechanism is `openspec schema fork spec-driven` (project schema shadows the built-in; resolution order CLI flag > change `.openspec.yaml` > `config.yaml` > built-in).

So we fork and override `spec-driven` in place and edit only its instruction texts: proposal instruction → research step; tasks instruction/template → Track format; `apply.instruction` → parallel-delegation + verify-gate. The workflow `.js` files remain the orchestration engines, invoked from the instruction text. **No skill is forked.**
- **Why over editing the skills** (the rejected first attempt): forked skills are duplicated maintenance and drift from upstream; the schema is the sanctioned, version-controlled seam and leaves the stock skills upgradable.
- **Trade-off**: `apply.instruction` telling the agent to "run the opsx-apply-tracks workflow" is advisory prompt text — the schema exposes no hard execution hook. Acceptable: it is the only sanctioned seam, and the serial fallback is always correct.

### D2. Track is the unit of parallelism, not the task
Fan out by **track** (a set of file/module-independent tasks), one git worktree per track, tasks serial within a track. For 60-80 tasks this yields ~8-12 tracks instead of 60-80 worktrees.
- **Why over one-agent-per-task**: 80 worktrees blow up disk/merge cost and the 16-concurrency cap forces many waves; intra-track serialization also removes intra-track conflicts for free.

### D3. propose drafts tracks, apply corrects them
`propose` emits best-effort `Track`/`depends` metadata; `apply` runs a correction agent that validates independence against real code coupling, pulls shared-file tasks into a serial integration track, rebalances, and writes the corrected partition back to `tasks.md`.
- **Why over propose-only**: real file coupling (two "independent" tracks both editing `routes.ts`) is invisible at propose time. **Why over apply-only inference**: making one agent infer an 80-task DAG from scratch is slow and error-prone; reviewing a draft is faster and more accurate.

### D4. Mandatory integration barrier with build-verify + repair loop
After parallel tracks finish: merge worktrees → resolve shared-file conflicts → run build/test → on failure dispatch repair agents until green or budget exhausted. `apply` never reports success on a red build.
- **Why**: "each track self-tested" ≠ "merged tree builds." Without this, more parallelism means more hidden breakage.

### D5. Verify = semantic layer on specs, distinct from apply's mechanical gate
`apply`'s integration step proves "it builds/runs"; `verify` proves "it satisfies each spec requirement." Unit of verification is the requirement/scenario.
- **Why requirement, not task**: tasks lie ("I changed code"); requirements don't ("user can log in with JWT").

### D6. Static triage → high-risk dynamic, with adversarial refutation
Per requirement: static triage agent emits {met?, confidence, risk}. Low-risk + high-confidence "met" passes on one verdict. Uncertain or high-risk escalates to (a) diverse-lens skeptics prompted to *refute*, and (b) a dynamic agent that writes+runs a test. Verified only if it survives majority refutation.
- **Why**: a single "looks good" agent rubber-stamps everything (confirmation bias); diverse refutation catches distinct failure modes. Full dynamic on all ~30 requirements is too costly, hence triage-gated escalation.

### D7. Three-way findings routing
confirmed-unmet → append task to `tasks.md` (loop back to apply); spec-defect (ambiguous/untestable/contradictory) → flag for design/specs revision, NOT apply; confirmed-met → `verification-report.md`.
- **Why**: verify frequently finds *bad specs*, not bad code; routing those to apply would produce wrong code against a wrong contract.

### D8. Idempotent resume via the `[x]` ledger
Resume reads `tasks.md` checkboxes and dispatches only incomplete tracks. Workflow's `resumeFromRunId` is a secondary mechanism; the artifact ledger is primary.
- **Why over run-journal only**: the artifact survives across sessions and is the source of truth anyway.

### D9. Side-car files, not new schema artifacts
`research-brief.md` and `verification-report.md` are written as plain files into the change directory, not registered as schema artifacts.
- **Why**: adding a required artifact to the overridden `spec-driven` schema would retroactively mark every existing/in-flight change as incomplete (missing the new artifact). Side-car files keep the artifact dependency graph identical, so prior changes still validate.

### D11. Verify folded into apply, not gated at archive
The schema has no archive/post-apply execution hook (confirmed against OpenSpec docs). So verify runs as STAGE 2 of `apply.instruction` rather than as an archive precondition: a change is not "done" until verify passes.
- **Why over an archive-skill gate**: gating at archive would require forking the archive skill (violates D1). Folding into apply is schema-native and semantically tighter — implementation isn't complete until verified.

### D10. Closed feedback loop between the three phases
`propose-deep` produces testable Given-When-Then → `verify` has something to check → `verify` surfaces spec defects → routed back to `propose`/`design`. The three phases are one self-correcting loop, not three isolated features.

## Risks / Trade-offs

- **Bad track partition → merge hell** → D3 correction step + D4 integration barrier + shared-file tasks forced serial.
- **Static-only verify gets fooled by plausible-but-wrong code** → D6 escalates high-risk/uncertain requirements to dynamic ground-truth tests.
- **Verify only as good as the specs** → D10: deep-propose must emit testable scenarios; spec-defect routing (D7) improves specs over time.
- **Cost scales with change size** → serial fallback below a task threshold; workflows trigger only when work is wide.
- **Worktree overhead per track** → fan out by track (D2), not task, keeping worktree count to ~8-12.
- **Cross-track regression (track A satisfies req, track B breaks it)** → dedicated cross-track-integration skeptic lens in D6.
- **Concurrency/agent caps (16/1000)** → tracks sized so K ≤ ~12; verify uses triage to avoid spawning skeptics for every requirement.

## Migration Plan

1. Add the three `.claude/workflows/*.js` orchestration engines.
2. `openspec schema fork spec-driven spec-driven` to shadow the built-in schema project-locally; edit its proposal/tasks instructions, tasks template, and `apply.instruction`. Run `openspec schema validate spec-driven`.
3. Verify the artifact graph is unchanged (`openspec status` on an existing change still passes) and `openspec instructions apply` returns the new two-stage flow.
4. Rollback: delete `openspec/schemas/spec-driven/` (the built-in package schema re-resolves automatically) and remove the workflow files. The stock skills were never touched, so the original flow is fully intact.

## Open Questions

- The exact task-count threshold for serial-vs-parallel apply (D2/serial fallback) — tune empirically.
- Repair-loop budget in D4 (max rounds before surfacing failure to the user).
- Whether the cross-track-integration skeptic should run on every merged requirement or only those touching files changed by >1 track (cost vs coverage).
