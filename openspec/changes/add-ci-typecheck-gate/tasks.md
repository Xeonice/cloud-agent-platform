<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a
     track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: ci-workflow (depends: none)

- [x] 1.1 Add `.github/workflows/ci.yml`: trigger on `pull_request` + `push` to `main`; one job that runs `actions/checkout@v4` → `pnpm/action-setup@v4` → `actions/setup-node@v4` (node 22, `cache: pnpm`) → `pnpm install --frozen-lockfile` → `pnpm turbo build` → `pnpm turbo typecheck lint`. Add a `concurrency` group (cancel superseded) and `permissions: contents: read`. — written (6 steps, least-priv, concurrency cancel).
- [x] 1.2 Locally reproduce the exact CI sequence on the current `main` base — `pnpm install --frozen-lockfile`, `pnpm turbo build`, `pnpm turbo typecheck lint` — and confirm all tasks pass (build generates routeTree/Prisma/dist; typecheck+lint green). — frozen install ✓; `turbo build` 5/5 ✓ (routeTree+Prisma+dist generated); `turbo typecheck lint` 12/12 ✓; ci.yml structurally valid.
- [x] 1.3 Verify the workflow YAML is valid and the gate actually runs + concludes green on its own introducing PR (the `pull_request` trigger runs the new workflow on that PR). Note in the PR that marking the check **required** in branch protection is a follow-up repo setting. — PR #17's `typecheck + lint` check ran via the `pull_request` trigger and concluded **success (47s)**.

## 2. Track: fix-edit-time-hook (depends: none)

- [x] 2.1 Fix `.claude/hooks/typecheck-lint-edited.sh`: it selected the owning package with `pnpm --filter "{$PKG_DIR}"` where `PKG_DIR` is absolute on the editor's absolute paths → matches zero projects → silent no-op (never ran ESLint/typecheck). Filter by a repo-root-relative package path (`REL_PKG="${PKG_DIR#"$ROOT"/}"`) and pass the file to ESLint as an absolute path. — done.
- [x] 2.2 Verify the fixed hook across the matrix in a minimal (non-interactive-like) shell env: clean `.ts` absolute → exit 0; clean `.ts` relative → exit 0; a type-error probe → exit 2 + `TS2322` surfaced; a `debugger` probe → exit 2 + `no-debugger` surfaced; probes deleted, no residue. — all confirmed.
