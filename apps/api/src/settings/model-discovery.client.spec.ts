import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostResolver } from './assert-safe-provider-url';
import { ModelDiscoveryClient } from './model-discovery.client';

const PUBLIC_RESOLVER: HostResolver = async () => ['203.0.113.10'];

async function withFetch(
  replacement: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('production model discovery client sends one bounded owner credential request', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(
    (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          data: [
            { id: 'provider/model:a' },
            { id: 'provider:model-b' },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch,
    async () => {
      const result = await new ModelDiscoveryClient().discover(
        'https://provider.example.test/v1/',
        'owner-secret-token',
        PUBLIC_RESOLVER,
        { deadlineAt: Date.now() + 1_000 },
      );
      assert.deepEqual(result, {
        ok: true,
        models: ['provider/model:a', 'provider:model-b'],
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://provider.example.test/v1/models');
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.redirect, 'manual');
  assert.equal(
    new Headers(calls[0]?.init?.headers).get('authorization'),
    'Bearer owner-secret-token',
  );
});

test('production model discovery client rejects initial and redirected SSRF targets before fetching them', async (t) => {
  await t.test('initial unsafe target', async () => {
    let fetchCalls = 0;
    await withFetch(
      (async () => {
        fetchCalls += 1;
        throw new Error('must not fetch an unsafe target');
      }) as typeof fetch,
      async () => {
        const result = await new ModelDiscoveryClient().discover(
          'http://169.254.169.254/latest/meta-data',
          'must-not-leak',
          PUBLIC_RESOLVER,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, 'provider_url_blocked');
      },
    );
    assert.equal(fetchCalls, 0);
  });

  await t.test('redirect to unsafe target', async () => {
    const fetched: string[] = [];
    await withFetch(
      (async (input: string | URL | Request) => {
        fetched.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        });
      }) as typeof fetch,
      async () => {
        const result = await new ModelDiscoveryClient().discover(
          'https://provider.example.test/v1',
          'must-not-leak',
          PUBLIC_RESOLVER,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, 'provider_url_blocked');
      },
    );
    assert.deepEqual(fetched, ['https://provider.example.test/v1/models']);
  });
});

test('production model discovery client fails closed on redirect loops, oversized bodies, and caller abort', async (t) => {
  await t.test('bounded redirect count', async () => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(null, {
          status: 307,
          headers: { location: `https://provider.example.test/redirect-${calls}` },
        });
      }) as typeof fetch,
      async () => {
        const result = await new ModelDiscoveryClient().discover(
          'https://provider.example.test/v1',
          'must-not-leak',
          PUBLIC_RESOLVER,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, 'provider_unreachable');
      },
    );
    assert.equal(calls, 4, 'initial request plus three validated redirects');
  });

  await t.test('declared oversized body', async () => {
    await withFetch(
      (async () =>
        new Response('{"data":[]}', {
          status: 200,
          headers: { 'content-length': String(1_048_577) },
        })) as typeof fetch,
      async () => {
        const result = await new ModelDiscoveryClient().discover(
          'https://provider.example.test/v1',
          'must-not-leak',
          PUBLIC_RESOLVER,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, 'provider_bad_response');
      },
    );
  });

  await t.test('already-aborted caller', async () => {
    let fetchCalls = 0;
    const controller = new AbortController();
    controller.abort();
    await withFetch(
      (async () => {
        fetchCalls += 1;
        throw new Error('must not fetch after abort');
      }) as typeof fetch,
      async () => {
        const result = await new ModelDiscoveryClient().discover(
          'https://provider.example.test/v1',
          'must-not-leak',
          PUBLIC_RESOLVER,
          { signal: controller.signal },
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, 'provider_unreachable');
      },
    );
    assert.equal(fetchCalls, 0);
  });
});
