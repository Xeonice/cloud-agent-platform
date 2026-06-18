<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a
     track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: ci-workflow (depends: none)

- [x] 1.1 Add `.github/workflows/ci.yml`: trigger on `pull_request` + `push` to `main`; one job that runs `actions/checkout@v4` → `pnpm/action-setup@v4` → `actions/setup-node@v4` (node 22, `cache: pnpm`) → `pnpm install --frozen-lockfile` → `pnpm turbo build` → `pnpm turbo typecheck lint`. Add a `concurrency` group (cancel superseded) and `permissions: contents: read`. — written (6 steps, least-priv, concurrency cancel).
- [x] 1.2 Locally reproduce the exact CI sequence on the current `main` base — `pnpm install --frozen-lockfile`, `pnpm turbo build`, `pnpm turbo typecheck lint` — and confirm all tasks pass (build generates routeTree/Prisma/dist; typecheck+lint green). — frozen install ✓; `turbo build` 5/5 ✓ (routeTree+Prisma+dist generated); `turbo typecheck lint` 12/12 ✓; ci.yml structurally valid.
- [ ] 1.3 Verify the workflow YAML is valid and the gate actually runs + concludes green on its own introducing PR (the `pull_request` trigger runs the new workflow on that PR). Note in the PR that marking the check **required** in branch protection is a follow-up repo setting. — pending: confirmed after push when the workflow runs on the PR.
