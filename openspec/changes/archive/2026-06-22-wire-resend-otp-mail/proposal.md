## Why

The email-OTP login method (`email-otp-login`) is implemented but has never been configured in
production, so OTP is effectively off there: with `SMTP_*` unset the capability reports
unavailable and the login modal hides the method. We want OTP usable in production via a chosen
provider. A selection study picked **Resend** (passes the hard constraint of standard SMTP
credentials, zero approval/real-name/ICP friction, Cloudflare one-click DNS, strong Gmail
deliverability, generous free tier). Because operators may include China-mainland mailboxes —
where all international senders deliver poorly — the mail module also needs a recipient-routing
seam so a China-only channel (Aliyun DirectMail) can be added LATER without a rewrite. Per the
chosen incremental path, this change ships the Resend single channel now and only PREPARES the
seam; it does NOT wire a second channel.

## What Changes

- **Mail transport seam (code):** the mail module selects a transport per recipient address via a
  `resolveTransportFor(recipient)` seam instead of a single hard-bound transport. Today exactly
  ONE default channel is registered, so behavior is equivalent to the current single transport;
  the seam exists so a future China channel can be added by registering another named transport
  and a suffix rule — without touching the OTP send path.
- **Capability gating stays honest:** OTP is advertised available when the default transport is
  configured (unchanged today); the gating reasons about "a usable transport exists" rather than a
  fixed env tuple, so it remains correct when more channels are added.
- **Landing docs (docs/ops):** `docs/self-hosting.md` gains an email-OTP (SMTP) section with the
  end-to-end Resend setup — the `SMTP_*` values, the Cloudflare DNS records (MX/SPF/DKIM/DMARC),
  the **DKIM-must-be-DNS-Only (grey cloud)** gotcha, the recommended `auth.` subdomain, and the
  no-approval note; `apps/api/.env.example` gains a Resend example annotation.
- **Out of scope:** no Aliyun/China channel is implemented; OTP request/verify/throttle logic is
  unchanged; no new env tuple is introduced (the default channel still reads `SMTP_*`).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `email-otp-login`: verification-code mail is delivered through a per-recipient transport
  selection seam (a single default channel today, multi-channel-ready), and capability gating
  reasons about an available transport rather than a fixed env tuple.

## Impact

- **Backend:** `apps/api/src/mail/mail.service.ts` (introduce `resolveTransportFor` and a
  named-transport registry while keeping the existing fail-closed/visible-error discipline);
  `apps/api/src/auth/oauth-config.ts` (`isOtpAuthEnabled`) and `mail.service.ts`
  (`isSmtpConfigured`) reason over "a usable transport exists".
- **Docs:** `docs/self-hosting.md` (new email-OTP/SMTP section), `apps/api/.env.example`
  (Resend annotation).
- **Ops (operator action, not code):** set Resend `SMTP_*` in the production `files/api.env`;
  add the Resend DNS records in Cloudflare (DKIM as DNS-Only).
- **No database schema change**; OTP request/verify/throttle behavior is unchanged.
