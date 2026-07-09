## Why

Custom sandbox images can install third-party tools such as `gcode`, internal package clients, or deployment CLIs, but CAP currently has no simple place for an admin to configure the parameters those tools need at task runtime. Tying every tool token to user-level forge credentials is too complex for the intended admin-managed image model.

## What Changes

- Add admin-managed image parameters on sandbox environment records.
- Support plain parameters and secret parameters:
  - plain parameters are readable by admins and injected into matching tasks.
  - secret parameters are write-only on API/UI reads and injected only at sandbox provisioning time.
- Inject the selected image's parameters into the sandbox after workspace provisioning and before the agent runtime starts.
- Materialize parameters as a standard CAP-owned env file that custom image wrappers can source, instead of baking tokens into image layers.
- Add cleanup/trim behavior so retained sandbox state does not intentionally keep image parameter files after task stop.
- Document the custom image wrapper pattern for tools such as `gcode`.

## Capabilities

### New Capabilities

- `sandbox-image-parameters`: Admin-managed runtime parameters for custom sandbox images, including secret handling, injection, cleanup, and wrapper consumption.

### Modified Capabilities

- `sandbox-environments`: Environment/image records can store admin-managed plain and secret parameters while keeping secret values write-only on read paths.
- `sandbox-provider-port`: Provider-neutral provisioning/setup must support injecting image parameters after workspace materialization and before runtime launch.
- `aio-sandbox-execution`: AIO task provisioning and teardown must materialize and later clear selected image parameters.
- `boxlite-sandbox-provider`: BoxLite task provisioning and teardown must materialize and later clear selected image parameters.

## Impact

- API/contracts:
  - sandbox environment create/read contracts gain image parameter descriptors.
  - Prisma stores plain parameters and encrypted secret parameters on `SandboxEnvironment`.
  - read APIs return secret parameter names but not secret values.
- Sandbox orchestration:
  - `ProvisionLookup` resolves image parameters for the selected/default environment at task provisioning time.
  - the host harness writes a standard env file before runtime setup for both AIO and BoxLite.
  - teardown removes the CAP image parameter env file best-effort.
- UI/docs:
  - Image Management surfaces parameter configuration during image registration.
  - custom image docs show wrappers sourcing the CAP env file.
- Tests:
  - contract/service tests cover secret redaction and injection resolution.
  - provider tests cover setup ordering and cleanup.
