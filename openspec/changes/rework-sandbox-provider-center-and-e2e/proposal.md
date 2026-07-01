## Why

The current sandbox split has too many helper-only packages while the actual provider center and concrete provider orchestration remain too centralized in the API. This makes AIO and BoxLite look like API-composed implementations instead of provider adapters behind one CAP-owned sandbox center, and it leaves provider validation tied to API compose e2e rather than package-owned provider e2e.

The API boundary also needs a stricter harness rule: API is the sandbox host, not the provider composer. API code may provide business ports such as owner storage, provision lookup, runtime registry, auth material, skill installation, approval routing, and Nest/WebSocket wiring, but it must not know AIO, BoxLite, provider protocol strings, Docker lifecycle, BoxLite env/config, terminal transport protocol, command executor protocol, or provider-specific workspace defaults.

## What Changes

- Rework `@cap/sandbox` from a compatibility aggregate into the provider center that owns registry, capability selection, owner pinning, readoption routing, selected-run aggregation, workspace helpers, lifecycle planning, and provider-neutral terminal session behavior.
- Keep `@cap/sandbox-core` as the provider-neutral contract package for capabilities, descriptors, selected runs, command/terminal/workspace types, and errors.
- Introduce a `SandboxHostHarness` contract in `@cap/sandbox`: API implements host ports, while `@cap/sandbox` composes provider registry entries and concrete providers.
- Move the full AIO provider orchestration out of `apps/api` and into `@cap/sandbox-provider-aio`, including Docker lifecycle, readiness, runtime setup hooks, workspace materialization, terminal and command descriptors, retention, terminal session lifecycle, command executors, and readoption.
- Keep `@cap/sandbox-provider-boxlite` as a complete provider adapter and tighten its local structure around config, client, provider orchestration, command, terminal, workspace, preflight, retention, hooks, and e2e.
- Move provider-specific terminal transports, command executor protocols, workspace fallbacks, provider readiness/env parsing, and provider family selection out of `apps/api/src/sandbox` and `apps/api/src/terminal`.
- Collapse helper-only packages into their owning packages unless they become true external extension points:
  - `sandbox-scheduler`, `sandbox-lifecycle`, and `sandbox-workspace-git` move under `@cap/sandbox`.
  - `sandbox-aio-local` moves under `@cap/sandbox-provider-aio`.
  - `sandbox-conformance` becomes dev-only testkit or package test code rather than a runtime dependency.
- Add real provider e2e suites under provider packages. AIO e2e starts real AIO containers; BoxLite e2e starts real BoxLite sandboxes. Neither suite starts the CAP API backend nor the production web app.
- Move package unit tests under each package's `test/` directory and keep provider e2e under each package's `e2e/`.
- Add fixture-driven web terminal verification that consumes provider contract fixtures and validates initial render, reconnect, snapshot/tail replay, and descriptor rendering without starting the real backend.
- Preserve the browser-facing terminal protocol: provider terminal endpoints remain server-side only, and browsers continue to connect to CAP's terminal surface.

## Capabilities

### New Capabilities

- `sandbox-provider-validation`: Defines package-level unit, conformance, real provider e2e, and web fixture verification requirements for sandbox providers.
- `sandbox-host-harness`: Defines the API host harness boundary and forbids API-side provider composition.

### Modified Capabilities

- `sandbox-provider-port`: Provider center ownership, package boundaries, selected-run routing, and provider conformance requirements are tightened.
- `aio-sandbox-execution`: AIO lifecycle orchestration moves into the AIO provider package and gains real provider e2e that does not require the CAP API backend.
- `boxlite-sandbox-provider`: BoxLite provider package structure and real provider e2e requirements are strengthened.
- `realtime-terminal`: API keeps only browser WebSocket/auth/session orchestration; provider terminal session, reconnect, protocol translation, and command execution move behind the sandbox/provider harness.
- `sandbox-readoption`: Readoption and reattach route through durable provider ownership in the provider center.
- `session-sandbox-retention`: Retention and cleanup use provider-center descriptors and selected provider executors instead of AIO-specific assumptions.

## Impact

- Affected packages: `packages/sandbox-core`, `packages/sandbox`, `packages/sandbox-provider-aio`, `packages/sandbox-provider-boxlite`, and possibly `packages/sandbox-cloud-http`.
- Packages likely removed or merged: `packages/sandbox-scheduler`, `packages/sandbox-lifecycle`, `packages/sandbox-workspace-git`, `packages/sandbox-aio-local`, and runtime use of `packages/sandbox-conformance`.
- Affected API code: `apps/api/src/sandbox/*`, `apps/api/src/terminal/*`, task startup/recovery, retention cleaner wiring, provider module wiring, provider terminal story readiness, command executor lookup, and workspace bridge lookup.
- Affected web tests: provider terminal stories and terminal fixture e2e under `apps/web/e2e`.
- Affected scripts and CI: sandbox package coverage/test commands, real provider e2e commands, AIO e2e orchestration, and BoxLite e2e environment validation.
- No git push or release behavior is part of this change.
