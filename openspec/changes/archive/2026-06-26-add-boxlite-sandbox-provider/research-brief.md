## Research Brief

### Sources

- Local CAP sandbox split:
  - `packages/sandbox/README.md`
  - `packages/sandbox-core/src/capabilities.ts`
  - `packages/sandbox-core/src/provider.ts`
  - `packages/sandbox-scheduler/src/scheduler.ts`
  - `packages/sandbox-scheduler/src/provider-router.ts`
  - `apps/api/src/sandbox/aio-sandbox.provider.ts`
  - `apps/api/src/terminal/aio-pty-client.ts`
- Existing OpenSpec specs:
  - `sandbox-provider-port`
  - `realtime-terminal`
  - `sandbox-readoption`
  - `session-sandbox-retention`
  - `task-result-delivery`
  - `guardrails`
- Sandbank references:
  - https://github.com/chekusu/sandbank
  - https://github.com/chekusu/sandbank/blob/main/docs/provider-scheduler-workspace.md
  - https://github.com/chekusu/sandbank/tree/main/packages/boxlite

### Findings

- CAP already follows part of the Sandbank direction: provider-neutral packages exist, providers declare capabilities, and `SandboxProviderRouter` pins a provisioned task to the provider that owns it.
- The current scheduler still returns provider selections that are too close to the provider object. Sandbank's stronger pattern is a selected run context that carries provider, capabilities, create config, image/runtime resolution, workspace materialization, and cleanup policy through the whole run.
- `AioSandboxProvider` still owns too many concerns: container lifecycle, readiness, runtime preflight, runtime setup, git materialization, skill setup, retained transcript reads, retention, and delivery. Adding BoxLite by copying this class would multiply AIO-specific coupling.
- `AioPtyClient` contains shared terminal behavior and AIO transport behavior in one class. Shared behavior includes detached tmux launch/attach, DSR startup handling, liveness polling, exit resolution, pause/resume, resize, and reconnect replacement. Provider-specific behavior is the AIO `/v1/shell/ws` transport and `/v1/shell/exec` command executor.
- Sandbank treats optional provider features as capability helpers (`terminal`, `exec.stream`, `sleep`, `snapshot`, `port.expose`) rather than making every provider implement one fat interface. CAP should use that pattern, but preserve CAP-specific gateway semantics.
- Sandbank's BoxLite adapter exposes terminal by returning a terminal URL. CAP should not expose a provider terminal URL directly to the browser: the CAP `TerminalGateway` must remain the browser-facing boundary for write-lock, approval routing, `session.log`, `session.cast`, reconnect replay, snapshotting, and backpressure.
- Workspace truth should remain provider-neutral. Provider-native BoxLite snapshot/sleep/volume features are useful for speed and retention, but must not become the canonical task state. CAP's task DB, transcript archive, git/workspace sync, and audit records remain authoritative.
- BoxLite terminal support must be verified as an interactive PTY transport with input, resize, reconnect/re-attach, and liveness semantics. A polling-style `exec.stream` is not enough for CAP's live terminal contract.

### Design Implications

- Introduce a stronger `SelectedSandboxRun` or equivalent provision result that all follow-on paths consume.
- Split terminal mechanics into gateway, shared agent terminal, transport, command executor, and detached session driver.
- Add a BoxLite adapter as a provider package, with local and remote client modes if both are supported by the chosen BoxLite deployment.
- Extend capability vocabulary beyond current CAP operation names so scheduler decisions can distinguish terminal transport, command execution, archive workspace sync, sleep, snapshot, retained transcript, readoption, and delivery support.
- Keep AIO as the default provider and prove behavior preservation before enabling BoxLite.
