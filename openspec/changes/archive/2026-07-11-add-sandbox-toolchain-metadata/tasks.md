<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: metadata-contract (depends: none)

- [x] 1.1 Add the shared schema-version-1 sandbox metadata contract and types for exact `sandboxVersion` plus builder-declared dependency key/version pairs.
- [x] 1.2 Add parser validation for missing fields, duplicate/invalid dependency ids, empty values, unsupported schema versions, and moving `latest` selectors.
- [x] 1.3 Add focused contract tests for official, custom, malformed, and non-exact metadata payloads.

## 2. Track: image-build-metadata (depends: metadata-contract)

- [x] 2.1 Add a deterministic build helper that validates inputs and writes `/etc/cap/sandbox-metadata.json` without scanning installed packages.
- [x] 2.2 Update the AIO sandbox Dockerfile to generate metadata for the exact CAP, Codex, Claude Code, and OpenSpec build versions after the existing installation assertions.
- [x] 2.3 Update the BoxLite sandbox Dockerfile with the same helper and official dependency set, keeping its metadata shape identical to AIO.
- [x] 2.4 Update custom AIO and BoxLite image templates/build documentation so newly built custom images declare only user-selected dependencies through the helper.
- [x] 2.5 Add static and built-image smoke tests proving both official images contain valid, identical official toolchain metadata.

## 3. Track: environment-validation (depends: metadata-contract)

- [x] 3.1 Extend sandbox-environment validation contracts and persistence mapping to retain parsed builder-declared metadata with each validation result.
- [x] 3.2 Update the provider validation runner to read the fixed metadata file from its probe sandbox and fail missing, malformed, unsupported, or moving-version metadata.
- [x] 3.3 Expose non-secret validated metadata on sandbox-environment and validation read responses without enumerating undeclared packages.
- [x] 3.4 Add AIO and BoxLite custom-environment tests covering ready metadata, missing metadata, malformed metadata, and arbitrary declared custom keys.

## 4. Track: effective-run-snapshot (depends: metadata-contract)

- [x] 4.1 Add a provider-neutral pre-launch metadata read through the selected run command executor before runtime credential/setup commands.
- [x] 4.2 Fail runtime preflight with distinct reasons for missing/invalid metadata and for an official image that omits the selected Codex or Claude Code key.
- [x] 4.3 Persist the parsed effective snapshot in existing sandbox-run metadata together with effective image identity and preserve it across re-adoption/retention.
- [x] 4.4 Extend task read contracts and API mapping with an additive non-secret `sandboxMetadata` snapshot sourced from the effective run rather than the current environment.
- [x] 4.5 Add lifecycle tests proving metadata is read before Agent launch, remains immutable after environment/tag changes, and is unchanged by packages installed during a task.

## 5. Track: release-artifact-verification (depends: image-build-metadata)

- [x] 5.1 Make release CI pass one exact official toolchain version set into both sandbox image builds.
- [x] 5.2 Extend registry-image and offline-asset packaging verification to read sandbox metadata and compare CAP/tool versions across AIO and BoxLite distribution forms.
- [x] 5.3 Extend `cap-image-assets.json` generation or verification with the official metadata identity needed to detect mismatched packaged artifacts.
- [x] 5.4 Add release-script tests that fail for missing metadata, wrong CAP versions, or AIO/BoxLite toolchain drift.

## 6. Track: startup-version-ui (depends: effective-run-snapshot)

- [x] 6.1 Extend the real API client/query parsing for the task sandbox metadata snapshot and add fixtures for official and custom dependencies.
- [x] 6.2 Add a compact version region to the task sandbox-starting/session surface showing sandbox, Codex, Claude Code, OpenSpec, and arbitrary custom dependency versions.
- [x] 6.3 Preserve the existing neutral starting state until the effective snapshot exists and render concrete preflight failure instead of inferred versions when startup fails.
- [x] 6.4 Add responsive frontend tests for official metadata, unknown custom keys, pending metadata, failure state, and long version strings.

## 7. Track: end-to-end-verification (depends: environment-validation, effective-run-snapshot, release-artifact-verification, startup-version-ui)

- [x] 7.1 Build and inspect fresh AIO and BoxLite images, asserting the metadata file matches the installed CLI version commands.
- [x] 7.2 Run environment-validation and real task-start stories for both providers, proving metadata is read before Codex/Claude launch and returned unchanged on task reads.
- [x] 7.3 Verify a newly built custom image exposes only its explicitly declared custom dependencies and a metadata-less image fails closed.
- [x] 7.4 Run contract, API, sandbox provider, web, release packaging, boot-smoke, typecheck, and lint verification suites.
- [x] 7.5 Use Playwright at desktop and mobile widths to confirm the startup version region is readable, stable, and free of overlap.
