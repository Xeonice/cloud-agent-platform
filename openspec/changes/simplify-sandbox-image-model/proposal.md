## Why

The image library currently exposes internal delivery details as user-facing
image types, so admins must choose between `AIO Docker image`, `AIO loaded
image`, `BoxLite image`, and `BoxLite rootfs` even though the product concept is
only "which AIO or BoxLite base image should new tasks use". This makes custom
image setup hard to understand and hides the missing guidance for extending the
official CAP sandbox images.

## What Changes

- **BREAKING** Remove `aio-loaded-docker-image` and `boxlite-rootfs` from the
  managed sandbox environment model; no historical compatibility path is
  required for existing rows or clients using those source kinds.
- **BREAKING** Managed sandbox environments SHALL support only two product image
  sources:
  - AIO image: a pinned Docker image reference.
  - BoxLite image: a pinned BoxLite-compatible image reference.
- Replace the image-library create flow with a provider-first form: choose
  `AIO` or `BoxLite`, enter a single image reference, optionally scope runtimes,
  then validate.
- Add user-facing extension templates for both providers, showing how to derive
  from the official CAP sandbox images, install extra packages/tools, tag the
  result, push it to the operator's registry, and import that pinned tag into
  CAP.
- Treat registry reachability, Docker preloading, and BoxLite delivery as
  operator/deployment concerns rather than separate managed image types.
- Replace descriptor-only validation with provider-backed validation before an
  image can become selectable.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `sandbox-environments`: Restrict managed environment sources to AIO image and
  BoxLite image, remove loaded-image/rootfs source kinds, and require real
  provider-backed validation before readiness.
- `frontend-console`: Simplify image management to provider + image reference,
  and add custom image extension templates/guidance in the image-library flow.
- `aio-sandbox-execution`: Consume only managed AIO image references for custom
  environments.
- `boxlite-sandbox-provider`: Consume only managed BoxLite image references for
  custom environments.

## Impact

- Contract/schema changes in `@cap/contracts` and `@cap/sandbox-environment`.
- API changes in sandbox environment creation, validation, serialization, and
  any tests that reference removed source kinds.
- Provider changes so AIO and BoxLite reject removed managed source kinds.
- Frontend changes to the `/images` image-library create/import UI and display
  labels.
- New or updated docs/templates for custom AIO and BoxLite Dockerfiles.
- Existing managed environment rows using removed source kinds may be deleted,
  rejected, or fail parsing after the change; no migration compatibility is
  required.
