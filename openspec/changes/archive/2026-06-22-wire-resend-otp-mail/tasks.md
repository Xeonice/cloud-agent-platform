<!-- Track-annotated tasks. Two disjoint tracks (backend mail code vs docs) run in parallel;
     tasks within a track are serial. -->

## 1. Track: mail-transport-seam (depends: none)

- [x] 1.1 `apps/api/src/mail/mail.service.ts` — introduce a named-transport registry and a `resolveTransportFor(recipient)` seam: build the DEFAULT transport from the unprefixed `SMTP_*` vars (reusing `resolveSmtpConfig`), have `sendMail` obtain its transport via `resolveTransportFor(message.to)` (falling back to the default when no rule matches), and keep the existing memoised-by-fingerprint transport, fail-closed throw when no usable transport exists, and log-and-rethrow on send failure.
- [x] 1.2 `apps/api/src/mail/mail.service.ts` + `apps/api/src/auth/oauth-config.ts` — make `isSmtpConfigured`/`isOtpAuthEnabled` reason about "at least one usable transport is configured" rather than a fixed env tuple; with only the default channel registered this MUST stay equivalent to the current `SMTP_*`-configured check (no behavior change today).
- [x] 1.3 Extend backend tests (`apps/api/src/mail/mail.service.spec.ts`, `apps/api/src/auth/smtp-capability-gating.spec.ts`, `apps/api/src/auth-otp/email-otp-otp-auth.probe.spec.ts`) to cover: OTP unavailable + fail-closed when no transport is configured; the default transport delivers when `SMTP_*` is set; and a recipient with no matching rule routes to the default transport.

## 2. Track: resend-landing-docs (depends: none)

- [x] 2.1 `docs/self-hosting.md` — add an "Optional: email-OTP login (SMTP via Resend)" section: the `SMTP_*` values (`smtp.resend.com`, `465`, user `resend`, pass `re_…`, `SMTP_FROM=no-reply@auth.<domain>`), the Cloudflare DNS records to add (MX, SPF TXT, DKIM TXT, optional DMARC), the **DKIM TXT must be DNS-Only (grey cloud)** gotcha, the recommended `auth.` sending subdomain, that there is no sandbox/approval (domain verification up to ~72h, usually minutes), and a one-line note that China-mainland mailboxes (QQ/163/126) are not reliably reachable on this channel — those operators use password/GitHub login until a China channel is added.
- [x] 2.2 `apps/api/.env.example` — annotate the existing `SMTP_*` block with a concrete Resend example (host/port/user/pass/from) as commented guidance, without setting live values.
