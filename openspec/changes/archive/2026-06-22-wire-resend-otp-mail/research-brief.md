# Research Brief — wire-resend-otp-mail

Side-car notes (not a tracked artifact). Provider selection ran as a multi-agent study (8
candidates, web-verified pricing/limits, adversarial fact-check of the make-or-break claims).

## Selection matrix (verified 2026-06)

| Provider | Free tier | Std SMTP | Setup friction | Intl deliverability | China deliverability | Fit |
|---|---|---|---|---|---|---|
| **Resend** | 3000/mo + 100/day, no card | ✅ 465/587 | low (no approval/real-name/ICP; CF one-click DNS) | strong (SES under the hood) | weak (no mainland nodes) | **8** |
| Postmark | 100/mo | ✅ 587 only | medium (manual approval) | top-tier 98%+ | weak | 7 |
| Brevo | 300/day | ✅ 465/587 | medium (risk-control suspends) | good | weak | 7 |
| Aliyun DirectMail | 2000 lifetime + 200/day | ✅ 465 only | medium-high (**real-name required** + 4-48h) | average | **strong** | 7 |
| Amazon SES | $200/6mo (new) | ✅ 587/465 | medium-high (**sandbox often rejected for new accts**) | strong | weak | 6 |
| Tencent SES | 1000 one-off | ✅ 465/587/25 | high (**new personal-acct SMTP banned**) | strong | strong → out | 5 |
| Mailgun | nominal 100/day (no-card = 5 recipients only) | ✅ | medium (card required) | **dropped to ~26%** | weak | 4 |
| SendGrid | 60-day trial only | ✅ | medium | strong | weak | 3 |

Eliminated on hard constraints: SendGrid (free tier removed 2025-05), Mailgun (free tier
effectively unusable + worst inbox rate), Tencent SES (post-2026-03-02 personal-acct SMTP ban →
needs a business license). SES half-demoted (sandbox exit has real rejection risk for brand-new
accounts).

## Decision

**Default channel = Resend.** For this project (very low volume, the operator's own account is a
Gmail address) Resend is the lowest-friction fit. The "China weak" caveat only bites if operators
use mainland mailboxes (QQ/163/126) — confirmed they may, so a China channel (Aliyun DirectMail)
is a planned follow-up (change B), prepared for by the routing seam in THIS change but not built.

## Resend landing facts (for docs task 2.1)

- `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465` (secure:true; or 587 STARTTLS), `SMTP_USER=resend`
  (literal), `SMTP_PASS=re_…` (API key), `SMTP_FROM=no-reply@auth.douglasdong.com` (subdomain to
  isolate root-domain reputation).
- Cloudflare DNS on the `auth.` subdomain: MX(`send`,10), SPF TXT(`send` → `v=spf1
  include:amazonses.com ~all`), DKIM TXT(`resend._domainkey`), optional DMARC(`_dmarc` →
  `p=none`). **DKIM TXT must be DNS-Only (grey cloud)** or verification fails.
- No sandbox/approval; domain verification up to ~72h (usually minutes). Repo's CF token/wrangler
  are read-only for DNS → write via Resend's "Sign in to Cloudflare", dashboard, or a
  `Zone:DNS:Edit` token.

## Verify-stage corrections (carried for honesty)

- Tencent SES supports 465/587/25 (not 465-only) — but is out anyway due to the personal-acct SMTP
  ban (confirmed).
- SES sandbox exit is not a simple ~24h wait; brand-new/$0/free-email accounts are often rejected.
- Aliyun DirectMail effectively requires real-name (passport/business doc) on the international
  console; one identity → one DM account.
- China deliverability "best-in-class for domestic providers" is directionally credible but lacks
  an independent third-party benchmark (uncertain, not hard-proven).
