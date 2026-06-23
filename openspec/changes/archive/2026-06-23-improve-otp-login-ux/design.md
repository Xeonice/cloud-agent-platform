# Design

## Context

The OTP login panel (`OtpPanel` in `apps/web/src/routes/login.tsx`) sends a code then lets the user
enter it. The send button is disabled only while the request is in flight; there is no post-send
notice and no resend countdown, even though the backend enforces a 60s cooldown
(`OTP_RESEND_COOLDOWN_MS` in `apps/api/src/auth-otp/email-otp.service.ts`). The send is
non-disclosing, so an un-provisioned email looks identical to success.

## Goals / Non-goals

- **Goal:** clear, non-disclosing send feedback + a 60s resend countdown that mirrors the backend
  cooldown.
- **Non-goal:** no backend change (the cooldown already exists); never reveal account existence;
  don't touch the verify flow.

## Decisions

**D1 — 60s client countdown mirroring the backend.** After a successful send, start a 60s countdown:
disable the send button and label it 「X 秒后可重发」; on zero, restore to 重新发送. Implemented with
a remaining-seconds state + a 1s tick. The window mirrors `OTP_RESEND_COOLDOWN_MS` (60s) — a constant
the frontend documents it is mirroring — so a tap during the window can't even fire a (silently
declined) request.

**D2 — Non-disclosing post-send notice.** On success show a neutral notice block:
已发送（若该邮箱已开通）/ 检查收件箱与垃圾箱 / 未收到联系管理员. It NEVER states the email is or
isn't a real account (preserves the backend's anti-enumeration guarantee). Shown only AFTER a send.

**D3 — Design-first (OpenDesign).** The OtpPanel design is authored first in OD `login.html`
(`#login-otp`: the countdown send button + a `.otp-sent-note` block, achromatic Vercel styling) and
implemented pixel-faithfully (screenshot in this change's review).

**D4 — Failure path.** If the send mutation fails (network / 5xx), show the existing error, do NOT
start the countdown, and do NOT show the sent-notice — so the user can retry immediately.

**D5 — Timer hygiene.** The interval is cleared on unmount and before starting a new one (no leak,
no double-tick); switching away from the OTP tab does not strand a running timer.

## Risks / Trade-offs

- The countdown is UX-only; the backend cooldown remains the real guard (a determined client could
  still call the API directly). Acceptable — the anti-spam guarantee is server-side; this aligns the
  UI to it.
- The mirrored 60s constant could drift from the backend value; documented and low-churn.

## Migration

None (pure frontend).
