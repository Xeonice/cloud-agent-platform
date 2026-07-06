# Research Brief: Custom Sandbox Environments

## Problem Summary

Internal and self-hosted CAP deployments need a productized way to run tasks on customized sandbox bases. Today the sandbox base is an operator/deployment concern:

- AIO uses `AIO_SANDBOX_IMAGE` and requires a pinned image before provisioning.
- BoxLite uses `BOXLITE_IMAGE`, `BOXLITE_IMAGE_MAP`, `BOXLITE_ROOTFS_PATH`, or `BOXLITE_ROOTFS_PATH_MAP`.
- Task creation persists `runtime` and `executionMode`, but has no task-level environment selection.
- `SandboxProvisionContext` carries only `taskId` and optional `cloneSpec`, so providers cannot receive a resolved environment through the provider-neutral port.

This makes internal customization possible only by editing deployment env, and it prevents operators from safely importing, validating, selecting, auditing, and preserving multiple sandbox bases.

## Existing Contracts and Code Boundaries

Relevant current contracts:

- `sandbox-provider-port` already requires provider-neutral provision/readoption ownership, selected run context, provider capabilities, and durable owner metadata.
- `aio-sandbox-execution` defines one task-scoped AIO container from the pinned derived AIO image.
- `boxlite-sandbox-provider` already recognizes image and rootfs sources, runtime image/rootfs maps, readiness probes, and fail-closed source validation.
- `repo-and-task-management` owns task create/read persistence.
- `frontend-console` owns create-task runtime selection and settings UX requirements.
- `self-update-action` stages sandbox runtimes during upgrade.
- `public-v1-api` owns the external task create schemas and delegates to the same task admission path.

Relevant current code:

- `packages/sandbox-core/src/provider.ts` defines `SandboxProvisionContext` with no environment field.
- `packages/sandbox/src/host-harness/harness.ts` defines runtime/provision lookup seams but no environment resolver.
- `packages/sandbox/src/provider-center/router.ts` selects a provider from capabilities, records provider ownership, and does not persist environment metadata.
- `packages/sandbox-provider-aio/src/aio-local-provider.ts` reads a single pinned image from `AIO_SANDBOX_IMAGE`; `AioSandboxProvider` creates the container before resolving runtime.
- `packages/sandbox-provider-boxlite/src/boxlite-config.ts` can resolve image/rootfs by runtime, but `BoxLiteSandboxProvider.provision()` currently resolves without the task runtime or an environment override.
- `packages/contracts/src/task.ts`, `apps/api/prisma/schema.prisma`, and `apps/api/src/tasks/tasks.service.ts` have task runtime fields but no `sandboxEnvironmentId`.
- The web create-task surfaces only select runtime/skills/guardrails today.

## Design Direction

Introduce a provider-neutral sandbox environment domain rather than treating custom images/rootfs as provider env vars:

- `AgentRuntime`: codex / claude-code.
- `SandboxProvider`: aio / boxlite / cloud-http.
- `SandboxEnvironment`: a validated base runtime environment source, such as a Docker image, a loaded Docker image digest, a BoxLite image, a BoxLite rootfs path, or a provider template.

Add a thin `@cap/sandbox-environment` package that depends on `@cap/sandbox-core` and defines:

- Environment/source descriptors.
- Resolver/materializer/validator ports.
- Compatibility and status result types.
- Immutable resolved environment metadata that can be carried through `SandboxProvisionContext` and `SelectedSandboxRun`.

Keep provider-specific Docker/BoxLite/Nest/Prisma code outside that package.

## Product Direction

Use the operator-facing term `运行环境`.

Admin settings should offer a focused management flow:

- List environments.
- Add/import an environment source.
- Validate it before use.
- Set a default environment.
- Inspect recent validation failures in detail only when needed.

Task creation should include a compact `运行环境` selector filtered by selected runtime and readiness. Only ready compatible environments should be selectable.

Avoid a metrics-heavy or education-heavy main UI. Dockerfile authoring/building can be a later enhancement; the first product layer should accept already-built/importable artifacts and make selection safe.

## Key Risks

- Mutable image tags can drift; store and display digest/checksum where possible.
- CAP upgrades can change the sandbox contract; custom environments must be preserved but marked for revalidation when the contract changes.
- Provider fallback must remain fail-closed: a task selecting a BoxLite-only rootfs must not silently provision on AIO.
- Validation must not happen inside the hot task launch path except as readiness enforcement; long probes belong to environment validation jobs.
