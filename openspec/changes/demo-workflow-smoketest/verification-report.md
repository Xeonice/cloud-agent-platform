# Verification Report: demo-workflow-smoketest

Status: PASS — 11/11 requirements met, 0 unmet, 0 spec-defects.

Deliverables exist and are non-empty:
- `CONTRIBUTING.md` (repository root, 5203 bytes)
- `docs/repo-layout.md` (4686 bytes; `docs/` directory created by this change)

## Met Requirements

### Capability: contributor-docs

#### Root CONTRIBUTING.md exists and is GitHub-discoverable — MET
- Evidence: `CONTRIBUTING.md` present at repository root (not under `.github/` or any subdirectory), non-empty at 5203 bytes.

#### Guide documents the five-step OpenSpec lifecycle — MET
- Evidence: `CONTRIBUTING.md` lifecycle section contains the literal labels `Propose`, `Create Artifacts`, `Implement`, `Verify`, `Archive` in that top-to-bottom order.

#### Guide routes contributors to the actual OpenSpec tooling — MET
- Evidence: all four slash commands `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, `/opsx:explore` appear; path references to `.claude/commands/opsx/` and to the backing skills under `.claude/skills/` are present.

#### Guide documents the Track format convention for tasks.md — MET
- Evidence: `CONTRIBUTING.md` shows the track header form `## N. Track: <name>` with the `(depends: ...)` annotation and the task checkbox form `- [ ] N.Y`; links to `.claude/workflows/README.md` and the schema under `openspec/schemas/spec-driven/` rather than restating them.

#### Guide includes standard contributor sections and a table of contents — MET
- Evidence: a table of contents near the top with 6 anchor links; headings for "How to propose a change", "Conventions", and "How things run" are present.

### Capability: repo-layout-docs

#### docs/repo-layout.md exists in a new docs directory — MET
- Evidence: `docs/repo-layout.md` present at the expected path, non-empty at 4686 bytes; `docs/` directory created.

#### Guide presents an annotated directory tree with the two-bucket model — MET
- Evidence: tree references `.claude/` (`commands/opsx`, `skills`, `workflows`) and `openspec/` (`specs`, `changes`, `changes/archive`, `schemas/spec-driven`, `config.yaml`); filename `repo-layout.md` is lowercase-hyphenated.

#### Guide explains per-change anatomy and the delta convention — MET
- Evidence: names `proposal.md`, `design.md`, `tasks.md`, and the delta `specs/` directory; names the `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements` delta operations; cites `enhance-openspec-with-workflows` as the live example.

#### Guide explains the schema fork and rollback path — MET
- Evidence: references `openspec/schemas/spec-driven/`, the `openspec/config.yaml` selection mechanism, and the delete-the-directory rollback path.

#### Guide calls out untracked side-car files — MET
- Evidence: names `research-brief.md` and `verification-report.md`, stating they are intentionally outside the schema dependency graph and must not be wired into it.

#### Guide cross-links the canonical workflows README — MET
- Evidence: contains a link to `.claude/workflows/README.md` and defers to it for the workflow table and threshold rather than restating them.

## Gap Check (missing implementation)

No gaps. Every requirement across both spec files traces to concrete content in the implemented files, and every cited path exists in the repository. Both deliverable files exist, are non-empty, and the `docs/` directory was created. All 11 requirements are traceable to implemented content; no requirement lacks a traceable implementation.

## Scope Check (out-of-scope / unrequired behavior)

The following are minor documentation embellishments not traced to any requirement. They are non-blocking (doc-only additions, no behavioral surface) but are recorded for completeness:

1. `CONTRIBUTING.md:48-49` — adds explore-first guidance ("If you are still figuring out what to build, explore first"); specs only require the four slash-command strings to appear, not workflow advice on when to explore.
2. `docs/repo-layout.md:29` — adds a `docs/` bucket entry in the directory tree; the two-bucket-model requirement only mandates the `.claude/` and `openspec/` buckets and their listed subdirs.
3. `docs/repo-layout.md:32-34` — adds a "pipeline" reading model and the claim that tooling "never modifies the openspec CLI, schema engine, or dependency graph"; no requirement asks for this directional/invariant statement.
4. `docs/repo-layout.md:92-93` — names the literal `APPLY_PARALLEL_THRESHOLD` env var; the cross-link requirement only says to defer to the README for the threshold, not to name the variable.
5. `CONTRIBUTING.md:109-112` — "How things run" asserts that "stock OpenSpec skills remain untouched" and that behavior is layered via a schema override; no contributor-docs requirement specifies this implementation claim (it is only required to cross-link the README).
