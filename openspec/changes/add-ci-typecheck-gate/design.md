## Context

CI has no strict-`tsc` gate (only `release-please.yml` + `release.yml`; merge is gated by
the transpile-only Docker/vite build). `monorepo-foundation` already specifies the
runnable `turbo typecheck lint build` command; this change adds the missing CI
**enforcement**. Root-cause evidence and the `@types/react`/vaul resolution fragility are
captured in `repo-ci-no-tsc-gate-and-mcp-browsers`.

The non-obvious constraint is **codegen ordering**: a bare `turbo typecheck` fails on a
fresh checkout because two generated inputs are missing:
- `@cap/web` needs `src/routeTree.gen.ts` — gitignored, produced ONLY by the TanStack
  Start vite plugin during `vite build` (no standalone CLI in deps). Without it,
  `resume.tsx`/`workspace.tsx` route types collapse to `never`.
- `@cap/api` needs the generated Prisma client — produced by its `build` script
  (`prisma generate && nest build`). Without it, `PrismaService` members are missing.

Turbo's `typecheck` task only `dependsOn: ["^build"]` (upstream packages), NOT a
package's own `build`, so `turbo typecheck` (or even `turbo typecheck lint build` in one
invocation) can run `@cap/web` typecheck before `@cap/web`'s vite build generates the
route tree — a race.

## Goals / Non-Goals

**Goals:**
- A CI job that fails a PR/push when strict `tsc` or ESLint fails anywhere in the
  workspace, with all codegen prerequisites satisfied.
- Mirror the repo's existing CI conventions (Node 22, pnpm pinned via `packageManager`).

**Non-Goals:**
- No app/runtime change; no `drawer.tsx` edit (its error is not present on current `main`).
- Not making the check **required** in branch protection (a repo setting; follow-up).
- Not committing `routeTree.gen.ts` (keep the generated-file convention; generate in CI).

## Decisions

### D1 — Two-step `turbo build` then `turbo typecheck lint` (codegen before checks)

Run `pnpm turbo build` FIRST (it generates the route tree via `@cap/web` vite build, the
Prisma client via `@cap/api`'s build script, and `@cap/contracts`/`@cap/ui` dist types),
THEN `pnpm turbo typecheck lint`. The separate invocations guarantee every build (hence
every codegen output) completes before any typecheck runs — avoiding the
`typecheck`-races-`build` ordering gap.

- **Verified locally on current `main`**: `turbo build` (5 tasks ok) → `turbo typecheck
  lint` (12 tasks ok). `@cap/web` vite build runs offline with no special env (VITE_*
  bake as undefined; the build output is discarded — only its codegen side effect
  matters).
- **Alternatives considered:**
  - Single `turbo typecheck lint build` — rejected: no edge forces web's own build before
    web's typecheck, so the route tree may be missing when typecheck runs.
  - Add `dependsOn: ["build"]` to the `typecheck` turbo task — rejected: slows every local
    typecheck by forcing a full build first; the CI two-step is scoped to CI.
  - Commit `routeTree.gen.ts` (un-gitignore) — rejected: changes a repo convention and
    adds a sync burden; out of scope.
  - Add `@tanstack/router-cli` for a lighter `tsr generate` — rejected: a new dependency
    for marginal CI time savings; `turbo build` already does it.

### D2 — Triggers, setup, hygiene

- Triggers: `pull_request` (gate PRs) + `push` to `main` (catch direct pushes / post-merge).
- Setup: `actions/checkout@v4`, `pnpm/action-setup@v4` (reads the pinned
  `packageManager: pnpm@10.34.1`), `actions/setup-node@v4` with `node-version: 22` and
  `cache: pnpm`.
- `concurrency` group cancels superseded runs on the same ref; `permissions: contents:
  read` (least privilege — the gate needs no write).

## Risks / Trade-offs

- **[`turbo build` runs a full web vite build → slower CI]** → acceptable (local ~6s with
  warm cache; CI cold build is minutes but bounded). Turbo's remote cache is not
  configured; if CI time becomes a problem, add caching later.
- **[A future codegen step is added but not run before typecheck]** → the two-step
  `turbo build` covers any task wired into the `build` graph; a new codegen outside
  `build` would need adding here. Documented.
- **[The gate is added but not REQUIRED in branch protection]** → it still runs and is
  visible on every PR; making it required is a one-click repo setting (follow-up noted in
  the proposal).

## Open Questions

- None blocking. The build→typecheck sequence is proven locally; CI green is confirmed by
  the workflow running on its own introducing PR.
