# @cap/sandbox

Sandbox scheduling and lifecycle core for CAP.

This package follows the same architectural direction as Sandbank:

- the provider is compute, not the long-term source of workspace truth;
- local and cloud sandbox backends are modeled as provider candidates;
- callers select providers by declared capabilities instead of class names;
- workspace materialize/deliver logic is separated from provider runtime
  lifecycle;
- terminal completion and guardrail failures share one explicit settle plan;
- provider adapters must prove conformance through the same local/cloud test
  matrix.

## Package Boundary

`@cap/sandbox` is now a compatibility aggregate. It must not own implementation
logic beyond re-exporting the smaller sandbox packages.

The implementation packages are:

- `@cap/sandbox-core`: capability vocabulary, provider ports, execution modes,
  connection/result shapes, descriptor helpers, and shared clone spec types.
- `@cap/sandbox-scheduler`: local/cloud candidate selection, capability
  matching, provider registry/router, task-owner pinning, and provision planning.
- `@cap/sandbox-lifecycle`: provider-neutral settle plans for terminal and
  guardrail paths.
- `@cap/sandbox-workspace-git`: git materialize/delivery command helpers and
  sandbox exec parsing/scrubbing.
- `@cap/sandbox-conformance`: framework-neutral provider conformance scenarios.
- `@cap/sandbox-aio-local`: local AIO/Docker adapter config, deterministic
  container naming/URLs, pinned image checks, and Docker create config.
- `@cap/sandbox-cloud-http`: cloud HTTP provider adapter.
- `@cap/sandbox-provider-aio`: AIO/Docker provider controller for container
  lifecycle, readiness, shell exec, retained transcript reads, and readoption.

All implementation packages remain framework-free except provider adapters at
the edge. They must not import Nest, Prisma, or app-specific runtime/auth ports.
The API assembles those dependencies and passes them into adapters.

The API keeps Nest wiring, runtime/auth lookup, task prompt, and skill policy in
`apps/api/src/sandbox/aio-sandbox.provider.ts`. The reusable AIO/Docker
mechanics live in `@cap/sandbox-aio-local` and `@cap/sandbox-provider-aio`.
Cloud providers implement the same candidate/capability contract and can then
be scheduled by the same selector/router.

Adapter packages should register themselves with:

- `defineLocalSandboxProvider(...)` for self-hosted Docker/AIO/VM providers;
- `defineCloudSandboxProvider(...)` for managed sandbox providers.

Both helpers return schedulable provider descriptors with declared capabilities,
priority, and location metadata.

The first local adapter config package is `@cap/sandbox-aio-local`; its Docker
lifecycle controller is `@cap/sandbox-provider-aio`. The first cloud adapter
package is `@cap/sandbox-cloud-http`, which talks to a CAP-compatible managed
sandbox control plane over HTTP.

`SandboxProviderRegistry` owns the in-memory candidate set for a process. It can
list local/cloud providers separately and select a capability-compatible
candidate through the shared scheduler.

`SandboxProviderRouter` is the upper-layer facade: apps inject one provider-like
object, while the router selects a local or cloud candidate per operation and
pins provisioned/readopted task ids back to the provider that owns them.

## Provider Locations

- `local`: self-hosted/local process, VM, Docker, or AIO-style provider.
- `cloud`: managed provider such as a future CAP-managed cloud sandbox.

Location is not a capability. It is scheduling metadata used after capability
requirements are satisfied. Priority wins first; location preference is only a
tie-breaker.

## Tests

See [docs/testing-strategy.md](./docs/testing-strategy.md).

Every sandbox package that owns implementation has a `coverage` script using
`c8 --100`. The repo-level `pnpm coverage:sandbox` runs the full sandbox
coverage gate across core, scheduler, lifecycle, workspace-git, conformance,
local AIO config, cloud HTTP, AIO provider controller, and this compatibility
aggregate.
