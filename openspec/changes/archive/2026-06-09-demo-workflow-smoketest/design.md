## Context

The repository ships its OpenSpec tooling (`.claude/` slash commands, skills, workflows; `openspec/` specs, changes, schema fork) but no contributor-facing entry point: no `README.md`, `CONTRIBUTING.md`, or `docs/`. This change is purely additive documentation — two new Markdown files — that orients new contributors to the Propose → Apply → Archive lifecycle and the repo's two-bucket layout. See `proposal.md` for full motivation and the `contributor-docs` / `repo-layout-docs` specs for requirements.

This is a small, doc-only change with no code, build, or schema impact, so the design is intentionally short.

## Goals / Non-Goals

**Goals:**
- Establish a documented on-ramp before more changes accumulate.
- Keep canonical detail single-sourced: docs cross-link `.claude/workflows/README.md`, the slash commands, skills, and schema rather than restating them.
- Place files where GitHub and contributors expect them (root `CONTRIBUTING.md`; net-new `docs/repo-layout.md`).

**Non-Goals:**
- No `README.md` (out of scope for this change).
- No changes to existing tooling, skills, workflows, schema, or specs — references only.
- No build/CI wiring (none exists in the repo).
- Not duplicating the workflows README content; the docs point to it.

## Decisions

- **Root placement for `CONTRIBUTING.md`** — no `.github/` directory exists, so GitHub auto-surfaces the contribution guide from the repo root. Alternative (`.github/CONTRIBUTING.md`) rejected to avoid creating a near-empty `.github/` tree for a single file.
- **Net-new `docs/` directory for the layout guide** — keeps orientation reference material separate from the actionable contribution guide. Alternative (folding layout into `CONTRIBUTING.md`) rejected: it would bloat the guide and mix "how to contribute" with "how the repo is organized."
- **Cross-link, don't duplicate** — both docs reference `.claude/workflows/README.md`, `.claude/commands/opsx/*.md`, `.claude/skills/*/SKILL.md`, the schema, and `config.yaml` as canonical sources. This avoids drift; the docs describe the model and route readers to the source of truth.
- **Use the live `enhance-openspec-with-workflows` change as the structural example** — the archive is empty, so it is the only available real reference for per-change anatomy and the delta convention.
- **Lowercase-hyphenated file naming** (`repo-layout.md`) to match existing repo convention.

## Risks / Trade-offs

- [Docs drift out of sync with tooling] → Mitigated by cross-linking canonical sources instead of restating them; the docs carry model/orientation, not authoritative detail.
- [Contributors mistake untracked side-car files (`research-brief.md`, `verification-report.md`) for schema dependencies] → Mitigated by an explicit callout in `docs/repo-layout.md`.
- Trade-off: minimal risk overall — both files are net-new (`CONTRIBUTING.md`, `docs/` do not exist today), so there is zero overwrite risk and no build/lint pipeline to integrate with. Rollback is deletion of the two files.
