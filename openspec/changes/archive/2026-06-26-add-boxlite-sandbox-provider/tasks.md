<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: core-contracts (depends: none)

- [x] 1.1 Extend `@cap/sandbox-core` capability vocabulary with provider feature capabilities for command execution, interactive terminal transport, archive workspace transfer, retained transcript source, readoption, snapshot, sleep, and port exposure while preserving existing operation-level helpers.
- [x] 1.2 Add provider-neutral selected-run contracts: selected provider id, provider sandbox id, connection metadata, terminal transport descriptor, command executor descriptor, workspace descriptor, retention/readoption policy, and preflight result.
- [x] 1.3 Update `@cap/sandbox-scheduler` planning so provisioning requirements map to provider feature capabilities and produce a selected-run context instead of only a raw provider selection.
- [x] 1.4 Expand `@cap/sandbox-conformance` with scenarios for terminal transport, command executor, workspace transfer, durable owner metadata, retained transcript, readoption, and delivery ownership.
- [x] 1.5 Update sandbox package unit tests and aggregate exports for the new contracts without changing current AIO behavior.

## 2. Track: provider-owner-persistence (depends: core-contracts)

- [x] 2.1 Add a nullable, additive Prisma migration for a `SandboxRun` owner record keyed to task/provision attempt, carrying provider id, provider sandbox id, status, connection metadata, and timestamps without storing secrets.
- [x] 2.2 Add a provider-owner repository/service in the API that records successful provisions, resolves the current owner for readoption/delivery/teardown, and marks terminal/removed owner states idempotently.
- [x] 2.3 Update the sandbox router/readoption path to prefer stored owner metadata before probing providers, while preserving probing fallback for older tasks.
- [x] 2.4 Add persistence tests proving owner records are written only after successful provision, survive restart-style reconstruction, and are not used to guess delivery ownership when stale.

## 3. Track: terminal-transport-refactor (depends: core-contracts)

- [x] 3.1 Add characterization tests around current AIO terminal behavior: launch/attach line, DSR/CPR startup, resize, stale bridge replacement, liveness polling, exit resolution, `session.log`, `session.cast`, and write-lock gating.
- [x] 3.2 Define `TerminalTransport`, `DetachedSessionDriver`, `SandboxCommandExecutor` consumption points, and shared `AgentTerminalPty` interfaces in the terminal layer.
- [x] 3.3 Extract AIO WebSocket frame handling into `AioTerminalTransport` while keeping detached tmux launch/attach and runtime startup logic in the shared terminal mechanism.
- [x] 3.4 Keep `TerminalGateway` as the only browser-facing terminal endpoint and route provider transport selection through the selected-run terminal descriptor.
- [x] 3.5 Update terminal unit/e2e tests to prove AIO behavior and browser protocol are unchanged after the split.

## 4. Track: executor-workspace-lifecycle (depends: core-contracts, provider-owner-persistence)

- [x] 4.1 Implement provider-neutral command execution helpers that normalize exit code, output, timeout, working directory, and secret scrubbing across AIO and future providers.
- [x] 4.2 Move runtime preflight, runtime setup, trim, transcript probes, and liveness checks to consume the selected provider command executor instead of AIO `baseUrl`.
- [x] 4.3 Add workspace bridge descriptors for git clone/delivery and archive upload/download materialization, preserving current AIO git behavior as the first implementation.
- [x] 4.4 Update task delivery to resolve the provider owner and execute git commit/push through the selected provider executor/workspace descriptor.
- [x] 4.5 Update retention, transcript capture, and readoption surfaces to consume provider-neutral owner/run descriptors rather than `cap-aio-*` assumptions.
- [x] 4.6 Add focused tests for unknown owner, missing delivery capability, executor failure, trim fail-open, and transcript/readoption fallback behavior.

## 5. Track: aio-adapter-migration (depends: terminal-transport-refactor, executor-workspace-lifecycle)

- [x] 5.1 Adapt the existing AIO provider/controller to return selected-run descriptors, AIO terminal transport descriptors, AIO command executor descriptors, and AIO workspace/retention policies.
- [x] 5.2 Preserve local AIO as the default provider and keep its existing capabilities, container naming, readiness, clone, skill install, readoption, retained transcript, and stop-only retention behavior.
- [x] 5.3 Remove duplicated AIO-specific lifecycle logic from API callers once it is available through selected-run descriptors.
- [x] 5.4 Run and update AIO provider, scheduler, terminal, guardrails, delivery, retention, and compose e2e tests for behavior parity.

## 6. Track: boxlite-provider (depends: core-contracts, terminal-transport-refactor, executor-workspace-lifecycle)

- [x] 6.1 Create a BoxLite provider package with a CAP-owned BoxLite client abstraction and a remote REST implementation, plus fake client support for deterministic tests.
- [x] 6.2 Implement BoxLite provider registration/config parsing for endpoint, credentials, image mapping, priority/location, and explicitly enabled capabilities.
- [x] 6.3 Implement BoxLite provision/reattach/teardown/sandbox-exists flows with task-scoped provider sandbox ids and idempotent retry behavior.
- [x] 6.4 Implement BoxLite command execution and archive upload/download adapters that satisfy CAP executor/workspace contracts.
- [x] 6.5 Implement BoxLite runtime static/runtime preflight and cache results by provider/image/runtime fingerprint.
- [x] 6.6 Implement BoxLite terminal transport only when the configured backend supports true interactive PTY input/output/resize/reattach; otherwise do not advertise terminal capability.
- [x] 6.7 Implement optional BoxLite sleep/snapshot/retention support as capability-gated optimizations, never as canonical task state.
- [x] 6.8 Add BoxLite conformance, fake-client unit tests, and opt-in live integration tests guarded by BoxLite environment variables.

## 7. Track: api-wiring (depends: aio-adapter-migration, boxlite-provider)

- [x] 7.1 Register BoxLite as an optional provider candidate in `SandboxModule` when configuration is present, preserving AIO-only behavior when absent.
- [x] 7.2 Wire guardrails provisioning to store selected `SandboxRun` owner metadata and carry selected-run context into terminal open, delivery, transcript capture, teardown, and slot release.
- [x] 7.3 Update bootstrap recovery to re-adopt through stored provider owners and provider registry readoption surfaces, sparing stopped retained artifacts from all providers.
- [x] 7.4 Add configuration documentation and examples for BoxLite endpoint, credential, image mapping, priority, preferred location, and live-test env vars.
- [x] 7.5 Add API integration tests covering AIO default, BoxLite selected by priority/capability, BoxLite preflight failure, missing owner delivery skip, and restart-style readoption.

## 8. Track: verification (depends: api-wiring)

- [x] 8.1 Run sandbox package coverage/type checks for core, scheduler, conformance, AIO, BoxLite, workspace, and lifecycle packages.
- [x] 8.2 Run API unit/integration tests covering terminal, guardrails, delivery, retention, readoption, provider owner persistence, and provider selection.
- [x] 8.3 Run live AIO compose e2e to prove existing behavior remains unchanged.
- [x] 8.4 Run BoxLite live e2e when BoxLite env vars are configured; otherwise record it as intentionally skipped with fake-client conformance passing.
- [x] 8.5 Check for `debugger` statements before any future commit and write a verification report summarizing commands, results, and any live BoxLite limitations.
