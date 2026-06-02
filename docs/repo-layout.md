# Repository Layout Guide

An orientation map for this repository. It explains how the codebase is
organized into two top-level buckets, how an individual change is laid out, how
the schema fork works, and where to find the canonical workflow wiring. This
guide carries the *model*; it routes you to the source of truth rather than
restating authoritative detail.

## The two-bucket model

The repository splits into two cooperating buckets: `.claude/` holds the
**agent tooling** (the things that *act*), and `openspec/` holds the
**spec content** (the things being acted on).

```
.
├── .claude/                      # Agent-tooling bucket — slash commands, skills, workflow engines
│   ├── commands/opsx/            #   Slash-command definitions (/opsx:propose, :apply, :archive, :explore)
│   ├── skills/                   #   Backing skills invoked by the commands
│   └── workflows/                #   Orchestration engines (.js) + README (canonical wiring doc)
│
├── openspec/                     # Spec-content bucket — the specs, changes, and schema fork
│   ├── specs/                    #   Current capability specs (the established baseline)
│   ├── changes/                  #   In-flight changes, one directory per change
│   │   └── archive/              #     Completed, archived changes
│   ├── schemas/spec-driven/      #   Project-local schema fork (shadows the built-in schema)
│   └── config.yaml               #   Selects which schema the openspec CLI resolves
│
└── docs/                         # Contributor-facing orientation docs (this guide lives here)
```

Read the buckets as a pipeline: tooling under `.claude/` reads and writes the
spec content under `openspec/`, but never modifies the openspec CLI, schema
engine, or dependency graph.

## Anatomy of a change

Each in-flight change is a directory under `openspec/changes/<change-name>/`.
A change is made of these per-change artifacts:

- `proposal.md` — why the change exists, what it covers, and what it does not.
- `design.md` — the technical decisions, goals/non-goals, and trade-offs.
- `tasks.md` — the Track-annotated, checkbox implementation plan.
- `specs/` — the **requirement deltas**, one `spec.md` per affected capability.

The delta `specs/` directory does not restate the full spec; it records only
the operations applied to the baseline, under these section headers:

- `## ADDED Requirements` — brand-new requirements introduced by the change.
- `## MODIFIED Requirements` — existing requirements whose behavior changes.
- `## REMOVED Requirements` — requirements the change retires.

For a concrete, real structural example, see the live change
`enhance-openspec-with-workflows` under `openspec/changes/` — it demonstrates the
full artifact set and the delta convention in practice.

## The schema fork and rollback path

This repository runs on a **project-local schema fork** at
`openspec/schemas/spec-driven/`. The fork shadows the built-in OpenSpec schema,
which is how the repo layers its Track-aware proposal/apply/verify behavior onto
the stock flow without forking any skill.

Which schema the `openspec` CLI resolves is selected through
`openspec/config.yaml`. When the fork directory is present, it takes precedence;
the config points the CLI at the `spec-driven` schema.

**Rollback path:** delete the `openspec/schemas/spec-driven/` directory. With the
fork gone, the built-in default schema re-resolves automatically and the repo
returns to stock OpenSpec behavior.

## Side-car files (do not wire into the schema)

Two files may appear inside a change directory but are **deliberately untracked
side-car files**, not part of the artifact dependency graph:

- `research-brief.md` — research output produced during the propose phase.
- `verification-report.md` — the verification record produced after apply.

These are intentionally **outside the schema dependency graph** and **must not be
wired into it**. Keeping them out preserves the artifact graph so existing
changes continue to validate. Do not add them as schema artifacts or list them as
dependencies.

## Workflow wiring (canonical source)

The orchestration engines, how they are wired into the schema seams, the
workflow table, and the parallel-apply threshold are all documented in one
canonical place: [`.claude/workflows/README.md`](../.claude/workflows/README.md).

Defer to that README for the full workflow table and the
`APPLY_PARALLEL_THRESHOLD` value rather than relying on this guide — those
details live there as the single source of truth and are intentionally not
duplicated here.
