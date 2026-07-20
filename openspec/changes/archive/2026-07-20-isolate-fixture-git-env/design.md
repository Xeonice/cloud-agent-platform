# Design: isolate-fixture-git-env

## Context

git exports repository-locating environment variables (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_PREFIX`, `GIT_WORK_TREE`, …) to hook processes. Every git spawn under `scripts/public-surface-*` currently inherits the parent environment, so when the suites run inside pre-commit/pre-push, the fixture harness's `init/add/commit` intended for a `mkdtempSync` temp dir resolve against the real repository (env overrides `cwd`), committing fixture state onto the real branch and replacing the real index. The real-repo collectors (`gitValues` diff/ls-files in `public-surface-adversarial.mjs`, base resolution in `public-surface-pre-push.mjs`) have the inverse exposure: inside pre-commit, lint-staged swaps `GIT_INDEX_FILE`, so inherited env can make even intentional real-repo reads observe the wrong index. CI never reproduces any of this because it runs the suites outside hooks.

## Goals / Non-Goals

**Goals:**
- No git subprocess spawned by repository scripts can be redirected by hook-exported `GIT_*` variables.
- Fixture/scratch repositories are self-contained: their operations can only ever touch the temp directory.
- A regression test proves the incident cannot recur (poisoned hook env, bystander repo untouched).
- Pre-commit and pre-push become safe again for contracts-touching changes; the `--no-verify` workaround is retired.

**Non-Goals:**
- No change to what the hooks check or when they trigger (classifier, suite selection, and gate semantics stay as-is).
- No product-code or public-surface changes.
- No attempt to sandbox other repositories' hooks or third-party tools (lint-staged internals stay untouched).

## Decisions

1. **One shared pure helper, two explicit modes.** New `scripts/git-env.mjs` exporting `cleanGitEnv(base = process.env)` (drop every key matching `/^GIT_/`, keep everything else — `PATH` included) and `fixtureGitEnv(base)` (= `cleanGitEnv` plus deliberate fixture config: `GIT_CONFIG_NOSYSTEM: '1'`, `GIT_CONFIG_GLOBAL: '/dev/null'`, `HOME` untouched). Dropping the whole `GIT_*` namespace is chosen over an allowlist of known locator vars: git grows locator/config vars over time (`GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_INTERNAL_*`), and no script here legitimately depends on inheriting any `GIT_*` value. Alternative (per-site `delete env.GIT_DIR` patches) rejected: incident showed exactly how one missed site behaves.
2. **Fixture spawns use `fixtureGitEnv`; real-repo spawns use `cleanGitEnv`.** The distinction is semantic and load-bearing: fixture repos must be fully self-contained (system/global config excluded so `init` cannot pick up e.g. `init.templateDir`), while `gitValues`/push-base resolution must still resolve the real repository — from `cwd`, which is the only resolution channel left once locator vars are gone. The pre-commit staged-path collector keeps reading the real (lint-staged-swapped) staged state correctly because `public-surface-hook.mjs staged` reads via `git diff --cached` in the real repo from `cwd` — with locator vars dropped, `--cached` resolves the repository's own index file, which is the honest canonical state to gate on.
3. **Helper is dependency-free and unit-tested under plain node** (same discipline as `public-surface-files.mjs`): tests assert `GIT_*` removal, non-git preservation, and no mutation of the input object.
4. **Regression test simulates the hook, not the symptom.** `withPoisonedHookEnv` creates a bystander repo (temp dir, one commit), sets `GIT_DIR`/`GIT_INDEX_FILE` (and `GIT_WORK_TREE`) pointing into it, runs the full fixture-repository lifecycle from `public-surface-adversarial.test.mjs`'s helper, then asserts the bystander's `HEAD` sha, ref list, and index mtime/content are byte-identical. This test fails on today's code (red) and passes after the helper is wired (green). Alternative (assert on the real dev repo) rejected: tests must never gamble with the developer's actual repository.
5. **No hook/config changes.** `.husky/*`, suite selection, and `lint-staged.config.mjs` stay untouched; safety comes from the spawned processes, so the fix also covers any future caller (CI, manual runs, workflows) for free.

## Risks / Trade-offs

- [Dropping `GIT_*` breaks a legitimate future use (e.g. worktree layouts where `cwd` alone cannot resolve the repo)] → All current scripts run with `cwd` inside the repo/worktree, which git resolves natively; if a future caller genuinely needs an override it must opt in explicitly through the helper rather than ambient env.
- [`GIT_CONFIG_GLOBAL=/dev/null` changes fixture commit identity resolution] → Fixture already sets `user.email`/`user.name` via `git config` per repo; excluding global config makes that deterministic rather than breaking it.
- [Regression test flakiness via index mtime comparison] → Compare content hashes (`git -C bystander rev-parse HEAD`, `git -C bystander ls-files -s` output) instead of raw mtimes where platforms differ.

## Migration Plan

Pure tooling change; lands with the next release PR. Rollback = revert. Developers stop using `--no-verify` immediately after merge.

## Open Questions

_None._
