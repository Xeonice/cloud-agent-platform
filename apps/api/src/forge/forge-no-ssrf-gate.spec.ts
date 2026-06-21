/**
 * Requirement: "Forge HTTP calls the operator's connected forge directly and
 * is not SSRF-gated" (add-multi-forge-task-delivery).
 *
 * Verifies that forgeFetch — the single shared HTTP helper used by all three
 * forge impls — calls native fetch WITHOUT routing through assertSafeProviderUrl.
 *
 * Strategy:
 *   1. Stub globalThis.fetch to capture what URL was fetched + return a 2xx.
 *   2. Stub assertSafeProviderUrl so that IF it is called the test fails.
 *   3. Call GithubForge.openChangeRequest (representative forge HTTP call).
 *   4. Assert fetch was called with the expected forge URL.
 *   5. Assert assertSafeProviderUrl was never called.
 *
 * A private-range / localhost URL (192.168.1.1) is used as the apiBaseUrl to
 * prove the call goes through even for hosts that SSRF-gating would block.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubForge } from './github-forge';
import type { ForgeTarget } from './forge.port';

// Re-import the module under test so we can spy on assertSafeProviderUrl.
// We use a spy on the LIVE module via dynamic import + module-level flag.
// Because Node test runner doesn't provide mocking helpers, we rely on the
// simpler approach: track fetch calls and confirm assertSafeProviderUrl is
// not imported/called by checking it is not in the forge.port module at all.

test('forgeFetch reaches private-range forge URL without SSRF gate', async () => {
  // A private-range URL that assertSafeProviderUrl WOULD block.
  const PRIVATE_API_BASE = 'https://192.168.1.1/api/v3';

  const target: ForgeTarget = {
    kind: 'github',
    apiBaseUrl: PRIVATE_API_BASE,
    cloneUrl: 'https://192.168.1.1/o/r.git',
    repoId: { style: 'owner-repo', owner: 'o', repo: 'r' },
    token: 'ghp_test_token',
  };

  const fetchedUrls: string[] = [];
  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string, _init: RequestInit) => {
    fetchedUrls.push(String(url));
    return {
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          number: 42,
          html_url: `${PRIVATE_API_BASE}/pull/42`,
          state: 'open',
          merged_at: null,
          head: { ref: 'cap/task-1' },
        }),
    };
  }) as unknown as typeof fetch;

  // Track whether assertSafeProviderUrl was imported/called by the forge path.
  // We verify this structurally: forge.port.ts must NOT import assertSafeProviderUrl.
  const path = await import('node:path');
  const fs = await import('node:fs');
  // __dirname is dist/forge/ at runtime; the source lives at src/forge/.
  const srcDir = __dirname.replace(/[\\/]dist[\\/]/, '/src/');
  const forgePortSource = await fs.promises.readFile(
    path.resolve(srcDir, 'forge.port.ts'),
    'utf8',
  );
  // Check for an actual import statement (not just comment references).
  const assertSafeImportedInForgePort =
    /^import[^;]*assertSafeProviderUrl/m.test(forgePortSource);

  try {
    const ref = await new GithubForge().openChangeRequest(target, {
      headBranch: 'cap/task-1',
      baseBranch: 'main',
      title: 'Test PR',
      body: 'body',
    });

    // 1. The forge call reached the private-range URL.
    assert.ok(
      fetchedUrls.some((u) => u.startsWith(PRIVATE_API_BASE)),
      `Expected a fetch to ${PRIVATE_API_BASE} but got: ${JSON.stringify(fetchedUrls)}`,
    );

    // 2. The result is correct (forge impl works).
    assert.equal(ref.number, 42);
    assert.equal(ref.state, 'open');

    // 3. assertSafeProviderUrl must NOT be imported inside forge.port.ts.
    assert.equal(
      assertSafeImportedInForgePort,
      false,
      'forge.port.ts must not import assertSafeProviderUrl — forge calls are not SSRF-gated',
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('forgeFetch reaches a self-hosted forge on a LAN host (10.x) without SSRF gate', async () => {
  const LAN_API_BASE = 'https://10.0.0.5/api/v4';

  const target: ForgeTarget = {
    kind: 'gitlab',
    apiBaseUrl: LAN_API_BASE,
    cloneUrl: 'https://10.0.0.5/g/p.git',
    repoId: { style: 'project', idOrPath: '99' },
    token: 'glpat-lan-token',
  };

  const fetchedUrls: string[] = [];
  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string) => {
    fetchedUrls.push(String(url));
    return {
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          iid: 7,
          web_url: `${LAN_API_BASE}/-/merge_requests/7`,
          state: 'opened',
          source_branch: 'cap/task-2',
        }),
    };
  }) as unknown as typeof fetch;

  try {
    const { GitlabForge } = await import('./gitlab-forge');
    const ref = await new GitlabForge().openChangeRequest(target, {
      headBranch: 'cap/task-2',
      baseBranch: 'main',
      title: 'MR title',
      body: 'description',
    });

    // Call reached the LAN address.
    assert.ok(
      fetchedUrls.some((u) => u.startsWith(LAN_API_BASE)),
      `Expected fetch to LAN host ${LAN_API_BASE}, got: ${JSON.stringify(fetchedUrls)}`,
    );
    assert.equal(ref.number, 7);
  } finally {
    globalThis.fetch = origFetch;
  }
});
