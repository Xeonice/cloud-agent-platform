## Research Brief

### External Reference: Sandbank

- Sandbank HEAD was checked at `891f3de4358681d64643319bfabea81c8f5472eb`.
- Sandbank positions the top-level `sandbank` package as a Workspace Agent Harness. Its durable state boundary is the Workspace; provider adapters are interchangeable execution backends.
- Sandbank's package split is capability-driven: `@sandbank.dev/core` owns provider SDK and capability helpers, `@sandbank.dev/workspace` owns durable workspace materialization/sync, `sandbank` owns the harness and provider scheduler, and provider packages own concrete backend adapters.
- Sandbank provider capabilities are optional and probed through typed helpers. The scheduler selects providers by declared capabilities rather than class names.
- Sandbank's provider scheduler flow materializes a workspace into the selected sandbox, executes, then syncs output back to the durable workspace. Provider-native volumes or snapshots are not the canonical state boundary.

### Current CAP Findings

- CAP already has many sandbox packages: `sandbox-core`, `sandbox-scheduler`, `sandbox-lifecycle`, `sandbox-workspace-git`, `sandbox-aio-local`, `sandbox-cloud-http`, `sandbox-conformance`, `sandbox-provider-aio`, `sandbox-provider-boxlite`, and `sandbox`.
- The split is too fine for helper-only packages. `sandbox-lifecycle`, `sandbox-workspace-git`, and `sandbox-aio-local` are implementation helpers, not long-term extension points.
- `@cap/sandbox` is currently an aggregate facade rather than the implementation center for provider registry, selection, owner pinning, readoption, selected runs, lifecycle, workspace helpers, and terminal session behavior.
- `@cap/sandbox-provider-boxlite` is close to a real provider package, but its e2e coverage is still light and API wiring still participates in runtime setup.
- `@cap/sandbox-provider-aio` currently contains controller-level pieces, while the full `AioSandboxProvider` orchestration remains under `apps/api/src/sandbox/aio-sandbox.provider.ts`.
- Existing provider tests are mostly under `src/*.test.mjs`; package unit tests should live under `test/`, and provider e2e should live under each provider package's `e2e/`.
- Existing live AIO e2e (`scripts/aio-e2e.sh` and `apps/api/test/aio-e2e.mjs`) proves the full CAP compose path, but it cannot serve as provider-package e2e because it requires the CAP API process and web-facing terminal endpoint.
- The terminal reconnect path already has a snapshot plus `tail_replay` contract. That behavior belongs to the provider-neutral sandbox terminal/session layer and web UI, not to AIO or BoxLite provider packages.

### Proposed Direction

- Keep only real extension boundaries as packages: core contracts, provider center, and concrete provider adapters.
- Move provider center concerns into `@cap/sandbox`, and make API consume sandbox through that package only.
- Collapse helper-only packages into either `@cap/sandbox` or the relevant provider package.
- Move the full AIO provider orchestration into `@cap/sandbox-provider-aio`.
- Keep BoxLite as a complete provider package and strengthen its real e2e coverage.
- Add provider-package e2e suites that start real AIO containers and real BoxLite sandboxes without starting the CAP API backend or the production web app.
- Keep web verification as fixture-driven Playwright stories that consume provider contract fixtures rather than provisioning live sandboxes.
