/**
 * Schema + version-compare validation for the update-availability contract
 * (update-availability-check, task 1.1). Drives the REAL compiled zod schemas
 * and the pure `compareVersions` / `isNewer` helpers from dist/ — the contract
 * is the single source of truth shared by api + web. Guards that:
 *   - `UpdateStatusSchema` accepts an honest "update available" + a degraded shape
 *     and rejects malformed payloads,
 *   - `compareVersions` orders versions correctly, tolerates a `v` prefix, and
 *     returns `null` for unparseable input,
 *   - `isNewer` is strict, fail-safe (unparseable / `"unknown"` → not newer), and
 *     never throws — so a garbage tag can never fabricate an update prompt.
 *
 * Requires `pnpm --filter @cap/contracts build` first. Run: `node update-status.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { UpdateStatusSchema, degradedUpdateStatus, compareVersions, isNewer } = require(
  path.join(here, '..', 'dist', 'update-status.js'),
);
const { UNKNOWN_VERSION_VALUE } = require(path.join(here, '..', 'dist', 'version.js'));

const CHECKED_AT = '2026-06-17T00:00:00.000Z';

test('UpdateStatusSchema accepts an honest "update available" payload', () => {
  const parsed = UpdateStatusSchema.parse({
    currentVersion: 'v1.2.3',
    latestVersion: 'v1.3.0',
    updateAvailable: true,
    releaseUrl: 'https://github.com/Xeonice/cloud-agent-platform/releases/tag/v1.3.0',
    releaseName: 'v1.3.0',
    checkedAt: CHECKED_AT,
  });
  assert.equal(parsed.updateAvailable, true);
  assert.equal(parsed.latestVersion, 'v1.3.0');
});

test('UpdateStatusSchema accepts a degraded payload (no latest, nulls)', () => {
  const parsed = UpdateStatusSchema.parse({
    currentVersion: UNKNOWN_VERSION_VALUE,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseName: null,
    checkedAt: CHECKED_AT,
  });
  assert.equal(parsed.updateAvailable, false);
  assert.equal(parsed.latestVersion, null);
  assert.equal(parsed.releaseUrl, null);
});

test('UpdateStatusSchema rejects malformed payloads', () => {
  const base = {
    currentVersion: 'v1.0.0',
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseName: null,
    checkedAt: CHECKED_AT,
  };
  // currentVersion must be a non-empty string (never null).
  assert.throws(() => UpdateStatusSchema.parse({ ...base, currentVersion: '' }));
  assert.throws(() => UpdateStatusSchema.parse({ ...base, currentVersion: null }));
  // updateAvailable must be a boolean.
  assert.throws(() => UpdateStatusSchema.parse({ ...base, updateAvailable: 'yes' }));
  // releaseUrl, when present, must be a URL.
  assert.throws(() => UpdateStatusSchema.parse({ ...base, releaseUrl: 'not-a-url' }));
  // checkedAt must be an ISO datetime.
  assert.throws(() => UpdateStatusSchema.parse({ ...base, checkedAt: 'last tuesday' }));
});

test('degradedUpdateStatus is honest false with null latest fields', () => {
  const status = degradedUpdateStatus('v1.0.0', CHECKED_AT);
  assert.deepEqual(status, {
    currentVersion: 'v1.0.0',
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseName: null,
    checkedAt: CHECKED_AT,
  });
  // It must satisfy the schema it claims to produce.
  assert.doesNotThrow(() => UpdateStatusSchema.parse(status));
});

test('degradedUpdateStatus falls back to the unknown sentinel for a blank current version', () => {
  const status = degradedUpdateStatus('   ', CHECKED_AT);
  assert.equal(status.currentVersion, UNKNOWN_VERSION_VALUE);
});

test('compareVersions orders the numeric core (major.minor.patch)', () => {
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
  assert.ok(compareVersions('1.3.0', '1.2.9') > 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('compareVersions tolerates a v / V prefix on either side', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', 'V1.2.3'), 0);
  assert.ok(compareVersions('v1.2.3', 'v1.2.4') < 0);
});

test('compareVersions defaults missing minor/patch to zero', () => {
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.2', '1.2.1') < 0);
});

test('compareVersions orders pre-release below the matching release (semver §11)', () => {
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha') > 0);
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0);
});

test('compareVersions returns null for unparseable input (either side)', () => {
  assert.equal(compareVersions('not-a-version', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', 'banana'), null);
  assert.equal(compareVersions('', '1.0.0'), null);
  assert.equal(compareVersions('1.2.3.4', '1.0.0'), null);
  assert.equal(compareVersions(UNKNOWN_VERSION_VALUE, '1.0.0'), null);
});

test('isNewer is strict: only a strictly greater candidate is newer', () => {
  assert.equal(isNewer('v1.3.0', 'v1.2.3'), true);
  assert.equal(isNewer('1.2.3', '1.2.3'), false);
  assert.equal(isNewer('1.2.2', '1.2.3'), false);
});

test('isNewer is fail-safe: unparseable or unknown never produces a prompt', () => {
  assert.equal(isNewer('garbage', '1.2.3'), false);
  assert.equal(isNewer('1.3.0', 'also-garbage'), false);
  assert.equal(isNewer('1.3.0', UNKNOWN_VERSION_VALUE), false);
  assert.equal(isNewer(UNKNOWN_VERSION_VALUE, '1.2.3'), false);
});

test('isNewer never throws on hostile input', () => {
  for (const [c, cur] of [
    ['', ''],
    ['  ', '1.0.0'],
    ['v', 'v'],
    ['1.0.0-', '1.0.0'],
  ]) {
    assert.doesNotThrow(() => isNewer(c, cur));
    assert.equal(typeof isNewer(c, cur), 'boolean');
  }
});
