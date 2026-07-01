## Context

CAP's previous sandbox split extracted several useful pieces, but the resulting boundaries do not yet match the real extension points. `@cap/sandbox` is still mostly a compatibility aggregate, while provider-center behavior is split across scheduler-style packages and API wiring. The AIO implementation is also still thick inside `apps/api/src/sandbox/aio-sandbox.provider.ts`, which prevents `@cap/sandbox-provider-aio` from owning its own real lifecycle e2e.

The stricter boundary for this change is: API is a sandbox host, not a sandbox provider composer. `apps/api/src/sandbox` and `apps/api/src/terminal` must not instantiate, register, select, or translate concrete providers. API should only provide product/business ports to a sandbox host harness; `@cap/sandbox` and provider packages own the provider registry, provider-specific lifecycle, command protocol, workspace protocol, terminal protocol, readiness, and provider-family selection.

Sandbank's current architecture is a useful reference point: the durable boundary is the Workspace/Harness, while provider adapters are interchangeable compute backends selected by capabilities. CAP has different product constraints, but the same principle applies: CAP's sandbox center should own provider selection, ownership, readoption, selected runs, terminal session behavior, and workspace/lifecycle policy; provider packages should own concrete backend mechanics.

## Goals / Non-Goals

**Goals:**

- Make `@cap/sandbox` the API-facing provider center instead of a re-export package.
- Keep `@cap/sandbox-core` focused on provider-neutral types, capabilities, descriptors, selected runs, and errors.
- Define `SandboxHostHarness` so API supplies host ports but never composes concrete provider implementations.
- Move full AIO provider orchestration from API into `@cap/sandbox-provider-aio`.
- Keep BoxLite as a complete provider package and strengthen its real provider e2e coverage.
- Move provider-specific terminal session lifecycle, terminal transport translation, command executor protocol handling, workspace fallback/default behavior, and provider readiness/env parsing out of API.
- Collapse helper-only sandbox packages into their owning package boundaries.
- Add real provider e2e that starts AIO and BoxLite resources without starting CAP API or the production web app.
- Move package unit tests under `test/` and provider e2e under `e2e/`.
- Keep browser-facing terminal behavior provider-neutral and unchanged.

**Non-Goals:**

- Replacing AIO or BoxLite with a new sandbox backend.
- Removing the existing full CAP compose e2e path; it remains useful for API and deployment coverage.
- Changing the browser WebSocket protocol.
- Making Docker socket based AIO execution multi-tenant safe.
- Letting API choose between AIO/BoxLite/cloud-http or interpret their internal protocols.
- Publishing a release or changing deployment defaults as part of this refactor.

## Decisions

### Decision: `@cap/sandbox` becomes the provider center

`@cap/sandbox` will own provider registration, capability selection, explicit provider-family constraints, owner pinning, readoption, selected-run aggregation, workspace helpers, lifecycle plans, and provider-neutral terminal session behavior.

Alternative considered: keep `sandbox-scheduler`, `sandbox-lifecycle`, and `sandbox-workspace-git` as separate packages. This keeps package names tidy but creates extension points where the product has no independent adapter boundary. The selected approach reduces package sprawl and makes API consumption simpler.

Target structure:

```text
packages/sandbox/src/
  host-harness/
    harness.ts
    configured-provider.ts
    configured-terminal.ts
    command-executor.ts
    workspace-router.ts
    provider-readiness.ts
  provider-center/
    registry.ts
    router.ts
    selection.ts
    owner-store.ts
    readoption.ts
    selected-run.ts
    operation-router.ts
  terminal/
    session-engine.ts
    reconnect-frames.ts
    terminal-transport-registry.ts
  workspace/
    git.ts
    archive.ts
  lifecycle/
    settle-plan.ts
```

### Decision: API exposes a host harness, not provider composition

`apps/api` will bind one neutral host harness into Nest DI and hand it to `@cap/sandbox`. API code may implement or pass these host-side ports:

- sandbox run owner store
- provision lookup
- runtime registry
- runtime material resolver registry
- auth source persistence
- skill installer registry or resolver
- approval sink/router
- logger

API code must not import or call concrete provider factories, provider env readers, provider terminal transports, provider command executors, or provider-family selection helpers. The API binding should have the shape:

```ts
createConfiguredSandboxProvider({
  ownerStore,
  provisionLookup,
  runtimeRegistry,
  materialResolvers,
  codexAuthSource,
  skillInstallers,
  approvals,
});
```

The provider registry builder in `@cap/sandbox` is the only layer that reads provider configuration and imports provider package factories. This keeps all AIO/BoxLite/cloud-http knowledge out of API while still allowing provider packages to call host hooks through neutral contracts.

Alternative considered: let API call provider package factories with API-owned hooks. This removes the old provider class but still leaves API as the real provider composer, which is the architectural problem this change is meant to fix.

### Decision: provider packages own concrete backend lifecycle

`@cap/sandbox-provider-aio` will own Docker container creation, readiness, command execution, workspace materialization, terminal/command/workspace descriptors, retention, readoption, and runtime hook seams. `@cap/sandbox-provider-boxlite` will own its REST client, sandbox lifecycle, exec, terminal, archive/workspace, preflight, retention, and runtime hook seams.

Alternative considered: keep API-local provider classes and treat provider packages as helper libraries. That preserves current wiring but prevents provider packages from being independently tested and makes AIO/BoxLite look like unrelated implementations rather than adapters behind one center.

Provider packages may accept neutral host hooks from `@cap/sandbox`, but they must not import API modules, Nest providers, Prisma implementations, or API terminal gateway classes.

### Decision: terminal and command protocol handling move behind the harness

`TerminalGateway` remains the browser-facing Nest/WebSocket gateway. It owns operator authentication, write lease, control frame validation, snapshot/tail replay fanout, and guardrails exit mapping. It does not construct `AioPtyClient`, `AioTerminalTransport`, `BoxLiteTerminalTransport`, or any provider-specific command executor.

Instead, API obtains a neutral terminal session factory from the sandbox harness:

```ts
sandboxTerminalHarness.openSession({
  connection,
  selectedRun,
  runtimeContext,
  onExit,
});
```

AIO owns launch-or-attach, initial ready handling, tmux liveness, DSR/CPR startup handling, exit status resolution, AIO frame translation, and AIO command execution. BoxLite owns exec/attach, binary channel translation, resize/control frames, token/header handling, and BoxLite command execution. `@cap/sandbox` owns the registry that resolves the right provider terminal implementation from selected-run descriptors.

Alternative considered: keep provider transports in API behind a descriptor registry. This still requires API to register `aio-json-v1`, `boxlite-v1`, `aio-http-exec-v1`, and `boxlite-exec-v1`, so it fails the harness boundary.

### Decision: helper-only packages are merged into owning boundaries

`sandbox-scheduler`, `sandbox-lifecycle`, and `sandbox-workspace-git` move under `@cap/sandbox`. `sandbox-aio-local` moves under `@cap/sandbox-provider-aio`. `sandbox-conformance` becomes dev-only testkit or test code rather than a runtime dependency.

Alternative considered: keep all current packages and only change exports. That would not solve the user's architecture concern: packages with no independent extension reason would remain standalone.

### Decision: real provider e2e starts real providers but not CAP API or web

Provider e2e will prove that provider packages can independently complete their lifecycle:

```text
provider e2e runner
  -> provider package
  -> real AIO container or real BoxLite sandbox
  -> provision / exec / selectedRun / workspace / readoption / teardown assertions
```

AIO e2e may run a provider test runner container joined to a test Docker network with docker.sock mounted, because AIO addressability depends on container-name networking. BoxLite e2e will use `BOXLITE_*` env and real readiness checks, then create/delete real BoxLite sandboxes.

Alternative considered: fake-only provider contract tests. Those are still needed for fast feedback, but they cannot prove image, network, readiness, terminal transport, or real exec behavior.

### Decision: web rendering uses provider contract fixtures

Web e2e should not provision live providers. Provider e2e or checked-in fixtures will provide selected-run and terminal-frame fixtures. Vite story + Playwright will verify initial render, reconnect, snapshot/tail replay, scroll behavior, and provider descriptor rendering against those fixtures.

Alternative considered: keep provider terminal story tied to a live API/backend. That is useful as optional full-stack verification, but it is too heavy and too indirect for provider package validation.

### Decision: API becomes a thin sandbox host

API will construct/inject the sandbox host harness, persistence adapters, runtime hooks, auth lookup, approval sink, and Nest/WebSocket surfaces. It will not import helper subpackages directly, own concrete provider lifecycle logic, register provider terminal protocols, switch on provider command protocols, read BoxLite env, instantiate Docker, or provide AIO workspace fallbacks.

Alternative considered: leave current API module as the real provider center. That keeps fewer moved files but preserves the central problem.

## Risks / Trade-offs

- Provider refactor touches many files -> migrate in vertical slices and keep existing API e2e passing after each provider path.
- AIO e2e may be environment-sensitive because it needs Docker and network topology -> keep it opt-in locally/CI and provide a fake contract suite for default CI.
- BoxLite e2e depends on operator-provided endpoint/image/rootfs -> fail clearly when `BOXLITE_*` is missing and do not silently fall back to AIO.
- Moving packages can break Docker build order -> update workspace scripts and keep the existing Docker build regression checks.
- Terminal session extraction can regress reconnect/replay -> keep snapshot plus tail replay tests and web fixture Playwright coverage.
- Durable provider ownership may need schema or adapter changes -> support backward-compatible probing for older tasks without owner records.
- API boundary hardening can break current tests that encode provider details -> move those tests into provider packages or rewrite them as harness boundary tests instead of widening API allowlists.

## Migration Plan

1. Stabilize `@cap/sandbox-core` exports and remove accidental dependencies on provider implementations.
2. Build the new `@cap/sandbox` provider center using existing scheduler/router behavior as the source.
3. Move lifecycle and workspace helper code into `@cap/sandbox`.
4. Move AIO local config/spec helpers and full AIO provider orchestration into `@cap/sandbox-provider-aio`.
5. Normalize BoxLite provider package structure and runtime hook seams.
6. Define `SandboxHostHarness` in `@cap/sandbox` and replace API provider composition with a single host-harness factory call.
7. Move provider terminal clients/transports, provider command executor protocol handling, and provider workspace fallbacks out of API.
8. Move provider-specific readiness/env/family logic out of API provider terminal story support.
9. Move package unit tests into `test/` and add provider-package e2e suites.
10. Add web provider-terminal fixture stories and Playwright checks.
11. Update root/package scripts and CI grouping.
12. Remove or deprecate helper-only packages after all imports are moved.

Rollback strategy: keep API-facing behavior behind `@cap/sandbox` and preserve old full-stack e2e while migrating. If a provider package fails, route that provider family back through the previous API wiring until the package e2e passes.

## Open Questions

- Should `sandbox-cloud-http` remain a provider package or become an internal adapter under `@cap/sandbox` until a real remote provider contract is stable?
- Should conformance helpers live under `packages/sandbox/testkit` or under `packages/sandbox/test/conformance`?
- Does durable provider ownership need a new persisted field/table, or can the existing owner service be reused without schema changes?
- Should AIO provider e2e always run inside a runner container, or also support host-side mode when container-name networking is not needed?
- Should provider-specific approval hook enforcement stay in provider packages while API exposes only a neutral approval sink, or should all approval enforcement be provider-neutral under `@cap/sandbox`?
