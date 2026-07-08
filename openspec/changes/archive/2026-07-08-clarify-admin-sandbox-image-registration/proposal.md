## Why

The custom sandbox image flow is being interpreted as a CAP-managed build/upload
pipeline, while the product should remain a control plane: admins register and
validate image references that already exist in a registry. The current OpenSpec
contract still mentions legacy source kinds such as "AIO already-loaded image"
and "BoxLite rootfs path" inside managed environments, which conflicts with the
implemented model and creates product confusion.

## What Changes

- **BREAKING** Remove legacy managed environment source kinds from the product
  contract: no AIO already-loaded Docker image source and no BoxLite rootfs path
  source in the image library.
- Reframe `/images` as an admin-only image registration and validation surface
  for existing registry image references.
- Make CAP's responsibility explicit: store non-secret image references,
  validate them through the configured provider, track readiness, and expose
  ready images for user default/task selection.
- Make non-goals explicit: CAP does not build images, upload images, host a
  registry, store registry credentials, or configure provider-host registry
  access.
- Preserve BoxLite rootfs as an advanced deployment-level default only, outside
  the managed image library and outside per-user/per-task image selection.
- Align user-facing copy and docs around "register image reference" and
  extension templates for AIO / BoxLite official base images.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `sandbox-environments`: managed sandbox environments only accept AIO registry
  image references and BoxLite registry image references; admin registration and
  validation are the only image-library operations.
- `frontend-console`: the image management UI distinguishes admin image
  registration from user image selection and must not imply upload/build/registry
  management.
- `self-hostable-deployment`: custom image documentation must present external
  build/push plus CAP registration as the supported chain, while keeping BoxLite
  rootfs documented only as deployment-level configuration.
- `boxlite-sandbox-provider`: provider behavior must continue supporting
  deployment-level image/rootfs defaults, but managed environment selection must
  use registry image references only.

## Impact

- Affected product surfaces: `/images`, settings default image selection, new
  task image selection, and sandbox image help docs.
- Affected contracts/specs: sandbox environment source kinds, validation
  semantics, BoxLite managed environment usage, and self-host custom image docs.
- No registry, builder, uploader, or credential-storage dependency is added.
- Existing deployment-level BoxLite rootfs support remains available for
  operators who configure `BOXLITE_ROOTFS_PATH` or release-asset rootfs mode.
