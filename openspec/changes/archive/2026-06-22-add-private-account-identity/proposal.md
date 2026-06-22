## Why

Today the only way into the console is GitHub OAuth gated by the `AUTH_ALLOWLIST`
env var, so air-gapped or no-GitHub operators cannot get in and there is no
self-hosted private account. Because the backend runs as host-root over
`docker.sock`, "who can log in == who can run as root on the host" — the login
boundary is load-bearing. We need a private, self-hostable identity layer
(email+password and email verification code) alongside GitHub, with a default
admin provisioned at deploy, while keeping the fail-closed security posture.

## What Changes

- **BREAKING (data model):** Decouple `User` from GitHub. `User` gains
  `email? @unique`, `role`, `mustChangePassword`; a new `IdentityLink` table holds
  every login identity (`github` → encrypted access token, `password` → argon2
  hash). Existing GitHub users are backfilled into `IdentityLink` by migration;
  `User.githubId` / `User.githubAccessToken` columns are removed.
- **BREAKING (auth gate):** The per-request re-confirmation in
  `resolveSession` / `resolveApiKey` / `resolveMcpToken` switches from
  `isAllowlistedRaw(githubId)` to `User.allowed`. `AUTH_ALLOWLIST` is demoted to a
  GitHub **login-time provisioning** input (sets `allowed` on first login); it no
  longer takes effect at runtime.
- **Email + password login**: new public endpoint; argon2 hashing; forced
  first-login password change (`mustChangePassword`) enforced at the AuthGuard.
- **Email verification code (OTP) login**: passwordless login for accounts with a
  verified email; codes are short-lived, hashed-at-rest, rate-limited; delivered
  over SMTP (`nodemailer`). Hidden when SMTP is unconfigured.
- **Default admin bootstrap**: on first boot, seed a default admin; if no
  `ADMIN_PASSWORD` is set, generate a random one shown via a **one-time reveal**
  (plaintext in memory only, never persisted) and require a password change.
- **Account administration**: admins create / enable / disable / reset local
  accounts; GitHub-linked accounts are listed too (role read-only, disable-able)
  so they can be revoked under the pure-DB gate. No public registration.
- **GitHub OAuth keeps working**: scope adds `user:email`; primary verified email
  is stored on `User`; a GitHub login whose verified email matches an existing
  account auto-links to it (audited).
- **Login rate limiting**: add an anonymous IP + per-email throttle tier for the
  auth endpoints (the existing throttler keys on authenticated principal only).
- **Frontend**: login becomes a modal with three methods + first-login change
  dialog; a dedicated account-administration page reached from the account menu;
  capability flags hide unavailable methods; one-time admin-credential reveal.

## Capabilities

### New Capabilities
- `local-account-identity`: the `IdentityLink` model, decoupling of `User` from
  GitHub, email as canonical identity, the unified `User.allowed` runtime gate, the
  migration of `githubAccessToken` into the github identity, and verified-email
  auto-linking.
- `password-login`: email+password authentication, argon2 hashing, and the forced
  first-login password-change flow.
- `email-otp-login`: email verification-code authentication, code lifecycle
  (issue/verify/expire/cooldown), and SMTP delivery via nodemailer.
- `default-admin-bootstrap`: idempotent boot-time seed of the default admin and the
  one-time credential reveal.
- `account-administration`: admin-managed account lifecycle (create/enable/disable/
  reset, role assignment) over both local and GitHub-linked accounts.

### Modified Capabilities
- `multi-user-oauth`: runtime gate flips to `User.allowed`; `AUTH_ALLOWLIST` becomes
  login-time provisioning; OAuth fetches+stores verified email and auto-links;
  session minting routes through the identity layer; `mustChangePassword` gate.
- `api-key-auth`: re-confirmation switches from allowlist(githubId) to `User.allowed`.
- `mcp-server`: token re-confirmation switches from allowlist(githubId) to `User.allowed`.
- `request-rate-limiting`: add an anonymous IP + per-email throttle tier covering
  the pre-authentication auth endpoints.
- `frontend-console`: login modal (3 methods + first-login change), account-
  administration page, account-menu entry, auth capability flags, one-time admin
  reveal modal.

## Impact

- **Schema / data**: `prisma/schema.prisma` (User reshape + new `IdentityLink`);
  a data migration backfilling GitHub users into `IdentityLink` and moving the
  encrypted access token. Drops `githubId`/`githubAccessToken` columns.
- **API**: `apps/api/src/auth/*` (session service, guard, oauth controller/service,
  allowlist usage, new password/otp/seed-reveal controllers), new mail module,
  rate-limit additions, `secret-storage` reuse.
- **Token read points**: `github-import.service.ts`, `prisma-provision-lookup.ts`,
  `forge-target-resolver.ts` (+ specs) migrate to the github-identity helper.
- **Dependencies (new)**: `@node-rs/argon2`, `nodemailer`.
- **Env (new)**: `ADMIN_EMAIL`, `ADMIN_PASSWORD?`, `SMTP_HOST/PORT/USER/PASS/FROM`,
  OTP/login throttle knobs. `AUTH_ALLOWLIST` semantics change (provisioning, not
  runtime gate). Legacy `AUTH_TOKEN` path unchanged.
- **Frontend**: `apps/web` login route/modal, new accounts page, account menu,
  capability flags, API client methods; OD design baseline already updated.
- **CI/ops**: boot-smoke must cover seed path; deploy docs for `ADMIN_*` / `SMTP_*`.
