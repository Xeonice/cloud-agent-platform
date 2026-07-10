## Why

CAP cannot currently identify or display the Codex, Claude Code, and builder-declared custom dependency versions contained in the sandbox that a task actually starts. Since the official and supported custom images will be rebuilt, CAP can establish a required image metadata contract now and make sandbox startup auditable without dependency scanning or runtime installs.

## What Changes

- Require every newly built supported sandbox image to include a small, versioned metadata file declaring the sandbox version and only the dependency versions selected by its builder.
- Generate the metadata during official AIO and BoxLite image builds for Codex, Claude Code, and OpenSpec, and provide the same build-script convention for custom images.
- Read and validate the metadata after sandbox provisioning but before the selected Agent runtime launches; missing or malformed metadata fails preflight.
- Persist the exact metadata with the task's effective sandbox run so later reads remain tied to the image that actually started.
- Display the effective sandbox and declared dependency versions in the task startup/session surface.
- Keep registry images and packaged AIO/BoxLite release assets coupled to identical metadata.
- **BREAKING**: images without the new metadata contract are no longer valid for new task starts; all supported images are rebuilt as part of this change.

## Capabilities

### New Capabilities
- `sandbox-toolchain-metadata`: Defines the required image metadata schema, builder-declared dependency semantics, pre-launch read, and immutable task snapshot.

### Modified Capabilities
- `release-and-versioning`: Official AIO and BoxLite registry/offline artifacts must be rebuilt with matching sandbox toolchain metadata and verified during release.
- `sandbox-environments`: Managed custom image validation must require and retain the builder-provided metadata before the environment becomes selectable.
- `frontend-console`: Task startup and session views must show the sandbox version and declared dependency versions from the task's effective snapshot.

## Impact

- Official sandbox Dockerfiles and their shared build helpers.
- Release workflow, offline image packaging, and release verification.
- Sandbox environment validation and provider-neutral runtime preflight for AIO and BoxLite.
- Task/sandbox-run persistence and task response contracts.
- Dashboard task dialog/full-page creation flow only insofar as they lead into the startup view; the version source remains the effective task snapshot.
- Task detail startup/session UI and corresponding API/query tests.
