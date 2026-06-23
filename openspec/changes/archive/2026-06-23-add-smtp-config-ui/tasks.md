<!-- Track-annotated tasks. Corrected partition after a codebase file-touch scan.
     contracts feeds backend + frontend; backend-storage feeds mail-capability + api.
     Independent tracks run in parallel at apply time; the integration track runs
     serially LAST and is the single writer of the shared module-wiring file
     (`apps/api/src/mail/mail.module.ts`, edited by both backend-storage and backend-api).
     `apps/api/src/app.module.ts` is touched only by backend-storage (2.3 registers the
     boot-seed module, mirroring AdminSeedModule), so it stays inside that track. The
     new SMTP service/boot-seed/controller FILES themselves are disjoint and stay in
     their parallel tracks; only the mail.module.ts provider/controller wiring is pulled
     out. PrismaModule is @Global(), so injecting PrismaService into MailService (3.1)
     needs NO mail.module.ts edit. -->

## 1. Track: contracts (depends: none)

- [x] 1.1 `@cap/contracts` — add SMTP config schemas: `SaveSmtpConfigRequest` (host/port/user/pass/from; `pass` present only on save), `SmtpConfigRead` (host/port/user/from + `passLast4` + `hasPassword`; NEVER the plaintext pass), and a test-send request/response (`{ ok, message }`). Export from the package index.

## 2. Track: backend-storage (depends: contracts)

- [x] 2.1 `apps/api/prisma/schema.prisma` — add a singleton `SmtpConfig` model (fixed-id, upserted on a constant like `SystemSettings`): `host`/`port Int`/`user`/`from` (non-secret) + `passCiphertext String?` + `passLast4 String?` + timestamps, `@@map("smtp_config")`. Also add `smtpEnvMigratedAt DateTime?` to the existing `SystemSettings` model (the one-time env→DB migration marker, mirroring `adminRevealConsumedAt`). Generate the migration.
- [x] 2.2 New SMTP config service FILE (`apps/api/src/mail/smtp-config.service.ts` + spec) — `readConfig()` (masked projection, no plaintext), `saveConfig(body)` (encrypt the password via `secret-storage.encryptToStored`, store `passCiphertext` + `passLast4`; fail-closed when no `CODEX_CRED_ENC_KEY`), and `resolveDbSmtpConfig()` returning a decrypted `ResolvedSmtpConfig | null` for the mail path. Do NOT edit `mail.module.ts` here (its provider wiring is the integration track's, task 6.1).
- [x] 2.3 One-time env→DB migration — a SELF-CONTAINED boot seed in its OWN module (new `apps/api/src/mail/smtp-env-migration.service.ts` + spec, plus its own `*.module.ts`), registered in `apps/api/src/app.module.ts` exactly mirroring `AdminSeedModule` (one order-independent `onApplicationBootstrap` hook; never throws into boot). On boot, when `resolveDbSmtpConfig()` is null AND the `SMTP_*` env is fully configured AND `SystemSettings.smtpEnvMigratedAt` is null AND the encryption key is available, save the env values into the DB config (encrypting the password) and stamp `smtpEnvMigratedAt`. Idempotent + fail-closed: no key → skip (env fallback continues); marker set → never re-seed. Unit-test: migrates on first boot; no re-seed once the marker is set (even if the DB config was deleted); skips without a key. (`app.module.ts` is touched ONLY by this track — no cross-track collision.)

## 3. Track: backend-mail-capability (depends: backend-storage)

- [x] 3.1 `apps/api/src/mail/mail.service.ts` — inject `PrismaService` (PrismaModule is @Global, so NO mail.module.ts edit needed); make the default transport DB-first/env-fallback: `resolveTransportFor` (and `isSmtpConfigured`) become async, resolving `resolveDbSmtpConfig()` first then `resolveSmtpConfig(env)`. Add `source: 'db' | 'env'` to `ResolvedSmtpConfig`. Keep fail-closed throw + log-and-rethrow. Update `mail.service.spec.ts` for the async + DB-first/env-fallback behavior.
- [x] 3.2 `apps/api/src/auth/oauth-config.ts` (`isOtpAuthEnabled`) + the `GET /auth/session` capabilities computation (`apps/api/src/auth/github-oauth.controller.ts`) — make them async and report OTP available when EITHER the DB config OR the env is configured. Update affected specs/tests (`apps/api/src/auth/smtp-capability-gating.spec.ts`) to the async, either-source shape.

## 4. Track: backend-api (depends: backend-storage, contracts)

- [x] 4.1 New admin SMTP controller FILE (`apps/api/src/mail/smtp.controller.ts`) — `GET` (masked read), `PUT` (save via the service), `POST .../test` (send a test email to the requesting admin's own session email using the submitted/saved config, no persist on failure, never return the password). Each route enforces `requireAdmin` (live role===admin & allowed, fail-closed) reusing the accounts pattern. Do NOT edit `mail.module.ts` here — registering this controller is the integration track's job (task 6.1).
- [x] 4.2 Tests (`apps/api/src/mail/smtp.controller.spec.ts`) — admin-gate denies non-admin on read/save/test; masked read never includes the plaintext; save encrypts (ciphertext only); test-send targets the admin's own email.

## 5. Track: frontend (depends: contracts)

- [x] 5.1 `apps/web/src/lib/api/queries.ts` + `mutations.ts` (+ `real.ts` + `mock.ts`) — `smtpConfigQuery` (masked read), `saveSmtpConfigMutation`, `testSmtpConfigMutation`, with `real.ts` calls behind the `settings` capability and `mock.ts` fallbacks; invalidate the config + auth-session/capabilities queries on save.
- [x] 5.2 `apps/web/src/components/settings/smtp-config-card.tsx` + `smtp-config-dialog.tsx` — admin-only card (masked status: 发件人 + API Key 后缀; 配置 button gated on `isAdminSession`) and a **Resend-shaped** dialog: ONLY an API Key field (the SMTP password; never pre-filled, 留空沿用) + a sender-address field (with the "@ 后域名需 Resend 验证、@ 前可自定" hint); the host/port/username are shown as FIXED Resend copy (`smtp.resend.com`/`465`/`resend`), not inputs; a 发送测试 → test mutation row; and a 「如何配置 Resend」 help link. **Pixel-faithful to the OpenDesign source** `screens/settings.html` (`#smtp` panel + `#smtp-dialog`, project 680d21c4).
- [x] 5.3 Resend SMTP help page — create `apps/web/src/content/resend-smtp.md` (content per this change's `resend-smtp-help.md` draft) + `apps/web/src/routes/_app/help/resend-smtp.tsx` that renders it via the shared `Markdown` component (mirror `forge-tokens.tsx` + `?raw` import), reachable from the SMTP card/dialog help links (`<Link to="/help/resend-smtp">`).
- [x] 5.4 `apps/web/src/routes/_app/settings.tsx` — mount the SMTP section (admin-only); refresh the settings pixel baseline to include the new section; add a frontend test for the data seam (mock save/test round-trip + masked read shape).

## 6. Track: integration (depends: backend-storage, backend-mail-capability, backend-api, frontend) — runs serially LAST

- [x] 6.1 `apps/api/src/mail/mail.module.ts` — SINGLE writer of the shared module wiring: add the new SMTP config service (2.2) + the SMTP admin controller (4.1) to the module's `providers`/`controllers`, export the config service if the boot-seed/test paths need it, and confirm `MailService`'s new `PrismaService` dependency resolves (PrismaModule is global). This is the only file edited by more than one draft track, so it is isolated here and run after all parallel tracks land. Build + the API test suite (mail resolution, capability gating, SMTP controller admin-gate, env→DB migration) must be green; the existing golden/capability tests stay green.

## Track: verify-reopened (depends: none)

- [x] V.1 Fix the missing `await` on the now-async `MailService.isConfigured()` (declared `async … Promise<boolean>`, `mail.service.ts:226`) at all three OTP fail-closed call sites — `apps/api/src/auth-otp/otp.controller.ts:69` (`POST /auth/otp/request`), `apps/api/src/auth-otp/otp.controller.ts:93` (`POST /auth/otp/verify`), and `apps/api/src/auth-otp/email-otp.service.ts:85` (`requestCode`). Today `!this.mail.isConfigured()` negates a Promise (always truthy → always `false`), so the fail-closed guard never fires: with neither DB nor env SMTP configured the request endpoint returns 202 instead of 404 and `requestCode` falls through to `sendMail()` (which throws, is caught and logged) — a silent no-op rather than fail-closed. This violates the email-otp-login spec scenario "OTP is unavailable when neither DB nor env SMTP is configured → … the OTP request endpoint fails closed". Add `await` (and make `requestCode`'s guard await its async result). Add regression coverage that exercises the REAL async `isConfigured()` (the existing fakes are synchronous `() => configured`, which is why they pass while the real path is broken) — e.g. an async fake returning `Promise<boolean>` asserting the request endpoint returns 404 and `requestCode` never reaches `sendMail` when unconfigured.
