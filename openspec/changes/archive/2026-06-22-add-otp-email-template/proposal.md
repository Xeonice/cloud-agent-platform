## Why

The email-OTP login code is delivered as a bare plaintext line
(`'Your verification code is 123456. It expires in 10 minutes.'`) with an English subject
and no branding. Now that OTP is live in production, the email should match the console's
brand. A design was finalized in OpenDesign (`680d21c4` project, `emails/otp.html`) following
the Vercel/Geist design system: achromatic black-and-white, AC brand mark, neutral code box
with black Geist Mono digits — no decorative color.

## What Changes

- **`MailService` gains an HTML path:** `MailMessage` adds an optional `html` field and `sendMail`
  passes it to nodemailer, so a message is sent as `multipart/alternative` (HTML + plaintext).
  The plaintext part is retained as the fallback for clients that can't render HTML.
- **A branded OTP email template:** a new template module renders the finalized design to an
  email-safe HTML string (table layout + inline CSS, achromatic Vercel palette, AC brand,
  Geist/Geist Mono, the code + validity interpolated) plus a matching plaintext body and a
  Chinese subject.
- **`email-otp.service` uses the template:** `requestCode` builds the email via the template
  (subject localized to Chinese) instead of the inline English string. All existing
  fail-closed / uniform-response / hash-at-rest behavior is unchanged.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `email-otp-login`: the verification-code email is delivered as a branded HTML template
  (with a plaintext fallback) instead of a bare plaintext line.

## Impact

- **Backend:** `apps/api/src/mail/mail.service.ts` (`MailMessage.html` + `sendMail` HTML part);
  a new template module (e.g. `apps/api/src/auth-otp/otp-email-template.ts`);
  `apps/api/src/auth-otp/email-otp.service.ts` (use the template, localize the subject).
- **Design source of truth:** OpenDesign `680d21c4` → `emails/otp.html` (Vercel-achromatic).
- **No contract / schema change**, no change to OTP generation, TTL, attempt cap, cooldown, or
  the uniform non-disclosing response. Plaintext fallback keeps older clients working.
