# Verification Report — wire-resend-otp-mail

## Verdict

All three spec requirements (the three scenarios under the single MODIFIED requirement
"SMTP delivery and capability gating") re-trace end-to-end as **MET**. The raw-unmet list
handed to this routing pass was empty; on independent re-trace nothing was re-opened as a
code task and no requirement was routed to design.md "Open Questions" as a spec defect.

- Reopened code tasks: 0
- Spec defects (routed to Open Questions): 0
- Met (incl. minor-gap-as-written): 3

## MET requirements (re-traced end-to-end)

All three spec requirements are fully implemented:

1. **"OTP is unavailable when no transport is configured"** — `isOtpAuthEnabled` returns
   false (`apps/api/src/auth/oauth-config.ts:153-159`, delegating to `isSmtpConfigured`),
   the frontend hides the OTP method (`apps/web/src/routes/login.tsx:276` gates the panel on
   `caps.otp`), and the OTP request controller returns 404 when SMTP is unconfigured
   (`apps/api/src/auth-otp/otp.controller.ts:69-70`). Covered by tests
   `smtp-capability-gating.spec.ts` (S1) and `email-otp-otp-auth.probe.spec.ts` (D).

2. **"Configured default transport delivers the code"** — `resolveTransportFor` picks the
   default transport (`apps/api/src/mail/mail.service.ts:96-109`), `MailService.sendMail`
   delivers via it (`mail.service.ts:167-190`), and `isOtpAuthEnabled` returns true. Covered
   by `smtp-capability-gating.spec.ts` (S2) and `mail.service.spec.ts`
   ("resolveTransportFor: the configured default transport serves any recipient").

3. **"Recipient routing falls back to the default transport"** — `resolveTransportFor`
   iterates `TRANSPORT_CHANNELS`; the default channel's `matches: () => true`
   (`mail.service.ts:81-87`) always falls through for any recipient. Covered by
   `mail.service.spec.ts` ("a recipient with no specific rule falls back to the default
   transport").

The docs section ("Optional: email-OTP login (SMTP via Resend)") is in
`docs/self-hosting.md:431` (with the DKIM-must-be-DNS-Only/grey-cloud gotcha at line 476 and
the mainland-China note at line 440) and `apps/api/.env.example:65-77` carries the Resend
annotation. Send failures are logged at error level and re-thrown
(`mail.service.ts:184-188`).

Test status: all 14 assertions across `mail.service.spec.ts`,
`smtp-capability-gating.spec.ts`, and `email-otp-otp-auth.probe.spec.ts` pass.

## Scope findings (implemented behavior with NO mapped spec requirement)

These are extra behaviors present in the working tree that map to no requirement in this
change's spec. They are recorded for traceability, not flagged as gaps in this change.

1. **`password.service.ts` session rotation on `changePassword`** — the service deletes all
   pre-change sessions and mints a fresh one, returning `{ token, user }` instead of just
   `SessionUser`. No requirement in this spec mentions password session rotation.
   (`apps/api/src/auth-password/password.service.ts:160-177`)

2. **`password.controller.ts` Set-Cookie header on password change** — the controller calls
   `buildSessionCookies` and sets `Set-Cookie` after a password change. No spec requirement
   covers cookie rotation on password change.
   (`apps/api/src/auth-password/password.controller.ts:86-91`)

3. **`password.service.spec.ts` session-rotation test assertions** — new assertions for
   `sessions.length === 1`, pre-change token invalidation, and `changed.token !== login.token`.
   No spec scenario covers this. (`apps/api/src/auth-password/password.service.spec.ts:143-168`)

4. **`login.tsx` `enterConsole()` full-document-load helper** — extracted function using
   `window.location.assign` instead of TanStack `navigate`. No spec requirement covers the
   login navigation strategy. (`apps/web/src/routes/login.tsx:98-112`)

5. **`login.tsx` removal of `queryClient.invalidateQueries` in `afterForcedChange`** —
   changed from soft navigate + cache invalidation to a full document load via
   `enterConsole()`. No spec requirement covers post-change navigation or cache invalidation.
   (`apps/web/src/routes/login.tsx:204-210`)

6. **`mail.service.spec.ts` partial-config fail-closed test**
   (`isSmtpConfigured: false on a partial default config`) — tests that a missing `SMTP_PASS`
   makes `isSmtpConfigured` return false. The spec scenarios only cover "no transport
   configured" and "configured default transport" — not the partial-config sub-case. This is
   an implementation-detail test, not a spec scenario.
   (`apps/api/src/mail/mail.service.spec.ts:35-39`)

7. **`TransportChannel.name` field** — the `TransportChannel` interface declares a
   `name: string` field (set to `'default'`) that is never read or used anywhere in the
   implementation. No spec requirement mentions a named-transport identifier.
   (`apps/api/src/mail/mail.service.ts:67-71`)

## Gap notes

No implementation gaps. All three spec requirements are fully implemented; the spec's only
recorded Open Question ("None blocking") still holds, so nothing was routed there as a spec
defect.
