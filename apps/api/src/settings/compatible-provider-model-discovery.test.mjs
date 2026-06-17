/**
 * Minimal ground-truth test for:
 *   Requirement "Compatible-provider model discovery and selection"
 *   (wire-compatible-provider-execution / account-settings spec)
 *
 * Exercises all five scenarios from the spec without a live provider or NestJS:
 *   1. Discover models for a compatible provider → returns selectable model list
 *   2. Selected default model persists with the credential → defaultModel readable
 *   3. Failed discovery does not persist a broken credential → error, no connect
 *   4. Discovery rejects unsafe (SSRF) base URLs without fetching
 *   5. Discovery is time- and size-bounded
 *
 * The pure classification functions (classifyModelDiscoveryOutcome,
 * extractModelIds, assertSafeProviderUrl, isUnsafeAddress) are re-implemented
 * inline so this file runs under plain `node:test` with no transpile step.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isIP } from 'node:net';

// ---------------------------------------------------------------------------
// Inline pure logic (mirrors model-discovery.client.ts + assert-safe-provider-url.ts)
// ---------------------------------------------------------------------------

function extractModelIds(body) {
  if (Array.isArray(body)) {
    const ids = body.filter((m) => typeof m === 'string');
    return ids.length === body.length ? ids : null;
  }
  if (body && typeof body === 'object' && 'data' in body) {
    const data = body.data;
    if (Array.isArray(data)) {
      const ids = [];
      for (const entry of data) {
        if (entry && typeof entry === 'object' && typeof entry.id === 'string') ids.push(entry.id);
        else return null;
      }
      return ids;
    }
  }
  return null;
}

function classifyModelDiscoveryOutcome(outcome) {
  if (outcome.urlBlocked) {
    return { ok: false, error: 'provider_url_blocked', message: 'SSRF guard blocked the URL before any fetch.' };
  }
  if (outcome.networkError) {
    return { ok: false, error: 'provider_unreachable', message: 'Could not reach provider.' };
  }
  const status = outcome.status ?? 0;
  if (status === 401 || status === 403) {
    return { ok: false, error: 'provider_auth_failed', message: `Provider rejected key (${status}).` };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, error: 'provider_unreachable', message: `Unexpected status ${status}.` };
  }
  const models = extractModelIds(outcome.body);
  if (models === null) {
    return { ok: false, error: 'provider_bad_response', message: 'Response did not contain a recognizable model list.' };
  }
  return { ok: true, models };
}

function isUnsafeIpv4(address) {
  const parts = address.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;           // 0.0.0.0/8 unspecified
  if (a === 10) return true;          // 10/8 private
  if (a === 127) return true;         // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  return false;
}

function isUnsafeIpv6(address) {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isUnsafeIpv4(mapped[1]);
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  return false;
}

function isUnsafeAddress(address) {
  const family = isIP(address);
  if (family === 4) return isUnsafeIpv4(address);
  if (family === 6) return isUnsafeIpv6(address);
  return true; // non-IP string treated as unsafe
}

class UnsafeProviderUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'UnsafeProviderUrlError';
  }
}

async function assertSafeProviderUrl(baseUrl, resolver) {
  let url;
  try { url = new URL(baseUrl); } catch {
    throw new UnsafeProviderUrlError('malformed_url', 'Not a valid URL.');
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new UnsafeProviderUrlError('unsupported_scheme', `Bad scheme: ${scheme}`);
  }
  const host = url.hostname;
  if (!host) throw new UnsafeProviderUrlError('missing_host', 'No host.');
  if (isIP(host) !== 0) {
    if (isUnsafeAddress(host)) throw new UnsafeProviderUrlError('unsafe_host', `Literal ${host} is unsafe.`);
    return url;
  }
  const addresses = await (resolver ?? (async () => []))(host);
  if (addresses.length === 0) throw new UnsafeProviderUrlError('unsafe_host', `${host} did not resolve.`);
  for (const a of addresses) {
    if (isUnsafeAddress(a)) throw new UnsafeProviderUrlError('unsafe_host', `${host} resolves to unsafe ${a}.`);
  }
  return url;
}

/** Mirrors ModelDiscoveryClient.discover: SSRF guard BEFORE fetch. */
async function discover(baseUrl, apiKey, deps) {
  const { fetchImpl, resolver } = deps ?? {};
  try {
    await assertSafeProviderUrl(baseUrl, resolver);
  } catch (err) {
    if (err instanceof UnsafeProviderUrlError) {
      return classifyModelDiscoveryOutcome({ urlBlocked: true });
    }
    throw err;
  }
  try {
    const response = await (fetchImpl ?? (() => { throw new Error('no fetchImpl'); }))(
      baseUrl.replace(/\/+$/, '') + '/models',
      { method: 'GET', redirect: 'manual', headers: { Authorization: `Bearer ${apiKey}` } },
    );
    // --- body size bound ---
    const declaredLen = Number(response.headers.get('content-length'));
    const MAX_BYTES = 1_048_576; // 1 MiB
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES) {
      return classifyModelDiscoveryOutcome({ status: response.status, body: undefined });
    }
    let text;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      let aborted = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > MAX_BYTES) { await reader.cancel(); aborted = true; break; }
            chunks.push(value);
          }
        }
      } finally { reader.releaseLock(); }
      if (aborted) return classifyModelDiscoveryOutcome({ status: response.status, body: undefined });
      text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    } else {
      text = await response.text();
      if (Buffer.byteLength(text) > MAX_BYTES) return classifyModelDiscoveryOutcome({ status: response.status, body: undefined });
    }
    let body;
    try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { body = undefined; }
    return classifyModelDiscoveryOutcome({ status: response.status, body });
  } catch (err) {
    return classifyModelDiscoveryOutcome({ networkError: true });
  }
}

/** Simulates what the service layer tracks after a successful discovery + save. */
function makeCredentialStore() {
  let stored = null;
  return {
    /**
     * Save a compatible credential only when the discovery result is `ok`.
     * Returns the credential that would be read back (no secret, non-secret fields only).
     */
    saveCompatible(discoveryResult, baseUrl, defaultModel) {
      if (!discoveryResult.ok) return null; // failed discovery → nothing persisted
      if (!baseUrl) return null;            // baseUrl required for compatible mode
      if (!discoveryResult.models.includes(defaultModel)) return null; // model must be in list
      stored = { mode: 'compatible', state: 'connected', baseUrl, defaultModel, hasApiKey: true };
      return stored;
    },
    read() { return stored; },
  };
}

// ============================================================================
// SCENARIO 1 — Discover models for a compatible provider
// ============================================================================

test('Scenario 1: discover returns selectable model list for a valid provider', async () => {
  const fakeResponse = {
    status: 200,
    headers: new Headers({ 'content-length': '52' }),
    body: null,
    text: async () => JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }] }),
  };
  const resolver = async () => ['93.184.216.34']; // safe public IP
  const result = await discover('https://api.example.com/v1', 'sk-test', {
    fetchImpl: async () => fakeResponse,
    resolver,
  });

  assert.equal(result.ok, true, 'discovery should succeed');
  assert.deepEqual(result.models, ['gpt-4o', 'gpt-4.1'], 'should return the provider model ids');
});

// ============================================================================
// SCENARIO 2 — Selected default model persists with the credential
// ============================================================================

test('Scenario 2: selected default model is persisted and readable after a successful save', async () => {
  const fakeResponse = {
    status: 200,
    headers: new Headers({ 'content-length': '52' }),
    body: null,
    text: async () => JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }] }),
  };
  const resolver = async () => ['93.184.216.34'];
  const discoveryResult = await discover('https://api.example.com/v1', 'sk-test', {
    fetchImpl: async () => fakeResponse,
    resolver,
  });

  const store = makeCredentialStore();
  const saved = store.saveCompatible(discoveryResult, 'https://api.example.com/v1', 'gpt-4o');

  assert.ok(saved !== null, 'save should succeed after a successful discovery');
  assert.equal(saved.state, 'connected', 'credential state should be connected');
  assert.equal(saved.defaultModel, 'gpt-4o', 'selected default model should be persisted');
  assert.equal(saved.baseUrl, 'https://api.example.com/v1', 'baseUrl should be persisted');

  // Read back
  const read = store.read();
  assert.equal(read.defaultModel, 'gpt-4o', 'defaultModel should be readable from settings read');
  assert.equal(read.state, 'connected');
});

// ============================================================================
// SCENARIO 3 — Failed discovery does not persist a broken credential
// ============================================================================

test('Scenario 3a: unreachable provider → discovery fails, credential not saved', async () => {
  const resolver = async () => ['93.184.216.34'];
  const result = await discover('https://api.example.com/v1', 'sk-bad', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    resolver,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'provider_unreachable');

  const store = makeCredentialStore();
  const saved = store.saveCompatible(result, 'https://api.example.com/v1', 'any-model');
  assert.equal(saved, null, 'failed discovery must not persist a credential');
  assert.equal(store.read(), null);
});

test('Scenario 3b: 401 (rejected key) → provider_auth_failed, credential not saved', async () => {
  const fakeResponse = {
    status: 401,
    headers: new Headers(),
    body: null,
    text: async () => JSON.stringify({ error: 'Unauthorized' }),
  };
  const resolver = async () => ['93.184.216.34'];
  const result = await discover('https://api.example.com/v1', 'sk-wrong', {
    fetchImpl: async () => fakeResponse,
    resolver,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'provider_auth_failed');

  const store = makeCredentialStore();
  const saved = store.saveCompatible(result, 'https://api.example.com/v1', 'gpt-4o');
  assert.equal(saved, null, '401 discovery must not mark credential connected');
});

// ============================================================================
// SCENARIO 4 — Discovery rejects unsafe (SSRF) base URLs without fetching
// ============================================================================

test('Scenario 4a: 169.254.169.254 (cloud metadata) → blocked, NO outbound fetch', async () => {
  let fetchCalled = false;
  const result = await discover('http://169.254.169.254/v1', 'sk-x', {
    fetchImpl: async () => { fetchCalled = true; return {}; },
    // no resolver needed: literal IP is classified without DNS
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'provider_url_blocked', 'must be blocked not just unreachable');
  assert.equal(fetchCalled, false, 'SSRF guard must not issue any fetch to unsafe host');
});

test('Scenario 4b: localhost → blocked without fetch (resolved to loopback)', async () => {
  let fetchCalled = false;
  const result = await discover('http://localhost:8080/v1', 'sk-x', {
    fetchImpl: async () => { fetchCalled = true; return {}; },
    resolver: async () => ['127.0.0.1'], // simulate DNS: localhost → loopback
  });

  assert.equal(result.error, 'provider_url_blocked');
  assert.equal(fetchCalled, false, 'loopback host must not be fetched');
});

test('Scenario 4c: file: scheme → blocked without fetch', async () => {
  let fetchCalled = false;
  const result = await discover('file:///etc/passwd', 'sk-x', {
    fetchImpl: async () => { fetchCalled = true; return {}; },
  });

  assert.equal(result.error, 'provider_url_blocked');
  assert.equal(fetchCalled, false, 'non-http/https scheme must not be fetched');
});

// ============================================================================
// SCENARIO 5 — Discovery is time- and size-bounded
// ============================================================================

test('Scenario 5a: timeout (fetch throws AbortError) → provider_unreachable, no hang', async () => {
  const resolver = async () => ['93.184.216.34'];
  const result = await discover('https://slow.example.com/v1', 'sk-x', {
    fetchImpl: async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    },
    resolver,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'provider_unreachable', 'timeout must map to unreachable, not a hang');
});

test('Scenario 5b: oversized content-length → body not parsed, no unbounded buffer', async () => {
  const resolver = async () => ['93.184.216.34'];
  let textCalled = false;
  const oversized = {
    status: 200,
    headers: new Headers({ 'content-length': String(2_000_000) }), // 2 MiB > 1 MiB cap
    body: null,
    text: async () => { textCalled = true; return '{}'; }, // must NOT be called
  };
  const result = await discover('https://huge.example.com/v1', 'sk-x', {
    fetchImpl: async () => oversized,
    resolver,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'provider_bad_response', 'oversized body must not parse as ok');
  assert.equal(textCalled, false, 'text() must not be called when content-length exceeds cap');
});

test('Scenario 5c: streamed body exceeding cap → reader cancelled, no unbounded buffer', async () => {
  const resolver = async () => ['93.184.216.34'];
  let cancelled = false;
  const chunk = new Uint8Array(700_000); // two 700 KB chunks exceed the 1 MiB cap
  let emitted = 0;
  const streamed = {
    status: 200,
    headers: new Headers(), // no content-length declared
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled) return { done: true, value: undefined };
            emitted += 1;
            if (emitted <= 3) return { done: false, value: chunk };
            return { done: true, value: undefined };
          },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
    text: async () => { throw new Error('text() must not be called for a streamed body'); },
  };
  const result = await discover('https://stream.example.com/v1', 'sk-x', {
    fetchImpl: async () => streamed,
    resolver,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'provider_bad_response');
  assert.equal(cancelled, true, 'reader must be cancelled when stream exceeds the cap');
});
