/**
 * Verify-phase test for the compatible-provider model-discovery classification
 * (account-settings, task 7.6).
 *
 * Requirement semantics (from model-discovery.client.ts):
 *   1. Provider errors are DISTINGUISHABLE: network/no-response & non-2xx (incl.
 *      5xx) => provider_unreachable; 401/403 => provider_auth_failed; 2xx with an
 *      unrecognizable body => provider_bad_response.
 *   2. A 2xx OpenAI-style `{ data: [{ id }] }` OR a bare `string[]` yields ok with
 *      the model ids; an empty-but-successful list is ok (models: []), NOT an
 *      error.
 *   3. modelsEndpoint joins base URL + `/models` tolerating a trailing slash.
 *   4. The classification is available WITHOUT persisting (pure function of an
 *      outcome record), so a candidate can be validated before save.
 *
 * Logic is inlined (mirrors model-discovery.client.ts) so the test runs under
 * plain node:test with no transpile.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
  if (outcome.networkError) {
    return { ok: false, error: 'provider_unreachable', message: 'unreachable' };
  }
  const status = outcome.status ?? 0;
  if (status === 401 || status === 403) {
    return { ok: false, error: 'provider_auth_failed', message: 'auth' };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, error: 'provider_unreachable', message: 'status' };
  }
  const models = extractModelIds(outcome.body);
  if (models === null) {
    return { ok: false, error: 'provider_bad_response', message: 'bad body' };
  }
  return { ok: true, models };
}

function modelsEndpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
}

// 1. distinguishable errors
test('network error => provider_unreachable', () => {
  const r = classifyModelDiscoveryOutcome({ networkError: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'provider_unreachable');
});

test('401/403 => provider_auth_failed', () => {
  assert.equal(classifyModelDiscoveryOutcome({ status: 401 }).error, 'provider_auth_failed');
  assert.equal(classifyModelDiscoveryOutcome({ status: 403 }).error, 'provider_auth_failed');
});

test('non-2xx (incl 5xx, 404) => provider_unreachable, distinct from auth', () => {
  assert.equal(classifyModelDiscoveryOutcome({ status: 500 }).error, 'provider_unreachable');
  assert.equal(classifyModelDiscoveryOutcome({ status: 404 }).error, 'provider_unreachable');
});

test('2xx with unrecognizable body => provider_bad_response', () => {
  assert.equal(classifyModelDiscoveryOutcome({ status: 200, body: { nope: 1 } }).error, 'provider_bad_response');
  assert.equal(classifyModelDiscoveryOutcome({ status: 200, body: undefined }).error, 'provider_bad_response');
  // mixed array with a non-string is malformed, not a partial list
  assert.equal(classifyModelDiscoveryOutcome({ status: 200, body: ['a', 5] }).error, 'provider_bad_response');
  // data[] with a non-id entry is malformed
  assert.equal(classifyModelDiscoveryOutcome({ status: 200, body: { data: [{ id: 'a' }, { nope: 1 }] } }).error, 'provider_bad_response');
});

// 2. success shapes
test('OpenAI-style data[].id body => ok with model ids', () => {
  const r = classifyModelDiscoveryOutcome({ status: 200, body: { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] } });
  assert.deepEqual(r, { ok: true, models: ['gpt-4o', 'gpt-4o-mini'] });
});

test('bare string[] body => ok with model ids', () => {
  const r = classifyModelDiscoveryOutcome({ status: 200, body: ['m1', 'm2'] });
  assert.deepEqual(r, { ok: true, models: ['m1', 'm2'] });
});

test('empty-but-successful list is ok (models: []), not an error', () => {
  assert.deepEqual(classifyModelDiscoveryOutcome({ status: 200, body: { data: [] } }), { ok: true, models: [] });
  assert.deepEqual(classifyModelDiscoveryOutcome({ status: 200, body: [] }), { ok: true, models: [] });
});

// 3. endpoint join
test('modelsEndpoint tolerates a trailing slash', () => {
  assert.equal(modelsEndpoint('https://api.x.ai/v1'), 'https://api.x.ai/v1/models');
  assert.equal(modelsEndpoint('https://api.x.ai/v1/'), 'https://api.x.ai/v1/models');
  assert.equal(modelsEndpoint('https://api.x.ai/v1///'), 'https://api.x.ai/v1/models');
});

// ---------------------------------------------------------------------------
// SSRF guard + time/size bounds (wire-compatible-provider-execution, tasks
// 2.1/2.2/2.5; design D4). Logic mirrors assert-safe-provider-url.ts and the
// hardened ModelDiscoveryClient.discover orchestration so it runs under plain
// node:test with no transpile.
// ---------------------------------------------------------------------------

import { isIP } from 'node:net';

function isUnsafeIpv4(address) {
  const parts = address.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
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
  return true;
}

class UnsafeProviderUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'UnsafeProviderUrlError';
  }
}

// `resolver` maps a hostname -> [ip,...]; default rejects an unknown name so a
// test never reaches real DNS. Mirrors assert-safe-provider-url.ts ordering:
// parse -> scheme -> host -> literal-IP-or-resolved-IP classification.
async function assertSafeProviderUrl(baseUrl, resolver) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UnsafeProviderUrlError('malformed_url', 'bad url');
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new UnsafeProviderUrlError('unsupported_scheme', 'bad scheme');
  }
  const host = url.hostname;
  if (host.length === 0) throw new UnsafeProviderUrlError('missing_host', 'no host');
  if (isIP(host) !== 0) {
    if (isUnsafeAddress(host)) throw new UnsafeProviderUrlError('unsafe_host', 'unsafe literal');
    return url;
  }
  const addresses = await (resolver ?? (async () => []))(host);
  if (addresses.length === 0) throw new UnsafeProviderUrlError('unsafe_host', 'no resolve');
  for (const a of addresses) {
    if (isUnsafeAddress(a)) throw new UnsafeProviderUrlError('unsafe_host', 'unsafe resolved');
  }
  return url;
}

// Mirrors ModelDiscoveryClient.discover: SSRF guard BEFORE any fetch; an unsafe
// URL yields provider_url_blocked with the fetch spy NEVER called.
async function discover(baseUrl, apiKey, deps) {
  const { fetchImpl, resolver } = deps;
  try {
    await assertSafeProviderUrl(baseUrl, resolver);
  } catch (error) {
    if (error instanceof UnsafeProviderUrlError) {
      return { ok: false, error: 'provider_url_blocked', message: 'blocked' };
    }
    throw error;
  }
  let outcome;
  try {
    const response = await fetchImpl(modelsEndpoint(baseUrl), {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const text = await readBoundedText(response, 1_048_576);
    if (text === null) {
      outcome = { status: response.status, body: undefined };
    } else {
      let body;
      try {
        body = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      outcome = { status: response.status, body };
    }
  } catch {
    outcome = { networkError: true };
  }
  return classifyModelDiscoveryOutcomeWithBlock(outcome);
}

function classifyModelDiscoveryOutcomeWithBlock(outcome) {
  if (outcome.urlBlocked) return { ok: false, error: 'provider_url_blocked', message: 'blocked' };
  return classifyModelDiscoveryOutcome(outcome);
}

// Mirrors readBoundedText: content-length over the cap short-circuits; the
// stream is otherwise drained, aborting once the accumulated size exceeds cap.
async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes ? null : text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

// A fetch spy that records every call so "NO outbound fetch" is assertable.
function makeFetchSpy(impl) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (typeof impl === 'function') return impl(url, init);
    throw new Error('fetch should not have been called');
  };
  return { fetchImpl, calls };
}

// 4. SSRF rejection with NO outbound fetch (task 2.5)
test('SSRF: rejects 169.254.169.254 (cloud metadata) without any fetch', async () => {
  const spy = makeFetchSpy();
  const r = await discover('http://169.254.169.254/v1', 'sk-key', { fetchImpl: spy.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'provider_url_blocked');
  assert.equal(spy.calls.length, 0); // no network call to the metadata host
});

test('SSRF: rejects localhost (resolves to loopback) without any fetch', async () => {
  const spy = makeFetchSpy();
  // resolver stands in for DNS: localhost -> 127.0.0.1 is loopback.
  const resolver = async () => ['127.0.0.1'];
  const r = await discover('http://localhost:6379/v1', 'sk-key', { fetchImpl: spy.fetchImpl, resolver });
  assert.equal(r.error, 'provider_url_blocked');
  assert.equal(spy.calls.length, 0);
});

test('SSRF: rejects file: and gopher: schemes without any fetch', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:11211/_stat']) {
    const spy = makeFetchSpy();
    const r = await discover(url, 'sk-key', { fetchImpl: spy.fetchImpl });
    assert.equal(r.error, 'provider_url_blocked', `expected ${url} blocked`);
    assert.equal(spy.calls.length, 0, `expected no fetch for ${url}`);
  }
});

test('SSRF: rejects a hostname that resolves to a private/loopback address', async () => {
  const spy = makeFetchSpy();
  const resolver = async () => ['10.0.0.5']; // internal name -> RFC1918
  const r = await discover('https://internal.example.com/v1', 'sk-key', { fetchImpl: spy.fetchImpl, resolver });
  assert.equal(r.error, 'provider_url_blocked');
  assert.equal(spy.calls.length, 0);
});

test('SSRF: a safe public host IS fetched (guard does not block legitimate providers)', async () => {
  const ok = {
    status: 200,
    headers: new Headers({ 'content-length': '34' }),
    body: null,
    text: async () => JSON.stringify({ data: [{ id: 'gpt-4o' }] }),
  };
  const spy = makeFetchSpy(async () => ok);
  const resolver = async () => ['93.184.216.34']; // public IP
  const r = await discover('https://api.example.com/v1', 'sk-key', { fetchImpl: spy.fetchImpl, resolver });
  assert.deepEqual(r, { ok: true, models: ['gpt-4o'] });
  assert.equal(spy.calls.length, 1); // legitimate provider was reached exactly once
});

// 5. classifier surfaces the blocked outcome distinctly from unreachable
test('provider_url_blocked is distinct from provider_unreachable', () => {
  assert.equal(classifyModelDiscoveryOutcomeWithBlock({ urlBlocked: true }).error, 'provider_url_blocked');
  assert.equal(classifyModelDiscoveryOutcomeWithBlock({ networkError: true }).error, 'provider_unreachable');
});

// 6. timeout => unreachable (an aborted fetch throws; discover maps to networkError)
test('timeout: an aborted/throwing fetch maps to provider_unreachable', async () => {
  const spy = makeFetchSpy(async () => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    throw err;
  });
  const resolver = async () => ['93.184.216.34'];
  const r = await discover('https://slow.example.com/v1', 'sk-key', { fetchImpl: spy.fetchImpl, resolver });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'provider_unreachable');
  assert.equal(spy.calls.length, 1);
});

// 7. body-size bound (content-length over cap short-circuits; streamed overflow aborts)
test('body bound: a content-length over the cap is not parsed (provider_bad_response)', async () => {
  const oversized = {
    status: 200,
    headers: new Headers({ 'content-length': String(2_000_000) }), // > 1 MiB cap
    body: null,
    text: async () => {
      throw new Error('text() must not be called once content-length exceeds the cap');
    },
  };
  const spy = makeFetchSpy(async () => oversized);
  const resolver = async () => ['93.184.216.34'];
  const r = await discover('https://huge.example.com/v1', 'sk-key', { fetchImpl: spy.fetchImpl, resolver });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'provider_bad_response'); // oversized body not parsed as ok
});

test('body bound: a streamed body exceeding the cap aborts the read (no unbounded buffer)', async () => {
  // A streaming body with no content-length that emits chunks beyond the cap.
  let cancelled = false;
  const chunk = new Uint8Array(700_000); // two of these exceed the 1 MiB cap
  let emitted = 0;
  const makeBody = () => ({
    getReader() {
      return {
        async read() {
          if (cancelled) return { done: true, value: undefined };
          emitted += 1;
          if (emitted <= 3) return { done: false, value: chunk };
          return { done: true, value: undefined };
        },
        async cancel() {
          cancelled = true;
        },
        releaseLock() {},
      };
    },
  });
  const streamed = {
    status: 200,
    headers: new Headers(), // no content-length declared
    body: makeBody(),
    text: async () => {
      throw new Error('streamed read should not fall back to text()');
    },
  };
  const spy = makeFetchSpy(async () => streamed);
  const resolver = async () => ['93.184.216.34'];
  const r = await discover('https://stream.example.com/v1', 'sk-key', { fetchImpl: spy.fetchImpl, resolver });
  assert.equal(r.error, 'provider_bad_response');
  assert.equal(cancelled, true); // the bounded reader aborted rather than buffering unboundedly
});
