## Why

The repository has no `README.md`, no `CONTRIBUTING.md`, and no `docs/` directory — new contributors have no documented entry point for how the project is organized or how to propose and apply changes through its OpenSpec tooling. Without guidance, contributors will fall back on a generic PR-only mental model and miss the actual Propose → Apply → Archive lifecycle that this repo is built around. Adding contributor docs now establishes that on-ramp before more changes accumulate.

## What Changes

- Add a root `CONTRIBUTING.md` documenting how to contribute. GitHub auto-surfaces it from the repo root (no `.github/` exists, so root placement is correct).
  - Map the "how to propose and apply changes" section onto the real five-step OpenSpec lifecycle: Propose → Create Artifacts → Implement → Verify → Archive.
  - Route contributors to the actual tooling: the `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, `/opsx:explore` slash commands (`.claude/commands/opsx/*.md`) and their backing skills (`.claude/skills/*/SKILL.md`).
  - Surface the Track format convention for authoring `tasks.md` (`## N. Track: <name> (depends: ...)` with `- [ ] N.Y` checkboxes), pointing to the schema and workflows README rather than restating them, so apply-time parallelism and resume work correctly.
  - Include the standard contributor-guide checklist sections (how to propose, conventions, how things run) adapted to this tooling, with a table of contents.
- Add a net-new `docs/repo-layout.md` orientation guide.
  - Use an annotated directory tree with a two-bucket mental model: `.claude/` (dot-prefixed agent tooling/config: `commands/opsx`, `skills`, `workflows`) versus `openspec/` (project spec content: `specs`, `changes`, `changes/archive`, `schemas/spec-driven`, `config.yaml`). Use lowercase-hyphenated file naming.
  - Explain the per-change anatomy (`proposal.md` / `design.md` / `tasks.md` plus delta `specs/`) and the `## ADDED/MODIFIED/REMOVED Requirements` delta convention, citing `enhance-openspec-with-workflows` as the live example (the only structural reference available — the archive is empty).
  - Explain the `openspec/schemas/spec-driven/` schema fork plus `config.yaml` selection, including the delete-the-directory rollback path.
  - Call out the deliberately untracked side-car files (`research-brief.md`, `verification-report.md`) so contributors do not add them to the schema dependency graph.
- Both docs cross-link the canonical `.claude/workflows/README.md` (wiring, workflows table, threshold, executor-not-decision-maker boundary) instead of duplicating it.

## Capabilities

### New Capabilities
- `contributor-docs`: The root `CONTRIBUTING.md` contribution guide, defining how contributors propose, apply, verify, and archive changes via the OpenSpec slash commands/skills and the Track-format `tasks.md` convention.
- `repo-layout-docs`: The `docs/repo-layout.md` orientation guide, defining the annotated repository structure, the `.claude/` vs `openspec/` two-bucket model, per-change artifact anatomy and delta convention, schema-fork configuration, and the untracked side-car file callouts.

### Modified Capabilities
<!-- None. openspec/specs/ is empty; this change is purely additive and modifies no existing requirements. -->

## Impact

- New files only: `CONTRIBUTING.md` (repo root) and `docs/repo-layout.md` (in a net-new `docs/` directory). Zero risk of overwriting — neither file nor `docs/` exists today.
- No build impact: `.gitignore` excludes only `node_modules/` and `.DS_Store`; there is no `package.json`, build script, CI config, or lockfile anywhere, so the new docs need no wiring into any build/lint pipeline.
- Documentation references (not modifications) to existing assets: `.claude/workflows/README.md`, `.claude/commands/opsx/*.md`, `.claude/skills/*/SKILL.md`, `openspec/schemas/spec-driven/`, `openspec/config.yaml`, and the `enhance-openspec-with-workflows` change as a live example.
