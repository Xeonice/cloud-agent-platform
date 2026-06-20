# Research Brief — add-headless-execution-track

Side-car (NOT a tracked artifact). Grounds the proposal in the 2026-06-20 explore+spike.
Full record: memory `headless-execution-spike-findings`.

## Problem (diagnosed, with file:line)
- MCP / `/v1` API / console **share one** "interactive PTY + detached tmux" execution chain
  (`v1-tasks.controller.ts`: "the SAME TasksService the console uses"). Programmatic consumers
  are misconfigured onto a chain designed for console.
- Root: `AgentRuntime` port abstracts only ONE execution mode (interactive PTY), and the
  transcript capability is left OUT of the contract (`codex-runtime.ts:38` — capture lives in the
  retention path, "NOT a per-runtime seam").
- 3 symptoms: ① claude `no-rollout` ② task stuck `running` (resident never exits) ③ no programmatic multi-turn.
- Transcript chain is **codex-only**: `readRolloutFromContainer` (`aio-sandbox.provider.ts:483-512`)
  reads only `~/.codex/sessions` + matches only `rollout-*.jsonl`; `parseRollout` (`rollout-parser.ts`)
  only understands codex `{timestamp,type,payload}` dual-stream. Claude's `~/.claude/projects/<slug>/<uuid>.jsonl`
  matches neither → permanent no-rollout.
- Current `agent-runtime` spec actively LOCKS resident (2 archived changes: refactor-agent-runtime-policy-mechanism
  + align-claude-runtime-resident-session). Exit-detection requirement: "SHALL be a RESIDENT
  continuous-conversation session"; multi-turn bound to "operator types into live xterm".

## Spike evidence (empirical, exact production versions)
- **claude `-p` (2.1.183 ≈ pinned 2.1.181):** exits clean EXIT 0; `--output-format json` → array, final
  `type=result` with `result`+`session_id`; writes `~/.claude/projects/<slug>/<sid>.jsonl` with
  slug = `replace(/[^a-zA-Z0-9]/g,'-')` (**platform assumption verified correct**); JSONL is chained
  `{type,uuid,parentUuid,message,stop_reason:end_turn}` + many non-conversational types → **needs dedicated parser**;
  `--resume <sid>` continues SAME session (JSONL grew 13→23).
- **codex `exec` (exact 0.131.0 binary):** exits clean EXIT 0; ⚠️ **MUST `</dev/null`** or hangs on stdin;
  `--json` event stream `thread.started→turn.started→item.completed(agent_message)→turn.completed`
  (terminal signal = `turn.completed`); rollout `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
  `{timestamp,type,payload}` dual-stream (**platform parseRollout assumption verified correct**);
  `exec resume <sid> --json --skip-git-repo-check` continues SAME thread_id.
- 3 integration gotchas: codex needs `</dev/null`; `exec resume` flag-set ≠ `exec` (rejects `-s`,
  needs `--skip-git-repo-check`); non-git cwd needs `--skip-git-repo-check`.

## Decisions (user)
1. Programmatic (MCP/API) = pure fire-and-forget; NO gating/confirmation/interaction (console-only concepts).
2. Scope = dual-track, BOTH runtimes (user chose C, expanding the earlier "codex-only").
3. Pure container single-layer isolation; codex keeps `--sandbox danger-full-access` (no Landlock layering).
   Container is `seccomp=unconfined` (`aio-sandbox.provider.ts:76/277/785`).

## Constraints
- codex 0.131 pinned for gpt-5.5 account-model compatibility (Dockerfile matrix) — do NOT bump.
- Headless = JSON event stream, NOT live PTY frames → side-benefit: loosens the byte-identity version-pinning fragility.
