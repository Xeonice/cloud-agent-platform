# monorepo-foundation Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Greenfield pnpm + Turborepo workspace
The system SHALL be a single pnpm + Turborepo workspace authored from scratch, containing a root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, and a lockfile, with the workspace globs resolving the apps `apps/api`, `apps/web`, `apps/runner` and the packages `packages/contracts`, `packages/ui`, `packages/tsconfig`, `packages/eslint-config`.

#### Scenario: Workspace resolves all apps and packages
- **WHEN** `pnpm install` is run at the repo root
- **THEN** `pnpm-workspace.yaml` resolves the six workspace members `apps/api`, `apps/web`, `apps/runner`, `packages/contracts`, `packages/ui`, `packages/eslint-config`
- **AND** a lockfile is produced at the repo root and `pnpm -r ls` lists every workspace member without an unmet-dependency error

#### Scenario: Required root config files exist
- **WHEN** the repository is inspected at its root
- **THEN** `package.json`, `pnpm-workspace.yaml`, and `turbo.json` all exist and parse without syntax error

### Requirement: contracts package is the single source of truth
The `packages/contracts` package SHALL export zod schemas together with their inferred TypeScript types, and `apps/api`, `apps/web`, and `apps/runner` SHALL each depend on it via `workspace:*` rather than redefining shared shapes locally.

#### Scenario: Apps consume contracts via workspace protocol
- **WHEN** the `dependencies` of `apps/api`, `apps/web`, and `apps/runner` are inspected
- **THEN** each declares a dependency on the contracts package using the `workspace:*` protocol
- **AND** no app re-declares a shared schema type that already exists in `packages/contracts`

#### Scenario: Schemas are exported with inferred types
- **WHEN** a consumer imports a shared shape from the contracts package
- **THEN** both the zod schema and its `z.infer`-derived TypeScript type are importable from the package entry point

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

### Requirement: Build ordering builds contracts before consumers
The `turbo.json` pipeline SHALL declare `dependsOn: ["^build"]` for the `build` task so that `packages/contracts` is built before any app that depends on it.

#### Scenario: Turbo build task declares upstream dependency
- **WHEN** `turbo.json` is inspected
- **THEN** the `build` task pipeline includes `"^build"` in its `dependsOn` list

#### Scenario: Contracts builds before dependents
- **WHEN** `turbo build` is run from the repo root
- **THEN** the build of `packages/contracts` completes before the build of any app that depends on it begins

### Requirement: Runnable typecheck-lint-build command
The repository SHALL expose a single runnable command `turbo typecheck lint build` that runs typecheck, lint, and build across the workspace and exits with code 0 only when all three succeed.

#### Scenario: Aggregate command succeeds on a healthy tree
- **WHEN** `turbo typecheck lint build` is run on a tree with no type, lint, or build errors
- **THEN** the command exits with status code 0

#### Scenario: Aggregate command fails on a type error
- **WHEN** a TypeScript type error is introduced into any workspace member and `turbo typecheck lint build` is run
- **THEN** the command exits with a non-zero status code

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

### Requirement: CI boots the built application and probes liveness

The CI pipeline SHALL include a check that starts the BUILT application (with its required runtime dependencies, e.g. a throwaway database) and probes the `/health` liveness endpoint, failing the pipeline when the application cannot reach a healthy boot. This guards the cross-provider dependency-injection / bootstrap failure class — a previous DI-ordering defect reached production and caused a multi-hour outage that neither the build nor the unit tests detected. This check SHALL be a required status check for merging, and SHALL be in place before any new application module is introduced.

#### Scenario: A boot/DI failure fails CI

- **WHEN** a change introduces a dependency-injection or bootstrap error that prevents the application from starting
- **THEN** the CI boot-smoke check starts the built app, fails to get a healthy `/health` response, and fails the pipeline — blocking the merge

#### Scenario: A healthy build passes the boot-smoke check

- **WHEN** the built application boots cleanly and serves `/health`
- **THEN** the boot-smoke check reports success

### Requirement: Public contract edits validate downstream consumers

The edit-time TypeScript hook SHALL classify changes to public contracts,
capability registry entries, Public V1 bindings, MCP adapters, OpenAPI projection,
and Playground projection. For a public contract or registry edit it SHALL
typecheck `@cap/contracts` and every directly affected API/Web consumer and SHALL
run `pnpm test:public-surface`; checking only the owning package SHALL NOT count
as success. The classifier SHALL be shared by edit and staged-file gates so their
trigger sets cannot silently diverge.

#### Scenario: A contracts edit omits an MCP adapter

- **WHEN** a developer adds a mapped operation in `@cap/contracts` but has not
  added its exhaustive API adapter
- **THEN** the edit-time downstream typecheck exits non-zero and surfaces the
  missing operation id

#### Scenario: An unrelated edit avoids the focused gate

- **WHEN** an edited file is outside every public-surface and OpenSpec metadata
  trigger path
- **THEN** the classifier does not run the public-surface suite for that edit
- **AND** the repository's existing lint/typecheck behavior still applies

### Requirement: Contracts tests participate in normal verification

`@cap/contracts` SHALL expose a package test command, and its schema, registry,
and type fixtures SHALL run under the focused public-surface command and the
normal CI test graph. A test file present in the contracts package but absent
from normal package/CI scripts SHALL NOT be considered enforced.

#### Scenario: A contracts fixture fails

- **WHEN** a contracts registry/schema test fails
- **THEN** the package test, `pnpm test:public-surface`, and the corresponding CI
  gate all exit non-zero

### Requirement: Local hooks and CI reuse stable public-surface commands

The repository SHALL expose `pnpm test:public-surface` for the infrastructure-free
focused suite and `pnpm verify:public-surface` for the full push/CI gate. Relevant
staged files SHALL run the focused command once through pre-commit; pre-push SHALL
run the full command without relying on an incomplete single-commit diff; CI SHALL
invoke the same full root command in a stable merge-gating job. These layers MUST
reuse root scripts rather than maintaining separate command lists.

#### Scenario: Relevant staged files fail pre-commit once

- **WHEN** one or more staged public-surface files contain a parity defect
- **THEN** pre-commit invokes the focused root command once and blocks the commit
- **AND** it does not launch duplicate concurrent parity runs for overlapping
  globs

#### Scenario: A bypassed local hook is caught remotely

- **WHEN** a developer bypasses edit or commit hooks and pushes a parity defect
- **THEN** pre-push or the stable CI merge gate runs
  `pnpm verify:public-surface`, exits non-zero, and prevents the defect from being
  treated as mergeable

#### Scenario: Full gate is service-independent

- **WHEN** `pnpm verify:public-surface` runs on a fresh checkout with its declared
  build/code-generation prerequisites
- **THEN** it verifies contracts, API parity, OpenAPI, and Playground without a
  production database, external credential, or listening-port probe

