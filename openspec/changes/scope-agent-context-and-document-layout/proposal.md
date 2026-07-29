## Why

Three questions this repository cannot currently answer, each for a different
reader:

**An agent working here has no scope.** There is no `CLAUDE.md` or `AGENTS.md`
anywhere in the tree — not one. An agent opening this repository faces 16
packages, 908 source files, 270,676 lines, with nothing saying which subtree owns
what or where a given task's boundaries are. A search for `runtime` returns hits
in 228 api files, 58 web files, 36 contracts files, and 22 sandbox files, and
nothing distinguishes the one the task is about from the three it is not. This is
the concrete form of the context bleed that motivates the repo-split epic — and it
is the part of that problem that needs no split to fix.

**A self-hoster cannot tell what to run.** `docs/repo-layout.md` exists but
documents the `.claude/` and `openspec/` tooling buckets; about `apps/` and
`packages/` — the actual product — it says nothing. So the fact that the console
is optional (`docker-compose.prod.yml` already puts `web` behind
`profiles: ["web"]`, with the core unit being api + Postgres) is discoverable only
by reading compose comments.

**CI runs everything for every change.** `ci.yml` has six jobs and no `paths`
filter and no job-level condition, so editing a markdown file starts Postgres
twice and boots the full api. The last run cost 12.2 runner-minutes, of which
5.2 — `public-surface-parity`, `task model N-1 compatibility`, `task admission
migration compatibility`, `boot-smoke` — exercise api and database paths that a
docs-only or web-only change cannot affect.

The three share one shape: **nothing in the repository says what belongs to what**,
so every reader — human, agent, or CI — is handed the whole thing.

## What Changes

- **Each subtree states its own boundary.** Per-directory instructions for
  `apps/api`, `apps/web`, `packages/contracts`, and `packages/sandbox`, each
  saying what the subtree is, what it may depend on, what belongs elsewhere, and
  how to verify a change to it.
- **The product layout is documented** alongside the existing tooling layout:
  which packages exist, which are deployment units, which are optional, and what
  a self-hoster actually needs to run.
- **CI runs what a change affects.** Jobs that exercise only api and database
  paths stop running on changes that cannot reach them.

Not breaking: no source, API, database, or environment-variable changes. CI gains
conditions; it loses no coverage for the changes that need it.

## Capabilities

### New Capabilities

- `agent-workspace-scoping`: per-directory instructions that bound what an agent
  working in a subtree needs to know and may touch. New because nothing covers it
  today — the repository has never carried directory-scoped agent instructions.

### Modified Capabilities

- `repo-layout-docs`: the orientation guide currently covers only the agent
  tooling and spec buckets; it gains the product layout — packages, deployment
  units, and what is optional.
- `monorepo-foundation`: the CI gate is required to run the jobs a change can
  affect rather than every job for every change.

## Impact

**New files**

| file | purpose |
|---|---|
| `apps/api/CLAUDE.md` | NestJS orchestrator: 454 files; guardrails, admission, sandbox port |
| `apps/web/CLAUDE.md` | TanStack Start console: 230 files; consumes contracts, never api internals |
| `packages/contracts/CLAUDE.md` | the shared protocol; the one package both sides depend on |
| `packages/sandbox/CLAUDE.md` | provider implementations behind one port |
| `docs/product-layout.md` | the product-side counterpart to `docs/repo-layout.md` |

**Modified** — `.github/workflows/ci.yml` (job conditions), and
`docs/repo-layout.md` (a cross-link to its new sibling).

**Verification** — the CI change is the one that can silently reduce coverage: a
condition that never matches turns a job into a no-op that reports success.
Acceptance therefore requires demonstrating, per job, both that it runs when it
should and that it is skipped when it should be — not merely that the workflow
parses.

**Relationship to the split** — these files are what each sub-repository will
carry after the epic's Phase 3, so this is not throwaway work. It is also the
change that tests the epic's premise: if scoping and documentation remove most of
the pain, the later phases should be re-evaluated on that evidence rather than on
the original assumption.

**Non-Goals**

1. Splitting the repository, publishing anything, or changing any package name.
2. A root `CLAUDE.md`. The complaint is about scope, and a root file that
   describes everything is the situation being fixed.
3. Rewriting `docs/repo-layout.md`'s existing content. It documents the tooling
   buckets correctly; it gains a sibling, not a rewrite.
4. Reducing what CI verifies for changes that do reach api or database paths.
