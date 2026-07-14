import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RuntimeModelCatalogCache,
  RuntimeModelCatalogCacheCapacityError,
} from './runtime-model-catalog-cache';

test('cache stores only successes, expires without stale fallback and refreshes', async () => {
  let now = 0;
  let calls = 0;
  const cache = new RuntimeModelCatalogCache<string>({
    ttlMs: 10,
    maxEntries: 2,
    maxInFlight: 2,
    maxInFlightPerOwner: 1,
    now: () => now,
  });

  await assert.rejects(
    cache.getOrLoad('key', 'owner-a', async () => {
      calls += 1;
      throw new Error('transient');
    }),
    /transient/,
  );
  assert.equal(
    await cache.getOrLoad('key', 'owner-a', async () => {
      calls += 1;
      return 'fresh-1';
    }),
    'fresh-1',
  );
  assert.equal(
    await cache.getOrLoad('key', 'owner-a', async () => {
      calls += 1;
      return 'not-used';
    }),
    'fresh-1',
  );
  assert.equal(calls, 2);

  now = 11;
  await assert.rejects(
    cache.getOrLoad('key', 'owner-a', async () => {
      calls += 1;
      throw new Error('refresh-failed');
    }),
    /refresh-failed/,
  );
  assert.equal(calls, 3);
  assert.equal(
    await cache.getOrLoad('key', 'owner-a', async () => {
      calls += 1;
      return 'fresh-2';
    }),
    'fresh-2',
  );
  assert.equal(calls, 4);
});

test('cache uses LRU eviction rather than retaining the oldest accessed entry', async () => {
  const cache = new RuntimeModelCatalogCache<string>({
    ttlMs: 1_000,
    maxEntries: 2,
    maxInFlight: 2,
    maxInFlightPerOwner: 1,
  });
  let loads = 0;
  const load = async (key: string) => {
    loads += 1;
    return `${key}-${loads}`;
  };
  await cache.getOrLoad('a', 'owner-a', () => load('a'));
  await cache.getOrLoad('b', 'owner-a', () => load('b'));
  await cache.getOrLoad('a', 'owner-a', () => load('a'));
  await cache.getOrLoad('c', 'owner-a', () => load('c'));
  await cache.getOrLoad('b', 'owner-a', () => load('b'));
  assert.equal(loads, 4);
});

test('in-flight limits preserve cross-owner capacity', async () => {
  const cache = new RuntimeModelCatalogCache<string>({
    ttlMs: 1_000,
    maxEntries: 8,
    maxInFlight: 3,
    maxInFlightPerOwner: 2,
  });
  const releases: Array<() => void> = [];
  const hold = (value: string) =>
    new Promise<string>((resolve) => {
      releases.push(() => resolve(value));
    });

  const a1 = cache.getOrLoad('a1', 'owner-a', () => hold('a1'));
  const a2 = cache.getOrLoad('a2', 'owner-a', () => hold('a2'));
  await assert.rejects(
    cache.getOrLoad('a3', 'owner-a', () => hold('a3')),
    RuntimeModelCatalogCacheCapacityError,
  );
  const b1 = cache.getOrLoad('b1', 'owner-b', () => hold('b1'));
  await assert.rejects(
    cache.getOrLoad('c1', 'owner-c', () => hold('c1')),
    RuntimeModelCatalogCacheCapacityError,
  );

  for (const release of releases) release();
  assert.deepEqual(await Promise.all([a1, a2, b1]), ['a1', 'a2', 'b1']);
});
