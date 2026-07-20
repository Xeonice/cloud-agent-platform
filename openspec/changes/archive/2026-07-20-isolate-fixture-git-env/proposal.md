# Proposal: isolate-fixture-git-env

## Why

Running the public-surface suites from a git hook corrupts the real repository: git exports `GIT_DIR`/`GIT_INDEX_FILE` (and related locator variables) into hook processes, the fixture harness's spawned `git init/add/commit` inherit them, and the "temporary" fixture repository operations land on the real branch and index instead — reproduced twice on 2026-07-20 (a `fixture baseline` commit on the real branch, the real index replaced by 5 fixture files), forcing manual `git reset` recovery and `--no-verify` commits/pushes for any contracts-touching change.

## What Changes

- Add a small shared git-environment helper for repository scripts with two explicit modes: a fully clean environment for fixture/scratch repositories, and a locator-sanitized environment (drop every `GIT_*` repo-locating variable, keep the rest) for spawns that must target the real repository from `cwd`.
- Route every git subprocess under `scripts/public-surface-*` through that helper: the fixture harness in `public-surface-adversarial.test.mjs`, the real-repo collectors in `public-surface-adversarial.mjs`, the pre-push base resolution in `public-surface-pre-push.mjs`, and the workflow-invariant harness/test files.
- Add a regression test that simulates the hook environment (poisoned `GIT_DIR`/`GIT_INDEX_FILE` pointing at a bystander repository), runs the fixture repository flow, and asserts the bystander repository's HEAD, refs, and index are untouched.
- Restore trustworthy hooks: after the fix, pre-commit (`public-surface-hook.mjs staged`) and pre-push (`public-surface-pre-push.mjs`) run the full suites safely with no `--no-verify` workaround.

## Capabilities

### New Capabilities

_None — this hardens the existing local public-surface verification capability._

### Modified Capabilities

- `api-mcp-development-parity`: the locally runnable public-surface verification gains a hook-safety requirement — spawned git subprocesses must not inherit repo-locating `GIT_*` variables, fixture repositories must be self-contained, and running the suites from git hooks must leave the real repository's refs and index untouched.

## Impact

- `scripts/` only (classified `developerWorkflow` → internal): new shared helper (e.g. `scripts/git-env.mjs`), edits to `public-surface-adversarial.test.mjs`, `public-surface-adversarial.mjs`, `public-surface-pre-push.mjs`, `public-surface-tests.test.mjs`, plus a new regression test.
- No product code, no Public V1 / MCP / OpenAPI / Playground surface changes (see `surface-impact.json`).
- Developer workflow: contracts-touching commits/pushes stop requiring `--no-verify`.
