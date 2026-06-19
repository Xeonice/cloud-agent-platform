<!-- Track-annotated tasks. Small api-only fix: re-point the Claude onboarding
     pre-seed to $HOME/.claude.json, pin it in a test, verify. -->

## 1. Track: seed-path-fix (depends: none)

- [x] 1.1 In `apps/api/src/agent-runtime/claude-code-runtime.ts`, re-point the onboarding pre-seed: change `CLAUDE_JSON_PATH` from `/home/gem/.claude/.claude.json` to the HOME root `/home/gem/.claude.json` (the file Claude 2.1.181 actually reads). Update its doc comment to explain `CLAUDE_CONFIG_DIR` relocates only the `.claude` directory, not the main `.claude.json`.
- [x] 1.2 Confirm `sandboxSetupCommands` still `mkdir -p $CONFIG_DIR` (for `launch-env.sh`) but writes the `.claude.json` payload to the new HOME-root `CLAUDE_JSON_PATH`; keep `CONFIG_DIR`/`CLAUDE_CONFIG_DIR` and the launch line unchanged (transcript path + token inject untouched).

## 2. Track: pin-and-verify (depends: seed-path-fix)

- [x] 2.1 Add/adjust a unit assertion (the runtime's existing spec/golden test) that the emitted pre-seed command writes `.claude.json` to the sandbox HOME root, NOT `$CLAUDE_CONFIG_DIR/.claude.json` — so the path can't silently regress.
- [x] 2.2 Run the api gate: `pnpm --filter @cap/api typecheck && pnpm --filter @cap/api test` (the runtime spec lane) green.
- [ ] 2.3 Live verify on a fresh sandbox: a `claude-code` task reaches the prompt with NO theme/onboarding/auth screen, and `$HOME/.claude.json` (not `$CLAUDE_CONFIG_DIR/.claude.json`) carries `hasCompletedOnboarding:true`.
