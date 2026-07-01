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

`@cap/sandbox` is the API-facing sandbox provider center. It owns the
provider-neutral implementation that the API should consume directly:

- provider registry and capability selection;
- explicit provider-family fail-closed errors;
- task owner pinning and readoption routing;
- selected-run aggregation;
- provider-neutral lifecycle settle plans;
- provider-neutral workspace materialize/delivery helpers.

The core and provider packages are:

- `@cap/sandbox-core`: capability vocabulary, provider ports, execution modes,
  connection/result shapes, descriptor helpers, and shared clone spec types.
- `@cap/sandbox`: provider center, lifecycle helpers, and workspace helpers.
- `@cap/sandbox-cloud-http`: cloud HTTP provider adapter.
- `@cap/sandbox-provider-aio`: AIO/Docker provider controller for container
  lifecycle, readiness, shell exec, retained transcript reads, and readoption.
- `@cap/sandbox-provider-boxlite`: optional BoxLite provider client, config,
  command/archive adapters, runtime preflight, and conformance fakes.

All sandbox packages remain framework-free except provider adapters at the edge.
They must not import Nest, Prisma, or app-specific runtime/auth ports. The API
assembles those dependencies and passes them into adapters.

The older helper packages (`@cap/sandbox-scheduler`,
`@cap/sandbox-lifecycle`, `@cap/sandbox-workspace-git`, and
`@cap/sandbox-aio-local`) are excluded from the current workspace package graph.
Their runtime code moved under `@cap/sandbox` or `@cap/sandbox-provider-aio`.
`@cap/sandbox-conformance` remains only as a dev-only testkit for provider
package tests; it is not exported by `@cap/sandbox` or used at runtime.

The API keeps Nest wiring plus runtime/auth lookup, task prompt, and skill
policy as provider hooks passed through `apps/api/src/sandbox/sandbox.module.ts`.
Reusable AIO/Docker mechanics live in `@cap/sandbox-provider-aio`; BoxLite lives
in `@cap/sandbox-provider-boxlite`. Providers implement the same
candidate/capability contract and are scheduled by the same registry/router.

Provider-center code registers adapters with:

- `defineLocalSandboxProvider(...)` for self-hosted Docker/AIO/VM providers;
- `defineCloudSandboxProvider(...)` for managed sandbox providers.

Both helpers return schedulable provider descriptors with declared capabilities,
priority, and location metadata.

The local AIO adapter config and Docker lifecycle live in
`@cap/sandbox-provider-aio`. The cloud adapter package is
`@cap/sandbox-cloud-http`, which talks to a CAP-compatible managed sandbox
control plane over HTTP.

BoxLite is a second optional provider package. It is registered by the sandbox
host harness only when valid `BOXLITE_*` configuration is present; API code does
not parse BoxLite configuration or call BoxLite factories directly.

`SandboxProviderRegistry` owns the in-memory candidate set for a process. It can
list local/cloud providers separately and select a capability-compatible
candidate through the provider center.

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

Every active sandbox package that owns implementation has a `coverage` script
using `c8 --100`. The repo-level `pnpm coverage:sandbox` runs the sandbox
coverage gate across core, cloud HTTP, AIO provider, BoxLite provider, and the
provider center.
