## Why

The `migrate-execution-to-aio-sandbox` change introduced the connect-in AIO execution layer, but a hands-on end-to-end pass against a live compose stack, real codex 0.131, and the operator's ChatGPT credentials exposed 10 real defects that `pnpm verify` (build-green) entirely masked. This change hardens that layer so the migrated execution path actually works against a real account and a reconnecting operator.

## What Changes

Already-applied fixes (confirm + lock down with specs/tests):

- **D1** — derived Dockerfile no longer runs `pnpm --filter X prune --prod` (fails on pnpm 10 "Unknown option: recursive"); prune removed so the image builds.
- **D2** — compose `api` now joins BOTH the default network and `cap-net` (was `cap-net`-only, dropping it off the default network and breaking postgres reachability, P1001); postgres stays default-only, sandboxes stay `cap-net`-only.
- **D3** — compose `api` runs as `user: root` so the non-root user can read the root-owned `/var/run/docker.sock` (was EACCES, breaking DooD); consistent with the host-root-equivalent threat model.
- **D4** — CPR detector byte sequence corrected from `\x1b[?6n` to `\x1b[6n` (codex emits hex `1b 5b 36 6e`, no `?`), so the cursor-position read is answered and codex no longer aborts.
- **D5** — `hooks.json` is COPYed to `/home/gem/.codex` + chowned `1000:1000` (was baked to `/root/.codex`, but codex runs as the `gem` user with `HOME=/home/gem`, so the hooks file was never found); the gem user is created by the AIO entrypoint at runtime.
- **D6** — the Dockerfile COPYs the whole `/repo` workspace plus a stable `/opt/cap/dist` symlink so the pnpm symlink farm resolves (was COPYing only `apps/sandbox-hooks/node_modules`, a dangling symlink farm causing hook `ERR_MODULE_NOT_FOUND` and fail-closed deny on every approval).

To-fix defects:

- **D7 (P0)** — bump `CODEX_VERSION` from `0.42.0` to a compatible release (`0.131`) and/or make it a configurable build-arg, and document the codex-version ↔ account-model compatibility. The `0.42` pin was chosen for live-frame byte-identity but 400s on `gpt-5`/`gpt-5-codex`/`o4-mini` for ChatGPT accounts and is unusable with the operator's real `gpt-5.5` model. Verified working: codex 0.131.0 + gpt-5.5. **BREAKING** (codex-version bump; changes baked runner image and the agent frame stream).
- **D8 / #1b (P1)** — rewrite the baked `hooks.json` and the hook entry script to the codex 0.131 Claude-Code-style hook protocol (hooks.json `{matcher, hooks:[{type:"command", command, timeout?}]}`; read the 0.131 stdin schema `{session_id, ..., tool_name, tool_input}`; translate to cap's `permission_request` frame, `POST /v1/approvals` via the existing routing (#1a already proved allow/deny/fail-closed), and emit the 0.131 `{hookSpecificOutput:{permissionDecision}}` / exit-code decision); launch codex with `--full-auto` + hook trust. **RISK:** even with the correct format + `--full-auto` + `--dangerously-bypass-hook-trust` + matcher `.*`, the `PreToolUse` hook still did not fire in live tests (codex#16732; 0.131 is a research preview). The rewrite MUST be gated behind a live verification and the design MUST specify a FALLBACK (approval enforced at a layer cap controls rather than relying on codex firing the hook). Do NOT assert "codex fires the hook" as already-true. **BREAKING** (hook protocol change).
- **D9 (P0)** — restore real reconnect under connect-in: (a) persist raw PTY output to `workspaces/<id>/session.log` on the orchestrator (`AioPtyClient`/gateway), keeping `snapshots.feed`'s byte-offset in lockstep; (b) back `SnapshotManager` with a REAL xterm headless terminal (replacing `NullHeadlessTerminal` whose `serialize()` is empty) so the visible-frame snapshot is non-empty; (c) verify a reconnecting operator replays prior output. Currently `buildReconnectFrames` returns nothing — the "Snapshot plus tail-replay reconnect" requirement is unsatisfied after the migration.
- **D10 (P0)** — clone the task repo into a dedicated EMPTY workspace dir (e.g. `/home/gem/workspace`) instead of `git clone <url> .` into the non-empty `/home/gem` (which fails "destination path already exists and is not an empty directory"), and PARSE the `/v1/shell/exec` response `exit_code`/`output` rather than only the HTTP `res.ok`, surfacing a real provision error on clone failure (it previously LOGGED "cloned task repository" on a silent failure because the response `exit_code:0` came from the trailing `| head` pipe).
- **Config gap** — confirm the compose passthrough of `MAX_CONCURRENT_TASKS` / `TASK_REPO_URL` to the `api` service (code reads them but compose did not pass them), and capture the open question that `TASK_REPO_URL` as a GLOBAL env is wrong for per-task semantics — the repo URL should be sourced PER TASK.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `aio-sandbox-execution`: D7 (CODEX_VERSION pin/build-arg + account-model compatibility), D8 (hook adapter re-cast to the codex 0.131 protocol with a fallback), D9 (session.log persistence in the orchestrator bridge), D10 (provision clone into an empty workspace dir + `/v1/shell/exec` exit-code/output parsing). Affects the "SandboxConnection handle returned from provisioning", "codex launched in-shell over the terminal channel", and "Blocking approval hooks re-homed via outbound HTTP callback" requirements. Base text is in `openspec/changes/migrate-execution-to-aio-sandbox/specs/aio-sandbox-execution/spec.md`.
- `realtime-terminal`: D9 — the "Snapshot plus tail-replay reconnect" requirement must be satisfied under connect-in (session.log persisted + non-empty headless snapshot recording cols/rows + tail replay), which is currently a no-op.
- `agent-events-and-approvals`: D8 / #1b — the "Blocking hook forwards the approval round-trip" and "Hooks baked into a version-pinned runner image" requirements re-cast onto the codex 0.131 hook protocol (format + stdin/stdout), launched with `--full-auto` + trust, WITH a documented fallback if codex hooks remain unreliable.
- `multi-target-deploy`: D1/D2/D3 (compose build/network/`docker.sock` fixes) + the `MAX_CONCURRENT_TASKS` / `TASK_REPO_URL` passthrough (with the per-task-repo-URL open question captured). Attaches to the "API target is Fly.io or docker-compose" and "Persistent volume for session.log survives restart" requirements (the latter tying back to D9).

## Impact

- **Dependency:** `harden-aio-execution` DEPENDS ON `migrate-execution-to-aio-sandbox` being archived first — its specs build on the `aio-sandbox-execution` capability that `migrate` ADDs (still unarchived in `openspec/changes/migrate-execution-to-aio-sandbox/`).
- **Code:** the derived runner Dockerfile + baked `hooks.json` and hook entry script (`apps/sandbox-hooks`); `AioPtyClient` / terminal gateway (session.log persistence); `SnapshotManager` / headless terminal backing; the AIO sandbox provider (clone target + `/v1/shell/exec` exit-code parsing); `readGuardrailsConfig` / provider config reads.
- **Infra / config:** `docker-compose.yml` (api networks, `user: root`, `MAX_CONCURRENT_TASKS` / `TASK_REPO_URL` passthrough); `CODEX_VERSION` build-arg.
- **Behavior changes:** codex-version bump (0.42 → 0.131) changes the baked image and the agent frame stream; the hook protocol changes to the codex 0.131 Claude-Code-style spec.
- **Risk:** D8 hook firing is unverified against codex 0.131 (research preview, codex#16732) — gated behind live verification with a required fallback path. The cap-side approval path (hook bundle → HTTP round-trip → operator decision) is already proven (#1a); the only gap is the codex → hook adapter plus codex actually firing it.
- **Open question:** `TASK_REPO_URL` per-task vs global sourcing (carried from the `migrate` design).
