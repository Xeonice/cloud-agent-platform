## Context

CAP currently separates agent runtime (`codex`, `claude-code`) from sandbox provider
(`aio`, `boxlite`, `cloud-http`), but not from the sandbox base environment. The base
environment is still read from deployment configuration: AIO provisions from
`AIO_SANDBOX_IMAGE`, and BoxLite provisions from `BOXLITE_IMAGE` /
`BOXLITE_ROOTFS_PATH` plus runtime maps.

That works for a single deployment default, but it does not give admins a product
surface to import, validate, select, or audit different internal sandbox bases.
The existing sandbox split is the right place to add this: core owns
provider-neutral contracts, the sandbox facade owns orchestration seams, providers
consume concrete source descriptors, and API/UI own persistence and user flows.

## Goals / Non-Goals

**Goals:**

- Add a provider-neutral `SandboxEnvironment` domain that is distinct from runtime
  and provider.
- Let admins create/import environments from supported sources and validate them
  before use.
- Let task creation select an optional environment and fail closed before
  provisioning if the selection is unknown, stale, failed, or incompatible.
- Preserve existing deployments by falling back to the current deployment-level
  AIO/BoxLite source when no managed default exists.
- Carry immutable non-secret environment metadata through provisioning, selected
  run context, and sandbox owner records.
- Preserve custom environments across self-update and revalidate them when the
  sandbox contract changes.

**Non-Goals:**

- Building Docker images from Dockerfiles inside CAP.
- Uploading large image/rootfs blobs through the browser.
- Editing provider credentials or BoxLite endpoints through the environment
  feature.
- Making a custom environment bypass runtime credential readiness, guardrails,
  workspace materialization, or provider capability checks.
- Retrofitting already-provisioned running sandboxes to a new environment.

## Decisions

### 1. Add `@cap/sandbox-environment` as a thin domain package

Create a package that depends on `@cap/sandbox-core` and exports provider-neutral
types and pure helpers:

- `SandboxEnvironmentSourceDescriptor`
- `SandboxEnvironmentStatus`
- `SandboxEnvironmentCompatibility`
- `ResolvedSandboxEnvironment`
- resolver/materializer/validator port interfaces
- compatibility and fail-closed error helpers

It must not import Prisma, Nest, Docker, BoxLite clients, or UI code.

Alternative considered: keep environment types inside `@cap/sandbox-core`.
Rejected because environment validation and materialization are a larger domain
than the provider port itself. `sandbox-core` should only carry the minimal
resolved metadata needed by the provision contract.

Alternative considered: implement this only in API services. Rejected because AIO,
BoxLite, router, conformance, and future cloud providers need shared source and
compatibility vocabulary without depending on Nest or Prisma.

### 2. Resolve environments before provider provisioning

Task creation/admission resolves the runtime first, then resolves the requested or
default environment for that runtime. The resolved environment is passed through an
extended `SandboxProvisionContext`.

Providers consume only the resolved descriptor:

- AIO accepts a resolved Docker image source and passes it to `createContainer`.
- BoxLite accepts a resolved image or rootfs source and passes it to create/start.
- Cloud HTTP may later accept a provider-template source, but that is not required
  for this first change.

Alternative considered: let each provider reread the task row and environment row.
Rejected because it reintroduces provider-specific database knowledge and makes
router selection harder to reason about.

### 3. Validation is a pre-task lifecycle, not task launch work

Environment validation creates short-lived probe sandboxes/containers and records
results. Task launch only enforces that the selected environment is ready and
compatible; it does not run long validation probes inline.

Validation probes are provider-specific behind ports:

- AIO: create a transient container from the candidate image, poll `/v1/docs`,
  run required tool/runtime probes, then remove the probe.
- BoxLite: create/start/exec/delete a probe sandbox using image or rootfs.

Alternative considered: validate lazily on first task. Rejected because the user
experience is worse: task creation can look successful while provisioning fails
minutes later for a known bad base.

### 4. Persist identity on tasks and immutable source metadata on runs

`Task` stores the selected `sandboxEnvironmentId` when the operator or a managed
default selects one. `SandboxRun.metadata` stores non-secret resolved metadata:
environment id, source kind, image digest/checksum when known, source reference,
validation id/version, and environment contract version.

This lets task lists show what was selected while preserving the exact runtime
source actually used for replay/debug even if an environment is edited later.

Alternative considered: store only the current environment id. Rejected because
image tags and rootfs paths can drift and would make historical diagnosis
ambiguous.

### 5. Defaults are layered for backward compatibility

Resolution order:

1. Explicit `sandboxEnvironmentId` from the task create request.
2. Managed default compatible with the selected runtime/provider family.
3. Implicit deployment default derived from existing env vars.

The implicit default keeps existing installs working without a migration that
must create database rows before the first task can run.

### 6. UI stays operational and compact

Settings exposes `运行环境` as an admin management section. The main list focuses
on name, runtime compatibility, provider family/source, readiness, last
validation, and default marker. Details show validation output only when opened.

Task creation adds a compact selector filtered by selected runtime and ready
status. It does not expose image/rootfs internals unless the operator opens the
environment detail.

Alternative considered: a wizard that teaches image building and shows many
metrics cards. Rejected because the first product need is safe selection of
already-prepared internal artifacts.

## Risks / Trade-offs

- [Mutable tags drift] -> Store the resolved digest/checksum when validation can
  obtain one, and record that immutable metadata on `SandboxRun`.
- [Validation can be slow or flaky] -> Run it outside task launch, persist clear
  status/errors, and keep failed/stale environments non-selectable.
- [Provider fallback hides incompatibility] -> Bind environment compatibility to
  provider family/source kind and fail closed when the selected provider cannot
  consume it.
- [Self-update changes the sandbox contract] -> Preserve custom environments but
  mark them stale or revalidate them before future task use.
- [Rootfs paths are host-local] -> Treat BoxLite rootfs path environments as
  local deployment resources and validate readability from the BoxLite service,
  not from the browser or API process alone.

## Migration Plan

1. Add nullable task environment fields and new environment/validation tables.
2. Add the domain package and provision-context metadata without changing default
   behavior.
3. Add resolver fallback to existing deployment env vars.
4. Update AIO and BoxLite providers to consume the resolved environment when
   present.
5. Add admin APIs and UI for managed environments.
6. Add task-create selection after the resolver and providers are wired.
7. Add self-update revalidation/stale marking.

Rollback is safe while the task field is nullable: remove UI/API selection and
let resolver fall back to deployment env vars. Existing sandbox runs retain
non-secret metadata only.

## Open Questions

- Whether cloud-http environments should be first-class in this change or remain
  a provider-template placeholder until a real cloud provider contract exists.
- Whether managed defaults should be global only in the first implementation or
  also scoped by provider family and runtime from day one.
