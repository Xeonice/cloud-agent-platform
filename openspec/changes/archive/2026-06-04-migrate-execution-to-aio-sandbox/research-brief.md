# Research Brief — Migrate Execution Layer to AIO Sandbox

> Side-car file (not a tracked OpenSpec artifact). Captures the VALIDATED design brief for
> replacing the self-built dial-back runner execution layer with AIO Sandbox
> (`agent-infra/sandbox`, ByteDance OSS, Apache-2.0). The design is already validated by
> hands-on de-risking; this brief is grounded entirely in those verified facts.

## AIO Sandbox — verified API facts

- **Image**: `ghcr.io/agent-infra/sandbox` (verified with `:latest`; pin a tag for prod).
- **Run flags**: `--security-opt seccomp=unconfined -p 8080:8080`. `seccomp=unconfined` is
  REQUIRED. Single port `8080`.
- **Interactive PTY terminal**: `ws://<host>:8080/v1/shell/ws`.
  - Connecting **WITHOUT** `session_id` creates a new tmux-backed session; server sends
    `{type:"session_id"}` then `{type:"ready"}`.
  - Passing `?session_id=` to REJOIN a session that is not attached returns an immediate
    error frame and closes — so `AioPtyClient` MUST connect WITHOUT `session_id` (new session
    each task).
- **WS frame protocol (JSON text)**:
  - client -> server: `{type:"input",data}` / `{type:"resize",data:{cols,rows}}` /
    `{type:"pong",timestamp}`
  - server -> client: `{type:"output",data}` / `"session_id"` / `"ready"` / `"ping"`
- **TUI fidelity (VERIFIED)**: full-screen TUI ANSI passes VERBATIM in output frames — vim
  alt-screen (`\x1b[?1049h`, cursor-addressing `\x1b[r;cH`, `\x1b[?25l`, SGR, bracketed-paste)
  all byte-faithful. Resize round-trips (after `resize{123x37}`, `tput cols/lines` returns
  123x37). The D1 byte-identical interactive-terminal invariant HOLDS over AIO.
- **HTTP exec (non-interactive, shares the tmux session by id)**:
  - `POST /v1/shell/exec {id,command,async_mode}` + `/v1/shell/wait` + `/v1/shell/view`
  - `POST /v1/shell/sessions/create`
  - files under `/v1/file/*`
  - MCP at `/mcp`; VSCode at `/code-server/`; OpenAPI at `/v1/docs`
- **Auth**: OPEN by default (no token). Security boundary = **NETWORK ISOLATION**: sandboxes
  publish NO host port; they live only on a private docker network reachable solely by the
  orchestrator.

## De-risk results (TUI fidelity + CPR injection)

- **TUI fidelity**: confirmed verbatim ANSI passthrough and resize round-trip (see verified
  API facts above). The interactive-terminal invariant is preserved.
- **CPR injection (CRITICAL VERIFIED IMPLEMENTATION DETAIL)**:
  - codex (crossterm) on startup emits a DSR cursor-position query (`\x1b[6n`) and waits for a
    CPR reply (`\x1b[row;colR`). AIO's terminal does NOT reply CPR in time, so codex FAILS to
    start: `Error: The cursor position could not be read within a normal duration` (548 bytes,
    no TUI).
  - **Solution (hands-on verified)**: `AioPtyClient` watches the output stream; on seeing
    `\x1b[6n` (standard DSR-6, NO `?`) it immediately sends an input frame `{type:"input",data:"\x1b[1;1R"}` (synthetic
    CPR). With this, codex starts and renders its Welcome TUI (32631 bytes, 256-color,
    cursor-addressing).
  - This CPR injection is a REQUIRED, validated part of `AioPtyClient`. It makes codex-on-AIO
    work purely in our bridge layer (no AIO/tmux changes).

## Target architecture (connect-in)

### Core inversion: dial-back OUT -> connect-in IN

- **Today**: orchestrator schedules a per-task cap-runner container; the runner spawns codex
  under node-pty and DIALS BACK over WS (`?role=runner` + `dialback_handshake{taskId,TASK_TOKEN}`,
  base64 raw frames + control frames; `RunnerPtyProxy` wraps that inbound socket as the
  `TerminalSession.pty`). Orchestrator is a WS SERVER on the runner side.
- **After**: orchestrator dockerode-creates a per-task AIO Sandbox container and CONNECTS INTO
  its terminal WS. Orchestrator is a WS CLIENT on the sandbox side. No dial-back, no
  `?role=runner`, no `dialback_handshake`, no `TASK_TOKEN`, no
  `ORCHESTRATOR_WS_URL`/`host.docker.internal`.

### The seam stays; only the pty backend swaps

- **KEPT seam** = `TerminalSession.pty` (the `TerminalPty` interface in `terminal.gateway.ts`).
  New class `AioPtyClient` implements `TerminalPty`, fed by an OUTBOUND ws into the sandbox,
  translating AIO JSON frames <-> the EXISTING base64 raw + control frame protocol the
  front-end xterm speaks.
- **Everything ABOVE the seam is unchanged**: web ws-client, operator `AUTH_TOKEN`
  connect-auth, `WriteLockService` lease/takeover, approval routing
  (`onPermissionRequest`/`onDecision`), backpressure/ACK, `SnapshotManager` + `session.log`,
  guardrails admit/forceFail/teardown.

### Frame translation

- AIO `output` -> `AioPtyClient.emitData` -> existing `streamRawChunk` (base64 raw)
- operator keystroke (lock-gated) -> `{type:"input"}`
- resize -> `{type:"resize"}`
- AIO `ping` -> auto `pong` (internal, NOT the operator write-lease heartbeat)
- DSR `\x1b[6n` (standard DSR-6, no `?`) -> inject CPR

### SandboxProvider port redesign

- `ProvisionContext` drops `taskToken` (no dial-back to auth).
- `provision()` returns a `SandboxConnection { taskId, baseUrl: http://cap-aio-<taskId>:8080,
  wsUrl: ws://cap-aio-<taskId>:8080/v1/shell/ws }` instead of `void`.
- `teardownSandbox` unchanged.
- `getSandboxMode()` becomes informational (AIO is the container boundary;
  `seccomp=unconfined`).

### AioSandboxProvider.provision

- `dockerode createContainer({ Image: AIO_IMAGE, name: cap-aio-<taskId>,
  Env:[WORKSPACE=/home/gem], HostConfig:{ SecurityOpt:['seccomp=unconfined'], ShmSize ~2g,
  AutoRemove:true, NetworkMode:'cap-net' }, NO PortBindings })`
- start, poll `/v1/docs` readiness, git-clone the task repo via `POST /v1/shell/exec`, return
  `SandboxConnection`.
- teardown = stop + remove.

### Agent execution + hooks

- codex runs INSIDE the AIO shell over `/v1/shell/ws` (model A; preserves the interactive TUI;
  exec/MCP are request/response and forbidden for the terminal channel per
  `assertInteractiveArgs`).
- **DECIDED**: bake a derived image FROM the AIO image pinning codex + `~/.codex/hooks.json` +
  compiled `dist/hooks`, and re-home the blocking approval hooks
  (`permission_request`/`post_tool_use`) with an OUTBOUND HTTP callback from the sandbox to a
  NEW small orchestrator approvals endpoint reachable on `cap-net`, reusing the EXISTING
  `onPermissionRequest`/`onDecision` routing (only the transport changes).
- **Exit/startup detection**: node-pty `onExit` is gone; `AioPtyClient` detects WS close + uses
  `/v1/shell/exec` `echo $?` / `/v1/shell/wait` to map to guardrails
  `recordSuccess`/`recordFailure`.

### Deployment topology

- **DECIDED**: per-task one AIO container (clean isolation/teardown; ~2-8g RAM each).
- **DECIDED**: execution layer supports docker-compose SELF-HOST ONLY. Fly is DROPPED as an
  execution target (Firecracker microVMs expose no host docker socket, so DooD sibling
  provisioning is impossible). Fly may still host the orchestrator, but task execution requires
  the compose self-host topology.
- **DooD compose changes**:
  - mount `/var/run/docker.sock` into the `api` service (currently NOT mounted — a real gap)
  - add a user-defined network `cap-net` (default bridge has no container-name DNS) and join
    `api` to it
  - `AioSandboxProvider` attaches each sandbox to `cap-net` and dials it by container name;
    sandboxes publish NO host port.
  - Note: mounting docker.sock = host-root-equivalent for the `api` (acceptable for
    single-user self-host, must be stated).

## KEEP / ADAPT / DELETE

### KEEP

- web ws-client
- operator connect-auth / `AUTH_TOKEN`
- `WriteLockService`
- approval routing (`onPermissionRequest`/`onDecision`/`pendingApprovals`)
- `BackpressureController` + ACK
- `SnapshotManager` + `session.log`
- guardrails (semaphore/deadline/idle/circuit-breaker, admit/onTerminal/forceFail)
- `SandboxProvider` port + `SANDBOX_PROVIDER` DI token + `sandbox.module` seam
- `TerminalPty` interface + `TerminalSession` registry

### ADAPT

- `ProvisionContext` (drop `taskToken`) + `provision()` return `SandboxConnection`
- `guardrails.startRunning` (consume the returned handle; gateway opens `AioPtyClient` to
  `handle.wsUrl`)
- `getSandboxMode` informational
- docker-compose (docker.sock mount + `cap-net`)
- approval hooks re-homed (outbound HTTP callback)
- `RunnerPtyProxy` REPLACED by `AioPtyClient`

### DELETE

- entire `apps/runner` package (`main.ts`/`composeRunnerTask`, dialback-client,
  spawn-codex/node-pty, task-entry, startup-window, session-log producer, notify, runner
  Dockerfile)
- `DockerSandboxProvider` (current dockerode cap-runner +
  `ORCHESTRATOR_WS_URL`/`TASK_TOKEN`/`host.docker.internal`)
- gateway dial-back half (`onDialbackHandshake`, `ConnectionKind 'runner'`, `?role=runner`,
  `onRunnerRawFrame`, runner-disconnect branch)
- `dialback_handshake` control frame + `packages/contracts` `dialback.ts` + `TaskTokenService`
  dial-back verify
- `ORCHESTRATOR_WS_URL`/`RUNNER_IMAGE`/`RUNNER_AGENT_BIN` env

## Decisions

- **Agent execution model A**: codex runs INSIDE the AIO shell over `/v1/shell/ws` (preserves
  the interactive TUI; exec/MCP are request/response and forbidden for the terminal channel per
  `assertInteractiveArgs`).
- **Derived image**: bake FROM the AIO image, pinning codex + `~/.codex/hooks.json` + compiled
  `dist/hooks`.
- **Hooks re-homed**: blocking approval hooks (`permission_request`/`post_tool_use`) use an
  OUTBOUND HTTP callback from the sandbox to a NEW small orchestrator approvals endpoint on
  `cap-net`, reusing existing `onPermissionRequest`/`onDecision` routing (only transport
  changes).
- **Exit detection**: `AioPtyClient` detects WS close + uses `/v1/shell/exec` `echo $?` /
  `/v1/shell/wait` to map to guardrails `recordSuccess`/`recordFailure`.
- **Deployment**: per-task one AIO container.
- **Execution = compose self-host only**; Fly dropped as an execution target (orchestrator may
  still run on Fly).
- **DooD**: mount `/var/run/docker.sock` into `api`; add `cap-net`; sandboxes publish NO host
  port and are dialed by container name.

### Capabilities for this change

- **NEW: `aio-sandbox-execution`** — `AioSandboxProvider` provisioning AIO containers;
  `AioPtyClient` connect-in terminal bridge with CPR injection + JSON<->cap frame translation;
  codex-in-sandbox launch; hooks re-homed via outbound HTTP approval callback; exit detection.
- **MODIFIED: `sandbox-provider-port`** — `provision` returns `SandboxConnection`, mode
  informational.
- **MODIFIED: `realtime-terminal`** — the `TerminalSession.pty` backend is `AioPtyClient` not
  `RunnerPtyProxy`; gateway dial-back half removed.
- **MODIFIED: `multi-target-deploy`** — execution = compose self-host only + DooD docker.sock +
  `cap-net`; Fly dropped as execution target.
- **REMOVED: `runner-dialback-and-creds`** — the entire OUTBOUND dial-back model + cap-runner +
  `TASK_TOKEN` dial-back handshake is obsolete; terminal-execution's self-built node-pty runner
  (AIO is the runner now).

## Risks

- **docker.sock mount = host-root-equivalent** for the `api` service (acceptable for
  single-user self-host, must be stated).
- **AIO container heavy** (2-8g RAM each).
- **reconnect `restore_output` scope unquantified** — keep `SnapshotManager` authoritative.
- **pin the AIO image tag** (avoid `:latest`); confirm ghcr pull in self-host.
- **backpressure toward the AIO producer has no in-band pause/resume** — `AioPtyClient` can only
  socket-pause the WS read side; the per-operator ACK window still protects each browser.
