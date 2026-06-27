## Context

The self-hosting stack now treats local accounts as the normal operator boundary. A default admin is seeded from `ADMIN_EMAIL` and `ADMIN_PASSWORD`, password login is exposed at `/auth/password`, and protected routes use a session cookie. The release-image quick-deploy path still taught a different model: generate a single shared legacy bearer token and print it as the login credential.

That mismatch is security-sensitive because quick-deploy is the public one-line path and is commonly driven by agents. The install path must be source-free and platform-aware as before, but it should no longer create or advertise bearer login for the console.

## Goals / Non-Goals

**Goals:**

- Make release-image quick-deploy boot with local account login by default.
- Preserve source-free release images, provider auto-selection, Docker preflight, and `/health` verification.
- Print the admin email/password that the operator should use, and verify the printed credential when possible.
- Keep legacy bearer documented only as a dev/break-glass option outside the quick-deploy path.
- Keep optional provision smoke aligned with session-cookie auth.

**Non-Goals:**

- Do not remove the legacy bearer implementation from the API.
- Do not change local development `make up` or dev token generation.
- Do not introduce OAuth or external identity setup into the one-line release-image path.
- Do not make the prebuilt `cap-web` suitable for arbitrary production domains; it remains localhost-oriented.

## Decisions

### D1 - Quick-deploy owns a local-account `.env`

`scripts/quick-deploy.sh` writes or updates `.env` with `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PASSWORD_AUTH_ENABLED=true`, `SESSION_SECRET`, `CODEX_CRED_ENC_KEY`, `CAP_VERSION`, and provider pins. Missing credentials are generated; existing values are reused. The script also writes `AUTH_TOKEN_LEGACY_ENABLED=false` so an old `AUTH_TOKEN` left in `.env` is not an active console login path for this installer.

Alternative considered: keep generating a legacy token and document local accounts separately. That preserves the old convenience but continues teaching the wrong deployment boundary.

### D2 - Credential output is verified, not assumed

After `/health` passes, the script posts the printed credentials to `/auth/password`. A fresh seeded admin should return 200. If the admin already existed and has since changed its password, the script still prints the `.env` values but warns that credential verification failed and the operator must use the current password.

Alternative considered: call the one-time admin reveal endpoint. That only works for generated-password mode and does not fit the script's explicit `ADMIN_PASSWORD` path.

### D3 - Provision smoke requires a post-first-login session cookie

The default seeded admin has `mustChangePassword=true`, so its initial password cannot be used to create tasks until the operator completes the forced password change. `RUN_SMOKE=1` therefore requires `CAP_SMOKE_COOKIE=<cap_session>` plus `CAP_SMOKE_REPO_ID`, matching `scripts/upgrade.sh`.

Alternative considered: automate the forced password change inside quick-deploy. That would mutate the operator credential unexpectedly and would need another generated secret to print.

### D4 - Public copy and docs follow the same contract

The site wrapper, marketing copy, Claude Code prompt, manual `.env` hints, and self-hosting docs all refer to admin email/password for the release-image path. MCP bearer tokens remain documented because they are a separate console-minted API surface.

## Risks / Trade-offs

- Existing `.env` contains a stale `ADMIN_PASSWORD` after the admin changed it: mitigated by the `/auth/password` credential check and warning.
- Existing `.env` contains `AUTH_TOKEN`: mitigated by forcing `AUTH_TOKEN_LEGACY_ENABLED=false` and warning that the token remains but is disabled for this path.
- Operators may expect `RUN_SMOKE=1` to work immediately after install: mitigated by explicit `CAP_SMOKE_COOKIE` guidance and a non-fatal skip when prerequisites are missing.

## Migration Plan

Deploy the changed scripts/site/docs in the next release. Existing quick-deploy hosts keep their database state; rerunning quick-deploy updates `.env` pins and disables legacy bearer auth for this path. If an existing admin has already changed its password, the operator keeps using that current password.

Rollback is reverting the script/docs change. No database migration is involved.

## Open Questions

- None.
