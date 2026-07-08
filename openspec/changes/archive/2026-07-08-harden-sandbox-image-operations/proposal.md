## Why

Live customization of the `vibe-zlyan` BoxLite service proved that CAP's
simplified image model is directionally right, but the operational edges around
registry access, BoxLite validation cleanup, failed image records, and
deployment-default rootfs customization are still too rough. Operators can build
custom images, but the current experience leaves them with unclear failures and
manual cleanup when registry or BoxLite host assumptions are wrong.

## What Changes

- Keep the managed image product model limited to AIO image and BoxLite image
  references; do not reintroduce BoxLite rootfs or loaded-image source types in
  the image library.
- Add an admin lifecycle action for sandbox environment records so failed,
  obsolete, or experimental image imports can be retired from the image library
  without direct database edits.
- Harden BoxLite managed-image validation so probe sandboxes are always cleaned
  up using the actual provider sandbox id returned by BoxLite.
- Improve BoxLite validation failure reporting for registry reachability and
  registry transport issues, including the common case where the BoxLite host
  cannot pull a private image or an HTTP-only local registry is not accepted.
- Update custom image templates and documentation so GHCR permissions, private
  registry responsibilities, architecture expectations, and pinned tags are
  explicit.
- Document the advanced deployment-level path for same-host BoxLite defaults:
  build from the official BoxLite image, export an OCI rootfs layout, set
  `BOXLITE_ROOTFS_PATH`, and restart the API. This remains a server-default
  operations path, not a managed image-library source.
- Keep repository and in-console custom image documentation synchronized so the
  console's `查看文档` page and the checked-in operator guide describe the same
  flow and failure modes.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `sandbox-environments`: Add admin retirement/deletion semantics for image
  records and require failed/retired environments to be excluded from defaults
  and task selection.
- `boxlite-sandbox-provider`: Harden managed BoxLite image validation cleanup
  and error reporting for provider sandbox creation/pull failures.
- `frontend-console`: Surface image retirement controls and actionable
  validation failures in the image-library UI while keeping `/settings` as a
  plain default-image selector.
- `self-hostable-deployment`: Document the BoxLite deployment-default custom
  rootfs path and the registry requirements operators must satisfy outside CAP.

## Impact

- API/controller/service changes for sandbox environment lifecycle management.
- Contract/schema updates if a retired/deleted status or delete response is
  exposed on the wire.
- BoxLite provider validation changes and tests for cleanup of returned sandbox
  ids and classified registry failures.
- Frontend image-library mutations/UI for retiring records and displaying clear
  validation guidance.
- Documentation and template updates for custom image builds, GHCR permissions,
  private registry reachability, and advanced BoxLite rootfs deployment.
- Targeted tests across contracts, API sandbox environments, BoxLite provider,
  frontend image management, docs/template checks, and OpenSpec validation.
