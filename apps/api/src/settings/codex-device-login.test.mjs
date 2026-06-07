/**
 * Unit test for CodexDeviceLoginService.parseDeviceCode — the device-auth output
 * parser. Logic is INLINED (mirrors codex-device-login.service.ts) so it runs
 * under plain node:test with no transpile, per the repo's `.test.mjs` convention.
 *
 * Guards the anchored parse (review finding: the code must be taken from the
 * region AFTER the verification URL, so a code-shaped decoy earlier in codex's
 * banner can never be mistaken for the one-time code).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- inlined mirror of CodexDeviceLoginService.parseDeviceCode --------------
function parseDeviceCode(log) {
  const clean = log.replace(/\x1b\[[0-9;]*m/g, '');
  const uri = clean.match(/https:\/\/auth\.openai\.com\/[A-Za-z0-9/_-]*device[A-Za-z0-9/_-]*/);
  if (!uri) return null;
  const after = clean.slice((uri.index ?? 0) + uri[0].length);
  const code = after.match(/\b([A-Z0-9]{4}(?:-[A-Z0-9]{4,6})+)\b/);
  if (!code) return null;
  return { verificationUri: uri[0], userCode: code[1] };
}

// The real codex 0.131 `codex login --device-auth` output (verified live), with
// ANSI colour codes as codex emits them.
const REAL = [
  '',
  'Welcome to Codex [v\x1b[90m0.131.0\x1b[0m]',
  "\x1b[90mOpenAI's command-line coding agent\x1b[0m",
  '',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '',
  '1. Open this link in your browser and sign in to your account',
  '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m',
  '',
  '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m',
  '   \x1b[94m9L44-TBBVF\x1b[0m',
  '',
  '\x1b[90mDevice codes are a common phishing target. Never share this code.\x1b[0m',
].join('\n');

test('parseDeviceCode: extracts URL + code from the real device-auth output', () => {
  const r = parseDeviceCode(REAL);
  assert.deepEqual(r, {
    verificationUri: 'https://auth.openai.com/codex/device',
    userCode: '9L44-TBBVF',
  });
});

test('parseDeviceCode: the version banner 0.131.0 does NOT false-match', () => {
  // 0.131.0 has dots (no \b-hyphen group) so it is never taken as the code.
  assert.equal(parseDeviceCode(REAL).userCode, '9L44-TBBVF');
});

test('parseDeviceCode: a code-shaped DECOY before the URL is ignored (anchored after URL)', () => {
  const log =
    'session ABCD-1234 started\n' +
    'Open https://auth.openai.com/codex/device\n' +
    'one-time code\n   9L44-TBBVF\n';
  assert.equal(parseDeviceCode(log).userCode, '9L44-TBBVF');
});

test('parseDeviceCode: a multi-group code is captured whole (not truncated)', () => {
  const log = 'go to https://auth.openai.com/codex/device then enter AAAA-BBBB-CCCC';
  assert.equal(parseDeviceCode(log).userCode, 'AAAA-BBBB-CCCC');
});

test('parseDeviceCode: no verification URL => null (do not surface a bare code)', () => {
  assert.equal(parseDeviceCode('some output with a code WXYZ-1234 but no url'), null);
});

test('parseDeviceCode: URL but no code yet (mid-render) => null', () => {
  assert.equal(parseDeviceCode('Open https://auth.openai.com/codex/device and wait'), null);
});

console.log('parseDeviceCode tests defined');
