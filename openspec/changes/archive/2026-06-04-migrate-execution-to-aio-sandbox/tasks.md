<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.
     The final `## Integration` track runs SERIALLY after the parallel tracks and owns every
     task whose file is touched by more than one track (shared-file isolation).

     Partition rationale (grounded in real file coupling, verified against the codebase):
     - `apps/api/src/sandbox/sandbox-provider.port.ts` is the port seam (contracts-and-port).
     - `apps/api/src/sandbox/docker-sandbox.provider.ts` → new `aio-sandbox.provider.ts`; the `sandbox.module.ts` DI
       useClass flip lands with the new provider (aio-provider) — it consumes the new port shape from contracts-and-port.
       `sandbox.module.ts` is aio-provider-only: 2.8 removes the `DockerSandboxProvider` import when it flips `useClass`,
       so delete-runner's 7.2 only deletes the provider file + greps — it does NOT re-edit the module (disjoint, NOT shared).
     - `apps/api/src/terminal/terminal.gateway.ts` (1060 lines) holds BOTH the `RunnerPtyProxy`/`AioPtyClient` PTY seam
       AND the dial-back half (`onDialbackHandshake`, `onRunnerRawFrame`, `ConnectionKind 'runner'`, `?role=runner`).
       aio-pty-bridge OWNS that file (adds `AioPtyClient`, rips the dial-back half out, and adds the new
       handle-driven session-registration seam). guardrails-wiring's 4.2 must co-edit the SAME gateway file to hand
       the `SandboxConnection` through (today only `onDialbackHandshake` calls `registerSession`; under connect-in a new
       guardrails→gateway seam replaces it) — SHARED → moved to Integration.
     - `apps/api/src/guardrails/guardrails.service.ts` + `guardrails.module.ts` consume the handle + map exit → record*
       and drop `TaskTokenService` (guardrails-wiring; these files are guardrails-only and disjoint from delete-runner's
       token surface, which lives in `tasks.*` + `terminal.module.ts`).
     - `apps/api/src/terminal/terminal.module.ts` is touched by BOTH derived-image-and-hooks (5.5 registers the new
       approvals controller) AND delete-runner (7.4 removes the `TaskTokenService` dial-back-verifier import) — SHARED →
       both 5.5 and 7.4 moved to Integration so the module's imports/providers/controllers are edited once, serially.
     - `packages/contracts` (`dialback.ts`, `index.ts`, `control-frame.ts`) + `apps/runner` (whole package) +
       `task-token.service.ts`/`tasks.service.ts`/`tasks.module.ts` + residual `apps/api` `.ts` doc refs are delete-runner.
     - NOTE: the runner env (`ORCHESTRATOR_WS_URL`/`RUNNER_IMAGE`/`RUNNER_AGENT_BIN`) currently lives ONLY in source
       (`docker-sandbox.provider.ts`, `apps/runner/*`) — NOT in `.env`/`.env.example`/`docker-compose.yml`/`apps/api/Dockerfile`.
       So deploy-dood (6.3, config files) and delete-runner (7.5, `.ts` comments) target disjoint files by type, NOT shared.
     - `apps/runner/hooks.json` + hook scripts (`apps/runner/src/hooks/*`, relocated into the derived-image surface before
       7.1 deletes `apps/runner`) + a NEW `apps/api/.../approvals.controller.ts` are derived-image-and-hooks. Track 7
       depends on derived-image-and-hooks, so the relocation/delete ordering is enforced by the dep edge, not a shared file.
     - `docker-compose.yml` + `.env*` + `apps/api/Dockerfile` + `apps/api/fly.toml` + deploy docs are deploy-dood. -->

## 1. Track: contracts-and-port (depends: none)

- [x] 1.1 Define a `SandboxConnection` type (`{ taskId: string; baseUrl: string; wsUrl: string }`) in `apps/api/src/sandbox/sandbox-provider.port.ts` (or a co-located `sandbox-connection.ts`), documenting `baseUrl` = `http://cap-aio-<taskId>:8080` and `wsUrl` = `ws://cap-aio-<taskId>:8080/v1/shell/ws`; export it from the port module.
- [x] 1.2 In `ProvisionContext`, remove the `taskToken` field (no dial-back to authenticate) so only `taskId` remains; update the surrounding doc comment to drop all `TASK_TOKEN`/dial-back language.
- [x] 1.3 Change the `SandboxProvider.provision()` signature to `provision(ctx: ProvisionContext): Promise<SandboxConnection>` (was `Promise<void>`); rewrite its doc comment to describe connect-in (returns an addressable handle the caller dials by container name) instead of dial-back.
- [x] 1.4 Downgrade `getSandboxMode()` to INFORMATIONAL in the port doc comment (the real boundary is the AIO container + `seccomp=unconfined` + network isolation, not the reported mode); keep the method, `SandboxMode` re-export, `SANDBOX_MODES`, the `SANDBOX_PROVIDER` token, and the unchanged `teardownSandbox(taskId)` signature.
- [x] 1.5 Verify `apps/api` typechecks against the new port shape in isolation (e.g. `pnpm --filter @cap/api typecheck` or `tsc --noEmit`), accepting that the existing `DockerSandboxProvider`/`guardrails.service` callers are flagged as not-yet-updated (those are corrected in their own tracks).

## 2. Track: aio-provider (depends: contracts-and-port)

- [x] 2.1 Create `apps/api/src/sandbox/aio-sandbox.provider.ts` exporting `class AioSandboxProvider implements SandboxProvider` (dockerode-backed), with a per-task `taskId -> Docker.Container` map and an `OnModuleDestroy` that stops all provisioned containers (mirroring the lifecycle in `docker-sandbox.provider.ts`).
- [x] 2.2 Implement `provision(ctx)` to `createContainer` named `cap-aio-<ctx.taskId>` from the PINNED derived AIO image (env-configurable tag, NOT `:latest`), with `HostConfig.SecurityOpt: ['seccomp=unconfined']`, `ShmSize` ~2g, `AutoRemove: true`, `NetworkMode: 'cap-net'`, and NO `PortBindings`; then `container.start()`.
- [x] 2.3 After start, poll `GET <baseUrl>/v1/docs` until it responds successfully (readiness) before treating the sandbox as usable; bound the poll with a timeout that surfaces a clear provision error if readiness never arrives.
- [x] 2.4 Treat a container created WITHOUT `seccomp=unconfined` as invalid (assert/guard the `SecurityOpt` so a misconfigured container is never used for execution).
- [x] 2.5 Clone the task repository into the sandbox workspace via `POST <baseUrl>/v1/shell/exec` (git clone) AFTER readiness and BEFORE returning the handle.
- [x] 2.6 Return a `SandboxConnection { taskId, baseUrl: http://cap-aio-<taskId>:8080, wsUrl: ws://cap-aio-<taskId>:8080/v1/shell/ws }` from `provision()`; make it idempotent for an already-provisioned task.
- [x] 2.7 Implement `teardownSandbox(taskId)` as stop + remove (relying on `AutoRemove`), idempotent and matching the unchanged port signature; implement `getSandboxMode()` returning an informational mode.
- [x] 2.8 Flip DI in `apps/api/src/sandbox/sandbox.module.ts`: bind `SANDBOX_PROVIDER` to `useClass: AioSandboxProvider` (replacing `DockerSandboxProvider`) and update the module doc comment to describe the AIO connect-in seam.
- [x] 2.9 Verify the provider compiles and the DI module resolves (typecheck/build of `apps/api`), and add a focused unit test asserting `createContainer` is called with `cap-aio-<taskId>`, `seccomp=unconfined`, `cap-net`, and no `PortBindings` (dockerode mocked).

## 3. Track: aio-pty-bridge (depends: contracts-and-port)

- [x] 3.1 Create `AioPtyClient implements TerminalPty` (new file `apps/api/src/terminal/aio-pty-client.ts`) that opens an OUTBOUND `ws` client to the sandbox `wsUrl` WITHOUT any `?session_id=` query parameter (new tmux session per task), exposing the same `onData`/`write`/`resize`/`pause`/`resume` surface `RunnerPtyProxy` did.
- [x] 3.2 Treat the server-sent `session_id` frame followed by `ready` as the session-established signal; never pass `?session_id=` to rejoin a prior session.
- [x] 3.3 Implement the JSON↔cap frame translation: inbound `{type:"output",data}` → `onData`/`emitData` into the existing base64-raw pipeline; operator keystrokes → `{type:"input",data}`; resize → `{type:"resize",data:{cols,rows}}`.
- [x] 3.4 Implement CPR injection: watch the output stream and, on observing the DSR cursor-position query `\x1b[6n` (standard DSR-6, NO `?` — the private-mode `\x1b[?6n` form is wrong and disables injection), immediately send `{type:"input",data:"\x1b[1;1R"}` to the sandbox (bridge-layer only, no AIO/tmux changes).
- [x] 3.5 Answer a sandbox `{type:"ping"}` with an internal `{type:"pong",timestamp}` that is DISTINCT from the operator write-lease heartbeat (do not route it through `WriteLockService`).
- [x] 3.6 Detect exit by observing the terminal WS CLOSE, then resolve the status via `POST <baseUrl>/v1/shell/exec` (`echo $?`) and/or `/v1/shell/wait`, exposing the resolved exit status to the gateway (the guardrails mapping is wired in guardrails-wiring).
- [x] 3.7 In `apps/api/src/terminal/terminal.gateway.ts`, replace the `RunnerPtyProxy`-based `TerminalSession.pty` construction with `AioPtyClient` opened to the provisioned `handle.wsUrl`; delete the `RunnerPtyProxy` class and `onRunnerRawFrame`.
- [x] 3.8 Remove the gateway dial-back half: `onDialbackHandshake`, `ConnectionKind 'runner'` (the `state.kind === 'runner'` branches), the `?role=runner` connect path, the runner-disconnect/pendingApprovals-by-runner cleanup branch, and the `DialbackHandshakeFrame` import + `dialback_handshake` case in the control-frame switch.
- [x] 3.9 Verify the gateway compiles with no remaining references to `RunnerPtyProxy`/dial-back symbols, and that everything above the `TerminalPty` seam (write-lock, snapshots, backpressure, approval routing) is untouched (typecheck/build `apps/api`).

## 4. Track: guardrails-wiring (depends: contracts-and-port, aio-pty-bridge)

- [x] 4.1 Update `apps/api/src/guardrails/guardrails.service.ts` `startRunning` to `await this.sandbox.provision({ taskId })` (drop the `taskTokens.issue(...)`/`taskToken` argument) and capture the returned `SandboxConnection` handle.
- [x] 4.3 Wire exit detection to guardrails: when `AioPtyClient` resolves a zero exit status, call `recordSuccess(taskId)`; on non-zero or abnormal termination, call `recordFailure(taskId)`; keep `onTerminal`/`forceFail`/`teardownSandbox` behavior otherwise unchanged.
- [x] 4.4 Remove the `TaskTokenService` dependency and `teardownSession`'s `revokeForTask` call from `guardrails.service.ts` (token issuance/revocation is deleted in delete-runner), updating constructor injection and `guardrails.module.ts` providers accordingly.
- [x] 4.5 Verify a provision→connect→exit round-trip maps to `recordSuccess`/`recordFailure` (unit test with a mocked provider returning a stub `SandboxConnection` and a fake `AioPtyClient` emitting a WS close + exit status).

## 5. Track: derived-image-and-hooks (depends: aio-provider)

- [x] 5.1 Add a derived sandbox image Dockerfile (e.g. `apps/api/sandbox/Dockerfile.aio` or `docker/aio-sandbox.Dockerfile`) built `FROM` the PINNED `ghcr.io/agent-infra/sandbox:<tag>` (NOT `:latest`), installing/pinning codex and copying `~/.codex/hooks.json` + the compiled `dist/hooks`.
- [x] 5.2 Ensure codex is launched IN-SHELL over `/v1/shell/ws` (execution model A) — confirm the launch command/entrypoint used by the bridge starts interactive codex and is NOT routed through the request/response `exec`/MCP surfaces for the interactive channel.
- [x] 5.3 Author `hooks.json` for the derived image wiring `permission_request`/`post_tool_use` to the compiled hook scripts, pointing them at an OUTBOUND HTTP callback to the orchestrator approvals endpoint over `cap-net` (replacing the prior dial-back/WS transport).
- [x] 5.4 Re-home the approval hook scripts' transport to an outbound HTTP POST (the orchestrator approvals URL, reachable by container name on `cap-net`), reusing the existing approval `ApprovalTransport` contract so only the transport layer changes.
- [x] 5.6 Verify an end-to-end approval round-trip: a sandbox HTTP callback reaches the new endpoint, flows through `onPermissionRequest`→operator decision→`onDecision`, and the decision is returned to the hook over HTTP (integration/contract test).

## 6. Track: deploy-dood (depends: none)

- [x] 6.1 In `docker-compose.yml`, mount `/var/run/docker.sock` into the `api` service so the orchestrator can provision sibling AIO containers via Docker-out-of-Docker.
- [x] 6.2 Define a user-defined network `cap-net` in `docker-compose.yml` and join the `api` service to it (the default bridge has no container-name DNS); document that per-task sandboxes attach to `cap-net`, are dialed by container name, and publish no host port.
- [x] 6.3 Remove the `ORCHESTRATOR_WS_URL`/`RUNNER_IMAGE`/`RUNNER_AGENT_BIN`/`TASK_TOKEN` environment wiring from compose/`.env`/`.env.example` and any Dockerfiles; add the pinned AIO image tag env the provider reads.
- [x] 6.4 Document in the compose self-host docs that mounting `/var/run/docker.sock` into `api` is host-root-equivalent and accepted ONLY for single-user self-host, and that network isolation (no host port; `cap-net`) is the execution security boundary.
- [x] 6.5 State (in `fly.toml`/deploy docs) that Fly is NOT an execution target — Firecracker microVMs expose no host docker socket for DooD — while the orchestrator MAY still run the control plane on Fly; keep both `fly.toml` and `docker-compose.yml` running the same NestJS orchestrator.
- [x] 6.6 Verify `docker compose config` parses and shows the `docker.sock` mount, `cap-net` network on `api`, and no removed runner env on the `api` service.

## 7. Track: delete-runner (depends: aio-provider, aio-pty-bridge, guardrails-wiring, derived-image-and-hooks)

- [x] 7.1 Delete the entire `apps/runner` package: `src/main.ts`, `task-entry.ts`, `startup-window.ts`, `session-log.ts`, `pty/spawn-codex.ts`, `dialback/`, `notify/`, the runner `Dockerfile`, `package.json`, and the built `dist/`; remove it from `pnpm-workspace.yaml`/`turbo.json` if listed.
- [x] 7.2 Delete `DockerSandboxProvider` (`apps/api/src/sandbox/docker-sandbox.provider.ts`) now that `AioSandboxProvider` is the bound implementation; confirm no remaining import references it.
- [x] 7.3 Remove the dial-back contracts: delete `packages/contracts/src/dialback.ts`, drop its `export * from './dialback.js'` in `packages/contracts/src/index.ts`, and remove `DialbackHandshakeFrameSchema` from the composed control-frame union in `packages/contracts/src/control-frame.ts`.
- [x] 7.5 Remove residual `ORCHESTRATOR_WS_URL`/`RUNNER_IMAGE`/`RUNNER_AGENT_BIN`/`TASK_TOKEN` references and dial-back doc language from any remaining `apps/api` source (creds docs, comments) so no obsolete dial-back symbol or env remains.

## Integration (depends: aio-pty-bridge, guardrails-wiring, derived-image-and-hooks, delete-runner)

Runs SERIALLY after every parallel track. Owns the tasks whose target file is shared by more than one
track (`apps/api/src/terminal/terminal.gateway.ts` for 4.2; `apps/api/src/terminal/terminal.module.ts`
for 5.5 + 7.4) so each shared file is edited exactly once, in a known order, then runs the final
full-monorepo build verification once the gateway/module/contracts surface has fully converged.

- [x] 4.2 Hand the captured `SandboxConnection` to the terminal gateway so it opens `AioPtyClient` to `handle.wsUrl` (wire the handle through whatever seam the gateway uses to register the `TerminalSession`), replacing the previous dial-back-registers-the-session flow. SHARED FILE `terminal.gateway.ts` (co-owned with aio-pty-bridge 3.7/3.8): land this after aio-pty-bridge has removed `onDialbackHandshake`'s `registerSession` path and added the handle-driven seam.
- [x] 5.5 Add a NEW small orchestrator approvals HTTP endpoint (e.g. `apps/api/src/terminal/approvals.controller.ts` or a dedicated module) reachable on `cap-net` that accepts the sandbox's `permission_request`/`post_tool_use` callback and routes it through the EXISTING `onPermissionRequest`/`onDecision`/`pendingApprovals` logic (transport-only change; approval semantics unchanged). SHARED FILE `terminal.module.ts` (register the controller in the module's `controllers`).
- [x] 7.4 Delete `apps/api/src/tasks/task-token.service.ts` and remove the `TaskTokenService` dial-back verify/issuance wiring from `tasks.service.ts`, `tasks.module.ts`, and `terminal.module.ts` (TASK_TOKEN issuance at task creation and the gateway handshake verifier are obsolete). SHARED FILE `terminal.module.ts` (co-edited with 5.5): apply the import/provider removal in the same serial pass that 5.5 registers the controller.
- [x] 7.6 Verify a full monorepo build + typecheck passes with `apps/runner` and the dial-back surface gone, and grep confirms zero remaining references to `apps/runner`, `dialback`, `RunnerPtyProxy`, `TASK_TOKEN`, or `ORCHESTRATOR_WS_URL` in shipped source.
