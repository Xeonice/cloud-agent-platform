# OpenSpec × Claude Code Workflows

This repo enhances the stock OpenSpec flow with multi-agent Workflow orchestration
and repository-owned public-surface metadata enforcement. Orchestration remains in
the project-local schema override and the three `.js` engines here; the mirrored
Claude/Codex propose and apply skills add the sidecar/task preflight around it.

## How it's wired (two layers)

```
Project skills (openspec-propose / apply / archive)
        │ validate metadata, then call `openspec instructions <id>`
        ▼
openspec/schemas/spec-driven/schema.yaml            ← project override (shadows built-in)
   • proposal.instruction  → run opsx-propose-deep, write research-brief.md
   • tasks.instruction + template → Track format
   • apply.instruction → STAGE 1 parallel apply, STAGE 2 verify gate
        │ instruction text tells the agent to run:
        ▼
.claude/workflows/*.js                              ← orchestration engines (this dir)
```

The schema override was created with `openspec schema fork spec-driven spec-driven`.
The public-surface preflight is intentionally implemented outside the OpenSpec CLI,
schema engine, and artifact dependency graph.

## The three workflows

| File | Slash command | Phase | What it does |
|---|---|---|---|
| `opsx-propose-deep.js` | `/opsx-propose-deep` | propose | Parallel research fan-out (web + codebase + archive) → `research-brief.md`, then testable specs + Track-annotated tasks |
| `opsx-apply-tracks.js` | `/opsx-apply-tracks` | apply | Correct track partition → parallel worktree-isolated tracks (≤16) → integration merge → build verify + bounded repair → cleanup (prune merged worktrees). Idempotent resume via `[x]` ledger; honest `success` gate (green build + no track failures + empty ledger) |
| `opsx-verify.js` | `/opsx-verify` | verify | Enumerate requirements → static triage → high-risk dynamic + diverse-lens refutation → three-way routing (unmet→tasks, defect→design, met→`verification-report.md`) |

All three are invoked with `args: { changeName, changeDir, ... }`.

## Track format (in `tasks.md`)

```
## N. Track: <kebab-name> (depends: <track>|none)

- [ ] N.Y <task>
```

- Each numbered group is a parallel **Track**; tasks within a track run serially in order.
- Cross-track dependencies go in `depends`, never inside a task line.
- Independent tracks (disjoint files) run in parallel worktrees at apply time.
- `propose` emits a best-effort DRAFT; `apply` corrects it against real file coupling.

## Threshold & fallback

- `APPLY_PARALLEL_THRESHOLD = 12` (in `opsx-apply-tracks.js`, mirrored in `apply.instruction`).
- Below the threshold, or when the Workflow capability is unavailable, apply runs serially —
  the always-correct fallback. Workflow requires a Max/Team/Enterprise plan.

## Boundary

Workflows and project skills are **executors/verifiers of specs**, never decision-makers.
They read/write artifacts and code only; the `openspec` CLI, schema engine, and dependency
graph are not modified.
`research-brief.md` and `verification-report.md` are side-car files, not tracked artifacts —
so the artifact dependency graph is unchanged and existing changes still validate.
