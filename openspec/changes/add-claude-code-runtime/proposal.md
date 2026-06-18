## Why

The platform runs exactly one agent — the `codex` CLI — and every layer is
hard-coded to it (launch argv, ChatGPT auth injection, DSR-gated autosubmit,
`tmux has-session` exit detection, codex rollout transcripts). A working Claude
Code subscription is now available, and Claude Code is a capable second agent.
A spike proved (in the real production sandbox image) that Claude Code can run
under the **exact same** detached-tmux + terminal-replay model with a *simpler*
auth path, so introducing it as a selectable runtime is low-risk and high-value:
operators get to choose the agent best suited to a task at creation time.

## What Changes

- Introduce an **`AgentRuntime` port** that captures the per-agent seams
  (`buildLaunchLine` / `injectAuth` / `autoSubmit` / `detectExit` /
  `captureTranscript`). Extract today's hard-coded codex logic into a
  `CodexRuntime`; add a `ClaudeCodeRuntime`. The container, tmux scaffolding,
  WebSocket PTY client, terminal-replay capture, liveness poller, and boot
  re-adoption stay **runtime-agnostic and shared**.
- Add a **`ClaudeCodeRuntime`** with the spike-verified recipe: launch
  `claude --session-id <uuid> --permission-mode acceptEdits "<prompt>"` in a
  detached tmux session; inject `CLAUDE_CODE_OAUTH_TOKEN` (env, not a file);
  pin inline rendering via `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`; suppress the
  trust + onboarding gates via `CLAUDE_CODE_SANDBOXED=1` and a pre-seeded
  `~/.claude.json`; guarantee `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/
  `apiKeyHelper` are unset (they shadow the OAuth token).
- **`autoSubmit()` becomes a no-op for Claude** — `claude "prompt"` auto-runs the
  positional prompt, so the codex DSR/CPR autosubmit hack is dropped on this path.
- **`detectExit()` for Claude reads turn completion from the transcript** — an
  interactive Claude turn does NOT exit the process; the runtime tails the
  `--session-id` JSONL for the last `assistant` event with `stop_reason=="end_turn"`
  and then proactively `tmux kill-session` so the existing exit path resolves.
- Add a **per-task `runtime` selector** (`claude-code` | `codex`, default `codex`):
  a `Task.runtime` column, a `runtime` field in the create-task contract/DTO,
  persistence + echo-back, and a selector in the create-task dialog gated on
  runtime readiness (a `/runtimes` readiness probe so an un-provisioned runtime is
  disabled rather than failing at launch).
- Add an **`EnvClaudeAuthSource`** (reads `CLAUDE_CODE_OAUTH_TOKEN`) behind a
  `ClaudeAuthSource` port, mirroring the existing `EnvCodexAuthSource` fallback.
  No settings UI and no DB credential this change.
- **Bake claude into the derived AIO image** at a pinned version (sibling to the
  baked codex CLI), because `CLAUDE_CODE_SANDBOXED`/onboarding flags are
  undocumented internals and must not drift.
- **Relabel/remove the dormant "破坏性写入前停止" (stopOnWrite) checkbox.** A code
  audit confirmed it is unwired at every layer for codex (container is the trust
  boundary per `codex-execution-not-gated`); Claude matches codex by also not
  gating — zero regression. A real cross-runtime per-op gate stays a documented
  future option (the existing `permission-request.hook.ts` already speaks the
  Claude-Code hook protocol).

Out of scope (follow-ups): a Claude credential card + encrypted DB store in
settings (after `redesign-settings-single-column`); a headless `-p` mode; wiring
the compatible/custom codex provider into execution; a real per-op approval gate.

## Capabilities

### New Capabilities
- `agent-runtime`: A runtime-abstraction layer — an `AgentRuntime` port with
  `codex` and `claude-code` implementations defining how each agent builds its
  launch line, injects credentials, signals turn completion, and captures its
  transcript; plus the `ClaudeAuthSource`/`EnvClaudeAuthSource` env-token source
  and the spike-verified Claude launch/trust/onboarding recipe.

### Modified Capabilities
- `repo-and-task-management`: `Task` gains an OPTIONAL `runtime` field
  (`claude-code` | `codex`, default `codex`); the create-task request accepts,
  persists, and echoes it on every read path, and admission dispatches the task to
  the selected runtime.
- `aio-sandbox-execution`: per-task provisioning and pre-stop teardown become
  runtime-aware — they delegate credential/config injection and the launch line to
  the selected `AgentRuntime` (Claude injects an env token + a pre-seeded
  `~/.claude.json` and trims `/home/gem/.claude` instead of `/home/gem/.codex`),
  rather than hard-coding codex auth.json + codex launch.
- `frontend-console`: the create-task dialog gains a runtime selector gated on a
  runtime-readiness probe, the command preview reflects the chosen runtime, and the
  unwired stopOnWrite checkbox is relabeled "preview only" or removed.

## Impact

- **Contracts**: `packages/contracts` — `CreateTaskRequest`/`Task` gain `runtime`;
  new `runtime`/readiness shapes.
- **Backend**: `apps/api` — new `agent-runtime` module (port + `CodexRuntime` +
  `ClaudeCodeRuntime`), `ClaudeAuthSource`/`EnvClaudeAuthSource`; `sandbox` and
  `terminal` modules refactored to call the runtime port instead of inline codex
  logic; `tasks` persists/dispatches `runtime`; Prisma migration for `Task.runtime`;
  a `/runtimes` readiness endpoint.
- **Frontend**: `apps/web` — `new-task-dialog.tsx` runtime selector + preview +
  stopOnWrite relabel; `queries.ts` readiness query.
- **Image / ops**: `docker/aio-sandbox.Dockerfile` bakes a pinned `claude`; new env
  `CLAUDE_CODE_OAUTH_TOKEN` (+ pinned claude version); confirm `cap-net` egress to
  `api.anthropic.com`.
- **Operational**: token expiry (no auto-refresh) and a shared per-token rate limit
  pooled with claude.ai — surfaced as auth/rate-limit signals, not silent failures.
