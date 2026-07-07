## Research Brief

### Current Shape

- The current managed sandbox environment contract exposes five source kinds:
  `aio-docker-image`, `aio-loaded-docker-image`, `boxlite-image`,
  `boxlite-rootfs`, and `provider-template`.
- The image-library UI maps those source kinds directly into the create form:
  `AIO Docker image`, `AIO loaded image`, `BoxLite image`, and `BoxLite rootfs`.
- The current backend `validate` path records a passing validation with
  `source descriptor accepted; provider probe pending`, so the product can show
  a ready image without proving the image can actually start and satisfy the
  runtime tool contract.
- The archived sandbox-environments design intentionally excluded browser-based
  large image upload/build, but the current UI uses "添加镜像" without showing how
  to extend the official base image or where the entered image is expected to
  come from.

### Product Problem

Users think in provider images:

- AIO image
- BoxLite image

`aio-loaded-docker-image` and `boxlite-rootfs` are delivery/internal runtime
details, not product-level image types. Presenting them as peer choices makes
the image library look like four different image concepts and forces users to
reason about deployment mechanics before they can add a custom base.

### Relevant Implementation Points

- `packages/contracts/src/sandbox-environment.ts` defines the public source-kind
  schema and create request shape.
- `packages/sandbox-environment/src/index.ts` maps source kinds to provider
  families and resolved metadata.
- `apps/web/src/components/settings/sandbox-environments-card.tsx` renders the
  current four-kind create form.
- `apps/api/src/sandbox-environments/sandbox-environments.service.ts` creates
  and validates environment rows.
- `packages/sandbox-provider-aio/src/aio-local-provider.ts` accepts both AIO
  source kinds today.
- `packages/sandbox-provider-boxlite/src/boxlite-provider.ts` accepts both
  BoxLite image and rootfs source kinds today.
- `docker/aio-sandbox.Dockerfile` and `docker/boxlite-sandbox.Dockerfile` are
  the official bases that custom templates should derive from.

### Proposed Direction

- Make the managed image model intentionally simple and breaking:
  - AIO environments use one Docker image reference.
  - BoxLite environments use one BoxLite image reference.
  - Removed kinds are not accepted by new contracts, UI, or API.
- Keep registry reachability and local preloading as operator responsibility:
  CAP validates the provider can start the referenced image, not how the image
  arrived on the host.
- Provide user-facing extension templates:
  - AIO Dockerfile template deriving from the matching official AIO base.
  - BoxLite Dockerfile template deriving from the matching official BoxLite base.
  - Build/tag/push/import guidance that encourages pinned tags and never
    `latest`.
- Replace descriptor-only validation with provider-backed validation so a ready
  image means a short-lived sandbox/container actually started and passed the
  runtime/tool probes.
