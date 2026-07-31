## 1. Track: quick-deploy-auth (depends: none)

- [x] 1.1 Update `scripts/quick-deploy.sh` to synthesize/reuse local account `.env` values (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PASSWORD_AUTH_ENABLED=true`, session secrets, provider pins).
- [x] 1.2 Disable legacy bearer auth for the quick-deploy path by writing `AUTH_TOKEN_LEGACY_ENABLED=false` and warning when a leftover `AUTH_TOKEN` is present.
- [x] 1.3 Print admin email/password instead of `Authorization: Bearer`, and verify the printed credential against `/auth/password` after `/health`.
- [x] 1.4 Change optional provision smoke to require `CAP_SMOKE_COOKIE` and `CAP_SMOKE_REPO_ID`, matching session-cookie protected task access.

## 2. Track: installer-docs-copy (depends: quick-deploy-auth)

- [x] 2.1 Update `apps/www/public/install.sh` to describe admin email/password login.
- [x] 2.2 Update English and Chinese site content to remove console-login bearer guidance from the release-image install path.
- [x] 2.3 Update English and Chinese self-hosting docs to describe quick-deploy as local-account based while preserving dev-only legacy token docs.

## 3. Track: verification (depends: installer-docs-copy)

- [x] 3.1 Run shell syntax checks for `scripts/quick-deploy.sh` and `apps/www/public/install.sh`.
- [x] 3.2 Run `git diff --check`.
- [x] 3.3 Run `pnpm --filter @cap/www typecheck`.
- [x] 3.4 Run `pnpm --filter @cap/www lint`.
- [x] 3.5 Scan release-image install/docs copy to confirm remaining bearer references are limited to MCP or dev-only legacy token documentation.
