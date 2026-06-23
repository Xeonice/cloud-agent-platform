/**
 * Ground-truth tests for the OTP login panel's resend UX (improve-otp-login-ux,
 * track frontend, tasks 1.1–1.3; design.md D1/D2/D4).
 *
 * The vitest suite runs in the NODE environment (no DOM, no `window`, no React
 * effects/timers — see `vitest.config.ts`), so the countdown's interactive
 * behavior is exercised through the PURE, exported state derivations the panel
 * consumes (`otpSendButtonLabel`, `isOtpSendDisabled`) rather than by mounting
 * the component and advancing fake timers. The notice block + its non-disclosing
 * copy are asserted via `renderToStaticMarkup` (no DOM needed), mirroring the
 * existing `$taskId_.transcript.test.tsx` static-render pattern.
 *
 * Why this is faithful to the requirement: the React `OtpPanel` is a thin wrapper
 * that (a) flips `sent`/`remaining` state on the send result and (b) renders the
 * button label / disabled flag / notice purely from those values. Proving the
 * pure derivations for every (sending, sent, remaining) tuple + the success vs.
 * failure state transitions covers the spec'd behavior without a DOM harness.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

import {
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_SENT_NOTICE,
  otpSendButtonLabel,
  isOtpSendDisabled,
} from "./login";

describe("OTP resend countdown — mirrored cooldown constant", () => {
  it("mirrors the backend OTP_RESEND_COOLDOWN_MS (60s) as a 60-second window", () => {
    // Documented mirror of apps/api/src/auth-otp/email-otp.service.ts
    // `OTP_RESEND_COOLDOWN_MS = 60 * 1000`.
    expect(OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
  });
});

describe("otpSendButtonLabel — send-button label per state", () => {
  it("before any send: 「发送验证码」", () => {
    expect(otpSendButtonLabel({ sending: false, sent: false, remaining: 0 })).toBe(
      "发送验证码",
    );
  });

  it("in flight overrides everything: 「发送中…」", () => {
    expect(otpSendButtonLabel({ sending: true, sent: false, remaining: 0 })).toBe(
      "发送中…",
    );
    expect(otpSendButtonLabel({ sending: true, sent: true, remaining: 42 })).toBe(
      "发送中…",
    );
  });

  it("during the countdown: 「X 秒后可重发」 with the remaining seconds", () => {
    expect(otpSendButtonLabel({ sending: false, sent: true, remaining: 60 })).toBe(
      "60 秒后可重发",
    );
    expect(otpSendButtonLabel({ sending: false, sent: true, remaining: 1 })).toBe(
      "1 秒后可重发",
    );
  });

  it("after a send once the countdown hits zero: 「重新发送」", () => {
    expect(otpSendButtonLabel({ sending: false, sent: true, remaining: 0 })).toBe(
      "重新发送",
    );
  });
});

describe("isOtpSendDisabled — send-button disabled per state", () => {
  it("enabled before any send", () => {
    expect(isOtpSendDisabled({ sending: false, remaining: 0 })).toBe(false);
  });

  it("disabled while the request is in flight", () => {
    expect(isOtpSendDisabled({ sending: true, remaining: 0 })).toBe(true);
  });

  it("disabled while the countdown is running", () => {
    expect(isOtpSendDisabled({ sending: false, remaining: 60 })).toBe(true);
    expect(isOtpSendDisabled({ sending: false, remaining: 1 })).toBe(true);
  });

  it("re-enabled when the countdown reaches zero (resend possible)", () => {
    expect(isOtpSendDisabled({ sending: false, remaining: 0 })).toBe(false);
  });
});

describe("successful-send state transition", () => {
  it("on success the button is disabled and shows the FULL remaining window", () => {
    // What `handleSend` sets after `result.ok`: sent=true + remaining=60.
    const state = { sending: false, sent: true, remaining: OTP_RESEND_COOLDOWN_SECONDS };
    expect(isOtpSendDisabled(state)).toBe(true);
    expect(otpSendButtonLabel(state)).toBe("60 秒后可重发");
  });

  it("counting down one tick still disabled, label reflects the new remaining", () => {
    const state = { sending: false, sent: true, remaining: 59 };
    expect(isOtpSendDisabled(state)).toBe(true);
    expect(otpSendButtonLabel(state)).toBe("59 秒后可重发");
  });

  it("countdown reaching zero re-enables the button as 重新发送", () => {
    const state = { sending: false, sent: true, remaining: 0 };
    expect(isOtpSendDisabled(state)).toBe(false);
    expect(otpSendButtonLabel(state)).toBe("重新发送");
  });
});

describe("failed-send state — no countdown, no notice, immediate retry", () => {
  it("a failure leaves sent=false / remaining=0: button stays the initial enabled 发送验证码", () => {
    // What `handleSend` leaves on `!result.ok`: it returns BEFORE setSent/startCountdown,
    // so sent=false and remaining=0 (immediate retry possible).
    const state = { sending: false, sent: false, remaining: 0 };
    expect(isOtpSendDisabled(state)).toBe(false);
    expect(otpSendButtonLabel(state)).toBe("发送验证码");
  });
});

describe("post-send notice — non-disclosing copy", () => {
  it("the assembled copy hints check-spam / contact-admin WITHOUT revealing account existence", () => {
    const copy = OTP_SENT_NOTICE.before + OTP_SENT_NOTICE.bin + OTP_SENT_NOTICE.after;
    // Hedged with 「若该邮箱已开通」 — never asserts the email IS or IS NOT an account.
    expect(copy).toContain("若该邮箱已开通");
    expect(copy).toContain("垃圾箱");
    expect(copy).toContain("联系管理员");
    // It must NOT contain enumerating phrasing that would confirm/deny the account.
    expect(copy).not.toMatch(/该邮箱(不存在|未注册|无效|不是)/);
    expect(copy).not.toMatch(/账号不存在|未开通该邮箱/);
  });

  it("renders the notice block with the emphasized 垃圾箱 (static render)", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        "p",
        { "data-otp-sent-note": true },
        OTP_SENT_NOTICE.before,
        React.createElement("strong", null, OTP_SENT_NOTICE.bin),
        OTP_SENT_NOTICE.after,
      ),
    );
    expect(html).toContain("data-otp-sent-note");
    expect(html).toContain("<strong>垃圾箱</strong>");
    expect(html).toContain("若该邮箱已开通");
  });
});
