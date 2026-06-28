## Why

The release-image installer can currently bring up API/web on macOS while leaving the selected sandbox provider unusable, so the first task fails after install with `provision_failed`. The live `vibe-zlyan` deployment also showed that macOS shell portability, stale run-package files, Docker installation state, and unverified external dependencies are all part of the same install reliability problem.

## What Changes

- Make the site installer and `quick-deploy.sh` pipe-safe, macOS-safe, and explicit about installing Docker only when Docker is absent.
- Add install-time external dependency verification for required tools, Docker/Compose/socket, release endpoints, image registries, and selected sandbox provider readiness.
- Add a GitHub dependency validation path that can use a local, ignored test token without embedding secrets in source, specs, logs, or release artifacts.
- Ensure `quick-deploy.sh` refreshes managed run-package assets safely when an existing compose file is stale, while preserving operator secrets and volumes.
- Treat `CAP_SANDBOX_PROVIDER` as a real provider constraint so a forced BoxLite install cannot silently fall back to AIO.
- Productize the macOS BoxLite run path by either supporting BoxLite native REST directly or packaging/managing a compatible adapter, with capability declarations matching what the provider actually supports.
- Add real end-to-end validation using a local `lume` macOS VM for the release-image install path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `one-line-installer`: installer preflight gains safe Docker installation behavior, dependency classification, and pipe-safe delegation.
- `agent-oneclick-deploy`: quick-deploy gains macOS shell portability, external dependency checks, stale run-package refresh, selected-provider readiness gates, and GitHub validation support.
- `boxlite-sandbox-provider`: BoxLite support must be managed and protocol-compatible with the deployed BoxLite control plane, with terminal capability advertised only when the CAP terminal transport works.
- `sandbox-provider-port`: provider selection must honor explicit provider constraints and fail closed instead of silently selecting an unintended fallback provider.
- `release-and-versioning`: release/self-hosting docs must enumerate install-time versus task-time external dependencies and the validated macOS BoxLite release-image path.

## Impact

- Affected scripts: `apps/www/public/install.sh`, `scripts/quick-deploy.sh`, site static asset injection, and any new helper scripts for Docker/dependency preflight or BoxLite readiness.
- Affected backend/runtime code: sandbox provider registration, provider selection/router behavior, BoxLite REST client/adapter integration, and terminal transport selection if interactive BoxLite is implemented.
- Affected docs/specs: self-hosting, marketing install copy, env examples, and release-image caveats.
- Verification impact: adds shell tests, provider-selection tests, BoxLite protocol tests, dependency-preflight tests, and a maintainer-run `lume` macOS VM end-to-end install/task smoke.
