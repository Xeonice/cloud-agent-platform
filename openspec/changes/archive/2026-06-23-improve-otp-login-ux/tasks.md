# Tasks

## 1. Track: frontend (depends: none)

- [x] 1.1 `apps/web/src/routes/login.tsx` `OtpPanel` — on a SUCCESSFUL send: (a) show a non-disclosing notice block (已发送（若已开通）/ 检查收件箱与垃圾箱 / 未收到联系管理员); (b) start a 60s countdown — the send button is disabled and labelled 「X 秒后可重发」, restoring to 重新发送 at zero. A FAILED send shows the existing error, starts no countdown, shows no notice (immediate retry). Mirror the backend `OTP_RESEND_COOLDOWN_MS` (60s) as a documented frontend constant. Pixel-faithful to OD `login.html` `#login-otp` (countdown button + `.otp-sent-note`).
- [x] 1.2 Countdown uses a remaining-seconds state + a 1s tick; clear the interval on unmount and before starting a new one (no leak, no double-tick).
- [x] 1.3 Frontend tests: successful send → notice shown + button disabled showing remaining seconds; countdown reaching zero → re-enabled; failed send → no countdown, no notice, immediate retry possible; notice copy is non-disclosing.
- [x] 1.4 Refresh the login-screen pixel baseline to include the countdown button + notice block.

## 2. Track: verify-build (depends: frontend) — runs serially LAST

- [x] 2.1 `apps/web` typecheck + frontend tests all green + the login pixel baseline passes.
