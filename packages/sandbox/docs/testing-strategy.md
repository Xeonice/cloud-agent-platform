# @cap/sandbox Testing Strategy

The sandbox area is split around real extension points: core provider contracts,
the CAP provider center, and concrete provider adapters. Helper-only scheduler,
lifecycle, workspace-git, and AIO-local packages are no longer active workspace
packages; their runtime logic lives under `@cap/sandbox` or
`@cap/sandbox-provider-aio`. Provider adapters must prove conformance against
the shared contracts.

## Coverage Gate

Every implementation package has a `coverage` script using `c8 --100`.

- `@cap/sandbox-core`
- `@cap/sandbox-cloud-http`
- `@cap/sandbox-provider-aio`
- `@cap/sandbox-provider-boxlite`
- `@cap/sandbox` provider center

Run all sandbox coverage gates with:

```sh
pnpm coverage:sandbox
```

Run the package unit suites without coverage with:

```sh
pnpm test:sandbox
```

Real provider e2e suites are owned by provider packages and do not start the CAP
API backend or production web app:

```sh
pnpm --filter @cap/sandbox-provider-aio test:e2e
pnpm --filter @cap/sandbox-provider-boxlite test:e2e
```

The frontend provider terminal fixture story runs without the CAP API backend or
live provider resources:

```sh
pnpm --filter @cap/web test:provider-terminal-story
```

## Unit Tests

- Core: capability constants, execution modes, provider descriptors, local/cloud
  descriptor helpers, and legacy explicit capability declarations.
- Single-provider compatibility: declared providers fail closed; legacy test
  doubles can be allowed only through the single-provider compatibility helper.
- Candidate scheduling: local and cloud candidates are ranked by priority,
  optional location preference, then declaration order.
- Provider registry: duplicate ids are rejected, local/cloud provider lists stay
  separate, and selection delegates to the shared capability scheduler.
- Provider router: local/cloud candidates are exposed as one provider facade;
  provisioning picks a capability-compatible backend, task ownership is pinned,
  readoption is aggregated, and restart-time transcript/existence checks probe
  compatible providers.
- Candidate rejection: undeclared multi-provider candidates are rejected by
  default; missing capabilities are reported with candidate ids.
- Provision planning: selected `cloneSpec` and required capabilities are built
  together so static preflight and materialization cannot drift.
- Lifecycle planning: natural terminal exits and guardrail failures share one
  settle plan, with delivery enabled only for natural terminal completion.
- Workspace git helpers: clone and push commands keep credentials out of URLs,
  commit messages are file-injected through base64, and failure text is scrubbed.
- Exec parsing: nested and flat sandbox exec responses parse identically, while
  missing/unparseable exit codes remain `NaN` so callers can fail closed.
- Conformance helpers: provider adapters can run a shared framework-neutral
  scenario list that checks capabilities, provision handles, existence, delivery,
  retained transcripts, readoption surfaces, and teardown shape.
- Adapter edges: AIO provider tests cover pinned image validation, readiness
  timeout parsing, deterministic container naming, no host port bindings,
  seccomp guard, task-id parsing, Docker lifecycle, command execution, terminal
  transport, retention cleanup store, and descriptor capability selection. Cloud HTTP
  tests cover request bodies, auth headers, default/global fetch behavior,
  invalid responses, 404/204 idempotency, fail-open delivery/transcript/reattach
  reads, and fail-closed provision/teardown errors. AIO provider-controller tests
  cover Docker create/start/stop/remove mechanics, readiness polling, best-effort
  shell exec, startup readoption/reaping, reattach bookkeeping, retained
  transcript tar extraction, and malformed archive handling. BoxLite tests cover
  REST client normalization, explicit config parsing, task-scoped idempotent
  provision/reattach/teardown, command/archive adapters, terminal capability
  gating, runtime preflight caching, fake-client conformance, and guarded live
  integration.

## Provider Conformance Tests

Every local or cloud provider adapter should run the same conformance suite:

- Identity: provider id, location (`local` or `cloud`), priority, and declared
  capabilities are stable.
- Provision idempotency: repeated provision for a task returns the same handle
  and does not create a second sandbox.
- Runtime preflight: required image tools are probed before workspace
  materialization or runtime setup side effects.
- Workspace materialization: selected `cloneSpec` is used exactly once; provider
  fallback lookup is not consulted when the scheduler supplied a spec.
- Terminal attachment: `terminal.websocket` providers return an addressable
  WebSocket handle and can reattach after process restart when they also declare
  `lifecycle.readopt`.
- Delivery: `workspace.git.deliver` providers push only through the sandbox
  workspace bridge and never persist auth headers.
- Retained transcript: `transcript.retained-read` providers read only runtime
  transcript paths and never export credential files.
- Settle semantics: teardown is idempotent, stop-only when retention is expected,
  and never blocks slot release on provider errors.

## Integration Tests

- Local provider path: run against the AIO/Docker adapter with no host port
  publishing, network-only control-plane access, runtime preflight, clone,
  terminal connect, delivery, stop-only retention, transcript replay, and
  startup re-adoption. `@cap/sandbox-provider-aio` covers deterministic local
  adapter config, pinned image checks, container create options, task-id parsing,
  descriptor metadata, and the framework-free Docker lifecycle/readoption/
  transcript mechanisms that the API consumes through the sandbox host harness.
- Cloud provider path: run the same conformance suite against a managed provider
  adapter using test credentials, verifying cloud sandbox creation/destruction,
  addressable terminal handles, workspace materialize/sync, and provider-side
  cleanup. `@cap/sandbox-cloud-http` covers the HTTP control-plane adapter with
  fake-fetch unit tests. `@cap/sandbox-provider-boxlite` covers its BoxLite REST
  adapter with fake-client tests and runs live BoxLite checks only when
  `BOXLITE_LIVE_TEST=1` and valid `BOXLITE_*` env vars are configured.
- Mixed scheduling path: configure one local and one cloud candidate. Verify
  priority wins, location preference is only a tie-breaker, and a higher-priority
  candidate missing required capabilities is skipped.
- Failure path: force runtime preflight, clone, delivery, retained transcript,
  and teardown failures; verify the orchestrator records failure state while
  still releasing slots and unregistering sessions.
- Restart path: keep a live local/cloud sandbox across API process restart,
  list readoptable sessions, reattach valid ones, and reclaim DB in-flight rows
  that no provider can prove live.
