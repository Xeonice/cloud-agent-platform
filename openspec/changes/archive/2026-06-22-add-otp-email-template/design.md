## Context

`email-otp.service.requestCode` sends a bare plaintext line via `MailService.sendMail`, whose
`MailMessage` only carries `{ to, subject, text }`. The finalized design lives in OpenDesign
(`680d21c4` → `emails/otp.html`) and follows the Vercel/Geist system per
`od://design-systems/vercel/DESIGN.md`: achromatic (no decorative color), `#171717` text,
Gray 600 `#4d4d4d` body, AC brand mark, Geist + Geist Mono, shadow-style `#ebebeb` border, a
neutral `#fafafa` code box with black Geist Mono digits. The design was rendered as
email-safe HTML (table layout + inline CSS) so it previews exactly as it will send.

## Goals / Non-Goals

**Goals:**
- Send the OTP email as a branded HTML template matching the finalized design, with a plaintext
  fallback retained.
- Keep the template a single source rendered from the code + validity, so the same markup the
  design preview shows is what ships.

**Non-Goals:**
- No change to OTP generation, TTL, attempt cap, resend cooldown, hash-at-rest, or the uniform
  non-disclosing response.
- No HTML email framework (react-email/MJML) — the design is already email-safe hand-authored
  HTML; a template-string renderer is enough for one email.
- No second email type this change (the layout can be factored out later if more are added).

## Decisions

**D1 — multipart/alternative (HTML + retained plaintext).** `MailMessage` gains optional `html`;
`sendMail` passes both `text` and `html` to nodemailer, which emits `multipart/alternative`.
Clients that can't render HTML (or strip it) fall back to the plaintext part — accessibility and
old-client safety. The plaintext is not dropped, only supplemented.

**D2 — Email-safe HTML, not web HTML.** The template is table layout + fully inline CSS (Gmail /
Outlook / QQ-mail strip `<style>` and don't support flex/grid/external CSS). This mirrors the OD
design file verbatim, so the preview is faithful. Geist is a progressive enhancement via a
`<style>` `@import`; every element also declares a system fallback stack inline.

**D3 — Achromatic per the Vercel spec.** The DESIGN.md is explicit ("keep the palette achromatic",
"color is functional, never decorative", "don't apply Develop Blue #0a72ef decoratively"). So the
code box is neutral `#fafafa` + `#ebebeb` border with black `#171717` Geist Mono digits — emphasis
comes from size/mono/whitespace, not color. Dark mode (`prefers-color-scheme`) stays grayscale.

**D4 — Template module owns subject + html + text.** A new `otp-email-template.ts` exports a pure
`renderOtpEmail({ code, ttlMinutes })` → `{ subject, html, text }`. `email-otp.service` calls it
and forwards to `sendMail`. Keeping subject/html/text together in one pure function makes it unit-
testable and keeps the service thin. Subject is localized to Chinese.

**D5 — Injection-safe by construction.** The interpolated `code` is a CSPRNG 6-digit numeric
string (`generateNumericCode`); `ttlMinutes` is a number. No user-controlled text enters the
template, so there is no HTML-injection surface — but the renderer still only accepts those typed
inputs, never free text.

## Risks / Trade-offs

- **Client rendering variance.** → table + inline CSS is the most compatible baseline; the
  plaintext fallback guarantees the code is always readable even if HTML is stripped.
- **Web font not loaded in a client.** → inline system fallback stack on every element; the layout
  does not depend on Geist being present.
- **Design drift between OD file and shipped template.** → the shipped HTML is copied from the OD
  design file (same email-safe markup); the OD file remains the documented source of truth.

## Migration Plan

- Pure code change, no DB/schema/contract change. Deploy with the api image; verify by sending a
  real OTP through Resend to the admin Gmail and eyeballing the rendered email.
- Rollback: revert the three files; OTP falls back to the prior plaintext line.

## Open Questions

- None. A future "open the console" button or multi-email shared layout is out of scope.
