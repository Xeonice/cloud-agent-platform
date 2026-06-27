# Research Brief

## Current Contract

- `agent-oneclick-deploy` currently describes `scripts/quick-deploy.sh` as a source-free release-image bring-up path that synthesizes `AUTH_TOKEN_LEGACY_ENABLED=true` plus a random `AUTH_TOKEN`, then prints `Authorization: Bearer ...`.
- `one-line-installer` currently says the site-hosted installer delegates to that same prebuilt path and that the public quick-deploy option is legacy-token rather than local-account production.
- `self-hostable-deployment`, `default-admin-bootstrap`, and `password-login` already establish local account auth as the normal self-hosting path: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PASSWORD_AUTH_ENABLED=true`, and `/auth/password`.
- `scripts/upgrade.sh` already models provision smoke as a session-cookie operation through `CAP_SMOKE_COOKIE`, not a legacy bearer token.

## Code Paths

- `scripts/quick-deploy.sh` is the release-image source of truth used directly and by the site-served `quick-deploy.sh`.
- `apps/www/public/install.sh` is the site-hosted wrapper around `quick-deploy.sh`.
- `apps/www/content/en.ts` and `apps/www/content/zh.ts` expose the marketing/install prompts and manual `.env` hints.
- `docs/self-hosting.md` and `docs/self-hosting.zh.md` contain the operator-facing install guidance.
- `docker-compose.prod.yml` reads `env_file: .env` for auth variables and does not redeclare `AUTH_TOKEN`, so writing `AUTH_TOKEN_LEGACY_ENABLED=false` in `.env` disables the legacy path for this install flow.

## Decision

The release-image quick-deploy path should align with the platform's self-hosting security model: local account login is the operator entrypoint, and legacy bearer remains a documented dev-only/break-glass path. The script should generate or reuse local admin credentials, print those credentials, verify `/auth/password` after health, and require a post-first-login session cookie for optional provision smoke.

## Verification Signals

- Shell syntax for `scripts/quick-deploy.sh` and `apps/www/public/install.sh`.
- Site content typecheck/lint for the changed bilingual copy.
- OpenSpec validation for the new change only, because unrelated active changes may be incomplete.
