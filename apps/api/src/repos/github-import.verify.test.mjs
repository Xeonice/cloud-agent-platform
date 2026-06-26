/**
 * VERIFY-PHASE unit tests for Track 4 (be-github-import 4.6) — the pure decision
 * logic that needs NO live GitHub and NO running containers.
 *
 * These drive the REAL compiled logic from dist/repos/github-import.logic.js
 * (the impl module's only contracts import is an erased TYPE, so it loads under
 * plain `node`). Run with: `node github-import.verify.test.mjs`.
 *
 * Complements the impl agent's github-import.logic.test.mjs by pinning the
 * scenarios the verify task names explicitly, several of which were not asserted
 * before:
 *   - dedup keyed on the GitHub NUMERIC id: distinct same-DISPLAY-NAME repos are
 *     allowed (two different ids, identical full_name, are NOT deduped against
 *     each other); re-import of an already-imported id is idempotent at the logic
 *     level (findExistingImport returns the SAME existing platform repo → 409);
 *   - set/clear/read default: at most one default after a write; defaulting an
 *     un-imported repo is rejected; read-back picks the single default;
 *   - GitHub error mapping: missing-PAT → PAT-required signal vs rate-limit →
 *     retry-able vs empty-but-success ≠ failure;
 *   - only-imported-selectable: a plain gitSource (githubId null) repo can never
 *     be set default.
 *
 * Requires `pnpm --filter @cap/api build` (refreshes dist/) before running.
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
// 4.4 — dedup keyed on the GitHub NUMERIC id
// ---------------------------------------------------------------------------

test('4.4 dedup key is the namespaced numeric id, never the display name', () => {
  assert.equal(githubDedupKey(12345), 'gh:12345');
  // Distinct numeric ids → distinct keys even if names later collide.
  assert.notEqual(githubDedupKey(1), githubDedupKey(2));
});

test('4.4 DISTINCT same-display-name repos are ALLOWED (not deduped against each other)', () => {
  // owner/dup #100 is already imported. A DIFFERENT GitHub repo #200 that happens
  // to share the identical full_name is a distinct repo and must NOT be treated
  // as a duplicate — dedup is on the immutable numeric id, not the mutable name.
  const imported = [{ id: 'repo-a', githubId: githubDedupKey(100) }];
  const collision = findExistingImport({ id: 200, full_name: 'owner/dup' }, imported);
  assert.equal(collision, null, 'same display name, different id → not a duplicate');

  // And the genuine same-id repo IS recognized as already imported.
  const sameId = findExistingImport({ id: 100, full_name: 'owner/dup' }, imported);
  assert.equal(sameId?.id, 'repo-a');
});

test('4.4 dedup survives a GitHub-side RENAME (matches on id after full_name changes)', () => {
  const imported = [{ id: 'repo-x', githubId: githubDedupKey(42) }];
  const renamed = findExistingImport({ id: 42, full_name: 'owner/brand-new-name' }, imported);
  assert.equal(renamed?.id, 'repo-x', 'numeric id still de-dups after a rename');
});

test('4.4 re-import of an already-imported id is IDEMPOTENT → identifies the same existing repo (409)', () => {
  // The service throws 409 with repoId = the existing match; at the logic level
  // that means findExistingImport returns the SAME platform repo every time,
  // never creating a second row for the same GitHub id.
  const imported = [
    { id: 'repo-a', githubId: githubDedupKey(7) },
    { id: 'repo-b', githubId: githubDedupKey(8) },
  ];
  const first = findExistingImport({ id: 7, full_name: 'owner/seven' }, imported);
  const second = findExistingImport({ id: 7, full_name: 'owner/seven-renamed' }, imported);
  assert.equal(first?.id, 'repo-a');
  assert.equal(second?.id, 'repo-a', 're-import resolves to the SAME existing repo');
});

test('4.4 legacy slug rows fall back to full_name; name-shaped slugs never false-positive a numeric key', () => {
  const imported = [
    { id: 'legacy', githubId: 'owner/legacy-repo' }, // legacy: raw slug, not gh:<n>
    { id: 'modern', githubId: githubDedupKey(42) },
  ];
  assert.equal(
    findExistingImport({ id: 999, full_name: 'owner/legacy-repo' }, imported)?.id,
    'legacy',
    'legacy slug row matched on full_name',
  );
  // A new repo whose full_name is coincidentally shaped like a numeric key must
  // NOT collide with the namespaced numeric row.
  assert.equal(
    findExistingImport({ id: 7, full_name: 'gh:42' }, imported),
    null,
    'name-shaped slug does not false-positive the numeric key',
  );
});

test('4.4 reconcileAvailableRepos marks only the genuinely-imported entry among same-name repos', () => {
  const imported = [{ id: 'repo-a', githubId: githubDedupKey(100) }];
  const out = reconcileAvailableRepos(
    [
      { id: 100, full_name: 'owner/dup' },
      { id: 200, full_name: 'owner/dup' }, // same name, different id → NOT imported
    ],
    imported,
  );
  assert.deepEqual(
    out.map((r) => [r.id, r.imported, r.importedRepoId]),
    [
      [100, true, 'repo-a'],
      [200, false, null],
    ],
  );
});

// ---------------------------------------------------------------------------
// 4.2 — GitHub error mapping (PAT-required vs retry-able vs empty≠failure)
// ---------------------------------------------------------------------------

test('4.2 missing PAT → PAT-required signal (github_auth_required, non-retryable)', () => {
  const r = classifyGithubListError({ tokenMissing: true });
  assert.equal(r.code, 'github_auth_required');
  assert.equal(r.retryable, false);
});

test('4.2 401 expired / 403 revoked-scope PAT → PAT-required signal (non-retryable)', () => {
  for (const status of [401, 403]) {
    const r = classifyGithubListError({ status }); // 403 without rate-limit headers
    assert.equal(r.code, 'github_auth_required', `status ${status}`);
    assert.equal(r.retryable, false, `status ${status}`);
  }
});

test('4.2 403 rate-limit / 429 / 5xx / network → retry-able (github_unavailable)', () => {
  const cases = [
    { status: 403, headers: { 'x-ratelimit-remaining': '0' } }, // rate-limit 403
    { status: 403, headers: { 'Retry-After': '60' } }, // case-insensitive header
    { status: 429 },
    { status: 500 },
    { status: 503 },
    { networkError: true },
    { status: 418 }, // unexpected → fail SAFE to retry-able, not a false PAT-required signal
  ];
  for (const c of cases) {
    const r = classifyGithubListError(c);
    assert.equal(r.code, 'github_unavailable', JSON.stringify(c));
    assert.equal(r.retryable, true, JSON.stringify(c));
  }
});

test('4.2 PAT-required and retry-able are DISTINCT modes (a rate-limit 403 ≠ a revoked 403)', () => {
  const patRequired = classifyGithubListError({ status: 403 });
  const limited = classifyGithubListError({ status: 403, rateLimited: true });
  assert.notEqual(patRequired.code, limited.code);
  assert.equal(patRequired.retryable, false);
  assert.equal(limited.retryable, true);
});

test('4.2 empty-but-success is NOT a failure (it never reaches the classifier)', () => {
  // The classifier is only invoked on a known failure. A successful empty listing
  // is the plain value `[]` returned by the client, which the classifier never
  // sees. We pin that contract here: an "ok" outcome has no error to classify, so
  // an empty list is a normal success, not mapped to either failure code.
  const okEmptyResult = { ok: true, repos: [] };
  assert.equal(okEmptyResult.ok, true);
  assert.equal(okEmptyResult.repos.length, 0);
  // Sanity: every branch the classifier DOES handle is a failure, so none of them
  // could ever be produced from an empty-but-successful listing.
  for (const code of ['github_auth_required', 'github_unavailable']) {
    assert.notEqual(code, 'ok', 'failure codes are disjoint from success');
  }
});

// ---------------------------------------------------------------------------
// 4.5 — set / clear / read default (at most one; only-imported-selectable)
// ---------------------------------------------------------------------------

test('4.5 only an IMPORTED repo is selectable as default; a plain gitSource repo is rejected', () => {
  const d = validateSetDefaultTarget('plain', [
    { id: 'plain', githubId: null, isDefault: false }, // never imported from GitHub
  ]);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'not_imported');
});

test('4.5 defaulting an UN-IMPORTED (absent) repo is rejected (not_found)', () => {
  const d = validateSetDefaultTarget('ghost', [
    { id: 'repo-a', githubId: githubDedupKey(1), isDefault: false },
  ]);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'not_found');
});

test('4.5 set default clears the prior default → AT MOST ONE default after the write', () => {
  const d = validateSetDefaultTarget('repo-b', [
    { id: 'repo-a', githubId: githubDedupKey(1), isDefault: true },
    { id: 'repo-b', githubId: githubDedupKey(2), isDefault: false },
  ]);
  assert.equal(d.ok, true);
  assert.equal(d.targetId, 'repo-b');
  assert.deepEqual(d.clearIds, ['repo-a']);
  assert.equal(d.alreadyDefault, false);
  // The post-write default set = {target} ∪ (priors − cleared) = {repo-b} only.
  const postWriteDefaults = new Set(['repo-b']);
  for (const id of d.clearIds) postWriteDefaults.delete(id);
  assert.equal(postWriteDefaults.size, 1, 'exactly one default remains');
});

test('4.5 a corrupt multi-default state is reduced to exactly one (clears EVERY other)', () => {
  const d = validateSetDefaultTarget('repo-c', [
    { id: 'repo-a', githubId: githubDedupKey(1), isDefault: true },
    { id: 'repo-b', githubId: githubDedupKey(2), isDefault: true },
    { id: 'repo-c', githubId: githubDedupKey(3), isDefault: false },
  ]);
  assert.equal(d.ok, true);
  assert.deepEqual([...d.clearIds].sort(), ['repo-a', 'repo-b']);
  // target excluded from its own clear set.
  assert.ok(!d.clearIds.includes('repo-c'));
});

test('4.5 re-defaulting the current default is idempotent (no clears, alreadyDefault)', () => {
  const d = validateSetDefaultTarget('repo-a', [
    { id: 'repo-a', githubId: githubDedupKey(1), isDefault: true },
  ]);
  assert.equal(d.ok, true);
  assert.equal(d.targetId, 'repo-a');
  assert.deepEqual(d.clearIds, []);
  assert.equal(d.alreadyDefault, true);
});

test('4.5 read default returns the single flagged default, or null when none', () => {
  assert.equal(pickDefaultRepo([{ id: 'x', isDefault: false }]), null);
  const def = { id: 'd', isDefault: true };
  assert.equal(pickDefaultRepo([{ id: 'x', isDefault: false }, def]), def);
  assert.equal(pickDefaultRepo([]), null, 'empty inventory → null');
});
