# Contributing

This repository is developed spec-first using a project-local OpenSpec flow
enhanced with multi-agent Workflow orchestration. Contributions move through a
documented lifecycle rather than ad-hoc pull requests: you propose a change,
generate its artifacts, implement it track-by-track, verify it against its
specs, and archive it.

This guide orients you to that flow and routes you to the real tooling. It
deliberately does **not** restate canonical detail — it links to the source of
truth (`.claude/workflows/README.md`, the slash commands, their backing skills,
and the schema) so the docs cannot drift out of sync.

## Table of Contents

- [The OpenSpec lifecycle](#the-openspec-lifecycle)
- [How to propose a change](#how-to-propose-a-change)
- [Tooling](#tooling)
- [Conventions](#conventions)
- [Track convention](#track-convention)
- [How things run](#how-things-run)

## The OpenSpec lifecycle

Every contribution flows through these five ordered steps:

1. **Propose** — Describe the change you want to make. A new change directory is
   created under `openspec/changes/<change-name>/` with a `proposal.md`.
2. **Create Artifacts** — Generate the supporting artifacts for the change:
   `design.md`, the delta `specs/`, and a track-annotated `tasks.md`.
3. **Implement** — Work through the tasks in `tasks.md`, checking each one off as
   it is completed.
4. **Verify** — Prove every spec requirement is satisfied before the change can
   be archived. Unmet requirements route back to tasks; defects route back to
   design.
5. **Archive** — Once verification passes, finalize the change and move it into
   `openspec/changes/archive/`.

These steps map directly onto the tooling described below.

## How to propose a change

Start a new change with the propose tooling rather than hand-creating files.
This scaffolds the change directory and its initial artifacts in one step. See
[Tooling](#tooling) for the exact entry points, and [Track
convention](#track-convention) for how to author the resulting `tasks.md`.

If you are still figuring out *what* to build, explore first (see
`/opsx:explore` below) before committing to a proposal.

## Tooling

All contribution work goes through four OpenSpec slash commands. Use these
instead of a generic PR flow:

| Slash command   | Phase                       | Backing command file              |
| --------------- | --------------------------- | --------------------------------- |
| `/opsx:explore` | think through ideas first   | `.claude/commands/opsx/explore.md` |
| `/opsx:propose` | Propose + Create Artifacts  | `.claude/commands/opsx/propose.md` |
| `/opsx:apply`   | Implement (+ Verify gate)   | `.claude/commands/opsx/apply.md`   |
| `/opsx:archive` | Archive                     | `.claude/commands/opsx/archive.md` |

The command definitions live under `.claude/commands/opsx/`. Each command is a
thin entry point that invokes a backing skill under `.claude/skills/` — for
example `.claude/skills/openspec-propose/`, `.claude/skills/openspec-apply-change/`,
`.claude/skills/openspec-archive-change/`, and `.claude/skills/openspec-explore/`.
Read the skill's `SKILL.md` for the authoritative behavior of each command.

## Conventions

- **Spec-first** — changes are described in `openspec/changes/` before code is
  written; the specs are the contract that verification checks against.
- **Single-source canonical detail** — these docs link to the source of truth
  rather than copying it, so update the source, not a restatement.
- **Lowercase-hyphenated file names** for net-new files, matching existing repo
  convention.
- **Track-annotated tasks** — `tasks.md` groups work into parallelizable Tracks;
  see the [Track convention](#track-convention) for the exact format.

## Track convention

Tasks in a change's `tasks.md` are grouped into **Tracks**. Independent tracks
run in parallel at apply time; tasks within a track run serially and resume off
the `[x]` checkbox ledger.

A track header takes the form:

```
## N. Track: <name> (depends: <track>|none)
```

where `N` is the track number and `(depends: ...)` declares its dependency on
another track (or `none`). Each task under the header uses the checkbox form:

```
- [ ] N.Y <task description>
```

where `N` is the track number and `Y` is the task's position within the track.
A finished task flips `- [ ]` to `- [x]`.

Do not restate the full rules here — they are canonical in
[`.claude/workflows/README.md`](.claude/workflows/README.md) and enforced by the
schema under [`openspec/schemas/spec-driven/`](openspec/schemas/spec-driven/).
Refer to those when authoring tasks.

## How things run

The slash commands are thin executors; the real orchestration lives in
`.claude/workflows/`. The stock OpenSpec skills remain untouched — project
behavior is layered in through a schema override that points the skills at the
workflow engines.

For the full workflow table, the apply-time parallelism threshold, and the
wiring between the schema override and the orchestration engines, see
[`.claude/workflows/README.md`](.claude/workflows/README.md). It is the source of
truth for how propose, apply, and verify actually execute.
