# Research Brief: CONTRIBUTING.md + docs/repo-layout.md

A documentation-only, net-new change adding a root `CONTRIBUTING.md` and a `docs/repo-layout.md` guide to the cloud-agent-platform repository. Findings below are grouped by research route (Web / Codebase / Archive), with each finding attributed to its route, followed by implications for the proposal.

## Web

- **GitHub officially supports `CONTRIBUTING.md` in three locations** — repo root, `.github/`, or `docs/` — and auto-surfaces a "Contribute" banner/link when present. Precedence when duplicated is `.github` > root > `docs`. Source: https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors
  - Validates root placement as proposed. The repo has no `.github/`, so root placement is correct and GitHub will auto-link it.

- **Recommended `CONTRIBUTING.md` sections** per widely-cited guides: how to propose a change / open issues, the PR workflow, coding/commit conventions, how to run tests, a table of contents for long files, and a pointer to a Code of Conduct. Sources: https://contributing.md/how-to-build-contributing-md/ and https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors
  - Gives a concrete section checklist. For this repo, the "how to propose/apply changes" section should map onto the OpenSpec `/opsx:propose` → `/opsx:apply` → `/opsx:archive` flow rather than a generic PR-only flow.

- **OpenSpec (Fission-AI) separates `openspec/specs/`** (source of truth for current behavior) from `openspec/changes/` (self-contained proposed changes), with completed changes moved to `openspec/changes/archive/` with a date prefix. Source: https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md
  - Authoritative prior art for `repo-layout.md`. The doc should describe `openspec/specs`, `openspec/changes`, `openspec/changes/archive`, plus this repo's `openspec/schemas/spec-driven` and `openspec/config.yaml` which extend stock OpenSpec.

- **OpenSpec's documented contribution lifecycle is a five-step flow**: Propose → Create Artifacts (proposal.md → specs/ → design.md → tasks.md, schema-ordered) → Implement (check off tasks) → Verify → Archive (delta specs merge into main specs). Sources: https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md and https://openspec.pro/workflow/
  - The "how to propose and apply changes" part of `CONTRIBUTING.md` should mirror this lifecycle and reference the repo's `.claude/skills` (openspec-propose, openspec-apply-change, openspec-archive-change) and `.claude/commands/opsx` slash commands so contributors invoke the real tooling.

- **A change folder is self-contained**: `proposal.md` (intent/scope), `design.md` (technical approach), `tasks.md` (checklist), and delta `specs/` using `## ADDED/MODIFIED/REMOVED Requirements` headings so parallel changes don't conflict. Source: https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md
  - `repo-layout.md` should document per-change file anatomy and the ADDED/MODIFIED/REMOVED delta convention. The existing `openspec/changes/enhance-openspec-with-workflows/` already follows this and can be cited as a live example.

- **Community guidance**: use the README as the entry point, keep the rest in a `/docs` folder with clear section names, and add a "Repository Structure" section listing each top-level folder with a one-line purpose. Sources: https://dev.to/mochafreddo/how-to-manage-documentation-in-a-github-repository-a-guide-for-junior-developers-pgo and https://github.com/kriasoft/Folder-Structure-Conventions/blob/master/README.md
  - Supports the proposed `docs/repo-layout.md` location and an annotated directory-tree format. The kriasoft repo is a reusable template for the annotated-tree style.

- **Repo-layout doc conventions**: a mirrored docs tree, lowercase-hyphenated names for non-code files, and dot-prefixed folders for tooling/config (e.g. `.github`, `.claude`) — distinguishing tooling dirs from content dirs. Sources: https://github.com/akobr/mono.me/blob/main/docs/Monorepo/structure.md and https://github.com/kriasoft/Folder-Structure-Conventions
  - Gives a naming rationale the guide can state explicitly: `.claude/` is dot-prefixed because it is agent tooling/config, while `openspec/` holds the project's spec content — a clean two-bucket mental model.

- **Repo current state (web-route file listing)**: NO `CONTRIBUTING.md`, NO `docs/` directory; root contains only `.gitignore`, `.claude/`, and `openspec/`. Existing docs are limited to `.claude/workflows/README.md`. Evidence: root listing + find for the sole README.
  - Confirms the change is net-new and self-contained with no build impact. New docs should cross-link `.claude/workflows/README.md` rather than duplicate it, and document `.claude/` (commands/opsx, skills, workflows) and `openspec/` (specs, changes, changes/archive, schemas/spec-driven, config.yaml) as the two top-level areas.

## Codebase

- **No existing docs to reconcile**: NO `README.md`, NO `CONTRIBUTING.md`, NO `docs/` directory. Top-level entries are only `.claude/`, `openspec/`, `.gitignore`, `.git/`. Both target files are net-new; `docs/` must be created. Evidence: `ls` of repo root.
  - Confirms the change is purely additive and self-contained — no existing documentation to supersede.

- **Canonical architecture doc already exists** at `.claude/workflows/README.md`. It documents the two-layer wiring (stock skills → schema override → `.claude/workflows/*.js`), the three-workflows table, the Track format, the `APPLY_PARALLEL_THRESHOLD=12` fallback, and the executor-not-decision-maker boundary. Evidence: `.claude/workflows/README.md:1-59` (wiring diagram :9-20, workflows table :27-31, Track format :37-46, threshold :50-52).
  - `docs/repo-layout.md` and `CONTRIBUTING.md` should reuse and link to this rather than duplicate it; it already explains the `openspec/` + `.claude/` relationship.

- **The propose/apply flow is driven by slash commands and skills**: propose → (specs/design/tasks) → apply → verify → archive. Entry points are `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, `/opsx:explore` (in `.claude/commands/opsx/*.md`) backed by skills in `.claude/skills/*/SKILL.md`. Evidence: `.claude/commands/opsx/{propose,apply,archive,explore}.md`; `.claude/skills/{openspec-propose,openspec-apply-change,openspec-archive-change,openspec-explore}/SKILL.md`; `propose.md:15` "When ready to implement, run /opsx:apply".
  - This is the exact "how to propose and apply changes" workflow `CONTRIBUTING.md` must document; cite these command/skill files as contributor entry points.

- **Change lifecycle layout**: lives under `openspec/changes/<name>/` with `proposal.md`, `design.md`, `tasks.md`, and per-capability `specs/<cap>/spec.md`; completed changes move to `openspec/changes/archive/` (currently empty). A scaffolded change carries a `.openspec.yaml` (see `demo-workflow-smoketest`). `openspec/specs/` holds the deployed/source-of-truth specs (currently empty). Evidence: `openspec/changes/enhance-openspec-with-workflows/` contents; empty archive; `openspec/changes/demo-workflow-smoketest/.openspec.yaml`; empty `openspec/specs/`.
  - `docs/repo-layout.md` must describe `changes/`, `archive/`, `specs/`, and `schemas/` so contributors know where artifacts go through the lifecycle.

- **Customization via a project-local schema fork** at `openspec/schemas/spec-driven/schema.yaml` (created by `openspec schema fork spec-driven spec-driven`), which shadows the built-in schema and defines the artifact pipeline (proposal→specs→design→tasks with `requires:` edges) plus the apply two-stage instruction. Templates live in `openspec/schemas/spec-driven/templates/{proposal,design,spec,tasks}.md`. `openspec/config.yaml` selects `schema: spec-driven`. Evidence: `schema.yaml:1-294` (requires graph, apply STAGE 1/STAGE 2 at :264-294); templates dir; `config.yaml:1`; `README.md:22` fork command + rollback note.
  - The guide must explain `openspec/schemas/` and `config.yaml` so contributors understand how the pipeline is configured/extended — and the rollback path (delete the schema dir).

- **The Track format is the key tasks.md convention**, documented in two authoritative places to reference: the schema's tasks instruction and the workflows README. Format: `## N. Track: <kebab-name> (depends: <track>|none)` with `- [ ] N.Y <task>` checkboxes; tasks within a track run serially, independent tracks run in parallel worktrees at apply. Evidence: `schema.yaml:214-255` (TRACK FORMAT + example); `.claude/workflows/README.md:37-46`.
  - `CONTRIBUTING.md` should point contributors to this exact format so apply-time parallelism and the `[x]` ledger resume work correctly.

- **No build impact**: `.gitignore` only excludes `node_modules/` and `.DS_Store`; no `package.json`, build script, CI config, or lockfile anywhere. Evidence: `.gitignore` (2 lines); no package.json/CI found.
  - Validates the documentation-only, no-build-impact claim; the new files need no wiring into any build/lint pipeline.

- **Side-car file convention worth documenting**: `research-brief.md` (written by propose/opsx-propose-deep) and `verification-report.md` (written by opsx-verify) are deliberately NOT tracked OpenSpec artifacts, so the dependency graph stays unchanged. Boundary principle: "Workflows are executors/verifiers of specs, never decision-makers." Evidence: `.claude/workflows/README.md:55-59`; `schema.yaml:10-19`; `proposal.md:27`.
  - `repo-layout.md` should note these side-car files so contributors don't mistake them for tracked artifacts or add them to the schema graph.

## Archive

- **The OpenSpec archive directory is completely empty** — only the directory itself exists, no subfolders or files. Evidence: `openspec/changes/archive` (`find -mindepth 1` returns nothing).
  - No prior documentation-only change exists to mirror; this change must follow the repo's general OpenSpec conventions instead.

- **Git history confirms no change has ever been archived** (no commits touch `openspec/changes/archive/**`). Evidence: `git log --oneline --all -- 'openspec/changes/archive/**'` empty; only commit is `dea5928 baseline`.
  - The empty archive is not a working-tree artifact; the archive workflow has never run, so there is no historical template to copy.

- **Only in-flight (non-archived) changes serve as structural references**: `enhance-openspec-with-workflows` (has `design.md`, `tasks.md`, `specs/`) and `demo-workflow-smoketest` (only a `.openspec.yaml`). Evidence: the two `openspec/changes/` subfolders.
  - Model the proposal artifacts (`proposal.md`, `tasks.md`, optional `design.md`) on the active `enhance-openspec-with-workflows` change, since no archived precedent exists.

## Implications for the proposal

1. **Placement is confirmed correct.** `CONTRIBUTING.md` belongs at the repo root (Web: GitHub auto-links it; no `.github/` exists), and `docs/repo-layout.md` belongs in a net-new `docs/` directory (Web + Codebase: no `docs/` exists today). Both files are net-new — zero risk of overwriting and zero build impact (Codebase: no package.json/CI/lockfile; Archive: no precedent to overwrite either).

2. **`CONTRIBUTING.md` must document the real OpenSpec flow, not a generic PR flow.** Map the "how to propose and apply changes" section onto the five-step lifecycle Propose → Artifacts → Implement → Verify → Archive (Web), and route contributors to the actual tooling: `/opsx:propose` → `/opsx:apply` → `/opsx:archive` slash commands in `.claude/commands/opsx/*.md` and the backing skills in `.claude/skills/*/SKILL.md` (Codebase). Include the standard checklist sections (how to propose, conventions, how things run, ToC for length) adapted to this tooling.

3. **`CONTRIBUTING.md` must surface the Track format convention** for authoring `tasks.md` (`## N. Track: <name> (depends: ...)` with `- [ ] N.Y` checkboxes), pointing to `schema.yaml:214-255` and `.claude/workflows/README.md:37-46`, so apply-time parallelism and resume work correctly (Codebase).

4. **`docs/repo-layout.md` should adopt an annotated directory-tree with a two-bucket mental model**: `.claude/` (dot-prefixed agent tooling/config: `commands/opsx`, `skills`, `workflows`) vs `openspec/` (project spec content: `specs`, `changes`, `changes/archive`, `schemas/spec-driven`, `config.yaml`) (Web naming rationale + Codebase structure). Use lowercase-hyphenated file naming.

5. **`docs/repo-layout.md` must explain the change anatomy and delta convention**: per-change `proposal.md`/`design.md`/`tasks.md` plus delta `specs/` using `## ADDED/MODIFIED/REMOVED Requirements` headings (Web), and the `openspec/schemas/spec-driven/` fork + `config.yaml` configuration with the delete-the-dir rollback path (Codebase). Cite `enhance-openspec-with-workflows` as the live example (Codebase + Archive: it is the only structural reference available).

6. **Avoid duplication — cross-link, don't copy.** Both docs should reference the canonical `.claude/workflows/README.md` (wiring, workflows table, threshold, boundary) rather than restate it (Codebase).

7. **Call out the side-car files** (`research-brief.md`, `verification-report.md`) as deliberately untracked, so contributors don't add them to the schema dependency graph (Codebase).

8. **Model this change's own proposal artifacts on the active in-flight change**, not on an archived precedent — none exists (Archive). Follow `enhance-openspec-with-workflows`'s `proposal.md` / `tasks.md` / optional `design.md` shape.
