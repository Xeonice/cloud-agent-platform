## Context

`email-otp-login` ships a working OTP flow gated on SMTP being configured (`isSmtpConfigured` →
`isOtpAuthEnabled`), but production has never set `SMTP_*`, so OTP is dark there. A provider
selection study chose Resend for the international/default channel. Operators may include
China-mainland mailboxes (QQ/163/126), where international senders deliver unreliably; the agreed
path (incremental "A") is to ship Resend now and only PREPARE a recipient-routing seam so an
Aliyun DirectMail China channel can be added later as a separate change, without reworking the OTP
send path. Current mail module is a single `nodemailer` transport keyed on the five `SMTP_*`
vars (`apps/api/src/mail/mail.service.ts`).

## Goals / Non-Goals

**Goals:**
- Make OTP usable in production via Resend (single default channel) with documented end-to-end
  setup.
- Introduce a per-recipient transport-selection seam so a future China channel is additive, not a
  rewrite.

**Non-Goals:**
- No Aliyun/China channel implementation this change.
- No new env tuple: the default channel still reads the unprefixed `SMTP_*`.
- No change to OTP request/verify/throttle logic, the fail-closed posture, or the visible-error
  discipline.

## Decisions

**D1 — Resend as the default channel now.** Standard SMTP (`smtp.resend.com`, 465/587, user
`resend`, pass = API key), zero approval/real-name/ICP, Cloudflare one-click DNS, strong Gmail
deliverability, free tier ample for low-volume OTP. This is config + docs, not new send logic.

**D2 — Prepare the routing seam, don't build the second channel.** Add
`resolveTransportFor(recipient)` plus a named-transport registry; register exactly the default
channel today so behavior is identical to the current single transport. The seam is the cheap,
non-speculative extension point for the already-decided change B (China channel).
- *Alternative considered (rejected):* build the dual-channel router + China env now. Rejected per
  path A — it front-loads Aliyun real-name onboarding and a bigger refactor for a need that may
  not yet be exercised.

**D3 — Default channel keeps the unprefixed `SMTP_*`.** Avoids breaking existing
config/examples and lets gating stay backward-compatible; future channels add their own
prefixed tuples without disturbing the default.

**D4 — Gating reasons about "a usable transport exists".** `isOtpAuthEnabled` becomes "≥1
configured transport" rather than a fixed env check. With only the default channel registered this
is exactly today's `isSmtpConfigured`, so no behavior change now; it stays correct when channels
are added.

**D5 — Code/docs here, ops by the operator.** Claude writes the seam + the self-hosting section +
the `.env.example` annotation. Registering at Resend, setting production `SMTP_*`, and adding the
Cloudflare DNS records are operator actions captured as documented steps (they need the operator's
Resend account and a `Zone:DNS:Edit` token / dashboard).

## Risks / Trade-offs

- **China-mainland OTP deliverability remains weak under Resend.** → Accepted for path A: mainland
  operators fall back to password/GitHub login; the China channel arrives in change B. Documented
  explicitly so it is not mistaken for "OTP works everywhere".
- **DKIM TXT proxied (orange cloud) fails verification.** → The self-hosting section calls out
  DKIM-must-be-DNS-Only (grey cloud) as a known gotcha.
- **Seam looks like over-engineering at one channel.** → Kept deliberately thin: single default
  registration, zero behavior change today, only the selection indirection is added.

## Migration Plan

- Pure code + docs; no DB migration. The seam is behavior-preserving, so it can ship before any
  production SMTP is set (OTP simply stays unavailable until configured, as today).
- Operator rollout (documented, not code): set Resend `SMTP_*` in `files/api.env`, add CF DNS,
  verify domain in Resend, restart api → OTP capability flips on.
- Rollback: revert `mail.service.ts` + `oauth-config.ts`; unset `SMTP_*` to turn OTP back off.

## Open Questions

- None blocking. The trigger to actually build change B is "a mainland operator relies on OTP as a
  primary login"; until then the seam stays single-channel.
