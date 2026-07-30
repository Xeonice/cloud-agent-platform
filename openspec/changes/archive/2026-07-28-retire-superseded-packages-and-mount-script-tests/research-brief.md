# Research brief — retire-superseded-packages-and-mount-script-tests

Serial research pass (no fan-out). Verified against the working tree at commit
`203436a`.

## Method

Both items in this change were surfaced BY the previous three changes rather
than by a fresh survey — the dead packages when `turbo --filter` rejected one of
them mid-implementation, the unmounted script tests when the discovery gate's
count did not move after adding a test file. The research here is therefore
confirmation rather than discovery: is each finding real, is deletion safe, and
does an existing requirement already cover it?

## F1 — Four packages were superseded, then hidden rather than removed

`openspec/specs/sandbox-provider-port/spec.md` already requires it:

> "Scheduler, lifecycle, workspace-git, AIO-local configuration, and conformance
> helpers SHALL NOT remain runtime packages solely to hold internal helper code."

and its scenario asserts the code IS under `@cap/sandbox` /
`@cap/sandbox-provider-aio`. The migration happened. The empty shells were then
EXCLUDED from `pnpm-workspace.yaml` instead of deleted:

```yaml
  - "!packages/sandbox-aio-local"
  - "!packages/sandbox-lifecycle"
  - "!packages/sandbox-scheduler"
  - "!packages/sandbox-workspace-git"
```

So turbo knows 16 packages and none of these is one. They are never built,
typechecked or tested. `packages/sandbox/README.md:43-46` documents the
situation accurately — which means the repository has WRITTEN DOWN that these
directories are vestigial and kept them anyway.

| Package | Lines | Superseded by |
|---|---|---|
| `sandbox-scheduler` | 853 | `packages/sandbox/src/scheduler.ts`, `registry.ts`; the router's three exports (`RoutableSandboxProvider`, `SandboxProviderRouterOptions`, `SandboxProviderRouter`) all live in `@cap/sandbox` |
| `sandbox-aio-local` | 238 | `packages/sandbox-provider-aio/src/aio-local-provider.ts` |
| `sandbox-workspace-git` | 77 | `packages/sandbox/src/workspace-git.ts` |
| `sandbox-lifecycle` | 46 | `packages/sandbox/src/lifecycle.ts` |

**Deletion safety, verified.** Outside their own directories and the OpenSpec
archives, the only references anywhere in the repository are the four
`pnpm-workspace.yaml` exclusion lines and the `packages/sandbox/README.md`
paragraph describing them. No source import, no `package.json` dependency, no
Dockerfile, no CI workflow.

The concrete harm is not the disk space. `enforce-provider-contract-parity` set
out to remove an alias reconciliation "copied into three packages" and found the
third copy was in `sandbox-scheduler` — code that cannot run. An edit was made to
it and had to be reverted. Dead code that looks live costs review attention and
misdirects work.

## F2 — The discovery gate reads "repository" as "workspace packages"

`openspec/specs/test-suite-discovery/spec.md:75` requires:

> "**The repository** SHALL expose a check that enumerates test files on disk,
> enumerates the files the configured runners would discover, and fails when a
> test file exists that no runner would execute."

No qualifier — repository-wide. The implementation
(`scripts/test-discovery-check.mjs:58`) enumerates via `listWorkspacePackages()`
reading `pnpm-workspace.yaml`, so `scripts/` is outside its scope entirely.

That gap holds real files. Of 37 `scripts/*.test.mjs`:

- 21 are mounted — named in `package.json` scripts, in `ci.yml`, or run by
  `scripts/public-surface-tests.mjs` (itself a runner for six of them)
- **16 are named by none of those three**

Running all 16 directly: **15 pass, 1 fails** — and the one failure turned out
not to be a failure at all.

`compose-host-bind.test.mjs` shells out to
`docker compose -f docker-compose.yml --env-file /dev/null config`. It already
carries a `dockerAvailable()` guard and a `skip()` path, so it is not
ungated. It fails HERE because `--env-file /dev/null` clears
`COMPOSE_PROJECT_NAME` and docker then derives the project name from the working
directory — which in this worktree is `重构-整理项目架构`. Docker rejects it:
`project name must not be empty`. Passing `-p captest` makes the same command
succeed.

So the failure is an artefact of THIS checkout's non-ASCII directory name, not a
defect in the test, and not a reason to gate it. **All 16 unmounted tests are
runnable.** (Making the test pass an explicit `-p` would additionally make it
robust for any contributor whose checkout path is non-ASCII — a small real
improvement this change can carry.)

**This prediction was WRONG, and the implementation disproved it.** Running the
sixteen ONE AT A TIME is not the same as mounting them: under the glob, three
files fail, not one. Two canaries
(`boxlite-real-cli-terminal-canary`, `terminal-fresh-attach-create-cleanup`)
throw `Cannot find module '@xterm/headless'`, which they resolve via
`createRequire` from `apps/api` — a package that does not declare it. `git log -S`
dates the break precisely: commit **68c0907 removed `@xterm/headless` from
`apps/api` in the same commit that introduced the lookup against it**. These
canaries have been broken on import ever since, and nothing noticed because
nothing ran them.

So mounting surfaces the same class of finding `wire-orphaned-test-suites` did.
The remaining value is still prospective: 16 files' worth of assertions that
today protect nothing, because nothing runs them. Among them are `runtime-artifact-checksum.test.mjs`,
`sandbox-metadata-image.test.mjs`, `sandbox-provider-selection.test.mjs` and
`write-sandbox-metadata.test.mjs` — all covering machinery the last three
changes touched.

**Correction made during research.** A first pass reported three of these as
failing. That was an artefact of the check itself: the command wrapped each run
in `timeout`, which does not exist on macOS, so every invocation "failed" with
`command not found`. Re-run without it, 15 of 16 pass. Worth recording because
the same mistake would have produced a change that "fixed" three tests that were
never broken.

## What this change should therefore be

Two small, low-risk items that finish what the last three changes started:

1. Delete the four superseded packages and their `pnpm-workspace.yaml`
   exclusions; update the `@cap/sandbox` README paragraph that documents them.
2. Mount all 16 runnable root script tests, harden the compose test against a
   non-ASCII checkout path, and widen the discovery check to the repository scope its
   requirement already states.

## Open questions carried into design

- Should the root script tests be mounted as ONE root command (`pnpm
  test:scripts` with a glob) or added to the existing per-concern commands?
  A glob matches the "mechanical, never a hand-maintained list" requirement the
  discovery capability is built on; the existing per-file naming in `ci.yml` is
  precisely the allowlist shape that capability exists to eliminate.
- ~~The Docker-dependent test needs an exclusion or a runtime skip.~~
  **Answered: neither.** It already skips when Docker is absent; its failure here
  is the non-ASCII checkout path described above. No exclusion is needed, and the
  exclusion list stays empty — which matters, because the first entry in an empty
  exclusion list is how such lists start growing.
