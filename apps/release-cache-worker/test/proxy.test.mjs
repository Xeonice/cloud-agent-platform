/**
 * Unit smoke for the mirror's pure proxy logic (release-check-mirror, task 1.4).
 * Imports the COMPILED output (`dist/proxy.js`) so it runs as plain Node with no
 * TypeScript toolchain — the `pretest` hook builds it first. Proves path validation
 * (accept / fork-friendly / reject-without-fetch) and upstream URL construction
 * without touching any Cloudflare runtime global.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseReleasesPath,
  buildUpstreamUrl,
  GITHUB_API_ORIGIN,
} from '../dist/proxy.js';

test('parseReleasesPath accepts a well-formed releases/latest path', () => {
  assert.deepEqual(
    parseReleasesPath('/repos/Xeonice/cloud-agent-platform/releases/latest'),
    { owner: 'Xeonice', repo: 'cloud-agent-platform' },
  );
});

test('parseReleasesPath accepts any well-formed fork (no allowlist)', () => {
  assert.deepEqual(
    parseReleasesPath('/repos/some-fork/my.repo_v2/releases/latest'),
    { owner: 'some-fork', repo: 'my.repo_v2' },
  );
});

test('parseReleasesPath accepts a legitimate leading-dot repo (e.g. .github)', () => {
  assert.deepEqual(
    parseReleasesPath('/repos/some-org/.github/releases/latest'),
    { owner: 'some-org', repo: '.github' },
  );
});

test('parseReleasesPath rejects non-matching paths (caller makes no upstream fetch)', () => {
  for (const p of [
    '/',
    '/repos/owner/repo', // not releases/latest
    '/repos/owner/repo/releases', // the list, not latest
    '/repos/owner/repo/releases/tags/v1', // a different endpoint
    '/repos/owner/repo/releases/latest/extra', // trailing segment
    '/repos/owner/repo/releases/latest/', // trailing slash
    '/users/owner', // a different GitHub API surface
    '/repos/owner/releases/latest', // missing repo segment
    '/repos//repo/releases/latest', // empty owner
    '/repos/owner/re po/releases/latest', // space (outside the charset)
    '/repos/owner/repo/../../secrets/releases/latest', // traversal attempt
    '/repos/./repo/releases/latest', // bare-dot owner segment
    '/repos/../../releases/latest', // dot-dot segments would collapse the /repos/ prefix
    '/repos/../user/releases/latest', // traversal toward a non-repos endpoint
  ]) {
    assert.equal(parseReleasesPath(p), null, `must reject: ${JSON.stringify(p)}`);
  }
});

test('buildUpstreamUrl targets GitHub releases/latest for the ref', () => {
  assert.equal(
    buildUpstreamUrl({ owner: 'Xeonice', repo: 'cloud-agent-platform' }),
    `${GITHUB_API_ORIGIN}/repos/Xeonice/cloud-agent-platform/releases/latest`,
  );
});
