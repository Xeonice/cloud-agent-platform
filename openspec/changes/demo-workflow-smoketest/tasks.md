<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contributing-guide (depends: none)

- [x] 1.1 Create non-empty `CONTRIBUTING.md` at the repository root (not under `.github/` or any subdirectory)
- [x] 1.2 Add a table of contents near the top with at least three anchor links to the document's sections
- [x] 1.3 Document the five-step OpenSpec lifecycle with the literal labels `Propose`, `Create Artifacts`, `Implement`, `Verify`, `Archive` appearing in that top-to-bottom order
- [x] 1.4 Add a tooling section naming all four slash commands `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, `/opsx:explore`, with path references to `.claude/commands/opsx/` and the backing skills under `.claude/skills/`
- [x] 1.5 Add a Track convention section showing the header form `## N. Track: <name>` with the `(depends: ...)` annotation and the task checkbox form `- [ ] N.Y`, linking to `.claude/workflows/README.md` and the schema under `openspec/schemas/spec-driven/` rather than restating them
- [x] 1.6 Add the standard contributor-guide sections: a heading for how to propose a change, a heading for conventions, and a heading for how things run

## 2. Track: repo-layout-guide (depends: none)

- [x] 2.1 Create the `docs/` directory and a non-empty `docs/repo-layout.md` orientation guide using a lowercase-hyphenated filename
- [x] 2.2 Add an annotated directory tree with the two-bucket model: `.claude/` (with `commands/opsx`, `skills`, `workflows`) versus `openspec/` (with `specs`, `changes`, `changes/archive`, `schemas/spec-driven`, `config.yaml`)
- [x] 2.3 Add a per-change anatomy section naming `proposal.md`, `design.md`, `tasks.md`, and the delta `specs/` directory, plus the `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements` delta operations, citing `enhance-openspec-with-workflows` as the live example
- [x] 2.4 Add a schema section referencing `openspec/schemas/spec-driven/`, the `openspec/config.yaml` selection mechanism, and the delete-the-directory rollback path
- [x] 2.5 Add a side-car callout naming `research-brief.md` and `verification-report.md`, stating they are intentionally outside the schema dependency graph and must not be wired into it
- [x] 2.6 Cross-link `.claude/workflows/README.md`, deferring to it for the workflow table and threshold instead of duplicating them
