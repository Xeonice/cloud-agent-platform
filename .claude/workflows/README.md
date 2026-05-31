# OpenSpec × Claude Code Workflows

This repo enhances the stock OpenSpec flow with multi-agent Workflow orchestration
at three seams — **without forking any OpenSpec skill**. All behavior changes live
in a project-local schema override; the three `.js` files here are the engines it calls.

## How it's wired (two layers)

```
Stock skills (openspec-propose / apply / archive)   ← UNTOUCHED, generic executors
        │ call `openspec instructions <id>`
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
Rollback = delete `openspec/schemas/spec-driven/` (built-in re-resolves) + remove these files.

## The three workflows

| File | Slash command | Phase | What it does |
|---|---|---|---|
| `opsx-propose-deep.js` | `/opsx-propose-deep` | propose | Parallel research fan-out (web + codebase + archive) → `research-brief.md`, then testable specs + Track-annotated tasks |
| `opsx-apply-tracks.js` | `/opsx-apply-tracks` | apply | Correct track partition → parallel worktree-isolated tracks (≤16) → integration merge → build verify + bounded repair. Idempotent resume via `[x]` ledger |
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

Workflows are **executors/verifiers of specs**, never decision-makers. They read/write
artifacts and code only; the `openspec` CLI, schema engine, and dependency graph are not modified.
`research-brief.md` and `verification-report.md` are side-car files, not tracked artifacts —
so the artifact dependency graph is unchanged and existing changes still validate.
