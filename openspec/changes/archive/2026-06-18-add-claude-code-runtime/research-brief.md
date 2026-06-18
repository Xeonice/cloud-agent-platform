# Research Brief — add-claude-code-runtime

Side-car evidence base for this change. Grounded in a hands-on **spike** (4 real
Linux-container probe runs + 2 verification workflows + a codebase guardrail
audit), not theory. Tooling versions observed: `claude` 2.1.181, `tmux` 3.3a.

## Locked decisions (confirmed with the user)
1. **TUI-in-tmux** — Claude Code runs as an interactive TUI in a detached tmux
   session, identical model to codex, so the terminal-replay / boot re-adoption /
   guardrails scaffolding is reused unchanged.
2. **Auth via `CLAUDE_CODE_OAUTH_TOKEN`** — a long-lived OAuth token minted on a
   workstation with `claude setup-token`, injected as an env var. No settings UI
   this change (env-source only; the encrypted DB credential card is deferred to
   after `redesign-settings-single-column` lands).
3. **`AgentRuntime` port** — extract today's hard-coded codex logic into a
   `CodexRuntime`; `ClaudeCodeRuntime` is the second impl. One shared container.
4. **stopOnWrite** stays ungated for Claude, matching codex (see §5).

## Spike verdicts — all proven in a real Linux container (node:22 arm64 + the prod `cap-aio-sandbox:pinned` image)
| Q | Verdict | Evidence |
|---|---------|----------|
| Auto-submit | `claude "prompt"` auto-runs the positional prompt | `PONGTEST` answered, DSR `ESC[6n` count = 0 → no CPR handshake |
| Alt-buffer | Renders **inline** in the normal buffer (NOT alt-screen) | `ESC[?1049h` = 0, `alternate_on` = 0 (requires `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`; `CLAUDE_CODE_NO_FLICKER=1` and `claude attach` would force alt-screen) |
| tmux survival | Detached session survives abrupt client death, same pid | after `kill -9` of the attaching client: `has-session` ALIVE, same `pane_pid` |
| Clean-env auth | `CLAUDE_CODE_OAUTH_TOKEN` alone authenticates in a keychain-less container | `-p` → `AUTHOK`; interactive `acceptEdits` actually wrote `proof.txt`; **no** keychain/`~/.claude.json` login present |
| Transcript | Deterministic at `~/.claude/projects/<canonicalized-cwd-slug>/<session-id>.jsonl` via `--session-id` | file appeared at computed slug; valid JSONL; `end_turn` lands |
| Trust/onboarding | Zero-prompt launch achievable | `CLAUDE_CODE_SANDBOXED=1` short-circuits the trust gate; **plus** the global onboarding/theme screen must be pre-seeded (see recipe) |
| Bash autonomy | `acceptEdits + CLAUDE_CODE_SANDBOXED=1` runs Bash with **no** approval prompt | triangulated across 4 runs; `dontAsk`/`bypassPermissions` did NOT improve on this |
| Turn-completion | A finished turn does **not** exit the process (idles) | `proof.txt` at 6s while `has-session` still ALIVE; `end_turn` lands later than tool_use |

## Proven launch recipe (ClaudeCodeRuntime implements verbatim)
Provision-time pre-seed `$CLAUDE_CONFIG_DIR/.claude.json` (analog of codex's
`config.toml` trust step) — note the **global** onboarding keys, not just project trust:
```json
{"theme":"dark","hasCompletedOnboarding":true,"numStartups":5,
 "hasAcknowledgedCostThreshold":true,"bypassPermissionsModeAccepted":true,
 "projects":{"/home/gem/workspace":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}
```
Launch env (injectAuth): `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`,
`CLAUDE_CODE_SANDBOXED=1`, `CLAUDE_CONFIG_DIR=/home/gem/.claude`. **`ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper` MUST be unset** (a non-empty one silently shadows the OAuth token).
Launch line (reuse the codex detached-tmux + `$(cat file)` positional-prompt shape):
```
tmux new-session -d -s task<id> -c /home/gem/workspace \
  'P="$(cat ~/.claude/task-prompt.txt)"; claude --session-id <uuid> --permission-mode acceptEdits "$P"'
```
- `autoSubmit()` → **null** (no Enter injection; delete codex's DSR/CPR autosubmit subsystem for this runtime).
- `detectExit()` → tail the `--session-id` JSONL for the **last `assistant` event** with
  `stop_reason=="end_turn"` (NOT the last line — trailing `system`/`ai-title`/`last-prompt`
  events follow it), then proactively `tmux kill-session` so the existing session-gone
  exit path resolves. Liveness poller demotes to an abnormal-death watchdog.
- `captureTranscript()` → byte-stream asciicast pipeline reused unchanged; the
  `--session-id` JSONL is an ADDITIONAL structured archival source (parse all record types).

## detectExit nuance (proven, accepted)
`end_turn` cannot structurally distinguish "task done" from "claude asked a clarifying
question and is waiting" — both end on `assistant + end_turn`, process alive; only the text
differs (a `?`). An `--append-system-prompt` forbidding questions did **not** override an
explicit "ask me" task instruction. Decision: treat `end_turn` as run-complete and surface
the final assistant text (which may be a question) — identical one-shot model to codex; the
system-prompt nudge is a soft reducer, not a guarantee.

## stopOnWrite guardrail — VESTIGIAL for codex; Claude matches by also not gating
Audited end to end: the "破坏性写入前停止" checkbox is unwired at every layer — frontend
`new-task-dialog.tsx:254` sets it but `handleSubmit` (309-315) drops it; no field in
`CreateTaskRequestSchema` (`packages/contracts/src/task.ts:184-210`); `tasks.service.ts`
never reads it; account `writeConfirm` stored (`settings-logic.ts:82,208`) but unused; codex
launches `--ask-for-approval never --sandbox danger-full-access`; the codex PreToolUse hook
(matcher `.*`) is verified NOT firing (codex#16732); `AioApprovalEnforcer` is fail-closed but
has zero real call sites. This matches the deliberate `codex-execution-not-gated` decision
(container is the trust boundary). → Claude not gating = **zero regression**. A real per-op
gate (Claude `PreToolUse` hook → existing `permission-request.hook.ts`, which already speaks
the Claude-Code hook protocol) is HIGH-feasibility but a future cross-runtime product choice.
Only action this change: relabel/remove the over-promising checkbox.

## Residual operational risks (carried into tasks/design, not blockers)
- **Token expiry** (~1yr, no auto-refresh): expiry fails all tasks → surface an auth-failure
  signal from the byte-stream; re-mint via `setup-token`. Mint on a workstation, never in-sandbox.
- **Shared rate limit**: one Max token pools a 5-hour + weekly window across all sandboxes AND
  claude.ai chat → distinguish `rate_limit` vs `authentication_failed`; consider per-tenant tokens.
- **Image parity**: claude must be **baked + version-pinned** into the derived AIO image (the
  spike installed it at runtime); pinned because `CLAUDE_CODE_SANDBOXED`/onboarding flags are
  undocumented binary internals subject to drift. Re-run a full turn on the real amd64 image.
- **Egress**: confirm `cap-net` reaches `api.anthropic.com` (codex reaches OpenAI today).
