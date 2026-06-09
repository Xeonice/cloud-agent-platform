/**
 * Open-redirect guard test (auth-redirects-and-landing, task 1.5). Drives the REAL
 * compiled `safeRedirectPath` from dist/ — this is a security control (login ==
 * host-root, so a reflected redirect is a phishing vector), so the test pins the
 * actual function, not an inline mirror.
 *
 * Requires `pnpm --filter @cap/api build` first. Run: `node redirect-target.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { safeRedirectPath } = require(
  path.resolve(here, '../../dist/auth/redirect-target.js'),
);

test('accepts same-origin relative app paths', () => {
  assert.equal(safeRedirectPath('/dashboard'), '/dashboard');
  assert.equal(safeRedirectPath('/tasks/abc'), '/tasks/abc');
  assert.equal(safeRedirectPath('/tasks/abc?tab=logs'), '/tasks/abc?tab=logs');
  assert.equal(safeRedirectPath('/repositories'), '/repositories');
  assert.equal(safeRedirectPath('  /settings  '), '/settings', 'trims surrounding whitespace');
});

test('rejects protocol-relative and absolute URLs (off-origin)', () => {
  for (const bad of ['//evil.example', '//evil.example/x', 'https://evil.example', 'http://x', 'javascript:alert(1)', 'data:text/html,x']) {
    assert.equal(safeRedirectPath(bad), null, `rejects ${bad}`);
  }
});

test('rejects backslash tricks (browsers may treat \\\\ as /)', () => {
  for (const bad of ['/\\evil.example', '\\\\evil.example', '/a\\b', '/\\/evil']) {
    assert.equal(safeRedirectPath(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('rejects non-paths, empty, whitespace, control chars, and over-length', () => {
  assert.equal(safeRedirectPath('dashboard'), null, 'no leading slash');
  assert.equal(safeRedirectPath(''), null);
  assert.equal(safeRedirectPath('   '), null);
  assert.equal(safeRedirectPath(undefined), null);
  assert.equal(safeRedirectPath(null), null);
  assert.equal(safeRedirectPath('/a b'), null, 'embedded space');
  assert.equal(safeRedirectPath('/a\nb'), null, 'embedded newline');
  assert.equal(safeRedirectPath('/x'.padEnd(600, 'y')), null, 'over the length bound');
});

test('rejects a scheme/authority embedded later in the value', () => {
  assert.equal(safeRedirectPath('/redirect?next=http://evil'), null, 'contains ://');
});
