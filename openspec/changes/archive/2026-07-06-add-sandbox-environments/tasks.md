## 1. Track: domain-contracts (depends: none)

- [x] 1.1 Create `@cap/sandbox-environment` package with source descriptor, status, compatibility, validation result, resolved environment, and resolver/validator port types.
- [x] 1.2 Extend `@cap/sandbox-core` provision, selected-run, preflight, and owner metadata types to carry optional non-secret resolved environment metadata.
- [x] 1.3 Add package-boundary tests proving `@cap/sandbox-environment` does not import Prisma, Nest, Docker, BoxLite, or UI modules.
- [x] 1.4 Add unit tests for environment compatibility helpers, source ambiguity errors, ready/stale/failed selection gates, and immutable metadata normalization.

## 2. Track: persistence-api (depends: domain-contracts)

- [x] 2.1 Add Prisma models and migrations for sandbox environments, validation records, defaults, and nullable task `sandboxEnvironmentId`.
- [x] 2.2 Extend `@cap/contracts` task create/read schemas and add environment management schemas without breaking existing omitted-field behavior.
- [x] 2.3 Implement API services for admin environment CRUD, default selection, validation history reads, and non-secret task environment summaries.
- [x] 2.4 Implement environment resolution for task create/admission with explicit selection, managed default, and implicit deployment-default fallback.
- [x] 2.5 Wire console task creation and `/v1` task creation through the same resolver and fail-closed validation path.
- [x] 2.6 Add API tests for admin-only mutations, invalid environment rejection, default resolution, legacy task reads, and `/v1/openapi.json` schema output.

## 3. Track: provider-consumption (depends: domain-contracts)

- [x] 3.1 Update sandbox host harness and provider router to pass resolved environment metadata through provisioning and persist it in owner metadata.
- [x] 3.2 Update AIO provision spec/controller/provider to accept a resolved Docker-image environment while preserving `AIO_SANDBOX_IMAGE` fallback.
- [x] 3.3 Update BoxLite provider provisioning to consume resolved image/rootfs environment sources while preserving env image/rootfs map fallback.
- [x] 3.4 Add provider validation adapters for AIO transient container probes and BoxLite create/start/exec/delete probes.
- [x] 3.5 Add provider/router tests for selected environment override, incompatible-source fail-closed behavior, fallback defaults, and run metadata persistence.

## 4. Track: frontend-console (depends: persistence-api)

- [x] 4.1 Add API client queries/mutations for environment list, create/import, validate, default selection, and validation details.
- [x] 4.2 Add admin-only settings `运行环境` management UI with compact list, create/import form, default marker, status display, and validation detail drawer.
- [x] 4.3 Add ready-environment selector to dashboard new-task dialog and `/tasks/new`, filtered by selected runtime and backend readiness.
- [x] 4.4 Update create-task previews and task summaries to show the selected environment without exposing provider secrets.
- [x] 4.5 Add frontend tests for runtime-filtered selection, default fallback, mutation payloads, admin gating, and validation error display.

## 5. Track: self-update (depends: persistence-api)

- [x] 5.1 Add sandbox contract/version metadata used to decide whether custom environments remain ready after an update.
- [x] 5.2 Update self-update flow to preserve managed custom environments while staging the release default sandbox runtime asset.
- [x] 5.3 Mark custom environments stale or schedule revalidation when the target CAP version requires a newer sandbox contract.
- [x] 5.4 Add self-update tests for custom environment preservation, stale marking, and release-default fallback availability.

## 6. Track: verification (depends: provider-consumption, frontend-console, self-update)

- [x] 6.1 Run OpenSpec strict validation for `add-sandbox-environments`.
- [x] 6.2 Run package boundary, typecheck, and unit test suites covering contracts, API, sandbox packages, AIO, BoxLite, and web.
- [x] 6.3 Run provider smoke tests for AIO image override and BoxLite rootfs/image override using local validated environments.
- [x] 6.4 Run browser verification for settings environment management and create-task environment selection, including screenshot checks at desktop and mobile breakpoints.
- [x] 6.5 Run a self-host fallback regression where no managed environment exists and existing deployment env vars still provision tasks.
