<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-and-storage (depends: none)

- [x] 1.1 Add sandbox environment image parameter contract types for plain and secret parameters.
- [x] 1.2 Add Prisma storage for plain env vars and encrypted secret env vars with a migration.
- [x] 1.3 Update sandbox environment create/list mapping so secret values are write-only on read responses.
- [x] 1.4 Add contract/API service tests for validation, encryption, redaction, and backward-compatible empty params.

## 2. Track: provision-resolution (depends: contracts-and-storage)

- [x] 2.1 Replace task-owner forge credential resolver hook with selected-image parameter resolver hook.
- [x] 2.2 Resolve parameters from the explicit/default sandbox environment selected for task provisioning.
- [x] 2.3 Keep resolved environment metadata non-secret while returning parameter material only to setup.

## 3. Track: provider-setup-cleanup (depends: provision-resolution)

- [x] 3.1 Replace tool credential setup helper with image parameter env-file setup helper.
- [x] 3.2 Wire AIO to write `/home/gem/.cap/image-env` before runtime setup and remove it during pre-stop trim.
- [x] 3.3 Wire BoxLite to write `/home/gem/.cap/image-env` before runtime setup and remove it during teardown/readopt cleanup.
- [x] 3.4 Add provider/harness tests for setup order, missing params, secret redaction, and cleanup failure behavior.

## 4. Track: ui-docs (depends: contracts-and-storage)

- [x] 4.1 Add Image Management create-form controls for image parameters, including secret rows.
- [x] 4.2 Display parameter names on image rows while hiding secret values.
- [x] 4.3 Update custom image docs and templates to describe sourcing `/home/gem/.cap/image-env`.

## 5. Track: validation (depends: provider-setup-cleanup, ui-docs)

- [x] 5.1 Run targeted contracts, API, sandbox, BoxLite provider, and web tests.
- [x] 5.2 Run OpenSpec validation for `inject-sandbox-tool-credentials`.
