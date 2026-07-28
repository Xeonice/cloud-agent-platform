## Why

The last three changes each closed a gap between a rule the repository had
written down and code that did not follow it. Both items here were surfaced BY
that work, and both are the same shape a fourth time:

- `sandbox-provider-port` requires that scheduler / lifecycle / workspace-git /
  AIO-local helpers "SHALL NOT remain runtime packages solely to hold internal
  helper code". Their code DID move to `@cap/sandbox` and
  `@cap/sandbox-provider-aio`. The four empty shells — 1,214 lines — were then
  merely EXCLUDED from `pnpm-workspace.yaml`, so they are never built, never
  typechecked, never tested, and imported by nothing. `packages/sandbox/README.md`
  accurately documents that they are vestigial, which means the repository has
  written down that this code is dead and kept it anyway. It already cost real
  work: `enforce-provider-contract-parity` set out to delete an alias
  reconciliation "copied into three packages", made an edit to the copy inside
  `sandbox-scheduler`, and had to revert it on discovering the package cannot run.

- `test-suite-discovery` requires that "**the repository** SHALL expose a check
  that enumerates test files on disk … and fails when a test file exists that no
  runner would execute". The check enumerates WORKSPACE PACKAGES, so `scripts/`
  is outside its scope. Sixteen `scripts/*.test.mjs` files are named by no root
  script, no CI step, and no runner. All sixteen run and pass today — they simply
  never run. Several cover machinery the last three changes edited
  (`runtime-artifact-checksum`, `sandbox-metadata-image`,
  `sandbox-provider-selection`, `write-sandbox-metadata`).

Neither is urgent on its own. Together they are the accumulated tail of the
programme so far, and both are small, verifiable, and low-risk — which is
precisely why they should be closed before the larger structural work rather
than carried into it.

## What Changes

- **Delete the four superseded packages** (`sandbox-scheduler`,
  `sandbox-aio-local`, `sandbox-lifecycle`, `sandbox-workspace-git`) and their
  `pnpm-workspace.yaml` exclusion lines. Deletion safety verified: outside their
  own directories and the OpenSpec archives, the ONLY references in the entire
  repository are those exclusion lines and one README paragraph. Every module
  they contain has a live counterpart, including the one file without a
  same-named successor — the router's three exports all live in `@cap/sandbox`.
- **Rewrite the `@cap/sandbox` README paragraph** that describes them, so the
  documentation stops describing directories that no longer exist.
- **Mount the sixteen unrun script tests** through ONE discovered command rather
  than by adding sixteen more names to a list. `ci.yml` already names eight
  script tests individually, which is the hand-maintained-allowlist shape
  `test-suite-discovery` exists to eliminate; this replaces that shape rather
  than extending it.
- **Widen the discovery check to the repository scope its requirement states**,
  so a root-level test file that no runner would execute fails the build the same
  way a package-level one does. The exclusion list stays EMPTY.
- **Harden `compose-host-bind.test.mjs` against a non-ASCII checkout path.** It
  passes `--env-file /dev/null`, which clears `COMPOSE_PROJECT_NAME`; docker then
  derives the project name from the working directory and refuses a non-ASCII
  one. Any contributor whose checkout path is non-ASCII hits this. **Not** a
  gating problem — the test already skips correctly when Docker is absent.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `test-suite-discovery`: the drift-check requirement gains an explicit
  repository-wide scope — test files outside a workspace package are covered too
  — and the mounting requirement gains root-level scripts, so their suite is
  discovered by pattern rather than by names listed in CI.
- `sandbox-provider-port`: the helper-package requirement gains the final step it
  implied but never stated — a superseded package is REMOVED, not merely excluded
  from the workspace graph, since an excluded package still reads as live code to
  anyone browsing or grepping the repository.

## Impact

- Deleted: `packages/sandbox-scheduler`, `packages/sandbox-aio-local`,
  `packages/sandbox-lifecycle`, `packages/sandbox-workspace-git` (1,214 lines)
- `pnpm-workspace.yaml` — four exclusion lines removed
- `packages/sandbox/README.md` — the paragraph describing the deleted packages
- `package.json` — the command that mounts root script tests
- `.github/workflows/ci.yml` — eight individually named script tests replaced by
  the discovered command
- `scripts/test-discovery-check.mjs` + its self-test — repository-wide scope
- `scripts/compose-host-bind.test.mjs` — explicit compose project name
- **No runtime impact**: nothing imports the deleted packages, and no product
  code changes. The risk is confined to the build graph and CI wiring, both of
  which the existing gates verify.
