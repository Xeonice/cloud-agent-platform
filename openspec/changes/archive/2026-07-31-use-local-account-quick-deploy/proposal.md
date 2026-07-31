## Why

The public release-image install path drifted away from the platform's current self-hosting auth model: it generated a shared legacy bearer token even though self-hosted operators should log in with local accounts. This made fresh deployments and docs teach a weaker, trial-only auth path as if it were the normal deployment capability.

## What Changes

- Change the release-image quick-deploy path to synthesize or reuse local-account credentials instead of a legacy bearer token.
- Disable legacy bearer auth in quick-deploy-managed `.env` files by setting `AUTH_TOKEN_LEGACY_ENABLED=false`.
- Print the admin email/password after successful bring-up and verify those credentials against `/auth/password`.
- Treat the optional provision smoke as a session-cookie operation requiring `CAP_SMOKE_COOKIE`, matching the forced first-login password-change model.
- Update site installer output, marketing copy, and self-hosting docs so the one-line path consistently instructs users to use admin email/password.
- Preserve the existing dev-only legacy token documentation for local development and break-glass use.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities

- `agent-oneclick-deploy`: release-image quick-deploy uses local account auth, prints admin credentials, and uses session-cookie smoke prerequisites.
- `one-line-installer`: site-hosted install/quick-deploy copy presents local account credentials and no longer positions the prebuilt path as legacy-token auth.

## Impact

- `scripts/quick-deploy.sh`
- `apps/www/public/install.sh`
- `apps/www/content/en.ts`
- `apps/www/content/zh.ts`
- `docs/self-hosting.md`
- `docs/self-hosting.zh.md`
- OpenSpec deltas for `agent-oneclick-deploy` and `one-line-installer`
