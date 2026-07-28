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

### Requirement: Package-internal imports use a path alias, not relative traversal

An application or package SHALL refer to its own modules through a path alias
rooted at that package's source directory, not by relative traversal out of the
importing directory. `apps/web` already establishes the convention (`@/*` →
`./src/*`); the repository SHALL use ONE such convention rather than a different
answer per package.

The purpose is relocation: a directory whose consumers name it by position
relative to themselves cannot be moved without editing every consumer, which is
what makes reorganising a large module tree a manual exercise instead of a
mechanical one.

The alias SHALL resolve in every path the package is built or tested through —
the application build, the compiled test runner, and any standalone compilation
harness — so that adopting it cannot leave one lane silently unable to resolve
what the others can.

#### Scenario: A module is referred to by alias rather than traversal
- **WHEN** a source file inside an application imports another module of the same application
- **THEN** it names it by the package's alias
- **AND** no relative traversal out of the importing directory appears

#### Scenario: The alias resolves in every build and test lane
- **WHEN** the application is built, its compiled suite is run, and a standalone compilation harness compiles a single source file
- **THEN** the alias resolves in all of them
- **AND** no lane requires a second convention to resolve what the others resolve

#### Scenario: A newly added relative import fails the build
- **WHEN** a source file is added that traverses out of its directory to reach another module of the same package
- **THEN** a repository check fails and names the file

### Requirement: Directory dependencies are acyclic outside module composition

Two directories of an application SHALL NOT depend on each other through
non-module source. A mutual dependency between directories means neither owns
the concern they share, and it is what prevents either from being moved,
extracted, or reasoned about independently.

Dependency-injection COMPOSITION is exempt and SHALL be stated as such: imports
made BY a `*.module.ts` file — of another module, or of a provider class it
registers — are composition, because a framework whose composition model
requires them would otherwise be satisfied by indirection that hides the same
cycle rather than removing it. The exemption SHALL be narrow, and it is about
the IMPORTING file: a cycle in which any participating import comes from
ordinary source is NOT composition and is forbidden.

Where a symbol is reached for by a directory that does not own it, the symbol
SHALL be moved to a home named for what it IS, rather than left in a feature
directory that consumers must reach into. A single catch-all destination SHALL
NOT be used: a name that describes nothing cannot say what does or does not
belong in it.

#### Scenario: Two directories forming a mutual dependency fail the build
- **WHEN** ordinary source in one directory imports another directory that imports it back
- **THEN** a repository check fails and names both directories
- **AND** the check names the imports that form the cycle

#### Scenario: Module composition may be mutual
- **WHEN** two directories depend on each other ONLY through imports written in `*.module.ts` files — whether of another module or of a provider class being registered
- **THEN** the check passes
- **AND** the exemption is visible in the check as a stated rule rather than an unexplained absence

#### Scenario: A cycle with any ordinary-source import is not composition
- **WHEN** two directories form a mutual dependency in which at least one import is written in a file that is not a `*.module.ts`
- **THEN** the check fails
- **AND** it is not treated as composition merely because the other side is a module file

#### Scenario: A shared symbol lives where its name says
- **WHEN** a symbol is used by directories that do not own it
- **THEN** it lives in a directory named for the concern it belongs to
- **AND** that directory is not a general-purpose destination for unrelated symbols

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

Every workspace package that owns tests SHALL expose a package test command, and
those tests SHALL run under the repository-wide test task and the normal CI test
graph. `@cap/contracts` schema, registry, and type fixtures SHALL additionally run
under the focused public-surface command. A test file present in any workspace
package but absent from the normal package/CI test graph SHALL NOT be considered
enforced, and the repository SHALL detect that condition mechanically rather than
relying on review to notice it.

#### Scenario: A contracts fixture fails

- **WHEN** a contracts registry/schema test fails
- **THEN** the package test, `pnpm test:public-surface`, and the corresponding CI
  gate all exit non-zero

#### Scenario: Any package's failing test fails the graph

- **WHEN** a test fails in any workspace package that declares a test command
- **THEN** the repository-wide test task and the CI job invoking it exit non-zero

#### Scenario: An unenforced test file is detected, not tolerated

- **WHEN** a test file exists in a workspace package but no configured runner
  would execute it
- **THEN** the repository's discovery check exits non-zero and names that file

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

