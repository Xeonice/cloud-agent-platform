<!-- Track-annotated tasks. Tracks touch related files and were completed before archive. -->

## 1. Track: installer-entrypoint (depends: none)

- [x] 1.1 Replace the source-clone behavior in `apps/www/public/install.sh` with a Docker/curl/bash
      preflight and delegation to the site-served `quick-deploy.sh`.
- [x] 1.2 Remove obsolete repo URL marker injection from `apps/www/scripts/inject-install-sh.mjs`
      while continuing to stage `quick-deploy.sh` and `docker-compose.prod.yml` into the static
      export.
- [x] 1.3 Update install output so DNS, TLS, proxy, firewall, and auth-origin setup are described
      as operator-owned after local bring-up.

## 2. Track: prebuilt-version-and-platform (depends: none)

- [x] 2.1 Resolve `CAP_VERSION=latest` or an unset version to the latest GitHub Release tag before
      writing `.env`, pulling images, or starting compose.
- [x] 2.2 Update `.env` synthesis so stale operational pins (`CAP_VERSION`, `CAP_SANDBOX_PROVIDER`,
      `CAP_IMAGE_PLATFORM`) are corrected while secrets remain preserved.
- [x] 2.3 Make provider auto-selection platform-aware: macOS -> BoxLite, Linux -> AIO.
- [x] 2.4 Pin api/web release-image platform on non-amd64 hosts and reject explicit AIO staging on
      non-amd64 before pulling with BoxLite/control-plane guidance.
- [x] 2.5 Keep AIO image staging only for the AIO provider and skip it for BoxLite.

## 3. Track: compose-and-env-contract (depends: prebuilt-version-and-platform)

- [x] 3.1 Add `CAP_IMAGE_PLATFORM` support to release-image services in `docker-compose.prod.yml`.
- [x] 3.2 Stop overriding the API image-baked version with runtime `CAP_VERSION=latest`.
- [x] 3.3 Refresh `docker-compose.prod.env.example` for local-account auth, release version pins,
      platform/provider settings, BoxLite settings, and current public-origin guidance.

## 4. Track: docs-site-specs (depends: installer-entrypoint, compose-and-env-contract)

- [x] 4.1 Update landing content and Claude prompt so all advertised installs use the release-image
      path and current local-account positioning.
- [x] 4.2 Update README and self-hosting docs so `make up` is described as local source development
      or custom-build usage, not the default one-line install.
- [x] 4.3 Update OpenSpec specs for `one-line-installer`, `agent-oneclick-deploy`,
      `release-and-versioning`, and `marketing-www`.

## 5. Track: verification (depends: docs-site-specs)

- [x] 5.1 Run shell syntax checks for modified install scripts.
- [x] 5.2 Run targeted node tests for `.env` synthesis, compose host binds, and prod compose config.
- [x] 5.3 Run www typecheck, lint, and static build.
- [x] 5.4 Run OpenSpec strict validation for the full spec set.
- [x] 5.5 Run whitespace and targeted `debugger` scans before publishing.
