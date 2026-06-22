<!-- Track-annotated tasks. Track 2 depends on Track 1 (it calls sendMail's new html field). -->

## 1. Track: mail-html-path (depends: none)

- [x] 1.1 `apps/api/src/mail/mail.service.ts` — add an optional `html?: string` to `MailMessage` and pass it through in `sendMail` (`transporter.sendMail({ from, to, subject, text, html })` when present) so a message with both `text` and `html` is sent as `multipart/alternative`. Keep the existing fail-closed throw and log-and-rethrow behavior unchanged.

## 2. Track: otp-template (depends: mail-html-path)

- [x] 2.1 Create `apps/api/src/auth-otp/otp-email-template.ts` exporting a pure `renderOtpEmail({ code, ttlMinutes })` → `{ subject, html, text }`. The `html` is the email-safe (table + inline CSS) achromatic Vercel template copied from the OD design source (`680d21c4` `emails/otp.html`) with the code and `ttlMinutes` interpolated; the `text` is the plaintext fallback containing the code + validity; `subject` is the localized Chinese subject. Accept only the typed `code` (numeric string) and `ttlMinutes` (number) — no free text.
- [x] 2.2 `apps/api/src/auth-otp/email-otp.service.ts` — in `requestCode`, build the email via `renderOtpEmail({ code, ttlMinutes: OTP_TTL_MS / 60000 })` and pass `{ to, subject, html, text }` to `mail.sendMail`, replacing the inline English subject/text. Leave the fail-closed/uniform/hash-at-rest logic untouched.
- [x] 2.3 Add a unit test for `renderOtpEmail` asserting: both `html` and `text` contain the interpolated code and the validity window; the subject is the localized string; and (smoke) the html is table/inline-based (e.g. contains `<table` and no reliance on a `<style>`-only rule for the code). Update `smtp-capability-gating.spec.ts` if its OTP-send assertion needs the new shape (it checks `text` contains the 6-digit code — keep that passing).
