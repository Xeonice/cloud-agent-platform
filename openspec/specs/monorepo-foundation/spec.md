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
  (generating the `@cap-console/web` route tree, the `@cap-console/api` Prisma client, and the
  `@cap-console/contracts`/`@cap-console/ui` dist types), then runs `turbo typecheck lint`
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
typecheck `@cap-console/contracts` and every directly affected API/Web consumer and SHALL
run `pnpm test:public-surface`; checking only the owning package SHALL NOT count
as success. The classifier SHALL be shared by edit and staged-file gates so their
trigger sets cannot silently diverge.

#### Scenario: A contracts edit omits an MCP adapter

- **WHEN** a developer adds a mapped operation in `@cap-console/contracts` but has not
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
graph. `@cap-console/contracts` schema, registry, and type fixtures SHALL additionally run
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

### Requirement: Every workspace package SHALL share one npm scope the project controls

All packages in the workspace SHALL be named under a single npm scope, and that
scope SHALL be one the project owns on the public registry. Publishing any package
SHALL therefore require no rename.

A package that is never published SHALL NOT be exempt. The registry does not
validate a name it is never asked to publish, so an unowned scope can persist
indefinitely on unpublished packages and is discovered only at the moment
publishing becomes necessary — which is the moment it is most expensive to fix.

Ownership SHALL be established by an authenticated, member-scoped query rather
than by absence of evidence: a 404 on a package name, or an empty public listing
for a scope, proves only that nothing has been published there.

#### Scenario: A package can be published without being renamed

- **WHEN** any workspace package is prepared for publication to the public
  registry
- **THEN** its existing name SHALL be publishable as-is, because its scope is
  already owned by the project

#### Scenario: Unpublished packages carry the same scope as published ones

- **WHEN** the workspace package names are inspected
- **THEN** every package SHALL share one scope, so that no reader or tool has to
  know which names are registry names and which are local-only

#### Scenario: Scope ownership is proven, not assumed

- **WHEN** scope ownership is asserted
- **THEN** the evidence SHALL be an authenticated query that distinguishes an
  owned scope from an unowned one, verified against a control that is known not to
  be owned

### Requirement: A shared type SHALL have exactly one declaration

A type that crosses the boundary between the api and the console SHALL be declared
once, in the shared contracts package, and consumers SHALL obtain it by import. A
consumer SHALL NOT restate a shared type locally, whether by copying its members,
by re-typing its fields, or under a different name.

Where a consumer package deliberately limits its runtime dependencies, it SHALL
converge through a type-only import rather than by keeping a copy, because a
type-only import is erased and therefore costs that package nothing it was
protecting.

A restatement SHALL NOT be justified by the copy currently matching. Two
declarations that agree today agree only until one is edited, and the
repository has no mechanism that notices.

#### Scenario: A consumer imports rather than restates

- **WHEN** a consumer needs a type the contracts package already declares
- **THEN** it SHALL import that declaration, so the two cannot drift apart

#### Scenario: A dependency-constrained package still converges

- **WHEN** the consumer is a package that deliberately declares no runtime
  dependencies, and it needs the type only in type position
- **THEN** it SHALL take a type-only import, which leaves its runtime dependency
  graph unchanged, rather than keep a local copy

#### Scenario: A runtime need that cannot be imported is reconciled, not duplicated silently

- **WHEN** a dependency-constrained package needs the vocabulary as a runtime value
  and therefore cannot import it
- **THEN** its local copy SHALL be reconciled with the declaration by a check that
  fails when the two disagree, and any deliberate widening SHALL be stated as an
  extension of the declaration rather than as an independent list

### Requirement: An export nothing can reach SHALL fail the build

The contracts package SHALL NOT retain an export that nothing can reach. Such an
export is not shared, and the package's stated purpose is that everything in it is.

Reachability SHALL be judged by what actually keeps an export alive, not by whether
a consumer names it. An export is reachable when a consumer imports it, when
another export is composed from it, or when the schema/type twin it forms a unit
with is itself reachable — this package's documented pattern is a zod schema
alongside the type inferred from it, and a consumer that validates with the schema
never names the type. A check that demanded a direct import would flag most of the
package and be turned off; the requirement is that nothing is unreachable, not that
everything is imported.

An export reachable only from the package's own tests SHALL be reported as such
rather than counted as shared. It is neither dead nor shared, and the two answers
differ.

An export that is legitimately unreachable SHALL declare itself as an exception with
a reason, so the exception is visible in review rather than invisible by omission.

A dead export SHALL NOT be removed before the consumers that displaced it have been
converged. An export is frequently dead **because** a consumer restated it — including
by inlining its VALUE as a literal, which leaves no second declaration for a
name-based scan to find — and deleting it first ratifies the restatement, after which
the same shape reappears under another name.

#### Scenario: An unreachable export stops the build

- **WHEN** the contracts package exports a symbol that no consumer imports, that no
  other export is composed from, whose schema/type twin is equally unreachable, and
  that no exception covers
- **THEN** the build SHALL fail, naming the export

#### Scenario: A composed or paired export is not reported dead

- **WHEN** an export is not imported by any consumer, but another export is built
  from it or its schema/type twin is imported
- **THEN** it SHALL NOT be reported, because deleting it would leave the next
  consumer that needs it re-declaring it locally

#### Scenario: A schema nobody executes is treated as unverified

- **WHEN** a contract schema has no call site anywhere
- **THEN** it SHALL be reported, because a declaration nothing enforces can
  contradict what is actually sent without any signal

#### Scenario: Convergence precedes deletion

- **WHEN** an export is found to be unreachable while a consumer holds a local
  restatement of it, whether as a declaration or as an inlined literal value
- **THEN** the restatement SHALL be converged first and reachability re-measured,
  and only the exports still unreachable afterwards SHALL be removed

#### Scenario: The check is shown to be able to fail

- **WHEN** the check is added or changed
- **THEN** a throwaway unreachable export SHALL be shown to fail it by name and its
  removal SHALL be shown to return the build to green, because a check accepted on
  a green run has not been shown to do anything
