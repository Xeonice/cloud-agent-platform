## Research Brief

This change follows the `simplify-sandbox-image-model` work and the live
`vibe-zlyan` BoxLite customization exercise. The simplified product model is
still correct: managed sandbox environments expose AIO image and BoxLite image
references only. Local rootfs paths remain deployment-level server defaults.

### Field Findings

- Extending the official BoxLite base image and pushing to a regular registry
  is the intended product path, but pushing a new GHCR package failed when the
  current token lacked `write:packages`.
- A local HTTP registry on the BoxLite host was usable by Docker but failed
  during BoxLite image validation because native BoxLite attempted HTTPS for the
  `127.0.0.1:5000` registry reference.
- The operator still needed a practical same-host default path. Exporting the
  custom BoxLite image as an OCI layout and pointing `BOXLITE_ROOTFS_PATH` at it
  worked for the deployment default, but that path is currently scattered
  across deployment internals and not documented as an advanced operation.
- Failed registry validation creates a failed environment row. The API exposes
  list, create, validate, set-default, and validation history, but no admin
  retire/delete action, so test/import mistakes linger in the image library.
- `validateBoxLiteEnvironment` deletes the requested probe sandbox id in
  `finally`, but native BoxLite may return a different provider box id. Cleanup
  should target the returned sandbox id once known.
- The checked-in Dockerfile templates use `ARG CAP_VERSION` before `FROM`
  without a default, which works with `--build-arg` but triggers BuildKit's
  `InvalidDefaultArgInFrom` warning.
- There are two user-facing docs for the same flow:
  `docs/sandbox-images.zh.md` and `apps/web/src/content/sandbox-images.md`.
  They should stay in sync, especially around registry requirements and
  deployment-default rootfs guidance.

### Relevant Code Paths

- Sandbox environment API:
  `apps/api/src/sandbox-environments/sandbox-environments.controller.ts`
  and `apps/api/src/sandbox-environments/sandbox-environments.service.ts`
- Shared contracts:
  `packages/contracts/src/sandbox-environment.ts`
- BoxLite validation:
  `packages/sandbox-provider-boxlite/src/boxlite-environment-validation.ts`
  and `packages/sandbox-provider-boxlite/src/boxlite-client.ts`
- Image library UI:
  `apps/web/src/components/settings/sandbox-environments-card.tsx`
- Operator docs/templates:
  `docs/sandbox-images.zh.md`,
  `apps/web/src/content/sandbox-images.md`,
  `examples/sandbox-images/aio/Dockerfile`,
  `examples/sandbox-images/boxlite/Dockerfile`

### Proposal Direction

Treat this as operational hardening rather than another product-model change:

- Keep only AIO image and BoxLite image as managed environment sources.
- Add an admin lifecycle action for bad/obsolete image records.
- Make BoxLite image validation clean up actual provider boxes and surface
  registry reachability failures clearly.
- Document the supported registry path and the advanced deployment-default
  BoxLite rootfs path without making rootfs a managed image source.
- Remove template warnings and keep console/help docs aligned.
