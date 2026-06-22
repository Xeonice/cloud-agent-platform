/**
 * Test for the branded OTP email template (add-otp-email-template, email-otp-login
 * spec §"Verification-code email is a branded HTML template").
 *
 * Asserts the renderer produces both an HTML part and a plaintext fallback that each
 * carry the code + validity, a localized subject, and email-safe HTML (table + inline
 * CSS so a client that strips <style> still shows the code).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderOtpEmail } from './otp-email-template';

test('renderOtpEmail: html and text both carry the code and validity window', () => {
  const { subject, html, text } = renderOtpEmail({ code: '482913', ttlMinutes: 10 });
  assert.ok(html.includes('482913'), 'html contains the code');
  assert.ok(text.includes('482913'), 'plaintext fallback contains the code');
  assert.ok(html.includes('10 分钟'), 'html states the validity window');
  assert.ok(text.includes('10 分钟'), 'plaintext states the validity window');
  assert.equal(subject, '你的 Agent 控制台登录验证码', 'subject is localized');
});

test('renderOtpEmail: html is email-safe (table layout + the code carries an inline style)', () => {
  const { html } = renderOtpEmail({ code: '000000', ttlMinutes: 10 });
  assert.ok(html.includes('<table'), 'uses table layout');
  // The code must be styled inline, not only via a <style> rule clients may strip.
  const codeIdx = html.indexOf('000000');
  assert.ok(codeIdx !== -1, 'code is present');
  const spanStart = html.lastIndexOf('<span', codeIdx);
  assert.ok(
    spanStart !== -1 && html.slice(spanStart, codeIdx).includes('style="'),
    'the code span has inline styling',
  );
});

test('renderOtpEmail: the validity window is interpolated, not hardcoded', () => {
  const { html, text } = renderOtpEmail({ code: '111111', ttlMinutes: 5 });
  assert.ok(html.includes('5 分钟'), 'html reflects the passed ttl');
  assert.ok(text.includes('5 分钟'), 'text reflects the passed ttl');
  assert.ok(!html.includes('10 分钟'), 'no stale hardcoded 10-minute window');
});
