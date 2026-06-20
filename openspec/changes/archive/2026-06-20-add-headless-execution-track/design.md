## Context

Today every task — console, MCP, `/v1` API — runs through ONE execution chain: an interactive
codex/claude TUI launched in a **detached tmux session**, driven over a **live PTY** (`AioPtyClient`),
with completion resolved by `tmux has-session` GONE and the transcript captured as a byte-stream
asciicast. This is correct for the **console** (live terminal + operator takeover are the product).
It is wrong for **programmatic consumers** (MCP / `/v1`): the agents are RESIDENT (a finished turn
does not exit), so programmatic tasks stay `running` forever and never reach a terminal status; and
the transcript read/parse chain is **codex-only**, so claude tasks are permanently `no-rollout`.

A 2026-06-20 spike (memory `headless-execution-spike-findings`) proved, on the exact production
binaries (codex `0.131.0`, claude `2.1.183≈2.1.181`), that both runtimes have native **headless**
modes that exit-on-completion, emit structured results, persist a per-runtime transcript, and resume.

## Goals / Non-Goals

**Goals:**
- Add a second execution mode `headless-exec` alongside the existing `interactive-pty`, selected by
  **consumer** (programmatic → headless, console → interactive), so programmatic tasks reach a
  terminal status autonomously.
- Make the transcript read/parse chain **runtime-aware** so claude's transcript is read + parsed
  (fixes `no-rollout`) and durably captured — both runtimes.
- Express both as **declarative port contracts** (runtime declares; shared mechanism reads),
  consistent with the policy/mechanism refactor already in place.
- Reuse the existing detached-session + liveness-poller + boot-re-adoption scaffolding; change only
  WHAT is launched and HOW the transcript is read.

**Non-Goals:**
- Programmatic **multi-turn / continue** (no `continue_task` MCP tool, no `/v1` resume endpoint).
  The runtime *declares* a resume capability (validated in spike, kept for symmetry/future) but the
  task lifecycle stays single-turn fire-and-forget — this is the "interaction" the user dropped.
- Any change to the **console** interactive-pty path, operator takeover, or write-lock.
- Sandbox model changes — pure container, codex stays `--sandbox danger-full-access` (no Landlock layering).
- Bumping codex past 0.131 (pinned for gpt-5.5 account-model compatibility).
- A terminal-frame (asciicast/xterm) replay for headless tasks — they expose the structured
  transcript only.

## Decisions

**D1 — Execution mode is chosen by consumer, carried on the task.** `TasksService.create` derives
`executionMode` at creation: console → `interactive-pty`; MCP / `/v1` → `headless-exec`. Persisted on
the task row (drives provisioning + exit detection + transcript read). Default for an unspecified
consumer = `interactive-pty` (preserve today's behavior).

**D2 — Two declarative port contracts on `AgentRuntime`.**
- Execution mode: `executionModes: ReadonlySet<'interactive-pty'|'headless-exec'>`,
  `buildHeadlessLine(ctx)`, `buildResumeLine(ctx, prevSessionId)`.
- Transcript: `transcriptArtifact(ctx) → { dir, filenameGlob }`, `parseTranscript(rawJsonl) → ParsedTranscript`.
The runtime owns no I/O — it returns data/commands; the shared mechanism runs/reads them (same shape
as `sandboxSetupCommands` / `terminalStartup`).

**D3 — Headless reuses the detached scaffolding; only the launched command + exit/transcript differ.**
A headless task is still a detached, named, re-adoptable session, but the launched line is the
exit-on-completion `exec`/`-p` command (not an interactive TUI). Differences vs interactive-pty:
| seam | interactive-pty | headless-exec |
|---|---|---|
| launch | interactive `codex`/`claude` TUI (`buildLaunchLine`) | `buildHeadlessLine` (`codex exec --json` / `claude -p --output-format stream-json`) |
| terminalStartup | DSR-reply + cr-on-quiesce | none (no PTY handshake) |
| detectExit | `tmux has-session` GONE (resident → only on stop/idle) | process exits **naturally on completion** → session GONE → terminal |
| exit status | `resolveExitStatus` | exit 0 → `succeeded`, non-zero → `failed` |
| transcript | live PTY asciicast | structured per-runtime JSONL via `transcriptArtifact`/`parseTranscript` |
| gating | operator takeover / write-lock | none (fire-and-forget) |

**D4 — codex headless invocation (spike-exact).**
`codex exec --json -C <workspace> --ask-for-approval never --sandbox danger-full-access
--dangerously-bypass-hook-trust --skip-git-repo-check < /dev/null` (stdin redirect is **mandatory** —
codex 0.131 hangs on stdin otherwise). Resume: `codex exec resume <sid> "<prompt>" --json
--skip-git-repo-check < /dev/null` (NO `-s` — `exec resume` rejects it; sandbox inherited). Terminal
signal: the `turn.completed` event and/or process exit. The on-disk rollout stays
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`{timestamp,type,payload}`) — `parseRollout` already
handles it.

**D5 — claude headless invocation (spike-exact).**
`claude -p "<prompt>" --output-format stream-json --session-id <uuid>` (the uuid names the JSONL,
matching `claudeProjectSlug`). Resume: `claude -p "<next>" --resume <sid> --output-format stream-json`.
On-disk transcript `~/.claude/projects/<slug>/<sid>.jsonl`, slug = `replace(/[^a-zA-Z0-9]/g,'-')`
(spike-verified). A **new claude parser** maps the chained `{type,uuid,parentUuid,message}` records
(skipping `queue-operation`/`attachment`/`last-prompt`/`rate_limit_event` etc.) to the same
`SessionTurn[]` contract the codex parser produces.

**D6 — `readRolloutFromContainer` becomes runtime-aware.** It resolves the task's runtime, calls
`runtime.transcriptArtifact(ctx)` for `{dir, filenameGlob}`, pulls that path from the container, and
`parseRollout` dispatches to `runtime.parseTranscript`. Removes the hardcoded `~/.codex/sessions` +
`rollout-*.jsonl`. Fixes claude `no-rollout` across all read paths (MCP `get_transcript`, `/v1`,
session-history, durable capture).

**D7 — `agent-runtime` resident requirement is narrowed (BREAKING at spec).** The current "SHALL be a
RESIDENT continuous-conversation session" is scoped to `interactive-pty`. For `headless-exec`, a
finished agent process exits → the session-gone path resolves the task to terminal — no resident idle.

## Risks / Trade-offs

- **codex stdin hang** if `< /dev/null` is dropped (spike-caught) → mitigation: the headless launch
  line always redirects stdin; a golden test pins the exact argv.
- **claude JSONL schema drift** (rich, evolving record types) → the claude parser must be defensive
  (skip unknown types, degrade to honest omissions), mirroring `parseRollout`'s posture.
- **Headless tasks have no live terminal** in the console (no PTY/asciicast). Accepted: programmatic
  consumers want structured transcript, not xterm frames; a task created via API is not meant to be
  watched as a live terminal. Console-created tasks are unaffected (still interactive-pty).
- **Spec BREAKING**: relaxing the resident requirement must preserve console resident behavior exactly
  — the MODIFIED requirement keys resident on `interactive-pty`, so console is unchanged.
- **Long-running exec over the container**: the headless command runs minutes; it is launched detached
  (like today's tmux) and the liveness poller + boot re-adoption resolve completion — NOT a synchronous
  `/v1/shell/exec` call that would block. This keeps survive-api-redeploy guarantees.
