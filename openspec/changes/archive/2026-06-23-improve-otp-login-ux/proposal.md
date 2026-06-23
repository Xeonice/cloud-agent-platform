# Improve OTP login UX: send feedback + resend countdown

## Why

On the OTP login panel, after tapping 发送验证码 the only feedback is the button changing to
重新发送 plus a static hint. There is **no explicit post-send notice**, and crucially **no
client-side resend countdown**: the button is disabled only while the request is in flight, so a
user can immediately tap 重新发送 again. The backend already enforces a 60s resend cooldown
(`OTP_RESEND_COOLDOWN_MS`, silently declining a fresh code within the window), but the frontend
doesn't reflect it — taps still fire requests and the UI misleads. And because the request is
NON-DISCLOSING (an un-provisioned email returns the same "sent" response to prevent account
enumeration), a user whose email isn't a provisioned account gets a "sent" illusion with no code and
no clue why (the real `construenct@outlook.com` case).

## What Changes

- **Post-send notice (non-disclosing).** After a successful send, the panel shows a neutral notice:
  「验证码已发送（若该邮箱已开通）。请检查收件箱与垃圾箱；未收到请联系管理员确认账号已开通。」
  — enough to hint "maybe not provisioned / check spam" WITHOUT revealing whether the email is a real
  account (preserves the backend's anti-enumeration property).
- **60s resend countdown.** After a send, the send button is disabled for 60s showing 「X 秒后可重发」,
  then restores — aligning the UI with the backend cooldown (anti-spam + clear feedback). The existing
  「60 秒内可重发一次」 hint becomes a real UI behavior.
- **Design-first (OpenDesign).** Designed first in OD `login.html` (the `#login-otp` panel — the
  countdown send button + a `.otp-sent-note` block, achromatic Vercel styling) and implemented
  pixel-faithfully. **No backend change** (the cooldown already exists).

## Impact

- Affected specs: `email-otp-login` (ADD a frontend OTP-panel UX requirement).
- Affected code: `apps/web/src/routes/login.tsx` (`OtpPanel`); OD `login.html`; login pixel baseline.
- No backend / API / DB change.
