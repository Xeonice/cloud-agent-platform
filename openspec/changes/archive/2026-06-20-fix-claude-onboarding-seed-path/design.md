## Context

`ClaudeCodeRuntime` pre-seeds a `.claude.json` at provision time to suppress Claude Code's first-run onboarding (theme + auth), the analog of codex's `config.toml` trust step. The seed targets `CLAUDE_JSON_PATH = /home/gem/.claude/.claude.json` (i.e. `$CLAUDE_CONFIG_DIR/.claude.json`). Live inspection of a fresh v0.9.0 sandbox (Claude Code 2.1.181) shows Claude reads its main config from `$HOME/.claude.json` instead — it created `/home/gem/.claude.json` itself with no `theme`/`hasCompletedOnboarding`, so the seed is ignored and the onboarding runs. `CLAUDE_CONFIG_DIR` relocates only the `.claude` directory (settings, cache, `projects/` transcripts), not the main config file. See `research-brief.md` for the captured evidence.

## Goals / Non-Goals

**Goals:**
- A `claude-code` task launches headlessly — no theme/onboarding/auth screen — and runs the prompt with the injected OAuth token.
- The onboarding pre-seed lands in the file Claude actually reads.

**Non-Goals:**
- No change to the launch line, `CLAUDE_CONFIG_DIR`, transcript capture, credential injection, or codex.
- Not fixing the cosmetic "Codex" session-header tag (separate follow-up).
- No sandbox-image rebuild (the seed is written per-task at provision; the claude version pin is unchanged).

## Decisions

**D1 — Seed `$HOME/.claude.json`, keep `CLAUDE_CONFIG_DIR`.**
Re-point `CLAUDE_JSON_PATH` to `/home/gem/.claude.json` (HOME root). Keep `CONFIG_DIR`/`CLAUDE_CONFIG_DIR=/home/gem/.claude` for the `.claude` directory because the turn-completion `detectExit` tails the transcript at `$CLAUDE_CONFIG_DIR/projects`. Rationale: the live evidence shows the main config is HOME-rooted independent of `CLAUDE_CONFIG_DIR`; this is the minimal correct fix.
- Alternative (unset `CLAUDE_CONFIG_DIR`, rely on HOME for everything) — rejected: it would move the transcript path and ripple into `detectExit`/capture.

**D2 — Write before Claude's first launch (already the order).**
The seed runs at provision (`sandboxSetupCommands`), before the detached-tmux launch. Claude reads `$HOME/.claude.json` on startup, sees `hasCompletedOnboarding:true`, skips onboarding, and MERGES its own runtime fields (`firstStartTime`, `machineID`, …) into the same file. No race: provision precedes launch.

**D3 — Pin the path in a test so it can't silently regress.**
Add/adjust a unit assertion that the seed command targets `$HOME/.claude.json` (HOME root), not the config dir — mirroring how the runtime-selection guard pins its seam.

## Risks / Trade-offs

- [Claude merges vs overwrites the seeded file] → Claude reads-then-writes `~/.claude.json`, preserving existing keys (observed: it added migration fields without dropping others). Seeding it first is safe; if a future version overwrote it wholesale it would still read the seed on the first start (before writing), which is when the onboarding decision is made.
- [Workspace path in `projects` trust may not match] → `CLAUDE_CODE_SANDBOXED=1` already short-circuits the per-project trust dialog, so the `projects[...]` entry is belt-and-braces; theme + `hasCompletedOnboarding` are the actual blockers and are global.
- [Claude version drift re-breaks the path] → out of scope to chase, but D3's test pins the intended path; a future version that moves the main config again would need its own follow-up.

## Migration Plan

API-only; no DB migration. Ships in the next release; prod gets it on the next backend upgrade. Rollback = revert the one-line constant.
