<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-domain (depends: none)

- [x] 1.1 Remove `aio-loaded-docker-image` and `boxlite-rootfs` from `@cap/contracts` sandbox environment source schemas and exported source-kind unions.
- [x] 1.2 Update `@cap/sandbox-environment` source descriptor types, provider-family mapping, source reference/digest helpers, and compatibility helpers so managed sources are only AIO image and BoxLite image.
- [x] 1.3 Update contract/domain tests to assert removed source kinds are rejected and surviving AIO/BoxLite image sources still parse, resolve, and serialize.
- [x] 1.4 Review generated types/imports across the workspace and remove compile-time references to removed source kinds.

## 2. Track: api-environments (depends: contracts-domain)

- [x] 2.1 Update sandbox environment create/list/resolve services to reject removed source kinds without historical compatibility shims.
- [x] 2.2 Replace descriptor-only validation with provider-backed validation wiring for AIO and BoxLite image sources, recording non-secret probe output and failure reasons.
- [x] 2.3 Update API controller/service tests for create, validate, default selection, resolve, and serialization with the simplified image model.
- [x] 2.4 Add cleanup/migration behavior for existing managed rows using removed source kinds, with tests documenting the intentionally breaking behavior.

## 3. Track: aio-provider (depends: contracts-domain)

- [x] 3.1 Update AIO resolved-environment handling to accept only the managed AIO Docker image source.
- [x] 3.2 Remove AIO loaded-image branches and tests from provider/environment-validation code.
- [x] 3.3 Add or update AIO provider validation tests proving the selected image starts, required tools are checked, and invalid image references fail before task provisioning.

## 4. Track: boxlite-provider (depends: contracts-domain)

- [x] 4.1 Update BoxLite resolved managed-environment handling to accept only BoxLite image sources.
- [x] 4.2 Remove BoxLite rootfs managed-environment branches and tests from provider/environment-validation code while keeping deployment-level server-default handling separate if still required by installer internals.
- [x] 4.3 Add or update BoxLite image validation tests proving create/start/exec/delete checks run for the selected image and failures block readiness.
- [x] 4.4 Update provider-backed terminal story or readiness tests that referenced managed rootfs environments.

## 5. Track: frontend-image-library (depends: contracts-domain)

- [x] 5.1 Replace the `/images` add form source-kind dropdown with a provider selector (`AIO`, `BoxLite`) plus a single image-reference input.
- [x] 5.2 Update image-library list/detail labels so users see provider and image reference, not raw source-kind names.
- [x] 5.3 Add UI for viewing/copying the provider-specific extension template and build/push/import guidance.
- [x] 5.4 Update settings default-image dropdown and task-create environment selector tests for the simplified environment summaries.
- [x] 5.5 Remove frontend mock/test fixtures that create or display `aio-loaded-docker-image` or `boxlite-rootfs`.

## 6. Track: templates-docs (depends: none)

- [x] 6.1 Add repo-managed AIO custom image Dockerfile template derived from `ghcr.io/xeonice/cap-aio-sandbox:<version>`.
- [x] 6.2 Add repo-managed BoxLite custom image Dockerfile template derived from `ghcr.io/xeonice/cap-boxlite-sandbox:<version>`.
- [x] 6.3 Add docs explaining build, tag, push, and CAP import flow with pinned tags and no `latest`.
- [x] 6.4 Add a lightweight test or static check that the UI/docs reference the template files and that the templates keep `/home/gem/workspace` as the working directory.

## 7. Track: verification (depends: api-environments, aio-provider, boxlite-provider, frontend-image-library, templates-docs)

- [x] 7.1 Run targeted contract/domain tests for sandbox environment schemas and helpers.
- [x] 7.2 Run targeted API tests for sandbox environment create/validate/resolve flows.
- [x] 7.3 Run targeted AIO and BoxLite provider tests for image-source validation and provisioning behavior.
- [x] 7.4 Run targeted frontend tests for image management, settings default image, and task creation selectors.
- [x] 7.5 Run `openspec validate simplify-sandbox-image-model --strict` and address any spec formatting or requirement issues.
- [x] 7.6 Run broader typecheck/lint/build checks required by the touched packages before archive/release.
