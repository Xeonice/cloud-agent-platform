# Research Brief: Sandbox Toolchain Metadata

## Problem

CAP's official AIO and BoxLite images bake Codex, Claude Code, and OpenSpec at
Dockerfile-pinned versions, but those versions are not emitted as a machine-readable
runtime contract. Custom images likewise have no small, explicit way to declare the
operator-relevant dependencies they contain. The console can select a runtime and a
sandbox environment, but it cannot show the versions the selected task will actually
start.

## Existing Seams

- `docker/aio-sandbox.Dockerfile` and `docker/boxlite-sandbox.Dockerfile` install the
  same pinned agent tools and already execute each tool's `--version` during build.
- Release CI builds both official sandbox images and packages them into registry and
  offline asset forms from the same release image set.
- Managed sandbox environments already have validation history with resolved image
  identity, probe results, and checked timestamps.
- Runtime preflight runs after provisioning and before runtime setup/launch, which is
  the correct boundary for reading required image metadata and failing closed.
- Task and sandbox-run records already retain non-secret environment/run metadata for
  audit and re-adoption.
- Both task creation surfaces share runtime and sandbox-environment selection, while
  the task detail page already renders a sandbox-starting state.

## Decisions

1. Every newly built supported sandbox image contains
   `/etc/cap/sandbox-metadata.json`; no compatibility path is required for old images.
2. Metadata includes a schema version, sandbox version, and a string map of only the
   dependencies the image builder explicitly chooses to expose.
3. Versions are exact build inputs/results; moving values such as `latest` are not
   valid persisted metadata.
4. Official images expose Codex, Claude Code, and OpenSpec. Custom-image build scripts
   may add any user-relevant dependency without CAP scanning the package inventory.
5. CAP reads and validates metadata before launching Codex or Claude Code, persists an
   immutable task/run snapshot, and returns that snapshot on task read surfaces.
6. The console shows the snapshot in the sandbox-starting/session context. It does not
   infer versions from the CAP release, image tag, or current environment validation.
7. A missing or invalid metadata file is a preflight failure for newly built images.

## Scope Boundaries

- No SBOM generation or npm/pip/apt inventory scanning.
- No arbitrary dependency probe configuration in the product UI.
- No per-task installation of `latest` agent CLIs.
- No backwards compatibility for images built before this contract.
- No mutation of an environment's metadata by dependencies installed during a task.

## Verification Implications

- Build tests validate both official Dockerfiles emit the same schema and required
  official dependency keys.
- Provider-neutral preflight tests cover valid, missing, and malformed metadata for
  AIO and BoxLite execution paths.
- API tests prove the snapshot is persisted and read back unchanged.
- Web tests cover version rendering during startup and after the task begins.
- Release verification proves registry images and packaged offline assets contain the
  same metadata.
