## Context

CAP's managed sandbox environment feature was introduced to let admins register,
validate, select, and audit task startup bases separately from the agent runtime
and sandbox provider. The implementation currently exposes internal source
kinds directly to the image-library UI and API: AIO Docker image, AIO already
loaded image, BoxLite image, and BoxLite rootfs path.

That shape is accurate from a delivery-mechanism perspective, but it is the
wrong product model. Operators need to manage custom AIO and BoxLite base
images. Whether a Docker daemon can pull the image, whether the image was
preloaded, or whether a release installer staged a BoxLite rootfs is deployment
mechanics. It should not create four product-level "image" concepts.

## Goals / Non-Goals

**Goals:**

- Reduce managed sandbox environment sources to two custom image concepts:
  AIO image and BoxLite image.
- Remove `aio-loaded-docker-image` and `boxlite-rootfs` from managed
  environment contracts, UI, API creation, provider environment selection, and
  tests without preserving historical compatibility.
- Keep image references pinned and auditable.
- Add user-facing templates for extending the official AIO and BoxLite bases.
- Validate custom images by actually starting short-lived provider sandboxes or
  containers and running runtime/tool probes.
- Keep `/settings` as a plain per-user default-image dropdown and `/images` as
  the admin image-library management surface.

**Non-Goals:**

- Browser upload of large Docker/rootfs blobs.
- In-product Dockerfile editing, registry hosting, or build farm execution.
- Automatic repair of registry reachability or Docker/BoxLite host setup.
- Preserving existing managed environment records that use removed source kinds.
- Removing deployment-level installer internals that stage official release
  assets for the server default; those internals are not a managed image-library
  source type.

## Decisions

### 1. Keep provider as the product choice and image reference as the only input

The image-library create flow will ask for:

- image name
- provider: `AIO` or `BoxLite`
- image reference
- optional runtime ids

The form will not ask admins to choose `loaded image`, `rootfs`, or other
delivery forms. The backend will construct the source descriptor from the
provider:

- AIO -> `aio-docker-image`
- BoxLite -> `boxlite-image`

Alternative considered: keep the four source kinds but hide advanced entries by
default. Rejected because the user requirement is to remove the concepts rather
than bury them in an advanced panel.

Alternative considered: rename `aio-docker-image` to `aio-image`. Rejected for
this change because the Docker image reference remains the exact provider
contract for AIO. The external product label should be "AIO image"; the internal
kind can stay explicit as long as there are only two managed kinds.

### 2. Remove loaded-image and rootfs from managed environment contracts

`@cap/contracts` and `@cap/sandbox-environment` will no longer accept
`aio-loaded-docker-image` or `boxlite-rootfs` in managed environment source
schemas. API create/validate/resolve paths will fail schema validation for those
kinds. Existing rows with removed kinds may fail to deserialize or be removed by
migration/cleanup; no compatibility shim is required.

Alternative considered: allow old rows but block new creation. Rejected because
the requested direction is to remove historical compatibility and avoid leaving
two hidden concepts in the model.

### 3. Validation must prove provider runtime readiness

The current descriptor-only validation marks environments ready without proving
that the provider can start the image. Validation will be provider-backed:

- AIO: create a short-lived container from the candidate image, confirm the
  expected workspace/runtime surface and required tools, then remove the probe.
- BoxLite: create/start/exec/delete a short-lived sandbox from the candidate
  image using the configured BoxLite endpoint.

Validation output remains non-secret and records probe names, pass/fail state,
digest when available, and a clear failure reason.

Alternative considered: validate only at task launch. Rejected because it lets
admins save/select broken images and makes normal task creation fail later.

### 4. Extension templates are product artifacts

The image library will provide copyable templates and commands for both
providers. The templates should live in repo-managed documentation/template
files and be surfaced in the UI rather than duplicated as ad hoc strings.

Template shape:

```Dockerfile
FROM ghcr.io/xeonice/cap-aio-sandbox:<cap-version>
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends <packages> \
  && rm -rf /var/lib/apt/lists/*
USER gem
WORKDIR /home/gem/workspace
```

```Dockerfile
FROM ghcr.io/xeonice/cap-boxlite-sandbox:<cap-version>
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends <packages> \
  && rm -rf /var/lib/apt/lists/*
USER gem
WORKDIR /home/gem/workspace
```

The accompanying commands should show build, tag, push, and CAP import using a
pinned tag, never `latest`.

Alternative considered: generate templates dynamically from installed provider
env. Rejected for the first pass because static official-base templates are
clearer and easier to test.

### 5. Registry and preload semantics stay outside CAP's product model

If an operator wants to use an internal registry, offline pull-through cache, or
preloaded Docker image, they are responsible for making the image reference
resolvable from the provider host. CAP validation is the proof point. There is
no separate "loaded image" type.

## Risks / Trade-offs

- [Breaking existing rows] -> No compatibility shim is required; implementation
  can delete, reject, or fail rows using removed source kinds and tests should
  assert the new behavior.
- [BoxLite installations still use release-asset rootfs for server defaults] ->
  Keep that path as deployment/internal configuration, but do not expose it as a
  managed custom image source.
- [Registry reachability failures become more visible] -> Surface validation
  errors clearly with provider family, image reference, and failed probe.
- [Templates can drift from official images] -> Keep templates minimal, derive
  from `ghcr.io/xeonice/cap-aio-sandbox:<version>` and
  `ghcr.io/xeonice/cap-boxlite-sandbox:<version>`, and include a test or docs
  check for the referenced template files.
- [Users may expect in-product build/upload] -> State explicitly that CAP imports
  image references and validates them; it does not build or host images.

## Migration Plan

1. Update contracts/domain types to remove `aio-loaded-docker-image` and
   `boxlite-rootfs` from managed environment schemas.
2. Update API creation/serialization/validation tests and remove compatibility
   branches for removed managed source kinds.
3. Update AIO and BoxLite providers so managed environments only resolve image
   references.
4. Replace descriptor-only validation with provider-backed probe validation.
5. Replace `/images` create UI with provider + image reference and add template
   guidance.
6. Add template files and documentation/tests.
7. Run targeted contract/API/frontend/provider tests and `openspec validate`.

Rollback is a normal code rollback before release. After release, rows created
with the simplified model remain valid because they use the surviving source
kinds.

## Open Questions

- Should the initial UI show the full template inline, or a compact "复制模板"
  action that opens a dialog?
- Should the API expose a higher-level create request (`providerFamily` +
  `image`) and stop accepting raw source descriptors from the console path?
