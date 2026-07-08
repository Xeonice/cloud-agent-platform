<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: environment-lifecycle-api (depends: none)

- [x] 1.1 Add a sandbox environment retire/disable service method that marks the environment `disabled`, clears `isDefault`, preserves validations, and rejects missing ids.
- [x] 1.2 Expose the admin-only retire endpoint from `SandboxEnvironmentsController` using the existing auth/admin guard behavior.
- [x] 1.3 Ensure disabled environments are excluded from task resolution, global defaults, and settings default-image selectable lists.
- [x] 1.4 Add API/service/controller tests for admin retire, non-admin rejection, default clearing, validation history preservation, and disabled environment non-selectability.

## 2. Track: boxlite-validation-hardening (depends: none)

- [x] 2.1 Update BoxLite managed environment validation to track the sandbox id returned by `createSandbox()` and delete that actual id during cleanup.
- [x] 2.2 Preserve the original validation failure when cleanup also fails, while keeping cleanup failures non-secret and diagnostic.
- [x] 2.3 Add registry/pull failure classification for BoxLite validation errors covering unreachable registry, unauthorized/private image, HTTP/HTTPS transport mismatch, missing image, and architecture/start failures.
- [x] 2.4 Add BoxLite provider tests for generated provider ids, create failure fallback cleanup, cleanup failure behavior, and classified registry errors.

## 3. Track: frontend-image-library (depends: environment-lifecycle-api)

- [x] 3.1 Add the sandbox environment retire mutation to the real/mock API layer and query invalidation path.
- [x] 3.2 Add an admin image-library retire action with confirmation/copy that distinguishes retiring from deleting artifacts in the provider registry.
- [x] 3.3 Ensure retired/disabled image records are not shown in task-create or settings default-image selectable options.
- [x] 3.4 Improve validation failure rendering so registry access, authorization, architecture, missing-tool, and provider-configuration failures are visible without exposing secrets.
- [x] 3.5 Add frontend tests for retire mutation behavior, list refresh, selector exclusion, and validation failure display.

## 4. Track: docs-and-templates (depends: none)

- [x] 4.1 Update AIO and BoxLite custom image Dockerfile templates so documented builds avoid the empty/invalid `FROM` BuildKit warning while preserving `USER gem` and `/home/gem/workspace`.
- [x] 4.2 Update repository custom image docs with GHCR `write:packages`, private registry pull responsibility, architecture guidance, pinned tags, and registry validation failure troubleshooting.
- [x] 4.3 Update in-console custom image markdown with the same registry guidance and a clearly labeled BoxLite deployment-default rootfs section.
- [x] 4.4 Document the advanced BoxLite OCI rootfs flow: build/export OCI layout, set `BOXLITE_ROOTFS_PATH`, restart API, and run create/start/exec/delete verification.
- [x] 4.5 Add or update a lightweight docs/template static check that guards the shared critical guidance and template invariants.

## 5. Track: verification (depends: environment-lifecycle-api, boxlite-validation-hardening, frontend-image-library, docs-and-templates)

- [x] 5.1 Run targeted contract/API tests for sandbox environment retire/default/selection behavior.
- [x] 5.2 Run targeted BoxLite provider validation tests.
- [x] 5.3 Run targeted frontend image-library/settings/task-create tests.
- [x] 5.4 Run docs/template static checks.
- [x] 5.5 Run `openspec validate harden-sandbox-image-operations --strict`.
- [x] 5.6 Run broader typecheck/lint/build checks required by the touched packages before archive/release.
