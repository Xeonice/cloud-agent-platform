# Verification report — add-smtp-config-ui

Adjudication of the raw-unmet verify findings (three-way routing). Each raw-unmet
requirement was re-traced end-to-end against the actual code before routing — the
skeptic was not rubber-stamped.

## Three-way tally

- reopened code tasks: 1 (SMTP delivery and capability gating)
- spec defects routed to design.md Open Questions: 0
- reclassified MET: 1 (Settings page has an admin-only Resend SMTP section)

## MET (reclassified) — folded findings

### Settings page has an admin-only Resend SMTP section (frontend-console)

Re-traced as MET despite the raw-unmet label; the skeptic's "evidence" is a
confirmation list, not a refutation. Every spec clause is satisfied:

- Admin-only section mount: `apps/web/src/routes/_app/settings.tsx:232-236`
  renders `<section id="smtp"><SmtpConfigCard/></section>` only when
  `isAdmin = isAdminSession(session)` (settings.tsx:110-111).
- Defense-in-depth in-card admin gate: `smtp-config-card.tsx:53` (`isAdmin`),
  `:92-99` (the 配置 button is admin-only; a non-admin sees "仅管理员可配置" copy
  instead), with the 仅管理员 pill at `:71`.
- `isAdminSession` is fail-closed: `update-banner.tsx:128-140` requires
  `session.allowed`, a non-empty allowlist, and a `login` present in the
  build-time `VITE_ADMIN_LOGINS` allowlist.
- Masked read only — never plaintext: `smtp-config-card.tsx:57-58` derives
  `keyLabel = ••••<passLast4>`; the query factory `smtpConfigQuery`
  (`queries.ts:554-560`) returns the masked `SmtpConfigRead` (suffix + `hasPassword`).
- Dialog collects only API Key + sender; fixed tuple shown as copy, not inputs:
  `smtp-config-dialog.tsx:50-54` (`RESEND_SMTP_FIXED` host/port/user as copy),
  rendered in the description at :178-182 (not editable fields).
- API Key never pre-filled: `apiKey` state initialises to `""` (:105) and the
  open effect always resets it to `""` (:113-119); the input is `type="password"`
  unless toggled (:207). The sender may be pre-filled from the masked read (:117).
- Help link present in both card (:108-116) and dialog (:258-266) → `/help/resend-smtp`.

Minor non-blocking observations (do not affect the primary scenario): the dialog
adds a 显示/隐藏 reveal toggle and a `canSave` guard (sender non-empty + a new-or-stored
key). These are UX hardening beyond the spec text, not violations — see scope notes.

## Scope-creep findings (informational; not spec violations, no tasks created)

Behaviors that are implemented but map to no spec requirement in the three spec
files. Each was re-traced against the actual code (line numbers confirmed). None
block any scenario; recorded for traceability only.

- `ResolvedSmtpConfig.source: 'db' | 'env'` diagnostic discriminator on the
  internal resolution shape — tracks which config source won DB-first/env-fallback
  resolution. Design D3 mentions it; no spec scenario requires exposing it.
  `apps/api/src/mail/mail.service.ts:48`
- Transport connection-pool memoization (fingerprint-keyed) in
  `MailService.getTransporter()` — lazy memoised Transporter keyed by
  host:port:user:from; no spec requirement.
  `apps/api/src/mail/mail.service.ts:271-285`
- `protected createTransport()` extracted as a subclass-overridable seam on
  `SmtpController` for unit-test isolation — no spec scenario prescribes this
  implementation pattern. `apps/api/src/mail/smtp.controller.ts:163`
- `GET /settings/smtp` returns `EMPTY_SMTP_CONFIG_READ` (all-blank 200) when no
  row has ever been saved, instead of 404/null — no spec scenario describes the
  never-saved read shape. `apps/api/src/mail/smtp.controller.ts:73` (const at :251)
- `resolveAccountWhere` private helper duplicated verbatim from
  `accounts.controller.ts` into `smtp.controller.ts` rather than shared — the spec
  only says "re-check the live account"; it does not prescribe the implementation
  shape. `apps/api/src/mail/smtp.controller.ts:275`
- `SmtpEnvMigrationService.migrate()` exposed as a public async method — the spec
  requires only an `onApplicationBootstrap` boot hook, not a publicly-callable
  migration entry point. `apps/api/src/mail/smtp-env-migration.service.ts:84`
- `SMTP_CONFIG_ROW_ID` exported as a public constant — singleton DB row id, an
  implementation detail not required to be exported.
  `apps/api/src/mail/smtp-config.service.ts:36`
- `SYSTEM_SETTINGS_ROW_ID` re-declared and exported from the migration service —
  a duplicate singleton id constant not required by any spec.
  `apps/api/src/mail/smtp-env-migration.service.ts:45`
- `parseSmtpConfigRead` defensive struct parser in `real.ts` that coerces
  shape-drifted `GET /settings/smtp` responses into safe defaults — no spec
  scenario requires client-side defensive parsing.
  `apps/web/src/lib/api/real.ts:1232` (consumed at :1253/:1264)
- `saveSmtpConfigMutation` invalidates `queryKeys.authSession` on success so the
  login modal re-checks OTP availability — no spec scenario covers this
  cache-invalidation side effect. `apps/web/src/lib/api/mutations.ts:560`
- API Key 显示/隐藏 reveal toggle (`revealKey`) in `SmtpConfigDialog` — UX control
  beyond the spec (spec only requires the field never be pre-filled).
  `apps/web/src/components/settings/smtp-config-dialog.tsx:106` (toggle at :207-219)
- `canSave` guard disabling 保存配置 unless the sender is non-empty AND a new key is
  entered or one is already stored — UX validation, not a spec-described save-gate.
  `apps/web/src/components/settings/smtp-config-dialog.tsx:155`
- `__resetMockSmtpState()` test-only reset exported from the production mock module —
  no spec requires this export. `apps/web/src/lib/api/mock.ts:1306`
- `smtp-config-card.admin-gate.test.ts` exercises case-insensitive matching of
  `isAdminSession` — tests pre-existing behaviour of a pre-existing function the
  spec never mentions.
  `apps/web/src/components/settings/smtp-config-card.admin-gate.test.ts:72`

## Gap note (no zero-implementation requirements found)

Every requirement across the three specs (smtp-configuration: encrypted storage,
masked read, DB-first/env-fallback resolution, admin-only API with test-send,
one-time env→DB boot migration; email-otp-login: capability gating + recipient
routing; frontend-console: admin-only Resend section + help page) has traceable
code. No requirement is wholly unimplemented.

The single real defect (the missing `await` on `MailService.isConfigured()`) was
an implementation correctness bug, not a missing implementation — but it was
security-sensitive (an auth-method fail-closed gate that never fired), so it was
reopened as code task V.1 rather than folded as MET-with-minor-gap.

Re-trace on this pass confirms V.1 is now resolved: `MailService.isConfigured()`
is declared `async` (`mail.service.ts:226`) and all three OTP fail-closed call
sites now await it — `otp.controller.ts:69` (`POST /auth/otp/request`),
`otp.controller.ts:93` (`POST /auth/otp/verify`), and `email-otp.service.ts:85`
(`requestCode`). The required regression coverage exercises the REAL async path:
the fakes are now `isConfigured: async () => …` (e.g.
`email-otp-otp-auth.probe.spec.ts:126`, `email-otp.service.spec.ts:147`,
`smtp-capability-gating.spec.ts:40`), and probe scenario D asserts the SMTP-off
path stores no code and sends no email (fail closed). V.1 stays `[x]`; the raw
re-verify pass surfaced no NEW unmet requirements (no further code tasks, no spec
defects).
