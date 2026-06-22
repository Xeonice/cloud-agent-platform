# Verification Report — add-otp-email-template

## Adjudication summary

- Raw-unmet from skeptic: 0 (empty list).
- Re-traced requirements: 1.
- Reopened code tasks: 0.
- Spec-defects routed to design.md Open Questions: 0.
- Reclassified / confirmed MET: 1.

Final tally: **PASS** — every spec requirement re-traces end-to-end as satisfied.

## Requirements verified MET

### Requirement: Verification-code email is a branded HTML template

Status: **MET** (all three scenarios trace end-to-end).

Evidence:

- **Scenario "The OTP email carries both an HTML part and a plaintext fallback."**
  - `apps/api/src/auth-otp/otp-email-template.ts` `renderOtpEmail({ code, ttlMinutes })`
    returns `{ subject, html, text }`; both `html` (line 89, code span) and `text`
    (lines 33-37) carry the code and the `${ttlMinutes} 分钟` validity window.
  - `apps/api/src/auth-otp/email-otp.service.ts:117-121` builds the email via
    `renderOtpEmail(...)` and forwards `{ to, subject, html, text }` to `mail.sendMail`.
  - `apps/api/src/mail/mail.service.ts:183-190` passes both `text` and `html` to
    `nodemailer.sendMail`, so the message ships as `multipart/alternative`
    (`...(message.html ? { html: message.html } : {})`).
  - Unit test `otp-email-template.spec.ts` asserts both parts carry the code + validity.
    7/7 specs green (3 template + 4 smtp-capability-gating, built dist).

- **Scenario "The plaintext fallback keeps the code readable without HTML."**
  - The `text` field is the human-readable plaintext body (code on its own line,
    explicit "X 分钟内有效，仅可使用一次"). `smtp-capability-gating.spec.ts` S2
    asserts `sent[0].text.match(/\b(\d{6})\b/)` — the plaintext still contains the
    6-digit code (test passes), so older clients that strip HTML still see it.

- **Scenario "Presentation change does not alter OTP security behavior."**
  - OTP generation (`generateNumericCode`, CSPRNG `randomInt`), TTL (`OTP_TTL_MS`),
    attempt cap (`OTP_MAX_ATTEMPTS`), resend cooldown (`OTP_RESEND_COOLDOWN_MS`),
    hash-at-rest (`hashOtpCode` SHA-256, only the hash persisted), and the uniform
    non-disclosing `requestCode` early-returns are all intact and untouched in
    `email-otp.service.ts`. `renderOtpEmail` is a pure function that only shapes the
    email output — it cannot affect security state.

Sub-claims of the requirement, each confirmed:
- multipart/alternative HTML + retained plaintext — confirmed.
- email-safe (table layout + inline CSS) — confirmed (`<table role="presentation">` +
  inline `style=` on every element, incl. the code span at line 89; the spec-required
  inline styling of the code is asserted by the template spec).
- achromatic palette / AC brand mark / monospace code — confirmed (neutral
  `#fafafa` code box, `#ebebeb` border, `#171717` Geist Mono digits, `AC` mark).
- code + validity in both parts — confirmed and tested.
- localized subject — confirmed (`你的 Agent 控制台登录验证码`).
- only the typed code interpolated, no free text — confirmed (`OtpEmailInput` accepts
  only `code: string` + `ttlMinutes: number`; the code is a CSPRNG numeric string, so
  there is no HTML-injection surface — matches design D5).

Skeptic refutation considered and rejected: the raw-unmet list was empty; no scenario
fails to trace. No code task or spec-defect is warranted.

## Gap notes (non-blocking)

A skeptical cross-check of every spec clause against the implementation found no gap that
blocks the primary scenario. All three scenarios have traceable implementations and passing
tests. No minor gap recorded.

## Scope notes — implemented behaviors with no direct spec requirement (all benign)

These are additive, standard email-client progressive enhancements. None violate a
requirement; the spec's design (D2 "Geist is a progressive enhancement via a `<style>`
`@import`", D3 "Dark mode … stays grayscale") explicitly anticipates them. Recorded here
for traceability, not routed to a code task or a spec-defect.

1. Dark-mode `@media (prefers-color-scheme: dark)` block (9 grayscale CSS overrides) —
   `apps/api/src/auth-otp/otp-email-template.ts:53`. Stays achromatic per D3; not a
   requirement but consistent with it.
2. Email preheader hidden div (`display:none; mso-hide:all`) for inbox preview text —
   `apps/api/src/auth-otp/otp-email-template.ts:67`. Standard email technique; benign.
3. `<meta name="color-scheme">` + `<meta name="supported-color-schemes">` light/dark
   declaration — `apps/api/src/auth-otp/otp-email-template.ts:44`. Progressive
   enhancement paired with the dark-mode block.
4. Google Fonts `@import` in `<style>` for Geist / Geist Mono (a remote network
   dependency) — `apps/api/src/auth-otp/otp-email-template.ts:50`. Matches design D2
   (Geist as progressive enhancement); every element also declares an inline system
   fallback stack, so rendering does not depend on the remote font and clients that strip
   `<style>` are unaffected. No spec breach.
