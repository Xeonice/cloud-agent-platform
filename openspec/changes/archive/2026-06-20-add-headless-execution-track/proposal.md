## Why

Programmatic consumers (MCP / `/v1` API) are misconfigured onto the "interactive PTY + resident tmux" execution chain built for the console: their tasks never exit, stay stuck `running` and never reach a terminal status, claude transcripts are permanently `no-rollout` (the read/parse chain is codex-only), and there is no programmatic multi-turn. A spike proved both runtimes' native headless modes (codex `exec`, claude `-p`) resolve all of this cleanly — and the public API + MCP server are already live, so this unusable behavior is exposed to integrators now.

## What Changes

- **AgentRuntime port gains two declarative contracts**:
  1. **Execution-mode contract**: `executionModes: Set<'interactive-pty' | 'headless-exec'>` + `buildHeadlessLine(ctx)` + `buildResumeLine(ctx, prevSessionId)`.
  2. **Transcript contract**: `transcriptArtifact(ctx) → { dir, filenameGlob }` + `parseTranscript(rawJsonl) → ParsedTranscript`, so transcript location/format is per-runtime declared, not hardcoded.
- **CodexRuntime + ClaudeCodeRuntime** each implement headless launch + resume:
  - codex: `codex exec --json` (with `< /dev/null`, `--skip-git-repo-check`, `--sandbox danger-full-access`); resume `codex exec resume <sid> --json --skip-git-repo-check` (no `-s` — inherited).
  - claude: `claude -p --output-format stream-json`; resume `claude -p --resume <sid>`.
- **Transcript read/parse becomes runtime-aware**: `readRolloutFromContainer` selects path/glob per runtime (codex `~/.codex/sessions/rollout-*.jsonl`; claude `~/.claude/projects/<slug>/<sid>.jsonl`), and a **new claude JSONL parser** is added → **fixes claude `no-rollout`**.
- **TasksService routes by consumer**: programmatic (MCP / `/v1`) → `headless-exec` (process exits → task reaches terminal autonomously); console → `interactive-pty` (unchanged).
- Programmatic tasks are **pure fire-and-forget**: no gating / approval / persistent-interaction (those stay console-only). **BREAKING** for the current `agent-runtime` spec's "resident" requirement, which is narrowed to interactive-pty only.
- Sandbox policy unchanged (pure container; codex stays `danger-full-access`).

## Capabilities

### New Capabilities
<!-- none — this extends existing capabilities -->

### Modified Capabilities
- `agent-runtime`: port gains execution-mode + transcript contracts; the resident exit-detection requirement is narrowed so resident applies to `interactive-pty` only, while `headless-exec` resolves a task to terminal on process exit.
- `session-transcript-persistence`: capture changes from codex-only to per-runtime (codex rollout AND claude JSONL), so a finished claude task's transcript is durably archived.
- `aio-sandbox-execution`: `readRolloutFromContainer` reads the per-runtime transcript path/glob (declared by the runtime) instead of hardcoded `~/.codex/sessions` + `rollout-*.jsonl`.
- `repo-and-task-management`: a task created by a programmatic consumer selects the `headless-exec` execution mode and reaches a terminal status autonomously (no operator interaction required), while console-created tasks stay `interactive-pty`.

## Impact

- **Code**: `apps/api/src/agent-runtime/` (port + codex-runtime + claude-code-runtime), `sandbox/aio-sandbox.provider.ts` (`readRolloutFromContainer` runtime-aware), `sandbox/rollout-parser.ts` (+ claude parser), `tasks/tasks.service.ts` (execution-mode routing), the headless launch path (run `exec`/`-p` over `/v1/shell/exec`, capture stdout JSON event stream — NOT the tmux PTY frame chain).
- **Behavior**: programmatic codex/claude tasks reach terminal on completion (no more stuck `running`); claude `get_transcript` no longer `no-rollout`; programmatic multi-turn available via resume.
- **Spec**: the 4 MODIFIED capabilities above; the current resident-locking requirement in `agent-runtime` is relaxed (BREAKING at spec level).
- **Unaffected**: console interactive terminal + operator takeover (`interactive-pty` path untouched); sandbox model (pure container, `seccomp=unconfined` + `danger-full-access`); the codex 0.131 pin (kept for gpt-5.5 compatibility).
