## Context

SMTP is env-only today: `mail.service` reads `SMTP_*` from `process.env` via `resolveSmtpConfig`
(sync), gated through `resolveTransportFor`/`isSmtpConfigured`; `oauth-config.isOtpAuthEnabled`
delegates to it; `GET /auth/session` returns the capability flags (sync). The repo already has the
pattern we need: `settings/secret-storage.ts` encrypts secrets at rest (AES-256-GCM,
`encryptToStored`/`decryptStored`, key `CODEX_CRED_ENC_KEY`, fail-closed) and `CodexCredential`
persists `apiKeyCiphertext` + `apiKeyLast4`; the Settings page composes admin sections
(Codex dialog, MCP card) over a `queries.ts`/`mutations.ts` seam; and `accounts` enforces an
admin double-gate (`requireAdmin` server-side + `isAdminSession`/route gate client-side).

## Goals / Non-Goals

**Goals:**
- An admin configures SMTP in the console (host/port/user/pass/from), with the password encrypted
  at rest, and sends a test email to confirm — no ssh, no restart.
- Outbound mail prefers the DB config and falls back to the `SMTP_*` env, so existing env
  deployments are unaffected until an admin saves a DB config.

**Non-Goals:**
- Not per-user SMTP — this is a single deployment-level config (unlike `CodexCredential`).
- No new crypto — reuse `secret-storage`.
- No change to OTP generation/TTL/cooldown or the email template; only the SMTP *source* + a config
  surface.
- The China-mainland multi-channel routing remains out of scope (the `resolveTransportFor` seam is
  unchanged in spirit; this change adds a DB source, not a second channel).

## Decisions

**D1 — Global singleton `SmtpConfig` table.** A single row (fixed id, upserted on a constant, like
`SystemSettings`) holds `host`/`port`/`user`/`from` (non-secret) + `passCiphertext` + `passLast4`.
SMTP is one outbound server for the deployment, so it is global, NOT keyed by `userId`.

**D2 — Reuse `secret-storage` for the password.** `passCiphertext = encryptToStored(pass)` on
save; `decryptStored` on read for sending; `passLast4` is the masked suffix for display. No new key
or algorithm. Fail-closed: with no `CODEX_CRED_ENC_KEY`, a save is rejected (never store plaintext)
— surfaced to the admin as a clear error.

**D3 — DB-first, env-fallback resolution.** `resolveTransportFor` becomes async: it resolves the DB
config first (decrypting the password) and falls back to `resolveSmtpConfig(env)` when the DB row
is absent. This keeps today's env Resend working as the fallback and lets a saved DB config take
precedence. `ResolvedSmtpConfig` carries a `source: 'db' | 'env'` for diagnostics.

**D4 — Async-ify the mail + capability path.** `MailService` gains a `PrismaService` dependency;
`resolveTransportFor`/`isSmtpConfigured` and `oauth-config.isOtpAuthEnabled` become async (DB +
env); the `GET /auth/session` capabilities computation awaits them. This is a mechanical async
propagation across a known, small set of call sites, all covered by tests.

**D5 — Test-send verifies without trusting persisted state.** `POST /settings/smtp/test` sends a
real email through the SUBMITTED config (or the saved one) to the requesting admin's own email,
mirroring the Codex "discover models" probe — proving connectivity before/independent of saving.

**D6 — Admin double-gate + masked read.** Server: a `requireAdmin` check (role===admin & allowed,
re-read live) on every SMTP route, reusing the accounts pattern. Client: the section renders/acts
only for `isAdminSession`. The read projection returns `host`/`port`/`user`/`from` + `passLast4` +
a `hasPassword` flag — NEVER the plaintext password.

**D7 — Capability = either source.** OTP is advertised available when the DB config OR the env is
configured, so enabling SMTP via the UI flips `otpAuthEnabled` true (after the session re-resolves)
without an env change.

**D8 — UI follows an OpenDesign source of truth (design-first).** The Settings 邮件/SMTP section +
config dialog are designed FIRST in OpenDesign (project `680d21c4`, `screens/settings.html`: the
`#smtp` panel + the `#smtp-dialog`), reusing the existing Codex/forge credential pattern (panel +
masked status + a config dialog with a 发送测试 conn-test row, Vercel-achromatic). The frontend
implements that design pixel-faithfully and updates the settings pixel baseline. The sender-address
field carries a hint that the domain must be verified at the provider (e.g. Resend) while the local
part is free (no real mailbox needed) — so an operator doesn't put an unverified domain there. The
dialog is **Resend-shaped**: it collects only the API Key (= SMTP password) + sender; the fixed
`smtp.resend.com`/`465`/`resend` are shown as copy, not inputs (the backend still stores the full
tuple). The step-by-step setup lives in a Resend **help page** reusing the `forge-token-help`
pattern verbatim — `apps/web/src/content/resend-smtp.md` (`?raw` import) rendered by the shared
`Markdown` component at a `/help/resend-smtp` route behind the auth gate, linked from the section
and dialog (content drafted in this change's `resend-smtp-help.md`).

**D9 — One-time env→DB migration on boot.** A deployment already running with env `SMTP_*` should
see that config surface in the UI without a manual re-entry. On boot, when NO DB SMTP config exists,
the `SMTP_*` env is fully configured, the marker `SystemSettings.smtpEnvMigratedAt` is null, AND the
encryption key is available, a self-contained boot seed copies the env values into the DB config
(encrypting the password) and stamps the marker. Idempotent + fail-closed: no key ⇒ skip (env
fallback continues); marker already set ⇒ NEVER re-seed, so an admin who later edits or deletes the
DB config is not overwritten on a subsequent boot. This mirrors the admin-seed's order-independent
single-boot-hook discipline (no cross-provider boot ordering — a prior outage's lesson). Because the
resolution is already DB-first/env-fallback (D3), the deployment never breaks regardless of whether
the migration runs; the migration only makes the env config visible/editable in the console.

## Risks / Trade-offs

- **Async propagation touches several files (mail, oauth-config, session controller).** → It is a
  bounded set; unit tests (mail resolution, capability gating, session capabilities) pin each, and
  the existing golden/capability tests stay green.
- **No encryption key configured.** → Save fails fail-closed with a clear message; env-only
  deployments are unaffected (they never hit the DB save path). Documented in the section copy.
- **Both DB and env present.** → DB wins (D3); `source` makes the active one observable.
- **Test-send recipient.** → The requesting admin's own session email, so a misconfig can't be used
  to mail arbitrary addresses.

## Migration Plan

- Additive Prisma migration (new `smtp_config` table); no data migration. The `SMTP_*` env stays as
  the fallback, so existing deployments behave identically until an admin saves a DB config.
- Rollback: revert the code + drop the table; mail falls back to env (current behavior).

## Open Questions

- None blocking. A future per-channel (China) DB config can extend the same table with a channel
  discriminator; out of scope here.
