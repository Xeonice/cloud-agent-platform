## Why

Task execution today relies on a self-built dial-back runner: the orchestrator schedules a per-task cap-runner container that spawns codex under node-pty and DIALS BACK over WebSocket with a `TASK_TOKEN` handshake, leaving us to maintain the entire `apps/runner` package, the dial-back protocol, and runner credentials. We can replace this whole execution layer with AIO Sandbox (`agent-infra/sandbox`, ByteDance OSS, Apache-2.0), inverting to a connect-in model where the orchestrator dials INTO a managed sandbox terminal. Hands-on de-risking has already VALIDATED the two facts this hinges on: full-screen TUI ANSI passes byte-faithfully over AIO's `/v1/shell/ws` (the interactive-terminal invariant holds), and codex's startup CPR (DSR cursor-position) requirement can be satisfied entirely in our bridge layer via synthetic-CPR injection — so the migration deletes a large surface of bespoke code with no loss of fidelity.

## What Changes

- **Core inversion (dial-back OUT → connect-in IN)** — **BREAKING**: the orchestrator stops being a WS SERVER waiting for runners to dial back and instead dockerode-creates a per-task AIO Sandbox container and CONNECTS INTO its terminal WS as a WS CLIENT. Eliminates `?role=runner`, `dialback_handshake`, `TASK_TOKEN`, and `ORCHESTRATOR_WS_URL`/`host.docker.internal`.
- **`AioSandboxProvider`**: dockerode `createContainer` for `cap-aio-<taskId>` from the AIO image with `SecurityOpt:['seccomp=unconfined']` (REQUIRED), `ShmSize ~2g`, `AutoRemove`, `NetworkMode:'cap-net'`, and NO `PortBindings`; start, poll `/v1/docs` for readiness, git-clone the task repo via `POST /v1/shell/exec`, return a `SandboxConnection`; teardown = stop + remove.
- **`AioPtyClient`** (new `TerminalPty` implementation) replacing `RunnerPtyProxy`: an OUTBOUND WS into the sandbox `/v1/shell/ws` connecting WITHOUT `session_id` (new tmux session per task), translating AIO JSON frames (`output`/`input`/`resize`/`ping`/`pong`) ↔ the EXISTING base64 raw + control frame protocol the front-end xterm speaks.
- **CPR injection** (validated, REQUIRED): `AioPtyClient` watches the output stream and on seeing the DSR cursor query immediately sends a synthetic CPR `{type:"input",data:"\x1b[1;1R"}`, without which codex (crossterm) fails to start — fixed purely in our bridge layer, no AIO/tmux changes.
- **Derived sandbox image**: bake FROM the AIO image, pinning codex + `~/.codex/hooks.json` + compiled `dist/hooks`. codex runs INSIDE the AIO shell over `/v1/shell/ws` (execution model A; preserves the interactive TUI; exec/MCP are request/response and forbidden for the terminal channel).
- **Hooks re-homed**: blocking approval hooks (`permission_request`/`post_tool_use`) switch to an OUTBOUND HTTP callback from the sandbox to a NEW small orchestrator approvals endpoint reachable on `cap-net`, reusing the EXISTING `onPermissionRequest`/`onDecision` routing (only the transport changes).
- **Exit/startup detection**: node-pty `onExit` is gone; `AioPtyClient` detects WS close and uses `/v1/shell/exec` `echo $?` / `/v1/shell/wait` to map to guardrails `recordSuccess`/`recordFailure`.
- **`SandboxProvider` port redesign**: `ProvisionContext` drops `taskToken`; `provision()` returns `SandboxConnection { taskId, baseUrl, wsUrl }` instead of `void`; `getSandboxMode()` becomes informational (AIO is the container boundary, `seccomp=unconfined`); `teardownSandbox` unchanged.
- **DooD docker-compose changes**: mount `/var/run/docker.sock` into the `api` service (currently NOT mounted — a real gap); add a user-defined network `cap-net` and join `api` to it; sandboxes attach to `cap-net`, are dialed by container name, and publish NO host port. Security boundary becomes NETWORK ISOLATION.
- **Deletions** — **BREAKING**: the entire `apps/runner` package (dialback-client, spawn-codex/node-pty, task-entry, startup-window, session-log producer, notify, runner Dockerfile); `DockerSandboxProvider`; the gateway dial-back half (`onDialbackHandshake`, `ConnectionKind 'runner'`, `?role=runner`, `onRunnerRawFrame`, runner-disconnect branch); the `dialback_handshake` control frame + `packages/contracts` `dialback.ts` + `TaskTokenService` dial-back verify; and the `ORCHESTRATOR_WS_URL`/`RUNNER_IMAGE`/`RUNNER_AGENT_BIN` env.
- **Fly dropped as an execution target** — **BREAKING**: execution is now docker-compose SELF-HOST ONLY (Firecracker microVMs expose no host docker socket, so DooD sibling provisioning is impossible). Fly may still host the orchestrator, but task execution requires the compose self-host topology.

## Capabilities

### New Capabilities
- `aio-sandbox-execution`: `AioSandboxProvider` provisioning per-task AIO containers; `AioPtyClient` connect-in terminal bridge with CPR injection and JSON↔cap frame translation; codex-in-sandbox launch over `/v1/shell/ws`; hooks re-homed via outbound HTTP approval callback; and WS-close + `exec`/`wait`-based exit detection mapped to guardrails.

### Modified Capabilities
- `sandbox-provider-port`: `provision()` returns a `SandboxConnection` (not `void`) and `ProvisionContext` drops `taskToken`; `getSandboxMode()` becomes informational.
- `realtime-terminal`: the `TerminalSession.pty` backend is `AioPtyClient` (outbound connect-in) instead of `RunnerPtyProxy`, and the gateway dial-back half is removed; everything above the `TerminalPty` seam is unchanged.
- `multi-target-deploy`: execution is compose self-host only with DooD `docker.sock` mount + `cap-net`; Fly is dropped as an execution target (orchestrator may still run on Fly).

### Removed Capabilities
- `runner-dialback-and-creds`: the entire OUTBOUND dial-back model — cap-runner provisioning plus the `TASK_TOKEN` dial-back handshake — is obsolete under connect-in.
- `terminal-execution` (node-pty runner): the self-built node-pty runner that spawned codex is removed; AIO is the runner now.

## Impact

- **Affected code**: `apps/runner` (deleted in full); `terminal.gateway.ts` (`TerminalPty` seam kept; `RunnerPtyProxy` → `AioPtyClient`; dial-back half removed); the `SANDBOX_PROVIDER` DI token / `sandbox.module` seam (`DockerSandboxProvider` → `AioSandboxProvider`); `guardrails.startRunning` (consumes the returned `SandboxConnection` handle so the gateway opens `AioPtyClient` to `handle.wsUrl`); a NEW orchestrator approvals HTTP endpoint on `cap-net`.
- **Contracts/env**: `packages/contracts` `dialback.ts` removed; `TaskTokenService` dial-back verify removed; env `ORCHESTRATOR_WS_URL`/`RUNNER_IMAGE`/`RUNNER_AGENT_BIN`/`TASK_TOKEN` removed.
- **Infra/deps**: docker-compose mounts `/var/run/docker.sock` into `api` and adds `cap-net`; a derived sandbox image is built FROM `ghcr.io/agent-infra/sandbox` (pin a tag, NOT `:latest`); AIO containers are heavy (~2–8g RAM each); dockerode is the provisioning surface.
- **Unchanged (KEPT) above the seam**: web ws-client, operator connect-auth / `AUTH_TOKEN`, `WriteLockService` lease/takeover, approval routing, `BackpressureController` + ACK, `SnapshotManager` + `session.log`, guardrails admit/onTerminal/forceFail/teardown, and the `TerminalSession` registry.
- **Risks**: `docker.sock` mount = host-root-equivalent for `api` (acceptable for single-user self-host, must be stated); reconnect `restore_output` scope is unquantified, so `SnapshotManager` stays authoritative; backpressure toward the AIO producer has no in-band pause/resume (`AioPtyClient` can only socket-pause the WS read side; the per-operator ACK window still protects each browser).
