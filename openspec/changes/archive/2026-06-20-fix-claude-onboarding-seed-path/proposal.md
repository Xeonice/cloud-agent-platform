## Why

A `claude-code` task on a fresh v0.9.0 sandbox stalls on Claude Code's first-run onboarding (the theme picker, then the auth/token prompt) instead of running headlessly. Verified inside the live sandbox: the onboarding-suppression pre-seed is written to `$CLAUDE_CONFIG_DIR/.claude.json` (`/home/gem/.claude/.claude.json`), but Claude Code 2.1.181 reads its MAIN config from `$HOME/.claude.json` (`/home/gem/.claude.json`) — so the seed is ignored and Claude runs a fresh, un-onboarded config. The current spec requirement encodes the wrong path.

## What Changes

- **Re-point the Claude onboarding pre-seed** from `$CLAUDE_CONFIG_DIR/.claude.json` to **`$HOME/.claude.json`** — the file Claude Code actually reads/writes for the global config (`theme`, `hasCompletedOnboarding`, project trust). `CLAUDE_CONFIG_DIR` only relocates the `.claude` DIRECTORY (settings/cache/`projects` transcripts), not the main `.claude.json`.
- Keep `CLAUDE_CONFIG_DIR=/home/gem/.claude` on the launch line (load-bearing: the transcript the turn-completion `detectExit` tails lives at `$CLAUDE_CONFIG_DIR/projects`).
- The token injection (`CLAUDE_CODE_OAUTH_TOKEN` + `ANTHROPIC_*` unsets) is unchanged: once `hasCompletedOnboarding` is read, Claude skips the whole onboarding (theme AND auth) and uses the injected token — so the token prompt disappears too.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `agent-runtime`: the "Provision-time trust and onboarding pre-seed" requirement is corrected — the pre-seed `.claude.json` is written to the sandbox HOME root (`$HOME/.claude.json`), the file Claude actually reads, not `$CLAUDE_CONFIG_DIR/.claude.json`.

## Impact

- **Code**: `apps/api/src/agent-runtime/claude-code-runtime.ts` — the `CLAUDE_JSON_PATH` constant (and its doc comment); the `sandboxSetupCommands` write still `mkdir -p $CLAUDE_CONFIG_DIR` for `launch-env.sh` but targets `$HOME/.claude.json` for the config. Possibly the runtime's golden/unit tests that pin the seed path.
- **Unaffected**: the launch line + `CLAUDE_CONFIG_DIR`, the transcript capture path (`$CLAUDE_CONFIG_DIR/projects`), the credential injection, codex runtime.
- **Verification**: a fresh `claude-code` task in the sandbox reaches the prompt with no theme/onboarding/auth screen (the live failure reproduced today).
- **Out of scope**: the session-header runtime tag showing "Codex" for a `claude-code` task (cosmetic frontend display, separate follow-up).
- **Deploy note**: api-only change → ships in the next release; prod picks it up on the next backend upgrade (no migration).
