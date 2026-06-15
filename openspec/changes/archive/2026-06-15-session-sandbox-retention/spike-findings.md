# Spike findings — sandbox retention + read-only history replay

Live spikes run against the local compose backend (api + postgres + the
`cap-aio-sandbox:pinned` image) with the operator's own ChatGPT codex login
injected via `CODEX_CHATGPT_AUTH_JSON_B64`. Real tasks (octocat/Hello-World)
provisioned, codex authenticated and ran real turns. Every claim below was
observed live, not inferred.

## A. codex writes a structured conversation record (its own rollout)

- Interactive codex 0.131 (this platform's connect-in TUI mode — see
  `codex-launch.ts`, NOT `codex exec`) persists a per-session **rollout JSONL** at
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-TS>-<UUID>.jsonl`. ONE file per
  session. `~/.codex/history.jsonl` also exists but is only the global user-input
  lines — capture must glob `rollout-*.jsonl`, NOT `history.jsonl`.
- The rollout is a clean, renderable conversation. Observed line types over one
  full turn (each line `{timestamp, type, payload}`):
  - `session_meta` (id / cwd / cli_version / originator / source)
  - `event_msg` (task_started, user_message, agent_message, token_count, task_complete)
  - `response_item` with payload.type ∈ { message(role: developer|user|assistant),
    function_call, function_call_output }
  This is exactly the scrollable user-prompt / assistant-text / tool-call+output
  transcript the history-replay page renders.
- Rollout is flushed **per turn** (it had a complete 23-line turn incl.
  `task_complete` while the task was still `running`) — so on an abnormal stop,
  every turn completed before the interruption is already on disk.

## B. The real problem: container teardown destroys it

- `createContainer` sets `HostConfig.AutoRemove: true`
  (`aio-sandbox.provider.ts`) → a stopped container is auto-removed by the Docker
  daemon. `teardownSandbox` additionally `stop({t:0})` + `remove({force})`.
- After a task settles its `cap-aio-<id>` container is torn down and the rollout
  (inside the container, NOT a mounted volume) vanishes with it. No capture today.
- `forceFail` (`guardrails.service.ts`) is the SINGLE chokepoint for every
  abnormal terminal cause (deadline / idle / circuit_breaker / abnormal_exit /
  provision_failed); it `await teardownSandbox` then `teardownSession` +
  `semaphore.release`.

## C. Keeping the container: stop preserves everything (read-only replay)

Experimentally flipped `AutoRemove:false` + `teardownSandbox` stop-only:
- The stopped container **survives** (`Exited`, not auto-removed). Its filesystem
  is frozen 100%: rollout, workspace (incl. `.git` + codex's changes), and all of
  `~/.codex`. **Includes abnormally-terminated tasks** — SIGKILL only kills the
  processes, not the filesystem.
- Read-only replay is then trivial: `docker cp` the rollout out of the STOPPED
  container (no restart needed) — read 23 lines back. The persisted `session.log`
  (raw PTY bytes, on the orchestrator's workspaces volume) cold-replays into a
  read-only xterm and gives the full colored scrollable terminal for a clean exit
  (verified in a prior spike); for an abnormal stop it is only a half-painted TUI,
  which is exactly why the structured rollout is the faithful context source.

## D. Resume-run: bare `docker start` fails, commit+entrypoint works

- Bare `docker start` of the stopped container → **exit 1**: AIO's
  `/opt/gem/run.sh` has `set -e` + one-shot init (`mv /opt/gem/bashrc …`, etc.)
  that already consumed its source files on first boot → `mv: cannot stat
  '/opt/gem/bashrc'`. The image is NOT designed to restart. (`run.sh` is supervisord
  for 14 services — vnc/code-server/gem-server/nginx/jupyter/mcp-*/browser… — not
  a single codex process.)
- **Working resume path (verified):** `docker commit <stopped container>` → run a
  NEW container from that image with `--entrypoint /opt/gem/entrypoint.sh`
  (skipping the non-idempotent `run.sh` init — `run.sh` itself ends with `exec
  /opt/gem/entrypoint.sh`). Result: container boots healthy (supervisord + service
  stack up), AND the prior session's rollout (23 lines) + workspace (.git +
  changes) are intact, AIO HTTP API answers. So resume is viable; the remaining
  work (re-inject fresh codex auth, re-attach PTY, take a slot) is orchestrator
  glue. NOTE: resume-run is a follow-up; the page ships read-only first.

## E. Disk (the real constraint on a 160GB VPS)

- A single container that ran one turn: writable layer **~106MB**. Of which
  `~/.codex` is **92MB** (codex cache + `logs_*.sqlite` — NOT the conversation),
  rollout is **52KB**, workspace 188KB (this repo; real projects larger).
- Decision: **trim cache before stop** — delete `~/.codex/cache` +
  `~/.codex/logs_*.sqlite`, keep only `~/.codex/sessions` + workspace →
  ~106MB → ~15MB per kept container, so retention (default 30 days) holds far
  longer. Trade-off: a resumed task re-fetches the model cache on its first turn.

## F. Caveats reconfirmed

- The injected ChatGPT token auto-refreshed (a week-old access_token worked via
  its refresh_token — no re-login). Each task burns real ChatGPT quota.
- `onApplicationBootstrap` reap currently force-removes ALL `cap-aio-*` — with
  retention it MUST reap only RUNNING orphans, else a Dokploy redeploy / api
  restart wipes the kept history.
- `provision_failed` / `agent_failed_to_start`: codex never ran → no rollout
  (maybe no container) → the page degrades honestly ("无可回看内容 + 失败原因").
- Reference for the transcript rendering: the mature OSS ecosystem already does
  this (8+ repos turning rollout JSONL into HTML). `masonc15/codex-transcript-viewer`
  is the most complete model — single-file HTML with a review sidebar (search + 5
  filter presets: 默认/无工具/用户/答案/全部), final answers green-tinted + labeled,
  commentary italic+muted distinct from final answers, inline token counts. The
  design baseline (`design-baseline/history-replay-preview.html`) adopts these.
