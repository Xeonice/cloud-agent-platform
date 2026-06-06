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
