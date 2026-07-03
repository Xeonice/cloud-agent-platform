/**
 * Forge credential apiAccess schema coverage (support-url-based-forge-import).
 *
 * Runs against dist/ after `pnpm --filter @cap/contracts build`, matching the
 * existing contracts package test convention.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  ForgeCredentialSchema,
  ForgeCredentialApiAccessSchema,
} = require(path.join(here, '..', 'dist', 'settings.js'));

test('ForgeCredential apiAccess accepts verified and unverified', () => {
  assert.equal(ForgeCredentialApiAccessSchema.parse('verified'), 'verified');
  assert.equal(ForgeCredentialApiAccessSchema.parse('unverified'), 'unverified');
});

test('ForgeCredential read shape remains backward compatible when apiAccess is absent', () => {
  const parsed = ForgeCredentialSchema.parse({
    kind: 'gitee',
    host: 'gitee.internal',
    state: 'connected',
    last4: 'abcd',
  });
  assert.equal(parsed.apiAccess, undefined);
});

test('ForgeCredential read shape carries apiAccess when present', () => {
  const parsed = ForgeCredentialSchema.parse({
    kind: 'gitee',
    host: 'gitee.internal',
    state: 'connected',
    apiAccess: 'unverified',
    last4: 'abcd',
  });
  assert.equal(parsed.apiAccess, 'unverified');
});
