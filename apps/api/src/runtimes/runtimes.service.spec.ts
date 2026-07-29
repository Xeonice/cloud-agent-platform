/**
 * Guards the readiness endpoint's coverage of the runtime declaration.
 *
 * The property under test is not "codex is ready" — that was already true. It is
 * that the response covers EVERY declared runtime. This endpoint used to build a
 * hand-written two-entry list, which made it the quietest failure mode the
 * runtime axis had: a newly declared and registered runtime would be accepted by
 * the API and resolved by the registry, then simply not appear here, so the
 * console — which builds its selector from this response — would never offer it,
 * with nothing failing anywhere.
 *
 * The service had no tests at all when that list was replaced by a total mapping.
 *
 * Run: node --test dist/runtimes/runtimes.service.spec.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_RUNTIME_IDS, DEFAULT_AGENT_RUNTIME_ID } from '@cap/contracts';

import type { ClaudeAuthSource } from '@/sandbox/claude-auth-source.port';
import { RuntimesService } from './runtimes.service';

const OWNER = 'owner-1';

/**
 * `getClaudeAuth` throws on purpose. The readiness surface must derive its
 * boolean from `configured` and never reach for the token itself, so a test
 * double that explodes if the secret path is touched proves that discipline
 * instead of merely documenting it.
 */
function authSource(
  configured: ClaudeAuthSource['configured'],
): ClaudeAuthSource {
  return {
    configured,
    getClaudeAuth: async () => {
      throw new Error('readiness must never resolve the token');
    },
  };
}

test('readiness reports every declared runtime, exactly once', async () => {
  const { runtimes } = await new RuntimesService().getReadiness(OWNER);
  assert.deepEqual(
    [...runtimes.map((entry) => entry.id)].sort(),
    [...AGENT_RUNTIME_IDS].sort(),
    'a declared runtime missing here is invisible to the console selector even though the API accepts it',
  );
  assert.equal(new Set(runtimes.map((entry) => entry.id)).size, runtimes.length);
});

test('the default runtime is always offerable, with or without a credential', async () => {
  const { runtimes } = await new RuntimesService().getReadiness(null);
  const fallback = runtimes.find((entry) => entry.id === DEFAULT_AGENT_RUNTIME_ID);
  assert.ok(fallback);
  assert.equal(
    fallback.ready,
    true,
    'the default runtime resolves its credential per task at provision time, so readiness must never disable it',
  );
});

test('claude-code readiness follows the auth source and fails closed', async () => {
  const readinessFor = async (
    source?: ClaudeAuthSource,
    owner: string | null = OWNER,
  ) => {
    const { runtimes } = await new RuntimesService(source).getReadiness(owner);
    return runtimes.find((entry) => entry.id === 'claude-code')?.ready;
  };

  assert.equal(await readinessFor(authSource(async () => true)), true);
  assert.equal(await readinessFor(authSource(async () => false)), false);

  assert.equal(
    await readinessFor(undefined),
    false,
    'an unwired auth source must report not-ready rather than offering a runtime that fails at launch',
  );
  assert.equal(
    await readinessFor(authSource(async () => true), null),
    false,
    'readiness is owner-scoped: no owner means no configured credential to read',
  );
  assert.equal(
    await readinessFor(
      authSource(async () => {
        throw new Error('probe exploded');
      }),
    ),
    false,
    'a throwing probe must fail closed, not propagate',
  );
});
