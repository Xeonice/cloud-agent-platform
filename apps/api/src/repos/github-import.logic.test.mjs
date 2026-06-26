/**
 * Verify-phase unit tests for the PURE GitHub-import decision logic
 * (be-github-import, 4.2 / 4.4 / 4.5).
 *
 * Drives the REAL compiled logic by importing dist/repos/github-import.logic.js
 * (matching the auth-session.service.test.mjs convention of running against
 * dist/ under plain `node --test` with no transpile step). The logic module has
 * no runtime dependency (its only import is an erased TYPE), so it loads
 * standalone.
 *
 * Requires `pnpm --filter @cap/api build` (refreshes dist/) before running.
 *
 * Covers:
 *   - classifyGithubListError: missing/expired(401)/revoked-scope(403)-PAT ->
 *     github_auth_required (non-retryable); 429 / 5xx / 403-rate-limit / network
 *     -> github_unavailable (retryable). Empty-but-successful is NEVER passed
 *     here (asserted at the call site by returning [], not an error).
 *   - findExistingImport / githubDedupKey: de-dup on the numeric id (namespaced),
 *     full_name fallback, and NEVER on the mutable display name.
 *   - reconcileAvailableRepos: marks already-imported entries.
 *   - validateSetDefaultTarget: not_found / not_imported rejection, single-default
 *     clearing of the prior default, idempotent already-default.
 *   - pickDefaultRepo: current default read-back.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist/repos');

const {
  classifyGithubListError,
  githubDedupKey,
  findExistingImport,
  reconcileAvailableRepos,
  validateSetDefaultTarget,
  pickDefaultRepo,
} = require(path.join(DIST, 'github-import.logic.js'));

// ---------------------------------------------------------------------------
// 4.2 — error classification (auth-required vs retry-able; empty != failure)
// ---------------------------------------------------------------------------

test('4.2 missing PAT -> github_auth_required, non-retryable', () => {
  const r = classifyGithubListError({ tokenMissing: true });
  assert.equal(r.code, 'github_auth_required');
  assert.equal(r.retryable, false);
});

test('4.2 HTTP 401 (expired/revoked PAT) -> github_auth_required, non-retryable', () => {
  const r = classifyGithubListError({ status: 401 });
  assert.equal(r.code, 'github_auth_required');
  assert.equal(r.retryable, false);
});

test('4.2 HTTP 403 without rate-limit headers (revoked scope) -> github_auth_required', () => {
  const r = classifyGithubListError({ status: 403 });
  assert.equal(r.code, 'github_auth_required');
  assert.equal(r.retryable, false);
});

test('4.2 HTTP 403 rate-limited (x-ratelimit-remaining: 0) -> github_unavailable, retryable', () => {
  const r = classifyGithubListError({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  });
  assert.equal(r.code, 'github_unavailable');
  assert.equal(r.retryable, true);
});

test('4.2 HTTP 403 with retry-after header -> github_unavailable, retryable', () => {
  const r = classifyGithubListError({
    status: 403,
    headers: { 'Retry-After': '60' }, // case-insensitive lookup
  });
  assert.equal(r.code, 'github_unavailable');
  assert.equal(r.retryable, true);
});

test('4.2 HTTP 429 -> github_unavailable, retryable', () => {
  const r = classifyGithubListError({ status: 429 });
  assert.equal(r.code, 'github_unavailable');
  assert.equal(r.retryable, true);
});

test('4.2 HTTP 500/503 outage -> github_unavailable, retryable', () => {
  for (const status of [500, 502, 503]) {
    const r = classifyGithubListError({ status });
    assert.equal(r.code, 'github_unavailable', `status ${status}`);
    assert.equal(r.retryable, true, `status ${status}`);
  }
});

test('4.2 network/transport error -> github_unavailable, retryable', () => {
  const r = classifyGithubListError({ networkError: true });
  assert.equal(r.code, 'github_unavailable');
  assert.equal(r.retryable, true);
});

test('4.2 unexpected status fails SAFE to retry-able, not a false auth signal', () => {
  const r = classifyGithubListError({ status: 418 });
  assert.equal(r.code, 'github_unavailable');
  assert.equal(r.retryable, true);
});

// ---------------------------------------------------------------------------
// 4.4 — de-duplication on the immutable numeric id (full_name fallback)
// ---------------------------------------------------------------------------

test('4.4 githubDedupKey namespaces the numeric id', () => {
  assert.equal(githubDedupKey(12345), 'gh:12345');
});

test('4.4 findExistingImport matches on namespaced numeric id', () => {
  const imported = [
    { id: 'repo-a', githubId: 'gh:111' },
    { id: 'repo-b', githubId: 'gh:222' },
  ];
  const hit = findExistingImport({ id: 222, full_name: 'owner/whatever' }, imported);
  assert.equal(hit?.id, 'repo-b');
});

test('4.4 findExistingImport falls back to full_name for legacy slug rows', () => {
  const imported = [{ id: 'legacy', githubId: 'owner/legacy-repo' }];
  const hit = findExistingImport({ id: 999, full_name: 'owner/legacy-repo' }, imported);
  assert.equal(hit?.id, 'legacy');
});

test('4.4 findExistingImport NEVER matches on the mutable display name', () => {
  // Same numeric id but the repo was RENAMED on GitHub (full_name changed).
  // Dedup must still hit on the stable numeric id, not on any name.
  const imported = [{ id: 'repo-x', githubId: 'gh:42' }];
  const renamed = findExistingImport({ id: 42, full_name: 'owner/new-name' }, imported);
  assert.equal(renamed?.id, 'repo-x', 'numeric id still de-dups after rename');

  // A different numeric id whose full_name collides with an existing display
  // name must NOT be considered a duplicate.
  const collide = findExistingImport({ id: 7, full_name: 'gh:42' }, imported);
  assert.equal(collide, null, 'no false-positive on name-shaped slug');
});

test('4.4 findExistingImport returns null when not imported', () => {
  const imported = [{ id: 'repo-a', githubId: 'gh:111' }];
  assert.equal(findExistingImport({ id: 222, full_name: 'o/r' }, imported), null);
});

test('4.4 reconcileAvailableRepos marks already-imported entries', () => {
  const available = [
    { id: 111, full_name: 'o/a' },
    { id: 222, full_name: 'o/b' },
    { id: 333, full_name: 'o/c' },
  ];
  const imported = [{ id: 'repo-b', githubId: 'gh:222' }];
  const out = reconcileAvailableRepos(available, imported);
  assert.deepEqual(
    out.map((r) => [r.id, r.imported, r.importedRepoId]),
    [
      [111, false, null],
      [222, true, 'repo-b'],
      [333, false, null],
    ],
  );
});

// ---------------------------------------------------------------------------
// 4.5 — single-default selection validation + read-back
// ---------------------------------------------------------------------------

test('4.5 validateSetDefaultTarget rejects a missing repo (not_found)', () => {
  const d = validateSetDefaultTarget('nope', [
    { id: 'repo-a', githubId: 'gh:1', isDefault: false },
  ]);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'not_found');
});

test('4.5 validateSetDefaultTarget rejects an un-imported (available-only/plain) repo', () => {
  const d = validateSetDefaultTarget('plain', [
    { id: 'plain', githubId: null, isDefault: false },
  ]);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'not_imported');
});

test('4.5 validateSetDefaultTarget designates target and clears the prior default', () => {
  const d = validateSetDefaultTarget('repo-b', [
    { id: 'repo-a', githubId: 'gh:1', isDefault: true },
    { id: 'repo-b', githubId: 'gh:2', isDefault: false },
  ]);
  assert.equal(d.ok, true);
  assert.equal(d.targetId, 'repo-b');
  assert.deepEqual(d.clearIds, ['repo-a']);
  assert.equal(d.alreadyDefault, false);
});

test('4.5 validateSetDefaultTarget clears EVERY prior default (at most one after)', () => {
  // Defensive: even a corrupt multi-default starting state is reduced to one.
  const d = validateSetDefaultTarget('repo-c', [
    { id: 'repo-a', githubId: 'gh:1', isDefault: true },
    { id: 'repo-b', githubId: 'gh:2', isDefault: true },
    { id: 'repo-c', githubId: 'gh:3', isDefault: false },
  ]);
  assert.equal(d.ok, true);
  assert.deepEqual(d.clearIds.sort(), ['repo-a', 'repo-b']);
});

test('4.5 validateSetDefaultTarget is idempotent when target is already default', () => {
  const d = validateSetDefaultTarget('repo-a', [
    { id: 'repo-a', githubId: 'gh:1', isDefault: true },
  ]);
  assert.equal(d.ok, true);
  assert.equal(d.targetId, 'repo-a');
  assert.deepEqual(d.clearIds, []); // target excluded from clear set
  assert.equal(d.alreadyDefault, true);
});

test('4.5 pickDefaultRepo returns the flagged default or null', () => {
  assert.equal(pickDefaultRepo([{ isDefault: false }]), null);
  const def = { id: 'd', isDefault: true };
  assert.equal(pickDefaultRepo([{ id: 'x', isDefault: false }, def]), def);
});
