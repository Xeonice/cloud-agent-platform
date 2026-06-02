/**
 * lint-staged config — runs on the husky pre-commit hook.
 *
 * Enforcement point (2) of three for strict TypeScript/ESLint (the others are
 * the Claude Code edit-time hook and the strict base tsconfig surfaced by
 * `turbo typecheck lint build`).
 *
 * Why delegate to Turborepo instead of running `eslint <files>` directly:
 * in this pnpm + Turborepo monorepo, ESLint is a per-package devDependency and
 * is NOT hoisted to a root-resolvable bin, so a root `eslint` (or even
 * `pnpm exec eslint`) invocation fails with ENOENT. ESLint 9 flat config is
 * also cwd-scoped, so a single command over a cross-package file list would
 * apply the wrong config. Turbo runs each package's own `eslint .` + `tsc`
 * with its own config, and its cache makes the unchanged-package case
 * near-instant. The callback form ignores the staged filenames (Turbo scopes
 * by package, not by file), so nothing is appended to the commands.
 *
 * @type {import("lint-staged").Configuration}
 */
export default {
  "*.{ts,tsx}": () => [
    "pnpm exec turbo run lint",
    "pnpm exec turbo run typecheck",
  ],
};
