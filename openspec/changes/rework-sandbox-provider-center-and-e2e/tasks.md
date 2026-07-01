## 1. Track: core-contracts (depends: none)

- [x] 1.1 Audit `@cap/sandbox-core` exports and identify provider-neutral contracts that must remain stable.
- [x] 1.2 Normalize provider capability, descriptor, selected-run, terminal, command, workspace, retention, and error types in `@cap/sandbox-core`.
- [x] 1.3 Remove accidental provider implementation imports from `@cap/sandbox-core`.
- [x] 1.4 Move `@cap/sandbox-core` unit tests from `src/` to `test/` and update its package scripts.

## 2. Track: sandbox-center (depends: core-contracts)

- [x] 2.1 Create the `@cap/sandbox` provider-center module structure for registry, selection, owner store, readoption, selected-run aggregation, and operation routing.
- [x] 2.2 Move scheduler/router behavior into `@cap/sandbox/src/provider-center/` while preserving explicit provider-family fail-closed behavior.
- [x] 2.3 Move lifecycle settle planning into `@cap/sandbox/src/lifecycle/`.
- [x] 2.4 Move provider-neutral workspace git/archive helpers into `@cap/sandbox/src/workspace/`.
- [x] 2.5 Add provider-center tests under `packages/sandbox/test/` for selection, owner pinning, readoption, selected-run aggregation, and workspace routing.

## 3. Track: aio-provider-package (depends: core-contracts)

- [x] 3.1 Move AIO local image/config/container-spec helpers from `@cap/sandbox-aio-local` into `@cap/sandbox-provider-aio`.
- [x] 3.2 Move full AIO provider orchestration out of `apps/api/src/sandbox/aio-sandbox.provider.ts` into `@cap/sandbox-provider-aio`.
- [x] 3.3 Add AIO provider runtime hook interfaces for provision lookup, runtime setup, prompt/auth injection, skill preinstall, transcript read, and pre-stop trim.
- [x] 3.4 Implement AIO selected-run, terminal descriptor, command descriptor, workspace descriptor, retention policy, and readoption exports in the provider package.
- [x] 3.5 Move AIO provider unit tests under `packages/sandbox-provider-aio/test/` and update package scripts.

## 4. Track: boxlite-provider-package (depends: core-contracts)

- [x] 4.1 Normalize `@cap/sandbox-provider-boxlite` source layout around config, client, provider, command, terminal, workspace, preflight, retention, hooks, and types.
- [x] 4.2 Ensure BoxLite runtime setup and preflight use explicit hooks instead of API-local imports.
- [x] 4.3 Ensure BoxLite selected-run descriptors include provider id, provider sandbox id, connection, terminal, command, workspace, retention, and preflight consistently.
- [x] 4.4 Move BoxLite unit/conformance tests under `packages/sandbox-provider-boxlite/test/` and update package scripts.

## 5. Track: terminal-session (depends: sandbox-center)

- [x] 5.1 Move provider-neutral terminal session engine, transport registry, snapshot/tail replay, reconnect frame building, ACK/backpressure, and stale transport replacement under `@cap/sandbox/src/terminal/`.
- [x] 5.2 Keep provider-specific terminal protocol translation behind descriptor-driven transport factories.
- [x] 5.3 Adapt existing AIO and BoxLite terminal transport tests to the new sandbox terminal module.
- [x] 5.4 Verify snapshot plus `tail_replay.final` semantics remain unchanged.

## 6. Track: api-wiring-initial (depends: sandbox-center, aio-provider-package, boxlite-provider-package, terminal-session)

- [x] 6.1 Remove the legacy API-local `aio-sandbox.provider.ts` class and route initial sandbox provider binding through the `@cap/sandbox` facade.
- [x] 6.2 Move first-pass AIO lifecycle code from the deleted API provider class into `@cap/sandbox-provider-aio`.
- [x] 6.3 Move first-pass BoxLite provider structure into `@cap/sandbox-provider-boxlite`.
- [x] 6.4 Move provider-neutral terminal helpers into `@cap/sandbox/src/terminal`.
- [x] 6.5 Add an initial API import boundary test that blocks direct imports of sandbox subpackages.

## 7. Track: provider-e2e (depends: aio-provider-package, boxlite-provider-package, sandbox-center)

- [x] 7.1 Add fast fake provider conformance and provider-center contract tests that run without Docker, BoxLite, API, or web.
- [x] 7.2 Add `packages/sandbox-provider-aio/e2e/` with real AIO container provision, readiness, exec, selected-run, workspace, readoption, teardown, and cleanup coverage.
- [x] 7.3 Add `packages/sandbox-provider-boxlite/e2e/` with real BoxLite readiness, provision, exec, selected-run, workspace, readoption when supported, teardown, and cleanup coverage.
- [x] 7.4 Ensure real provider e2e suites fail or skip clearly when Docker or `BOXLITE_*` prerequisites are missing.
- [x] 7.5 Keep full CAP compose e2e for API/deployment coverage, but remove provider-package lifecycle assertions that now belong to provider e2e.

## 8. Track: web-terminal-fixtures (depends: terminal-session)

- [x] 8.1 Add provider selected-run and terminal-frame fixtures for AIO and BoxLite descriptor shapes.
- [x] 8.2 Add a Vite provider-terminal fixture story that renders `SessionTerminal` from fixtures without CAP API or live provider resources.
- [x] 8.3 Add Playwright coverage for initial render, snapshot plus tail replay, final reveal, reconnect, scroll position, and provider descriptor parity.
- [x] 8.4 Assert provider-internal tokens, private URLs, and non-browser sandbox identifiers are not rendered in the DOM.

## 9. Track: package-collapse-and-ci (depends: api-wiring-initial, api-host-harness-hardening, provider-e2e, web-terminal-fixtures)

- [x] 9.1 Remove or deprecate runtime use of `@cap/sandbox-scheduler`, `@cap/sandbox-lifecycle`, `@cap/sandbox-workspace-git`, `@cap/sandbox-aio-local`, and `@cap/sandbox-conformance` after imports are moved.
- [x] 9.2 Update root and package scripts for unit tests, sandbox coverage, provider e2e, and web fixture tests.
- [x] 9.3 Update Docker/API build ordering so `@cap/sandbox` and provider packages are built before API.
- [x] 9.4 Run typecheck, package tests, sandbox coverage, provider fake conformance, and available opt-in real provider e2e.
- [x] 9.5 Update documentation or developer notes for the new sandbox package boundaries and e2e commands.

## 10. Track: api-host-harness-hardening (depends: sandbox-center, aio-provider-package, boxlite-provider-package, terminal-session)

- [x] 10.1 Add the `SandboxHostHarness` contract under `@cap/sandbox` for owner store, provision lookup, runtime registry, material resolvers, auth persistence, skill installers, approval sink, and logging.
- [x] 10.2 Replace `apps/api/src/sandbox/sandbox.module.ts` provider composition with a single neutral `@cap/sandbox` host-harness factory call.
- [x] 10.3 Move provider family/env/config parsing, cloud-http registration, AIO registration, and BoxLite registration out of API and into `@cap/sandbox` configured provider registry code.
- [x] 10.4 Move remaining AIO-specific runtime setup, preflight, skill preinstall, transcript read, pre-stop trim, Docker/controller construction, and AIO logging out of API.
- [x] 10.5 Move remaining BoxLite-specific runtime setup, required-tool parsing, readiness/config checks, and BoxLite setup logging out of API.
- [x] 10.6 Move provider command executor protocol handling out of `apps/api/src/sandbox/sandbox-command-executor.ts` into the sandbox/provider harness.
- [x] 10.7 Move AIO workspace bridge/fallback behavior out of API and route workspace materialization/delivery through selected provider descriptors or provider-center workspace APIs.
- [x] 10.8 Move AIO terminal client/transport/session lifecycle out of `apps/api/src/terminal` into the AIO provider terminal harness.
- [x] 10.9 Move BoxLite terminal transport/client lifecycle out of `apps/api/src/terminal` into the BoxLite provider terminal harness.
- [x] 10.10 Replace `TerminalGateway.openSession()` provider-specific construction with neutral sandbox terminal harness session creation.
- [x] 10.11 Remove provider-specific readiness/env checks from provider terminal story API service; use sandbox provider readiness/selection APIs instead.
- [x] 10.12 Rename or relocate AIO-named approval enforcement so API exposes only a neutral sandbox approval sink/enforcer.
- [x] 10.13 Strengthen API boundary tests to reject concrete provider names, provider factories, provider protocol strings, Docker lifecycle, provider env readers, terminal transports, and command protocol switches in `apps/api/src/sandbox` and `apps/api/src/terminal`.
- [x] 10.14 Move or rewrite API tests that currently assert AIO/BoxLite implementation details so provider behavior is tested in provider packages and API tests cover only host harness wiring.
