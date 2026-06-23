# Verification Report — improve-otp-login-ux

## Adjudication summary (three-way routing)

The raw skeptic pass surfaced no requirements as unmet (`[]`). I re-traced the
single spec requirement and all three of its scenarios against the actual code
(`apps/web/src/routes/login.tsx`, `apps/web/src/routes/login.otp-resend.test.tsx`,
and the mirrored backend constant in
`apps/api/src/auth-otp/email-otp.service.ts`). Every scenario re-traces
end-to-end as satisfied.

- Re-opened code tasks: 0
- Spec defects routed to design.md Open Questions: 0
- Reclassified / confirmed MET: 1 requirement (3 scenarios)

## Requirement: OTP login panel gives non-disclosing send feedback and enforces a resend countdown — MET

### Scenario: Post-send notice is non-disclosing — MET

- Copy lives in the `OTP_SENT_NOTICE` constant (`login.tsx:145-149`): hedged with
  「若该邮箱已开通」, advises checking 收件箱/垃圾箱 and contacting the admin if
  nothing arrives. It never states whether the email maps to a real account,
  preserving the backend anti-enumeration guarantee.
- It is rendered only after a successful send — the `sent ?` guard around the
  `data-otp-sent-note` paragraph (`login.tsx:537-548`).
- `login.otp-resend.test.tsx:120-146` asserts the copy contains the hedge +
  spam/admin hints AND does NOT contain enumerating phrasing
  (`该邮箱(不存在|未注册|无效|不是)`, `账号不存在|未开通该邮箱`).

### Scenario: Resend is disabled during the countdown — MET

- On a successful send `handleSend` sets `sent=true` and calls `startCountdown()`,
  which seeds `remaining = OTP_RESEND_COOLDOWN_SECONDS` (60) and runs a 1s tick
  (`login.tsx:463-475, 488-490`).
- The send button's `disabled` derives from `isOtpSendDisabled({ sending,
  remaining })` and its label from `otpSendButtonLabel(...)` — disabled and
  labelled 「X 秒后可重发」 while `remaining > 0`, restoring to 「重新发送」 at zero
  (`login.tsx:158-179, 506-531`).
- Tests cover the full state matrix and the success transition
  (`login.otp-resend.test.tsx:38-108`), including zero re-enabling the button.
- The 60s window is a documented mirror of the backend
  `OTP_RESEND_COOLDOWN_MS = 60 * 1000` (`email-otp.service.ts:20`); the mirror is
  asserted by `login.otp-resend.test.tsx:30-36`.

### Scenario: A failed send allows immediate retry — MET

- The failure branch of `handleSend` sets the error and `return`s BEFORE
  `setSent(true)` / `startCountdown()` (`login.tsx:482-486`), so no notice shows
  and no countdown runs — the button stays the enabled initial 「发送验证码」.
- `login.otp-resend.test.tsx:110-118` asserts the post-failure state
  (`sent=false, remaining=0`) leaves the button enabled and labelled
  「发送验证码」.

## Gap finding (no requirement left without an implementation)

All three scenarios in the spec have clear implementations in `login.tsx`:

1. **Post-send notice is non-disclosing** — `OTP_SENT_NOTICE` constant +
   conditional render of the `data-otp-sent-note` paragraph (lines 145-149,
   537-548).
2. **Resend is disabled during the countdown** — `isOtpSendDisabled`,
   `otpSendButtonLabel`, `startCountdown`, the `remaining` state, and the
   disabled send button (lines 136, 158-179, 463-475, 506-531).
3. **A failed send allows immediate retry** — the failure path in `handleSend`
   sets the error but does NOT call `setSent(true)` or `startCountdown()`
   (lines 482-486).

There are no requirements with no implementation at all.

## Scope finding (no behavior beyond the spec)

The spec has exactly three scenarios under one requirement (non-disclosing
notice / countdown-disabled-send / failed-send-immediate-retry). Everything in
the diff maps directly to those three. The only additional items are
engineering/testing artifacts, not user-visible scope-creep:

1. **`data-otp-sent-note` attribute** (`login.tsx:539`) — a test selector
   attribute, a testing concern rather than a user-visible behavior.
2. **Timer unmount cleanup / no-double-tick** (`login.tsx:454-475`, design.md D5)
   — implementation hygiene (tasks.md 1.2); the spec only requires the countdown
   behavior, not the cleanup. An internal quality guard.
3. **`startCountdown` clears any prior interval before starting** (the restart at
   `login.tsx:464`) — purely defensive/internal; the spec does not require
   re-send during the countdown since the button is disabled.

None of these represent visible functionality beyond the spec.
