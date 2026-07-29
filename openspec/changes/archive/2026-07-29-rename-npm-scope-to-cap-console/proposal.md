## Why

The sixteen workspace packages were named `@cap/*`, and none of them had ever been
published. That has been free until now, because `workspace:*` resolution never
touches a registry — npm does not validate a name it is never asked to publish.

The repo-split epic (`docs/repo-split-epic.md`, D2) makes exactly one of them a
real public package: the contracts package becomes the protocol artifact both the api
and the web repo consume over npm. At that moment the name stops being free and
has to be one the project actually owns.

`@cap` is not. The npm CLI cannot answer whether a scope is claimable — probes
against `@cap`, against a known-taken scope (`angular`), and against the operator's
own user scope all return identical output — so the question was settled by
registering an org. The scope now owned and verified is **`@cap-console`**
(`npm org ls cap-console douglasdong` → `owner`; the same query against `cap` and
`angular` returns nothing).

**Why now rather than in the phase that needs it:** the rename touches 1,597
occurrences across 606 files, plus the lockfile, two GitHub workflows, a
Dockerfile, and two shell scripts. Today that is one repository, one lockfile, and
one full verification run. After the split it is six repositories, six lockfiles,
submodule pointer updates, and a publish ordering constraint. The cost of this
change only goes up, and it blocks nothing else in the epic.

## What Changes

- **Every workspace package moves from `@cap/*` to `@cap-console/*`.** One scope
  for all sixteen, published and unpublished alike.
- **Every reference follows** — imports, `package.json` dependency keys, the
  pnpm lockfile, turbo filters in CI and release workflows, `apps/web/Dockerfile`,
  and the shell scripts that name packages.
- **Current capability specs follow** (73 occurrences across 16 files), because a
  spec describes the system as it is.
- **Records do NOT follow** — neither archived changes (616 occurrences / 209
  files) nor in-flight ones (27 occurrences). Both contain completed task
  checkboxes and captured verification output naming commands that were actually
  run under the old scope; rewriting them would make the record disagree with what
  happened. A stale filter in a later task fails loudly rather than silently, so
  nothing is lost by leaving them.
- **Nothing is published.** This change renames; the first `npm publish` belongs
  to the epic's Phase 1.

Not breaking: no HTTP, MCP, database, or environment-variable surface changes. No
runtime behaviour changes. The published Docker images keep their `cap-*` names —
those are GHCR image names, unrelated to the npm scope.

## Capabilities

### Modified Capabilities

- `monorepo-foundation`: the workspace gains a stated requirement that all
  packages share one npm scope, and that the scope is one the project controls —
  which is what makes any of them publishable without a rename.

## Impact

**Code** — 1,597 occurrences across 606 files:

| where | note |
|---|---|
| 16 × `package.json` | the `name` field and every scoped dependency key |
| `pnpm-lock.yaml` | regenerated, not hand-edited |
| `apps/api`, `apps/web`, `packages/*` sources | import specifiers |
| `.github/workflows/ci.yml`, `release.yml` | `turbo --filter` arguments |
| `apps/web/Dockerfile` | build-stage filters |
| `scripts/boot-smoke.sh`, `scripts/scheduled-tasks-live-e2e.sh` | package names |

**Specs** — 73 occurrences across 16 current capability specs. Archived changes
are deliberately left alone.

**Verification** — a typecheck pass is not sufficient evidence here. The rename
reaches build filters, a Dockerfile, and shell scripts that no typecheck reads, so
acceptance requires a full build plus the boot-smoke path.

**Not affected** — GHCR image names (`cap-api`, `cap-web`, `cap-aio-sandbox`), the
`CAP_VERSION` variable, `docker-compose*.yml` service names, and every product
surface.

**Non-Goals**

1. Publishing anything to npm. That is epic Phase 1.
2. Splitting the repository. That is epic Phase 3.
3. Renaming Docker images, compose services, or environment variables that happen
   to contain `cap`.
4. Rewriting archived changes.
