## Why

Self-hosted and internal CAP deployments need to customize the sandbox base image/rootfs for private networks, preinstalled tools, and enterprise mirrors. Today that customization is only a deployment-level env-var concern, so operators cannot safely manage, validate, select, or audit different sandbox bases per task.

## What Changes

- Add a productized `运行环境` concept for sandbox bases, separate from agent runtime (`codex` / `claude-code`) and sandbox provider (`aio` / `boxlite` / `cloud-http`).
- Allow admins to register/import sandbox environments from provider-specific sources such as pinned Docker images, already-loaded Docker images, BoxLite images, and BoxLite rootfs paths.
- Validate environments before they are selectable for tasks, recording compatibility with providers, runtimes, required tools, source digest/checksum, and validation errors.
- Let task creation choose an optional `sandboxEnvironmentId`; omitted tasks use the deployment/default environment for backward compatibility.
- Carry the resolved immutable environment through provider-neutral provisioning and selected-run metadata so providers consume a ready environment rather than rereading only global env vars.
- Preserve custom environments across self-update while marking them for revalidation when the CAP sandbox contract changes.
- Keep in-product Dockerfile editing/build/upload out of this first change; operators can bring an image/rootfs artifact and CAP manages validation, selection, and use.

## Capabilities

### New Capabilities

- `sandbox-environments`: Admin-managed sandbox environment registry, source descriptors, validation lifecycle, default selection, compatibility rules, and task-level environment resolution.

### Modified Capabilities

- `sandbox-provider-port`: Provisioning and selected-run contracts carry a resolved sandbox environment and persist non-secret environment metadata with provider ownership.
- `aio-sandbox-execution`: AIO provisioning can use a resolved ready Docker-image environment instead of only the deployment-level `AIO_SANDBOX_IMAGE`, while retaining the deployment image as the default fallback.
- `boxlite-sandbox-provider`: BoxLite provisioning can use a resolved ready image or rootfs environment for the task/runtime instead of only global env source maps.
- `repo-and-task-management`: Task create/read contracts persist and echo optional sandbox environment selection, and admission rejects unknown, incompatible, or not-ready environments before provisioning.
- `frontend-console`: Settings exposes admin `运行环境` management, and task creation exposes a compact ready-environment selector filtered by runtime.
- `self-update-action`: Self-update preserves custom environments and revalidates or marks them stale when the sandbox contract changes, instead of overwriting them with the new release default.
- `public-v1-api`: External task creation can supply the same optional environment selection and receives the same validation/admission behavior as the console path.

## Impact

- Adds storage and API surfaces for sandbox environments and validation records.
- Adds a provider-neutral `@cap/sandbox-environment` domain package and extends sandbox core provision/selected-run metadata.
- Updates AIO and BoxLite providers to consume resolved environment sources.
- Updates task contracts, Prisma task persistence, admission, and task read models with optional environment identity.
- Updates settings and create-task UI to manage/select environments without exposing provider secrets.
- Adds validation tests for resolver compatibility, provider source consumption, task admission, self-update preservation, and console flows.
