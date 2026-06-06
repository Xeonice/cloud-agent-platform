## Context

Task execution today runs on a **self-built dial-back runner**. The orchestrator (`apps/api`) acts as a WebSocket **server**; for each task it dockerode-creates a `cap-runner` container (`DockerSandboxProvider`) that spawns codex under `node-pty` and **DIALS BACK** to the orchestrator over WS (`?role=runner` + a `dialback_handshake{taskId, TASK_TOKEN}` frame, then base64 raw + control frames). `RunnerPtyProxy` wraps that *inbound* runner socket and presents it as the `TerminalSession.pty`. This forces us to own and maintain the entire `apps/runner` package, the dial-back protocol (`packages/contracts/dialback.ts`), per-task credentials (`TASK_TOKEN` via `TaskTokenService`), and the runner's `ORCHESTRATOR_WS_URL`/`host.docker.internal` plumbing.

The **target** replaces this whole execution layer with **AIO Sandbox** (`agent-infra/sandbox`, ByteDance OSS, Apache-2.0). The orchestrator becomes a WS **client**: it dockerode-creates a per-task AIO container and **CONNECTS INTO** the container's terminal WebSocket (`/v1/shell/ws`). The architectural inversion is **dial-back OUT → connect-in IN**.

This migration is grounded in `research-brief.md`, which records hands-on de-risking that already VALIDATED the two facts the design hinges on:

1. **TUI fidelity** — full-screen TUI ANSI passes byte-faithfully over AIO `/v1/shell/ws` output frames (vim alt-screen `\x1b[?1049h`, cursor-addressing, `\x1b[?25l`, SGR, bracketed-paste all verbatim; `resize{cols,rows}` round-trips so `tput cols/lines` reflects it). The D1 byte-identical interactive-terminal invariant **HOLDS** over AIO.
2. **CPR injection** — codex (crossterm) emits a DSR cursor-position query on startup and aborts (`Error: The cursor position could not be read within a normal duration`, 548 bytes, no TUI) because AIO's terminal does not reply CPR in time. Watching the output stream and injecting a synthetic CPR in our bridge layer makes codex start and render its Welcome TUI (32631 bytes). This is fixed **entirely below the seam**, with no AIO/tmux changes.

The design's load-bearing constraint is that **the `TerminalPty` seam stays; only the PTY backend swaps**. Everything above `TerminalSession.pty` — web ws-client, operator `AUTH_TOKEN` connect-auth, `WriteLockService`, approval routing, `BackpressureController` + ACK, `SnapshotManager` + `session.log`, guardrails — is unchanged. `RunnerPtyProxy` is replaced by a new `AioPtyClient` that connects OUT and translates AIO JSON frames ↔ the existing base64 raw + control-frame protocol the front-end xterm speaks.

**Constraints / stakeholders:** single-user self-host operator (security model is single-tenant). AIO's HTTP API is **open by default (no token)**; the security boundary is **network isolation** — sandboxes publish NO host port and live only on a private docker network (`cap-net`) reachable by the orchestrator. AIO containers are heavy (~2–8 GB RAM each) and require `--security-opt seccomp=unconfined`.

## Goals / Non-Goals

**Goals:**
- Invert execution from dial-back OUT to connect-in IN, with the orchestrator as the WS client into AIO `/v1/shell/ws`.
- Swap the PTY backend (`RunnerPtyProxy` → `AioPtyClient`) while keeping the `TerminalPty` seam and every layer above it byte-for-byte identical to the browser.
- Preserve the verified interactive-terminal invariant (byte-identical live frame) and make codex-on-AIO start reliably via in-bridge CPR injection.
- Delete the entire self-built runner surface (`apps/runner`, dial-back protocol, `TASK_TOKEN`, runner env) with no loss of fidelity.
- Re-home blocking approval hooks over an outbound HTTP callback, reusing the existing `onPermissionRequest`/`onDecision` routing (transport-only change).
- Establish the DooD compose self-host topology (`docker.sock` mount + `cap-net`) as the single execution topology.

**Non-Goals:**
- Multi-tenant / multi-user isolation hardening (single-user self-host is the accepted threat model; `docker.sock` = host-root-equivalent is accepted, not mitigated).
- Running task execution on Fly (Firecracker exposes no host docker socket → DooD impossible). Fly may still host the *control plane* orchestrator.
- Changing the browser-facing two-channel protocol (base64 raw + control frames) or any layer above the seam.
- Byte-matching scrollback history (only the **live frame** is byte-identity-bound; `SnapshotManager` stays authoritative for reconnect).
- Replacing codex with the AIO `exec`/MCP request/response surfaces for the interactive channel (execution model A keeps codex in-shell over `/v1/shell/ws`).
- Container pooling / warm-pool optimization (per-task container is the chosen model; pooling is an open question, not in scope).

## Decisions

### (D) Connect-in inversion — orchestrator becomes the WS client
**Decision:** The orchestrator stops being a WS server waiting for runners to dial back. For each task it dockerode-creates a per-task AIO container and opens an **OUTBOUND** WebSocket into that container's `/v1/shell/ws` terminal, addressing it by container name over `cap-net`.

**Rationale:** Dial-back existed so a sandbox with no inbound port could still reach the orchestrator. AIO already exposes a terminal WS, and network isolation (no host port; reachable only on `cap-net`) provides the same "no public inbound surface" property without us owning a dial-back protocol or per-task credentials. Inverting collapses an entire bespoke surface (`?role=runner`, `dialback_handshake`, `TASK_TOKEN`, `ORCHESTRATOR_WS_URL`, `host.docker.internal`) into "dial a container by name."

**Alternatives considered:** Keep dial-back and run codex in AIO that dials back — rejected: would require AIO to embed our dial-back client (defeats the point of adopting it) and keeps the whole protocol. Use AIO `exec`/MCP request/response instead of the terminal WS — rejected: loses the interactive TUI (`assertInteractiveArgs` forbids `exec`/MCP for the terminal channel).

### (D) `AioPtyClient` as the `TerminalPty` swap — frame translation below the seam
**Decision:** A new `AioPtyClient implements TerminalPty` is the sole new code at the seam. It owns the outbound WS into the sandbox and **translates** AIO JSON frames ↔ the existing base64 raw + control-frame protocol. Nothing above `TerminalSession.pty` changes.

**Frame translation table:**

| Direction | AIO JSON frame | Cap / browser side |
| --- | --- | --- |
| sandbox → orchestrator | `{type:"output", data}` | `emitData` → existing `streamRawChunk` (base64 raw) into the unchanged pipeline |
| orchestrator → sandbox | `{type:"input", data}` | operator keystroke (lock-gated by `WriteLockService`) |
| orchestrator → sandbox | `{type:"resize", data:{cols,rows}}` | resize event |
| sandbox → orchestrator | `{type:"session_id"}` then `{type:"ready"}` | session-established signal (terminal considered live) |
| sandbox → orchestrator | `{type:"ping"}` | auto `{type:"pong", timestamp}` — **internal**, distinct from the operator write-lease heartbeat |
| sandbox → orchestrator | DSR `\x1b[6n` inside an `output` frame | inject CPR `{type:"input", data:"\x1b[1;1R"}` (see below) |

**Rationale:** Keeping the seam means the entire validated stack above it (write-lock lease/takeover, approval routing, backpressure/ACK, snapshots, guardrails) is reused verbatim. The translation table is the complete contract between AIO's protocol and ours; everything else is a re-emit into existing functions.

**Alternatives considered:** Translate inside the gateway rather than a discrete `TerminalPty` impl — rejected: would leak AIO frame shapes into the gateway and break the clean swap. Teach the front-end to speak AIO JSON directly — rejected: changes a layer that must stay unchanged and couples the browser to a backend protocol.

### (D) ★ CPR injection — the verified codex-on-AIO fix
**Decision:** `AioPtyClient` watches the sandbox output stream and, on observing the DSR cursor-position query **`\x1b[6n`**, immediately sends a synthetic CPR reply input frame **`{type:"input", data:"\x1b[1;1R"}`** to the sandbox. This is a REQUIRED part of the bridge, performed entirely in our layer with **no AIO or tmux changes**.

**Rationale (verified):** codex uses crossterm, which on startup emits the DSR query and **blocks** waiting for a CPR reply (`\x1b[row;colR`). AIO's tmux-backed terminal does not reply CPR in time, so codex aborts before rendering (`Error: The cursor position could not be read within a normal duration` — 548 bytes, no TUI). Injecting the synthetic CPR (`\x1b[1;1R` = cursor at row 1, col 1) unblocks crossterm and codex renders its Welcome TUI (32631 bytes, 256-color, cursor-addressing). The exact byte detail (`\x1b[6n` → `\x1b[1;1R`) is the hands-on-verified fix and must be matched precisely. NOTE: crossterm emits the STANDARD DSR `\x1b[6n` with NO `?` (byte-verified against the live sandbox — `1b 5b 36 6e`); the private-mode `\x1b[?6n` form is NOT emitted, and matching it silently disables CPR injection so codex never starts.

**Alternatives considered:** Patch AIO/tmux to reply CPR — rejected: requires forking the sandbox image and re-homing the fix upstream; the brief mandates the bridge-layer fix. Disable codex's cursor probe via a codex flag — rejected: not reliably available and would change codex behavior; the bridge fix is non-invasive and already validated.

### (D) Connect WITHOUT `session_id` — new tmux session per task
**Decision:** `AioPtyClient` opens the terminal WS **without** any `?session_id=` query parameter, so AIO creates a fresh tmux-backed session. It treats the server-sent `session_id` then `ready` frames as the established signal and never attempts to rejoin a prior session.

**Rationale (verified):** Connecting without `session_id` is the documented "new session" path. Passing `?session_id=` to REJOIN a session that is not currently attached returns an **immediate error frame and closes**. Since per-task containers are ephemeral and there is no cross-process session to resume, always creating a new session is correct and avoids the reject-and-close failure mode. Reconnect/restore for the operator is handled above the seam by `SnapshotManager`, not by tmux session rejoin.

**Alternatives considered:** Reuse a `session_id` for operator reconnect — rejected: the rejoin path errors when unattached and `SnapshotManager` already owns reconnect/restore authoritatively, so tmux rejoin is both fragile and redundant.

### (D) `SandboxProvider.provision()` returns a `SandboxConnection`
**Decision:** The port's `provision()` returns a `SandboxConnection { taskId, baseUrl: http://cap-aio-<taskId>:8080, wsUrl: ws://cap-aio-<taskId>:8080/v1/shell/ws }` instead of `void`. `ProvisionContext` drops `taskToken` (no dial-back to authenticate). `getSandboxMode()` becomes **informational** (the real boundary is the AIO container + `seccomp=unconfined` + network isolation, not the reported `read-only`/`workspace-write`/`danger-full-access` mode). `teardownSandbox` is unchanged.

**Rationale:** Under connect-in the caller needs an *address* to dial; `void` no longer suffices. `guardrails.startRunning` consumes the returned handle and the gateway opens `AioPtyClient` to `handle.wsUrl`. Dropping `taskToken` reflects that there is no inbound connection to authenticate. The mode stays on the port for compatibility/observability but is downgraded to metadata because AIO is the actual isolation boundary.

**Alternatives considered:** Side-channel the address via a registry the gateway queries — rejected: indirection for no gain; the handle is the natural return value. Keep `taskToken` for future auth — rejected: dead field; reintroduce only if AIO auth is enabled later (Open Question).

### (D) DooD via `docker.sock` + `cap-net`, no host port — network isolation as the security boundary
**Decision:** The compose `api` service mounts `/var/run/docker.sock` so the orchestrator can provision **sibling** AIO containers (Docker-out-of-Docker). A user-defined network **`cap-net`** is defined and joined by `api` (the default bridge has no container-name DNS). Each per-task sandbox attaches to `cap-net`, is dialed **by container name** (`cap-aio-<taskId>`), and publishes **NO host port**. **Network isolation is the execution security boundary.**

**Rationale (verified):** AIO's HTTP/WS API is open by default. Publishing no host port and confining sandboxes to a private network means only the orchestrator on `cap-net` can reach them — replacing the "no inbound port" property dial-back gave us. `cap-net` is required because container-name DNS (needed to dial `cap-aio-<taskId>`) does not exist on the default bridge. The `docker.sock` mount is currently **absent** in compose (a real gap) and is required for DooD.

**Alternatives considered:** Docker-in-Docker (privileged nested daemon) — rejected: heavier, more privileged, and unnecessary when a sibling socket works. Publish a host port per sandbox and dial `localhost:<port>` — rejected: exposes the open AIO API on the host and breaks the network-isolation boundary. Default bridge with `--link`/IP — rejected: no stable container-name DNS, brittle addressing.

### (D) codex in-shell (execution model A) + derived image + hooks re-homed via outbound HTTP callback
**Decision:** codex runs **INSIDE the AIO shell over `/v1/shell/ws`** (execution model A), preserving the interactive TUI; it is NOT launched via the request/response `exec`/MCP surfaces for the interactive channel (`assertInteractiveArgs` forbids that). A **derived image** is baked FROM the pinned AIO image, pinning codex + `~/.codex/hooks.json` + the compiled `dist/hooks`. The blocking approval hooks (`permission_request`, `post_tool_use`) are **re-homed to an OUTBOUND HTTP callback** from the sandbox to a NEW small orchestrator approvals endpoint reachable on `cap-net`, reusing the EXISTING `onPermissionRequest`/`onDecision` routing — **only the transport changes**; approval semantics and routing above the transport are unchanged.

**Rationale:** Model A is the only model that keeps the verified byte-identical interactive TUI. The derived image guarantees codex + hooks are present and version-pinned rather than installed at runtime. Re-homing hooks over outbound HTTP works precisely because the sandbox can reach the orchestrator on `cap-net` (the same channel direction as connect-in is for the terminal), and reusing the existing routing means the approval UX/logic is untouched.

**Alternatives considered:** Keep hooks talking to the runner's local process — rejected: there is no runner process anymore. Deliver approvals over the terminal WS as control frames — rejected: conflates the interactive byte stream with structured approval traffic and complicates the translation; a dedicated HTTP endpoint is cleaner and reuses routing directly. Install codex/hooks at container start — rejected: slower cold start, unpinned, non-reproducible.

### (D) Per-task container
**Decision:** Exactly one AIO container per task (`cap-aio-<taskId>`), created on start and `AutoRemove` on teardown (stop + remove).

**Rationale:** Clean isolation and trivial teardown — a task's entire blast radius is its own container, removed when done. No cross-task state leakage; teardown is "stop + remove the named container."

**Trade-off / alternatives considered:** Each container is heavy (~2–8 GB RAM), so a warm pool would cut cold-start latency and memory churn — rejected for now: pooling complicates isolation/teardown semantics and session reuse (which conflicts with the no-`session_id` decision). Pooling is deferred (Open Question).

### (D) Exit/startup detection without `node-pty onExit`
**Decision:** Since `node-pty`'s `onExit` is gone, `AioPtyClient` detects task termination by observing the terminal **WS close** and resolves the exit status via `POST /v1/shell/exec` running `echo $?` and/or `/v1/shell/wait`, mapping zero → guardrails `recordSuccess` and non-zero/abnormal → guardrails `recordFailure`.

**Rationale:** The signal source moves from the local pty process to the remote sandbox; WS close is the termination event and AIO's exec/wait surfaces provide the authoritative status. Guardrails `recordSuccess`/`recordFailure` are unchanged downstream.

### (D) Compose self-host only — Fly dropped as an execution target
**Decision:** Per-task execution requires the **docker-compose self-host** topology. **Fly is dropped as an execution target.** Fly may still host the *control-plane* orchestrator, but it SHALL NOT execute tasks.

**Rationale:** DooD requires a host docker socket. Fly runs Firecracker microVMs that **expose no host docker socket**, so sibling sandbox provisioning is impossible there. Compose self-host is the only topology that provides DooD.

**Alternatives considered:** Run a nested daemon on Fly (DinD in a microVM) — rejected: privileged, fragile, and outside the single-user self-host model. Use a remote docker host from Fly — rejected: re-introduces network exposure of the docker API and breaks the isolation story.

### KEEP / ADAPT / DELETE

| Disposition | Item |
| --- | --- |
| **KEEP** | web ws-client; operator connect-auth / `AUTH_TOKEN`; `WriteLockService` (lease/takeover); approval routing (`onPermissionRequest`/`onDecision`/`pendingApprovals`); `BackpressureController` + ACK; `SnapshotManager` + `session.log`; guardrails (semaphore/deadline/idle/circuit-breaker, admit/onTerminal/forceFail); `SandboxProvider` port + `SANDBOX_PROVIDER` DI token + `sandbox.module` seam; `TerminalPty` interface + `TerminalSession` registry |
| **ADAPT** | `ProvisionContext` (drop `taskToken`) + `provision()` returns `SandboxConnection`; `guardrails.startRunning` (consume the returned handle; gateway opens `AioPtyClient` to `handle.wsUrl`); `getSandboxMode` → informational; docker-compose (`docker.sock` mount + `cap-net`); approval hooks re-homed (outbound HTTP callback); `RunnerPtyProxy` **replaced by** `AioPtyClient` |
| **DELETE** | entire `apps/runner` package (`main.ts`/`composeRunnerTask`, dialback-client, spawn-codex/node-pty, task-entry, startup-window, session-log producer, notify, runner Dockerfile); `DockerSandboxProvider` (cap-runner + `ORCHESTRATOR_WS_URL`/`TASK_TOKEN`/`host.docker.internal`); gateway dial-back half (`onDialbackHandshake`, `ConnectionKind 'runner'`, `?role=runner`, `onRunnerRawFrame`, runner-disconnect branch); `dialback_handshake` control frame + `packages/contracts` `dialback.ts` + `TaskTokenService` dial-back verify; env `ORCHESTRATOR_WS_URL`/`RUNNER_IMAGE`/`RUNNER_AGENT_BIN`/`TASK_TOKEN` |

## Risks / Trade-offs

- **`docker.sock` mount = host-root-equivalent for `api`** → Mitigation: explicitly DOCUMENTED and accepted only for single-user self-host; no multi-tenant claim is made. The compose docs state this plainly. (Not mitigated by capability-dropping — accepted in the threat model.)
- **AIO container is heavy (~2–8 GB RAM each)** → Mitigation: per-task lifecycle with `AutoRemove` bounds resident containers to active tasks; document host RAM sizing; warm-pool deferred as an Open Question. Set `ShmSize ~2g`.
- **Backpressure toward the AIO producer has no in-band pause/resume** → Mitigation: `AioPtyClient` can only **socket-pause the WS read side** (TCP backpressure to the producer); the existing per-operator ACK window still protects each browser independently. Accepted: AIO output is bounded by what tmux/codex emits and TCP-level pause is sufficient for the single-producer case.
- **Pin the AIO image (avoid `:latest`)** → Mitigation: the derived image is built FROM a **pinned** AIO tag, not `:latest`; confirm the `ghcr.io/agent-infra/sandbox` pull succeeds in the self-host environment before flipping DI.
- **Reconnect `restore_output` scope is unquantified** → Mitigation: keep `SnapshotManager` AUTHORITATIVE for reconnect/restore; do not rely on tmux session rejoin (which also errors when unattached, see the no-`session_id` decision). Only the **live frame** is byte-identity-bound; scrollback may diverge.
- **`seccomp=unconfined` is REQUIRED** → Trade-off: weakens the seccomp profile for the sandbox container; accepted because AIO needs it to run and the boundary is the container + network isolation, not seccomp.
- **Open AIO API (no token) on `cap-net`** → Mitigation: network isolation (no host port; private network) is the boundary; any container that should not reach sandboxes must not be on `cap-net`.

## Migration Plan

Phased so the seam is established before the backend swaps, and the DI flip + deletions happen **last**, after the new path is proven.

1. **Port shape** — Adapt the `SandboxProvider` port: drop `taskToken` from `ProvisionContext`, change `provision()` to return `SandboxConnection { taskId, baseUrl, wsUrl }`, make `getSandboxMode()` informational. Update `guardrails.startRunning` to consume the returned handle. No behavior flip yet (existing provider can return a stub handle). *Rollback: revert the port change; nothing downstream depends on the new field yet.*
2. **`AioSandboxProvider`** — Implement dockerode `createContainer` for `cap-aio-<taskId>` from the pinned derived image (`SecurityOpt:['seccomp=unconfined']`, `ShmSize ~2g`, `AutoRemove`, `NetworkMode:'cap-net'`, NO `PortBindings`); start; poll `/v1/docs` for readiness; git-clone the task repo via `POST /v1/shell/exec`; return the `SandboxConnection`. Build the derived image (codex + `~/.codex/hooks.json` + `dist/hooks`). Add `docker.sock` mount + `cap-net` to compose. *Rollback: provider not yet wired into DI; revert compose.*
3. **`AioPtyClient` bridge** — Implement the outbound WS client connecting WITHOUT `session_id`, the full frame translation table, **CPR injection** (`\x1b[6n` → `{type:"input",data:"\x1b[1;1R"}`), internal `ping`→`pong`, and WS-close + `exec`/`wait` exit detection mapped to guardrails. Verify byte-identical live frame and codex startup against a real sandbox before proceeding. *Rollback: `AioPtyClient` not yet the `TerminalSession.pty` backend.*
4. **Agent launch + hooks** — Launch codex in-shell over `/v1/shell/ws`; stand up the NEW orchestrator approvals HTTP endpoint on `cap-net` and re-home `permission_request`/`post_tool_use` to outbound HTTP callbacks reusing `onPermissionRequest`/`onDecision`. Verify an end-to-end approval round-trip. *Rollback: keep old hook transport until the callback is proven.*
5. **Flip DI + delete** — Switch `SANDBOX_PROVIDER` from `DockerSandboxProvider` to `AioSandboxProvider`; make `AioPtyClient` the `TerminalSession.pty` backend. Then DELETE: `apps/runner` (whole package), `DockerSandboxProvider`, the gateway dial-back half (`onDialbackHandshake`, `ConnectionKind 'runner'`, `?role=runner`, `onRunnerRawFrame`, runner-disconnect branch), `dialback_handshake` + `packages/contracts/dialback.ts` + `TaskTokenService` dial-back verify, and the `ORCHESTRATOR_WS_URL`/`RUNNER_IMAGE`/`RUNNER_AGENT_BIN`/`TASK_TOKEN` env. *Rollback (pre-delete): the DI flip is a one-line provider swap — revert it to fall back to the dial-back path while it still exists. After deletion, rollback requires reverting the deletion commit, so gate the flip on a full smoke test.*

## Open Questions

- **Container pooling / warm pool** — Per-task containers are heavy (~2–8 GB) with cold-start cost. Do we introduce a warm pool later, and how does it reconcile with the no-`session_id` (new session per task) and clean-teardown decisions?
- **AIO auth** — The API is open by default; if AIO later supports a token, do we enable it as defense-in-depth on top of network isolation, and does `ProvisionContext` regain a credential field?
- **`/v1/docs` readiness vs. shell readiness** — `/v1/docs` responding confirms the HTTP server; do we also need a `/v1/shell/ws` `ready`-frame probe (or a shell `exec` smoke) before declaring the sandbox usable, to avoid racing codex launch?
- **Exit-status race** — Is `echo $?` over `/v1/shell/exec` reliably reading the codex exit code after WS close, or do we need `/v1/shell/wait` as the primary and `echo $?` only as fallback?
- **`restore_output` / reconnect scope** — The AIO `restore_output` scope is unquantified; is `SnapshotManager` alone sufficient for all reconnect cases, or are there frames we must also replay from the sandbox side?
- **Resource limits per sandbox** — Should `AioSandboxProvider` set explicit `Memory`/`CpuQuota` `HostConfig` limits per task to bound the heavy-container risk, and what defaults are safe for a single-user host?
- **git clone credentials** — How are repo credentials supplied to the in-sandbox `POST /v1/shell/exec` clone now that there is no `TASK_TOKEN`/runner env carrying them?
