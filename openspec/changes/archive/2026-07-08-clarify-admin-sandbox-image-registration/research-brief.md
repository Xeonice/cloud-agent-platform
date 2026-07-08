# Research Brief

## Context

CAP is the control plane for sandbox task execution. The custom image workflow
should not become an image build service, upload service, registry host, or
registry credential broker. Operators build and publish images outside CAP, then
CAP registers a non-secret image reference, validates it through the configured
provider, and exposes ready images for task selection.

## Current Findings

- The current contract implementation in `packages/contracts/src/sandbox-environment.ts`
  only accepts `aio-docker-image` and `boxlite-image` source kinds.
- API tests already reject removed source kinds such as `boxlite-rootfs`.
- The existing `sandbox-environments` spec still says supported source kinds
  include AIO already-loaded Docker image and BoxLite rootfs path. That spec is
  now misleading and should be tightened to the registry-image-only managed
  environment model.
- The current console image library already contains guidance and templates, but
  still uses wording such as "添加镜像" / "保存镜像" that can imply CAP is adding
  or uploading an image rather than registering an existing image reference.
- Documentation already states that CAP does not upload images or store registry
  tokens, and that provider hosts must be able to pull private/internal images.
  The proposal should make this an explicit product contract and keep it aligned
  with the UI.
- BoxLite rootfs support is still valid as a deployment-level provider default
  and self-update/release-asset path. It should remain documented there, but it
  must not be presented as a managed image-library source.

## Proposed Direction

- Treat `/images` as an admin-only image reference registry, not a builder,
  uploader, or registry manager.
- Rename admin flow language around registration and validation:
  "注册镜像" / "保存引用" / "已发布到 registry 的镜像地址".
- Keep ordinary user surfaces limited to choosing ready images in settings and
  task creation.
- Tighten OpenSpec requirements so managed sandbox environments only support
  AIO registry image references and BoxLite registry image references.
- Keep BoxLite rootfs in self-host/provider specs only as deployment-level
  configuration, with explicit non-goal language for image library usage.
