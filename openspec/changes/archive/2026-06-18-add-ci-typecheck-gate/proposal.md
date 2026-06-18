## Why

The repo's `monorepo-foundation` spec already mandates that `turbo typecheck lint build`
exit 0 only when the tree is type/lint/build clean — but **CI never enforces it**. The
only GitHub Actions workflows are `release-please.yml` and `release.yml`; the de-facto
merge gate is the Docker/vite build, which **only transpiles** (no strict `tsc`). So
strict-`tsc` errors can land on `main` undetected.

This is not hypothetical: while validating an unrelated change we found
`apps/web/src/components/ui/drawer.tsx` failing strict `tsc` (`TS2322`, a vaul/`@types/react`
`React.ComponentProps` resolution fragility) on commit `756f4ee` — and then **silently
disappear on `cea5898`** because an unrelated lockfile change (a new devDep in PR #15)
shifted pnpm's type-peer resolution. A resolution-fragile type error that appears and
vanishes with unrelated dependency churn is exactly what a CI typecheck gate exists to
catch. (Note: `main` is currently strict-`tsc` clean, so the gate passes today; it is
preventive.)

## What Changes

- Add a GitHub Actions workflow (`.github/workflows/ci.yml`) that, on **pull requests**
  and **pushes to `main`**, runs the codegen-aware strict checks:
  1. `pnpm install --frozen-lockfile`
  2. `pnpm turbo build` — generates the codegen prerequisites (`@cap/web` route tree via
     the TanStack Start vite plugin, `@cap/api` Prisma client via its `build` script,
     `@cap/contracts`/`@cap/ui` dist types).
  3. `pnpm turbo typecheck lint` — strict `tsc --noEmit` + ESLint across the workspace.
- This makes the existing `monorepo-foundation` typecheck-lint-build contract
  **enforced by CI**, closing the gap that let resolution-fragile errors slip in.
- **Fix the (silently broken) edit-time hook** `.claude/hooks/typecheck-lint-edited.sh`
  — enforcement point 1 of the same `monorepo-foundation` requirement. It selected the
  owning package with `pnpm --filter "{<absolute path>}"`, which matches **zero** projects
  ("No projects matched the filters"), so on the absolute paths the editor passes it ran
  neither ESLint nor typecheck and always exited 0 — a silent no-op that never caught
  anything. Fix: filter by a **repo-root-relative** package path and pass the file to
  ESLint as an **absolute** path. Verified to now exit non-zero and surface the error on a
  type error and on a lint error (incl. `debugger`).
- No application/runtime code changes; no change to the `drawer.tsx` source (the live
  error it exhibited on `756f4ee` is not present on current `main`).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `monorepo-foundation`: add a requirement that **CI enforces** the strict
  typecheck-lint-build gate on changes; and strengthen the existing "Strict-TypeScript
  enforced in three places" requirement so enforcement point 1 (the edit-time hook)
  **actually runs** the checks rather than silently selecting zero packages.

## Impact

- **New file**: `.github/workflows/ci.yml` (CI only; no app code).
- **Modified file**: `.claude/hooks/typecheck-lint-edited.sh` (the edit-time hook fix —
  relative `pnpm --filter` path + absolute file path for ESLint).
- **Verified locally** on current `main`: `pnpm turbo build` then
  `pnpm turbo typecheck lint` → all tasks green; the fixed hook → exit 0 on clean files
  (absolute & relative), exit 2 + surfaced error on a type error and on a `debugger`/lint
  error.
- **Follow-up (out of scope)**: marking the new check **required** in branch protection
  is a repository setting the maintainer flips; this change only adds the workflow.
