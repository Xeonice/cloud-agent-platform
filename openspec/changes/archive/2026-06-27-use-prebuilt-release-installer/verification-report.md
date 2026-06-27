# Verification Report

Generated: 2026-06-27 CST

## Summary

The release-image installer path is now the default site and Claude install path. A fresh install no
longer clones the repository or runs `make up`; it delegates to `quick-deploy.sh`, resolves a
concrete release tag, writes operational pins, pulls GHCR release images, and selects BoxLite on
macOS or AIO on Linux.

## Incident Evidence

The remote private deployment on `vibe-zlyan` had been installed through the old Claude/source-build
path. The running API container used local source images and had:

- image: `cloud-agent-platform-api`
- compose working dir: `/Users/zlyan/WorkProject/cloud-agent-platform`
- env: `CAP_VERSION=unknown`, `GIT_SHA=unknown`, `BUILD_TIME=unknown`
- `/version`: `{"version":"unknown","gitSha":"unknown","buildTime":"unknown"}`

That confirmed the root cause: the installer allowed an unversioned local build path where a
release-artifact path was required.

## Commands

Passed:

- `bash -n scripts/quick-deploy.sh`
- `sh -n apps/www/public/install.sh`
- `node legacy-token-synthesized-env.test.mjs`
- `CAP_VERSION=v0.24.0 COMPOSE_PROFILES=web docker compose -f docker-compose.prod.yml config >/tmp/cap-prod-config.yml`
- `node scripts/compose-host-bind.test.mjs`
- `node scripts/docker-compose.deploy-config.test.mjs`
- `pnpm --filter @cap/www typecheck`
- `pnpm --filter @cap/www lint`
- `openspec validate --specs --strict --no-interactive`
- `pnpm --filter @cap/www build`
- `git diff --check`
- targeted `rg` scan for `debugger` in changed paths

## Expected Warnings

`pnpm --filter @cap/www build` completed with existing warnings:

- Next.js plugin not detected in the ESLint config.
- `metadataBase` not set, defaulting to `http://localhost:3000`.

The static export injection also logged fallback warnings because `NEXT_PUBLIC_SITE_URL` was unset
in the local environment; it still wrote `out/install.sh`, `out/docker-compose.prod.yml`, and
`out/quick-deploy.sh`.
