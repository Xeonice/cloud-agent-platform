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
