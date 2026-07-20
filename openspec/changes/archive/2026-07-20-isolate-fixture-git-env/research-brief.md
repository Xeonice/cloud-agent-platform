# Research Brief — isolate-fixture-git-env

Serial research pass (2026-07-20), grounded in a same-day live incident that
reproduced twice in this workspace.

## Incident evidence (firsthand, 2026-07-20)

While committing/pushing change `edit-sandbox-environment-parameters` (staged
paths included `packages/contracts/src/**`, which routes the pre-commit /
pre-push hooks into the full public-surface suite):

- The real branch gained a commit `"fixture baseline"` authored by
  `Public Surface Fixture <fixture@example.invalid>` — once during pre-commit
  (`c835cf5`, parent = then-HEAD `cb8f285`) and once during pre-push
  (`3d019c4`, parent = the real feature commit `5403a61`).
- The real repository index was replaced with exactly the 5 fixture files
  (`git ls-files | wc -l` → 5), making the entire tree appear untracked and
  showing the fixture change dir (`openspec/changes/public-surface-fixture/*`)
  as deleted tracked paths.
- The mutation-seam copies of `apps/api/src/mcp/mcp-tools.ts` and
  `packages/contracts/src/public-v1-operations.ts` appeared modified at the
  index level (working-tree file contents were never touched).
- Downstream steps of the same hook run then failed against the corrupted
  state (`openspec-metadata` diff validation, parity suite), masking the root
  cause. Recovery required manual `git reset <real-commit>`; the push was only
  possible with `--no-verify`.

## Mechanism (verified in code)

- git exports repository-locating environment variables — at minimum `GIT_DIR`
  and `GIT_INDEX_FILE` (plus `GIT_PREFIX`, `GIT_WORK_TREE` in some paths) — into
  the environment of hook processes (`.husky/pre-commit`, `.husky/pre-push`).
- `scripts/public-surface-adversarial.test.mjs` `runGit(cwd, args)` (line ~358)
  calls `spawnSync('git', args, { cwd, encoding, shell: false })` with **no
  `env` option**, so the child inherits the hook environment.
  `initializeFixtureRepository` then runs `init/config/add/commit` intending to
  target a `mkdtempSync` temp dir via `cwd` — but inherited `GIT_DIR`/
  `GIT_INDEX_FILE` override `cwd` resolution, so every operation lands on the
  real repository: `add .` stages the fixture tree (cwd supplies the paths)
  into the real index and `commit` advances the real branch.
- Trigger condition: the hook chain reaches these tests only when staged/pushed
  paths classify into public-surface categories (`scripts/public-surface-files.mjs`
  — e.g. any `packages/contracts/src/**` edit). Ordinary commits skip them,
  which is why the bug survived until a contracts-touching change was committed
  locally.

## Blast-radius survey (all git spawns under scripts/)

`spawnSync('git'|spawnSyncImpl('git'` sites:

- `scripts/public-surface-adversarial.test.mjs` — `runGit` fixture helper
  (init/config/add/commit/rev-parse): **vulnerable, the incident's origin**.
- `scripts/public-surface-adversarial.mjs` — production-path `gitValues`
  (diff/ls-files/rev-parse against the REAL repo): inheriting `GIT_INDEX_FILE`
  here is also wrong-in-hooks (lint-staged swaps the index mid pre-commit), and
  correct isolation differs: it must keep targeting the real repository but with
  a clean locator env, not a temp repo.
- `scripts/public-surface-pre-push.mjs` — resolves the push base via git: runs
  inside the pre-push hook by design; same clean-locator concern.
- `scripts/public-surface-tests.mjs` / `scripts/public-surface-tests.test.mjs` —
  workflow-invariant harness that shells the above; test file builds scratch
  repos the same way.

No other `scripts/*.mjs` spawn git directly (checked via grep).

## Prior art / constraints

- Node's `spawnSync` replaces the child env entirely when `env` is passed —
  building a sanitized copy must preserve `PATH` and other non-git vars.
- git documents the full set of repo-locating variables; the sanitize list
  should cover at least `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`,
  `GIT_PREFIX`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_INTERNAL_*` — simplest robust rule:
  drop every `GIT_*` key, then re-add deliberate config
  (`GIT_CONFIG_NOSYSTEM=1` optional hardening for fixtures).
- The repo already centralizes classifier logic in
  `scripts/public-surface-files.mjs`; a tiny shared `git-env.mjs` helper (pure,
  testable under plain node) fits the same pattern.
- CI runs these suites outside git hooks, so CI never reproduced the bug —
  a regression test must simulate the hook environment explicitly (set
  `GIT_DIR`/`GIT_INDEX_FILE` pointing at a bystander repo, run the fixture
  flow, assert the bystander's HEAD/refs/index bytes are untouched).

## Key design constraints

1. Two distinct isolation modes: **fixture spawns** need a fully clean git env
   (temp repo must be self-contained); **real-repo spawns** (adversarial
   collector, pre-push base resolution) need the locator vars dropped while
   still resolving the repository from `cwd`.
2. The fix must not weaken hook coverage — after it, pre-commit/pre-push must
   run the same suites safely (no `--no-verify` workaround).
3. Regression test must fail on today's code (red before fix) and be cheap
   (temp dirs only, no network).
