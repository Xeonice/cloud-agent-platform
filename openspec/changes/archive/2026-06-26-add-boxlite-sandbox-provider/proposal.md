## Why

CAP has the beginning of a Sandbank-style sandbox layer, but AIO still owns too much of the provider, terminal, workspace, and retention mechanism. Adding BoxLite is the forcing function to finish the provider boundary: BoxLite must be a horizontal provider extension, not a second copy of AIO-specific terminal and lifecycle code.

## What Changes

- Add a BoxLite sandbox provider that can provision task sandboxes through the existing provider registry/router and satisfy interactive task execution when its required capabilities are available.
- Promote provider selection into a reusable selected-run context carrying the selected provider id, capabilities, connection descriptors, image/runtime plan, workspace materialization plan, terminal transport descriptor, command executor descriptor, and retention policy.
- Refactor the terminal layer so CAP's browser-facing `TerminalGateway` remains unchanged while provider-specific terminal I/O moves behind `TerminalTransport` and command execution moves behind `SandboxCommandExecutor`.
- Keep detached tmux session semantics as the shared first implementation of the agent session driver, so AIO and BoxLite preserve resident session, reattach, liveness, and exit behavior.
- Extend sandbox capability vocabulary and conformance coverage to include provider features required by BoxLite: interactive terminal transport, command execution, archive workspace materialization/sync, retained transcript reads, readoption, sleep/snapshot when supported, and delivery.
- Preserve AIO as the default provider and gate BoxLite behind explicit configuration and preflight.
- Add static and runtime preflight for provider/runtime compatibility before a task consumes a long-running slot.

## Capabilities

### New Capabilities

- `boxlite-sandbox-provider`: BoxLite provider configuration, provisioning, exec/file/archive operations, terminal transport integration, preflight, and conformance expectations.

### Modified Capabilities

- `sandbox-provider-port`: selected-run context, expanded capability vocabulary, provider-neutral terminal/exec/workspace descriptors, and provider conformance rules.
- `realtime-terminal`: provider-neutral terminal transport behind the existing CAP browser protocol, keeping write-lock, replay, cast, snapshot, approval, and backpressure semantics intact.
- `sandbox-readoption`: re-adoption through provider-owned detached sessions rather than AIO-only `cap-aio-*` assumptions.
- `session-sandbox-retention`: provider-neutral retention semantics for AIO containers and BoxLite boxes/snapshots.
- `task-result-delivery`: delivery runs through the selected provider command/workspace executor rather than assuming AIO `/v1/shell/exec`.
- `guardrails`: provisioning, bootstrap recovery, teardown, and failure paths operate through selected provider/run context instead of AIO-specific container identity.

## Impact

- **Code:** sandbox core/scheduler packages, new BoxLite provider package, API sandbox wiring, terminal gateway internals, AIO pty client extraction, guardrails lifecycle, delivery, retention, readoption, conformance, and e2e harnesses.
- **Config:** new BoxLite provider configuration for local/remote endpoint, credentials, image mapping, priority/location preference, and opt-in capability advertisement.
- **Behavior:** AIO remains default. BoxLite is selected only when configured and capability/preflight checks pass. Browser terminal protocol and frontend terminal behavior remain unchanged.
- **Dependencies:** adds a BoxLite client/adapter dependency or local client wrapper, plus focused mocks/fakes for conformance and tests.
