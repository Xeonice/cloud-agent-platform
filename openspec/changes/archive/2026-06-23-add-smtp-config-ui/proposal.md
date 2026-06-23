## Why

SMTP is configured ONLY by deploy-time env (`SMTP_*` in `files/api.env`); changing it means an
ssh edit + a container restart, and there is no in-console entry. Every other operator-managed
credential (Codex/compatible provider, forge tokens) is configured in Settings with the secret
encrypted at rest. SMTP should match: an admin sets/edits SMTP in the console, sends a test email
to confirm it, and the change takes effect immediately — no ssh, no restart.

## What Changes

- **DB-backed SMTP config (global, encrypted).** A new singleton `SmtpConfig` table holds the
  non-secret fields (`host`/`port`/`user`/`from`) plus the password ENCRYPTED at rest
  (`passCiphertext` + `passLast4` for display), reusing the existing `secret-storage`
  AES-256-GCM helpers (`encryptToStored`/`decryptStored`, `CODEX_CRED_ENC_KEY`, fail-closed). It
  is a deployment-level singleton (NOT per-user, unlike `CodexCredential`).
- **DB-first, env-fallback resolution.** The mail module resolves SMTP from the DB config first
  and falls back to the `SMTP_*` env when the DB is unconfigured — so today's env-configured Resend
  keeps working untouched, and an admin's UI config takes precedence once set.
- **Admin SMTP API.** `GET` (masked read — never returns the password), `PUT` (save), and
  `POST …/test` (send a test email to verify connectivity), all behind the same `requireAdmin`
  double-gate the account-administration API uses.
- **Capability gating reflects either source.** `isSmtpConfigured`/`isOtpAuthEnabled` (and the
  `GET /auth/session` capabilities) report OTP available when EITHER the DB config or the env is
  configured.
- **Settings UI (Resend-shaped, design-first).** An admin-only 邮件发送（Resend）section + config
  dialog that collects ONLY what Resend needs — the API Key (= the SMTP password) + the sender
  address — with the fixed `smtp.resend.com` / `465` / `resend` shown as copy, plus a 发送测试 action
  and masked status. A Resend **help page** (app-authored markdown behind the auth gate, reachable
  from the section — mirroring `forge-token-help`) documents domain verification + API-Key creation.
  The UI is designed FIRST in OpenDesign (`screens/settings.html` `#smtp` + `#smtp-dialog`) and
  implemented pixel-faithfully.
- **Contracts.** `SmtpConfig` request/response schemas (the password appears only on save, never
  on read).

## Capabilities

### New Capabilities

- `smtp-configuration`: admin-managed SMTP settings stored in the DB with the password encrypted at
  rest, a test-send action, and DB-first/env-fallback resolution for outbound mail.

### Modified Capabilities

- `email-otp-login`: OTP availability gating reports configured when EITHER the DB SMTP config or
  the `SMTP_*` env is present (not env-only).
- `frontend-console`: the Settings page gains an admin-only Resend SMTP section + config dialog and
  a Resend help page (markdown, reachable from the section).

## Impact

- **Contracts:** `@cap/contracts` — `SaveSmtpConfigRequest` / `SmtpConfigRead` (+ test request).
- **Backend:** new `SmtpConfig` Prisma model + migration; `mail.service` resolution becomes
  async + DB-first (MailService gains a `PrismaService` dependency); a new admin SMTP controller +
  service; `oauth-config.isOtpAuthEnabled` / `mail.isSmtpConfigured` + the session-capabilities
  path become async (DB + env).
- **Frontend:** Settings `SmtpConfigCard` + `SmtpConfigDialog`; `queries.ts`/`mutations.ts` seam.
- **Security:** `passCiphertext` encrypted (fail-closed — no key ⇒ never store plaintext);
  admin-only read/save/test; the read projection never returns the plaintext password.
- **Migration:** additive DB table; no data migration; env config remains the fallback so existing
  deployments are unaffected until an admin saves a DB config.
