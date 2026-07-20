/**
 * Sanitized git environments for every git subprocess spawned by repository
 * scripts (isolate-fixture-git-env).
 *
 * git exports repository-locating variables (`GIT_DIR`, `GIT_INDEX_FILE`,
 * `GIT_WORK_TREE`, `GIT_PREFIX`, ...) into hook processes. A spawned git that
 * inherits them resolves the REAL repository even when `cwd` points at a
 * temporary fixture directory — which is exactly how the public-surface
 * fixture suite committed "fixture baseline" onto a real branch when run from
 * pre-commit/pre-push (2026-07-20). No script here legitimately depends on
 * inheriting ANY `GIT_*` value, so both modes drop the whole namespace rather
 * than maintain an allowlist that rots as git grows new locator variables.
 *
 * Two explicit modes:
 *  - {@link cleanGitEnv}: for spawns that target the REAL repository. The
 *    repository is resolved from `cwd` only; hook-swapped indexes and
 *    locator overrides cannot redirect the call.
 *  - {@link fixtureGitEnv}: for scratch/fixture repositories. Additionally
 *    excludes system and global git config so fixture repos are fully
 *    self-contained (no `init.templateDir`, hooks, or identity bleed-through).
 *
 * Pure functions of the given base environment — no `process.env` mutation,
 * no I/O — so the sanitization property is unit-testable under plain node.
 */

/**
 * Copy of `base` with every `GIT_*` key removed and everything else (PATH
 * included) preserved. The input object is never mutated.
 */
export function cleanGitEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^GIT_/u.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * {@link cleanGitEnv} plus deliberate fixture hardening: system and global
 * git config are excluded so a fixture repository's behavior depends only on
 * the per-repo config the fixture sets itself.
 */
export function fixtureGitEnv(base = process.env) {
  return {
    ...cleanGitEnv(base),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}
