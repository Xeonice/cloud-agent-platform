## Context

CAP already has a Sandbank-aligned sandbox package split: provider descriptors, capability selection, router ownership, lifecycle helpers, conformance, AIO-local, cloud HTTP, and workspace-git helpers live under `packages/`. The remaining coupling is in the execution path: `AioSandboxProvider` still performs container lifecycle, readiness, runtime preflight/setup, workspace clone, skill install, delivery, retained transcript reads, and retention; `AioPtyClient` still mixes shared agent-terminal behavior with AIO-specific WebSocket and exec transport.

BoxLite should enter as a horizontally schedulable sandbox provider. It must not fork AIO terminal semantics or let the browser bypass CAP's terminal gateway, because the gateway owns the product-level guarantees: write-lock, approval routing, reconnect replay, `session.log`, `session.cast`, snapshotting, and backpressure.

## Goals / Non-Goals

**Goals:**

- Add BoxLite as a configured provider candidate behind the existing provider registry/router.
- Promote provider selection into a selected-run context reused by provisioning, terminal attach, delivery, transcript read, retention, and readoption.
- Split terminal implementation into shared agent-terminal mechanics and provider-specific transport/command execution.
- Preserve AIO as the default and keep existing browser terminal protocol unchanged.
- Use Sandbank's provider model as architecture guidance: provider is compute, workspace/task truth remains outside the provider, optional provider features are capability-gated.
- Add conformance and preflight so BoxLite is selected only when its advertised capabilities are actually usable.

**Non-Goals:**

- Replacing AIO as the default self-host provider.
- Making provider-native BoxLite snapshots/volumes the canonical task or workspace state.
- Exposing BoxLite's terminal URL directly to browsers.
- Implementing multi-replica distributed locking for retention/readoption. The current single-instance assumption remains unless a future change introduces a distributed owner lock.
- Reworking the frontend terminal protocol or xterm rendering behavior.

## Decisions

### D1. `SelectedSandboxRun` is the scheduling boundary

The scheduler should return a run context, not just a provider object. The context carries:

- `taskId`
- `providerId`
- declared/effective capabilities
- provider connection
- terminal endpoint descriptor
- command executor descriptor
- workspace materialization/sync plan
- image/runtime/preflight result
- retention/readoption policy

This mirrors Sandbank's selected provider/run context pattern and prevents drift where preflight, setup, terminal attach, and delivery each rediscover slightly different provider/runtime state.

Alternative considered: keep returning a raw provider and let each caller ask it for what it needs. Rejected because BoxLite would force more AIO-style branching and make delivery/readoption guessing unsafe after restart.

### D2. Capabilities describe behavior, not provider branding

The current capability vocabulary is operation-oriented (`terminal.websocket`, `workspace.git.materialize`, `workspace.git.deliver`). BoxLite needs additional feature-level capabilities such as interactive terminal transport, command execution, archive upload/download, retained transcript source, readoption, sleep, snapshot, and port exposure.

The scheduler should continue to fail closed when no provider satisfies the required set. Provider packages must advertise only capabilities that are implemented and preflighted.

Alternative considered: add `provider === "boxlite"` branches in API services. Rejected because it would undo the provider split and make future providers repeat the same integration work.

### D3. CAP gateway remains the only browser-facing terminal

BoxLite may expose a provider terminal endpoint internally, but browsers continue to connect only to `TerminalGateway`. The provider terminal capability supplies a `TerminalTransport` descriptor consumed by the API process:

```text
Browser
  -> CAP TerminalGateway
       -> AgentTerminalPty
            -> TerminalTransport
                 -> AIO /v1/shell/ws
                 -> BoxLite tty/async terminal
```

`TerminalGateway` keeps ownership of write-lock, approvals, `session.log`, `session.cast`, reconnect replay, snapshots, and backpressure. `AgentTerminalPty` owns shared agent mechanics: detached tmux launch/attach, DSR startup behavior, liveness polling, exit detection, pause/resume, resize, and replacement of stale attach bridges. `TerminalTransport` owns provider protocol translation.

Alternative considered: expose BoxLite's terminal URL directly to the browser. Rejected because it bypasses CAP's audit, approval, logging, and replay guarantees.

### D4. Command execution is a provider-neutral executor

Runtime preflight/setup, workspace materialization, delivery, transcript capture, trim, and liveness checks should run through `SandboxCommandExecutor`. AIO implements it with `/v1/shell/exec`; BoxLite implements it with BoxLite exec APIs. The executor normalizes exit code, stdout/stderr, timeout, working directory, and secret scrubbing behavior.

Alternative considered: keep `runSandboxExec(baseUrl)` local to `AioSandboxProvider`. Rejected because delivery and runtime setup would remain AIO-specific.

### D5. Workspace truth stays outside the provider

CAP task DB, audit records, transcript archive, and git/workspace delivery remain the durable truth. BoxLite snapshots/sleep/volumes are optimization and retention tools, not canonical state. The first BoxLite implementation can still materialize via git clone and deliver via git push, but those actions should be driven through a provider-neutral `WorkspaceBridge` and command executor.

Alternative considered: treat BoxLite snapshots as the source of truth for finished tasks. Rejected because provider-native snapshots are not portable across providers and do not replace task/audit/transcript durability.

### D6. BoxLite is gated by static and runtime preflight

Static preflight validates provider config, image mapping, declared capabilities, and connection credentials. Runtime preflight creates or uses a disposable sandbox for the selected image/runtime and probes required tools such as `bash`, `git`, `tmux`, `tar`, `gzip`, runtime CLIs, and any delivery dependencies. Preflight results may be cached by provider id + image + runtime fingerprint.

Alternative considered: let the first task fail during launch if the BoxLite image is missing tools. Rejected because that burns operator time and can leak partially provisioned state.

### D7. Run ownership is durable enough for restart

The current router pins task owner in memory and probes providers after restart. BoxLite should add a durable owner record or task field carrying provider id and provider sandbox id/connection metadata once provisioning succeeds. Restart can first reattach through that owner and only fall back to provider probing when the durable owner is absent.

Alternative considered: always probe all providers. Rejected because multi-provider deployments can have ambiguous task ids, remote provider latency, and unsafe delivery writer guessing.

## Risks / Trade-offs

- **Risk: BoxLite terminal is only streaming exec, not a true interactive PTY.** -> Mitigation: do not advertise terminal capability unless input, output, resize, reconnect/reattach, and liveness semantics pass preflight/conformance.
- **Risk: Terminal refactor changes AIO behavior.** -> Mitigation: extract AIO transport first with golden/characterization tests for launch line, DSR/CPR startup, tmux attach, liveness, reconnect replay, and cast/log writes.
- **Risk: Capability vocabulary becomes too fragmented.** -> Mitigation: keep operation-level required sets in helpers and map them to low-level provider features inside the scheduler/planner.
- **Risk: Provider-native retention diverges from current stopped-container history.** -> Mitigation: require transcript capture/archive before teardown and treat provider retention as best-effort replay/readoption support.
- **Risk: Durable provider ownership needs a data migration.** -> Mitigation: make the new fields nullable, backfill only on future provisions, and preserve probing fallback for older tasks.
- **Risk: BoxLite dependency/API drift.** -> Mitigation: keep the BoxLite client behind a small adapter with fake client tests and live integration tests behind opt-in environment variables.

## Migration Plan

1. Introduce selected-run context types, capability helpers, and provider-neutral descriptors while keeping AIO as the only configured provider.
2. Extract `AioPtyClient` into shared terminal mechanism plus AIO transport, proving AIO behavior unchanged.
3. Route runtime preflight/setup, delivery, retention trim, and liveness probes through provider-neutral command executor interfaces.
4. Add durable provider owner metadata for new task provisions, with fallback probing for existing tasks.
5. Add BoxLite provider package, config, fake-client conformance, and opt-in live preflight/e2e.
6. Enable BoxLite selection only when explicitly configured and capability/preflight checks pass.

Rollback is configuration-first: disable BoxLite registration and the scheduler continues selecting AIO. If a migration adds nullable owner metadata, AIO continues to operate with either stored owner or fallback probing.

## Implementation Assumptions

- The first BoxLite implementation uses a small CAP-owned client abstraction with a remote REST implementation; a local SDK implementation can be added later behind the same client.
- If the configured BoxLite backend cannot provide true interactive PTY semantics, BoxLite will not advertise interactive terminal capability. A future in-sandbox bridge can satisfy the same `TerminalTransport` contract without changing the browser protocol.
- Durable provider owner metadata will use a separate `SandboxRun` record so retries and future multi-attempt history do not overload the `Task` row.
- The initial BoxLite image is configured by env/image catalog and must pass runtime preflight before use; publishing a default image is outside the first implementation unless an existing pinned image is already available.
