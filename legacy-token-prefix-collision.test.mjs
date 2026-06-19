/**
 * Minimal ground-truth test: "The legacy operator token must not collide with a
 * reserved prefix" (api-key-machine-identity spec).
 *
 * Exercises the *exact* predicate used by the main.ts boot assertion
 * (RESERVED_CREDENTIAL_PREFIXES.find(prefix => authToken.startsWith(prefix))),
 * sourced directly from the compiled @cap/contracts package (no build step
 * needed — the dist is already built).
 *
 * Run: node legacy-token-prefix-collision.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// Import the canonical source of truth from the already-built contracts dist.
import {
  RESERVED_CREDENTIAL_PREFIXES,
  startsWithReservedPrefix,
} from './packages/contracts/dist/credential-prefix.js';

/**
 * Reproduces the EXACT boot-assertion logic from apps/api/src/main.ts (lines 64-68):
 *
 *   const authToken = process.env.AUTH_TOKEN;
 *   if (typeof authToken === 'string' && authToken.length > 0) {
 *     const colliding = RESERVED_CREDENTIAL_PREFIXES.find((prefix) =>
 *       authToken.startsWith(prefix),
 *     );
 *     if (colliding !== undefined) { process.exit(1); }
 *   }
 *
 * Returns the colliding prefix string, or undefined when the token is safe.
 */
function bootAssertionCollide(authToken) {
  if (typeof authToken !== 'string' || authToken.length === 0) return undefined;
  return RESERVED_CREDENTIAL_PREFIXES.find((prefix) => authToken.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Scenarios that MUST be rejected (collide with a reserved prefix)
// ---------------------------------------------------------------------------

test('AUTH_TOKEN starting with cap_sk_ collides — would be mis-routed to api-key resolver', () => {
  const token = 'cap_sk_supersecretoperatortoken';
  const colliding = bootAssertionCollide(token);
  assert.ok(colliding !== undefined, 'boot assertion must detect the collision');
  assert.equal(colliding, 'cap_sk_', 'colliding prefix must be cap_sk_');
  // Also confirm via the exported helper that the two implementations agree.
  assert.ok(startsWithReservedPrefix(token), 'startsWithReservedPrefix must agree');
});

test('AUTH_TOKEN starting with mcp_ collides — would be mis-routed to MCP resolver', () => {
  const token = 'mcp_supersecretoperatortoken';
  const colliding = bootAssertionCollide(token);
  assert.ok(colliding !== undefined, 'boot assertion must detect the collision');
  assert.equal(colliding, 'mcp_', 'colliding prefix must be mcp_');
  assert.ok(startsWithReservedPrefix(token), 'startsWithReservedPrefix must agree');
});

// ---------------------------------------------------------------------------
// Scenarios that MUST be accepted (no reserved-prefix collision)
// ---------------------------------------------------------------------------

test('AUTH_TOKEN with no reserved prefix is safe — boot proceeds normally', () => {
  const safeToken = 'my-operator-secret-token-abc123';
  const colliding = bootAssertionCollide(safeToken);
  assert.equal(colliding, undefined, 'safe token must not trigger the boot assertion');
  assert.equal(startsWithReservedPrefix(safeToken), false, 'startsWithReservedPrefix must agree');
});

test('unset AUTH_TOKEN (undefined) is safe — boot proceeds (legacy path simply disabled)', () => {
  const colliding = bootAssertionCollide(undefined);
  assert.equal(colliding, undefined, 'absent token must not trigger the boot assertion');
});

test('empty AUTH_TOKEN is safe — boot skips the gate on zero-length string', () => {
  const colliding = bootAssertionCollide('');
  assert.equal(colliding, undefined, 'empty string must not trigger the boot assertion');
});

// ---------------------------------------------------------------------------
// Sanity: reserved prefix list contains exactly the two documented prefixes
// ---------------------------------------------------------------------------

test('RESERVED_CREDENTIAL_PREFIXES contains exactly cap_sk_ and mcp_', () => {
  assert.deepEqual(
    [...RESERVED_CREDENTIAL_PREFIXES].sort(),
    ['cap_sk_', 'mcp_'].sort(),
    'the reserved prefix list must match the spec (cap_sk_, mcp_)',
  );
});
