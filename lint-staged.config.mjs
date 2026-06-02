/**
 * lint-staged config — runs against staged files on the husky pre-commit hook.
 *
 * Enforcement point (2) of three for strict TypeScript (the others are the
 * Claude Code edit-time hook and the strict base tsconfig surfaced by
 * `turbo typecheck lint build`).
 *
 * For staged .ts/.tsx files: auto-fix with ESLint, then run a workspace-wide
 * typecheck. tsc must run against each member's tsconfig (not the bare staged
 * filenames, which would bypass project settings), so the typecheck command
 * ignores the passed filenames and typechecks every workspace member.
 *
 * @type {import("lint-staged").Configuration}
 */
export default {
  "*.{ts,tsx}": (stagedFiles) => [
    `eslint --fix ${stagedFiles.join(" ")}`,
    "pnpm -r typecheck",
  ],
};
