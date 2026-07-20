<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: git-env-isolation (depends: none)

- [x] 1.1 Create `scripts/git-env.mjs` exporting `cleanGitEnv(base)` (copy of the base environment with every `/^GIT_/` key removed, everything else preserved, input not mutated) and `fixtureGitEnv(base)` (cleanGitEnv plus `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`), with a plain-node unit test file covering GIT_* removal, PATH/non-git preservation, non-mutation, and the fixture-mode config keys.
  - requirements: ["api-mcp-development-parity/public-surface-suites-are-safe-to-run-from-git-hooks"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.2 Route every git spawn under `scripts/public-surface-*` through the helper: `runGit` in `public-surface-adversarial.test.mjs` and any scratch-repo builders in `public-surface-tests.test.mjs` use `fixtureGitEnv`; the real-repo spawns (`gitValues` in `public-surface-adversarial.mjs`, base resolution in `public-surface-pre-push.mjs`) use `cleanGitEnv`; grep-audit `scripts/` to confirm no remaining git spawn inherits the parent environment.
  - requirements: ["api-mcp-development-parity/public-surface-suites-are-safe-to-run-from-git-hooks"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.3 Add a hook-simulation regression test: build a bystander repository in a temp dir with one commit, poison the process environment with `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` pointing into it, run the full fixture-repository lifecycle, and assert the bystander's HEAD sha, ref list, and `ls-files -s` output are unchanged; confirm the test fails against the pre-fix spawn behavior (red) and passes with the helper wired (green).
  - requirements: ["api-mcp-development-parity/public-surface-suites-are-safe-to-run-from-git-hooks"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.4 Prove the hook paths end to end on this branch: run `node scripts/public-surface-hook.mjs staged` with contracts files staged and the pre-push wrapper against a base sha, verify the real repository's HEAD/refs/index are untouched afterwards and both exit zero, then run `pnpm verify:public-surface` and the focused parity suite to confirm no coverage regressed.
  - requirements: ["api-mcp-development-parity/public-surface-suites-are-safe-to-run-from-git-hooks"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "public-surface-fast"
