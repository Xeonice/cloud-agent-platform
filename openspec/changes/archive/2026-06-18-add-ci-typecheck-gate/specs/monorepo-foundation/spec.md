## ADDED Requirements

### Requirement: CI enforces the strict typecheck-lint gate

The repository SHALL run a GitHub Actions workflow on pull requests and on pushes to
`main` that performs the workspace strict typecheck and lint with all codegen
prerequisites generated first, and reports failure (non-zero) when any workspace member
has a type or lint error. The merge gate MUST NOT rely solely on the transpile-only
Docker/vite build.

#### Scenario: Pull request runs the typecheck-lint gate

- **WHEN** a pull request is opened or updated
- **THEN** a CI job installs dependencies with a frozen lockfile, runs `turbo build`
  (generating the `@cap/web` route tree, the `@cap/api` Prisma client, and the
  `@cap/contracts`/`@cap/ui` dist types), then runs `turbo typecheck lint`
- **AND** the job's conclusion is success only when strict `tsc --noEmit` and ESLint pass
  across the whole workspace

#### Scenario: A type or lint error fails the gate

- **WHEN** a workspace member contains a strict `tsc` type error or an ESLint error and
  the CI job runs
- **THEN** the job concludes with a non-zero (failure) status, surfacing the error on the
  pull request — so a transpile-only build can no longer let it merge silently

#### Scenario: Codegen prerequisites are generated before typecheck

- **WHEN** the CI job runs on a fresh checkout (no committed `routeTree.gen.ts`, no
  generated Prisma client)
- **THEN** `turbo build` runs before `turbo typecheck`, so the route tree and Prisma
  client exist when typecheck runs and route/Prisma types do not spuriously fail

## MODIFIED Requirements

### Requirement: Strict-TypeScript enforced in three places
The repository SHALL enforce strict TypeScript in three independent enforcement points: a `strict: true` base `tsconfig`, repository Claude Code hooks in `.claude/settings.json` that run a typecheck and lint on edited TypeScript, and a husky pre-commit hook running lint-staged.

#### Scenario: Base tsconfig enables strict mode
- **WHEN** the shared base `tsconfig` in `packages/tsconfig` is inspected
- **THEN** `compilerOptions.strict` is set to `true`

#### Scenario: Claude Code hooks gate edited TypeScript
- **WHEN** `.claude/settings.json` is inspected
- **THEN** it defines a hook that runs a TypeScript typecheck and an ESLint check on edited `.ts`/`.tsx` files

#### Scenario: The edit-time hook actually runs the checks (not a silent no-op)
- **WHEN** the edit-time hook fires for an edited `.ts`/`.tsx` file using the **absolute** path the editor passes
- **THEN** it resolves the owning workspace package via a path the `pnpm --filter` selector actually matches (a repo-root-relative path — an absolute path matches no projects), runs ESLint on the file plus the package typecheck, and exits non-zero with the surfaced error when a type or lint error is present — it MUST NOT silently pass by selecting zero packages

#### Scenario: Pre-commit hook runs lint-staged
- **WHEN** a commit is attempted with husky installed
- **THEN** the husky pre-commit hook invokes lint-staged against staged files
