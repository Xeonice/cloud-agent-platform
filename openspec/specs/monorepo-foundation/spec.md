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
