## Context

Execution today is codex-only and codex-hard-coded across six seams: launch argv
(`codex-launch.ts`), ChatGPT auth.json injection (`aio-sandbox.provider.ts`),
DSR-gated autosubmit (`aio-pty-client.ts`), `tmux has-session` exit detection,
codex rollout transcripts, and the prompt-file `$(cat)` delivery. Only the
container (the derived `cap-aio-sandbox` AIO image) and the surrounding scaffolding
(detached tmux, the `/v1/shell/ws` PTY client, asciicast capture/replay, the
liveness poller, boot re-adoption) are agent-agnostic.

A working Claude Code (Max) subscription is available. A hands-on spike (see
`research-brief.md`) ran the real `claude` 2.1.181 binary inside both `node:22`
(arm64) and the production `cap-aio-sandbox:pinned` image and proved Claude Code
fits the *same* TUI-in-tmux model with a simpler auth path. This design turns that
evidence into an `AgentRuntime` abstraction and a `ClaudeCodeRuntime`.

Constraints: keep codex behavior byte-identical; do not make Claude more or less
gated than codex; no settings UI this change (the encrypted credential card waits
for `redesign-settings-single-column`); reuse the replay/re-adoption machinery
unchanged.

## Goals / Non-Goals

**Goals:**
- An `AgentRuntime` port with `CodexRuntime` + `ClaudeCodeRuntime`; codex behavior unchanged.
- Per-task runtime selection (`claude-code` | `codex`, default `codex`) wired
  end-to-end: dialog → contract → DB → admission dispatch.
- Claude auth via injected `CLAUDE_CODE_OAUTH_TOKEN` (env-source only this change).
- Reuse the terminal-replay, liveness, and boot re-adoption scaffolding verbatim.
- Claude baked + version-pinned into the AIO image.

**Non-Goals:**
- Claude credential card / encrypted DB store in settings (follow-up after the settings redesign).
- A headless `-p`/SDK execution mode for Claude.
- A real per-operation approval gate (stopOnWrite) for either runtime.
- Wiring the compatible/custom codex provider into execution (separate debt).
- Multi-turn / interactive back-and-forth with a task (one prompt → one run, like codex).

## Decisions

### D1 — Introduce an `AgentRuntime` port; container stays shared
Extract the codex-specific seams into a port:
```
interface AgentRuntime {
  readonly id: 'codex' | 'claude-code'
  buildLaunchLine(ctx): string                 // detached-tmux inner command
  injectAuth(exec, material): Promise<void>     // creds + config into the sandbox
  autoSubmit(pty): void | null                  // codex: DSR-gated CR; claude: null
  detectExit(exec, taskId): Promise<ExitSignal> // codex: session-gone; claude: transcript end_turn
  captureTranscript(exec, taskId): Promise<…>   // shared byte-stream + per-runtime structured source
}
```
`CodexRuntime` is today's logic moved behind the port (no behavior change).
`ClaudeCodeRuntime` is the second impl. The provider/gateway/guardrails call the
port instead of inline codex calls. **Alternative rejected:** a minimal "swap the
launch line only" approach — rejected because auth, autosubmit, exit detection, and
transcript all diverge, so the codex-specifics would leak everywhere and a third
runtime would be painful.

### D2 — TUI-in-tmux, not headless `-p`
Claude runs as an interactive TUI in a detached tmux session, exactly like codex,
so the asciicast capture/replay (`session-terminal-replay`), liveness poller, and
boot re-adoption (`sandbox-readoption`) apply unchanged. **Alternative rejected:**
`claude -p --output-format stream-json` (headless) — cleaner JSON but produces no
TUI to replay, forcing a parallel render/capture/archival path and a UI split from
codex tasks. Spike-confirmed: Claude's TUI renders **inline** (no alt-screen) when
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` is set, and the existing xterm/SerializeAddon
capture is buffer-mode-agnostic, so no capture branching is needed.

### D3 — Auth via injected `CLAUDE_CODE_OAUTH_TOKEN`, env-source only
`injectAuth()` for Claude sets a single env var (token minted on a workstation via
`claude setup-token`) rather than writing an auth.json. A `ClaudeAuthSource` port
with an `EnvClaudeAuthSource` reads `CLAUDE_CODE_OAUTH_TOKEN`, mirroring the existing
`EnvCodexAuthSource` fallback. **Alternative rejected (for now):** an in-container
`device-login` flow like codex — deferred; and the encrypted-DB `PrismaClaudeAuthSource`
+ settings card — deferred to after the settings redesign. The launch MUST unset
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper` (spike: a non-empty one
silently shadows the OAuth token).

### D4 — `autoSubmit()` is null for Claude
Spike-proven: `claude "prompt"` auto-runs the positional prompt (DSR `ESC[6n` count
= 0; input box consumed). So `ClaudeCodeRuntime.autoSubmit()` is a no-op — none of
codex's `launchedCodex`/`dsrSeen`/quiesce-timer/CR-injection/CPR machinery is used.
Prompt is still passed positionally via the codex `$(cat <file>)` shape (never
inlined, shell-injection-safe).

### D5 — `detectExit()` reads `end_turn` from the transcript, then kills the session
The biggest divergence from codex. An interactive Claude turn does NOT exit the
process — it idles for the next input, so `tmux has-session` stays alive forever on
normal completion. `ClaudeCodeRuntime.detectExit()` tails the `--session-id` JSONL at
`~/.claude/projects/<canonicalized-workspace-slug>/<uuid>.jsonl` for the **last
`assistant` event** with `stop_reason=="end_turn"` (NOT the last line — trailing
`system`/`ai-title`/`last-prompt` events follow it), then proactively
`tmux kill-session` so the existing session-gone exit path resolves cleanly. The
liveness poller is demoted to an abnormal-death watchdog. **Accepted limitation:**
`end_turn` cannot distinguish "done" from "asked a clarifying question and waiting"
(both end on `assistant + end_turn`); the run is treated as complete and the final
assistant text — possibly a question — is surfaced, identical one-shot semantics to
codex. An `--append-system-prompt` discouraging questions is added as a soft reducer
(spike: it does not override an explicit "ask me" instruction, so it is not a gate).

### D6 — Full autonomy via `--permission-mode acceptEdits` + `CLAUDE_CODE_SANDBOXED=1`
Spike-proven across 4 runs: this combination runs Bash and edits with zero approval
prompts (the sandbox is the trust boundary, matching codex's `danger-full-access`).
**Alternatives rejected:** `--dangerously-skip-permissions` (does not skip the trust
dialog in an interactive TTY, adds an un-seedable warning, and hard-refuses root —
the AIO image runs as root); `--permission-mode dontAsk`/`bypassPermissions` (spike:
did not improve on `acceptEdits`, one even prompted). Trust + the first-run global
onboarding/theme screen are suppressed by `CLAUDE_CODE_SANDBOXED=1` plus a
provision-time pre-seeded `~/.claude.json` (global `theme`/`hasCompletedOnboarding`
keys, not just per-project trust — project-level alone left the theme screen blocking).

### D7 — Bake + pin claude in the derived AIO image
Claude is added to `docker/aio-sandbox.Dockerfile` at a pinned version alongside the
baked codex CLI. **Why pinned:** `CLAUDE_CODE_SANDBOXED` and the onboarding flags are
undocumented binary internals; an unpinned bump could flip inline→alt-screen or change
the trust gate. The spike installed claude at runtime for speed; production must bake it.

### D8 — stopOnWrite stays ungated for Claude (matches codex)
A code audit (see `research-brief.md`) confirmed stopOnWrite is unwired at every layer
for codex (dormant per `codex-execution-not-gated`). Claude matching = zero regression.
The only action is relabeling/removing the over-promising checkbox. A real cross-runtime
per-op gate via Claude's `PreToolUse` hook (the existing `permission-request.hook.ts`
already speaks the protocol) is a documented future option, not in scope.

### D9 — Runtime readiness probe gates the selector
A `/runtimes` endpoint reports each runtime's readiness as a boolean (e.g. is a token
configured) WITHOUT leaking secrets, so the create dialog disables an unconfigured
runtime instead of letting the task fail at launch. Default selection is `codex`.

## Risks / Trade-offs

- [`end_turn` ambiguity: a clarifying-question turn is read as "done"] → Treat as
  run-complete and surface the question as the final output (codex parity); add a
  soft no-questions system prompt; document that interactive back-and-forth is unsupported.
- [OAuth token expiry with no auto-refresh (~1yr) fails all tasks] → Detect the
  auth-failure text in the captured byte-stream and mark the task failed with a
  distinct reason; document re-minting via `setup-token`; mint on a workstation only.
- [One Max token pools a 5h + weekly rate limit across all sandboxes AND claude.ai chat] →
  Distinguish `rate_limit` vs `authentication_failed` from the stream; document per-tenant
  tokens as the scaling path; out-of-scope to solve fully here.
- [`ANTHROPIC_API_KEY` silently shadows the OAuth token] → Launch path unconditionally
  unsets `ANTHROPIC_*`/`apiKeyHelper`; assert it in an e2e check.
- [Undocumented `CLAUDE_CODE_SANDBOXED`/onboarding flags drift on version bump] → Pin the
  baked claude version; keep a byte-stream trust/disclaimer-prompt detector as a safety net.
- [Full turn proven on node:22 arm64 but not on the real amd64 AIO image (qemu was too slow
  in the spike)] → Re-run a full turn on the baked amd64 image as an e2e gate before ship.
- [`cap-net` egress to `api.anthropic.com` unverified] → Confirm egress in the compose e2e.
- [Refactor risk: moving codex logic behind the port regresses codex] → Land the port with
  `CodexRuntime` first as a pure no-op refactor, with the existing codex e2e green, before adding Claude.

## Migration Plan

1. Add `Task.runtime` (nullable, default `codex`) via a Prisma migration — additive,
   backward-compatible (existing tasks read as `codex`).
2. Land the `AgentRuntime` port + `CodexRuntime` as a behavior-preserving refactor;
   verify the codex e2e is unchanged.
3. Add `ClaudeCodeRuntime` + `EnvClaudeAuthSource` + the baked/pinned claude image +
   `/runtimes` probe; gate Claude tasks behind a configured `CLAUDE_CODE_OAUTH_TOKEN`.
4. Wire the create-dialog selector + readiness gating; relabel stopOnWrite.
5. Rollback: unset `CLAUDE_CODE_OAUTH_TOKEN` (the probe disables the Claude option) and/or
   revert the image bump; codex path is untouched, so rollback is low-risk.

## Open Questions

- Token storage interim: env var on the API host now; the encrypted-DB card lands after
  the settings redesign — confirm the env name (`CLAUDE_CODE_OAUTH_TOKEN`) is the bridge.
- Per-tenant vs single shared token — deferred; single token for v1.
- Whether to also relabel/remove stopOnWrite on the codex path now or leave it as a
  pre-existing latent issue (this change at least stops it spreading to Claude).
