# Research Brief — fix-claude-onboarding-seed-path

Side-car notes grounding the proposal (live-sandbox investigation, not a tracked artifact).

## Symptom
A `claude-code` task on a FRESH v0.9.0 sandbox stalls on Claude's first-run onboarding —
the "Choose the text style…/theme" picker, and then the auth/token prompt — instead of
running the task headlessly. Expected: the sandbox pre-initializes Claude so it skips
onboarding and runs `claude -p` directly.

## Root cause (verified inside the live v0.9.0 sandbox `cap-aio-dfa9e9a1-…`)
`ClaudeCodeRuntime.sandboxSetupCommands` writes the onboarding-suppression `.claude.json`
to `CLAUDE_JSON_PATH = /home/gem/.claude/.claude.json` (i.e. `$CLAUDE_CONFIG_DIR/.claude.json`),
with the correct content (`theme:"dark"`, `hasCompletedOnboarding:true`, project trust).

But Claude Code **2.1.181** reads/writes its MAIN config at **`$HOME/.claude.json`**
(`/home/gem/.claude.json`) — a DIFFERENT file. Inspected live:
- `/home/gem/.claude/.claude.json` (the seed) → has `hasCompletedOnboarding:true` ✓ but is IGNORED.
- `/home/gem/.claude.json` (what Claude actually reads) → Claude created it fresh on first
  launch with only `{firstStartTime, machineID, migrationVersion, userID, …}` — **NO `theme`,
  NO `hasCompletedOnboarding`** → so Claude runs the full first-run onboarding.

So `CLAUDE_CONFIG_DIR=/home/gem/.claude` only relocates the `.claude` DIRECTORY
(settings.json, cache, backups, `projects/` transcripts — all present there), but the main
`.claude.json` stays at `$HOME` root regardless of `CLAUDE_CONFIG_DIR`.

The spec requirement "Provision-time trust and onboarding pre-seed" literally encodes the
wrong path (`$CLAUDE_CONFIG_DIR/.claude.json`), so the bug is enshrined in the spec.

## Why the earlier spike (claude 2.1.179) looked fine
Either the spike never drove an interactive launch far enough to see the onboarding, or a
behavior shift across 2.1.179→2.1.181. The live evidence (2.1.181) is unambiguous; the pin
is `CLAUDE_CODE_VERSION=2.1.181` in `docker/aio-sandbox.Dockerfile`.

## Why the token prompt ALSO appears
With `hasCompletedOnboarding:false` (the un-read state), Claude runs the WHOLE onboarding
flow (theme → auth), so the token prompt shows even though `CLAUDE_CODE_OAUTH_TOKEN` is
injected via `launch-env.sh`. Fixing the seed path makes Claude skip onboarding entirely and
use the injected token → no theme prompt, no token prompt.

## Fix
Re-point the pre-seed target to `$HOME/.claude.json` (`/home/gem/.claude.json`). Keep
`CLAUDE_CONFIG_DIR=/home/gem/.claude` (load-bearing: the transcript `detectExit` tails lives
at `$CLAUDE_CONFIG_DIR/projects`). The token injection + ANTHROPIC_* unsets are unchanged.

## Out of scope (separate follow-up)
The session-header runtime tag shows "Codex" for a `claude-code` task (the `agent` tag is not
derived from `task.runtime`) — a cosmetic frontend-console display issue, not part of this fix.

## Not the cause (ruled out)
- Provision-time runtime mis-resolution (the v0.6.0 regression) — guarded since v0.9.0
  (e749d1f); user confirmed a fresh v0.9.0 sandbox + the seed file IS present (so claude was
  correctly resolved at provision).
- Claude version drift — 2.1.181 ≈ spike's 2.1.179 (patch only).
