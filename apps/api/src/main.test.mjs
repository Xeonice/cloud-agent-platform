/**
 * Boot-gate test for the relaxed legacy-AUTH_TOKEN requirement.
 *
 * Requirement semantics (from main.ts bootstrap):
 *   - The orchestrator refuses to boot (the AUTH_TOKEN check fails fatally) ONLY
 *     when the legacy operator-token path is ENABLED (AUTH_TOKEN_LEGACY_ENABLED)
 *     yet AUTH_TOKEN is unset/empty.
 *   - A local-account instance (legacy path NOT enabled) needs no AUTH_TOKEN: the
 *     gate is skipped entirely and bootstrap proceeds.
 *   - The local-dev legacy path (AUTH_TOKEN_LEGACY_ENABLED=true + a non-empty
 *     AUTH_TOKEN) is unchanged: it passes the gate exactly as before.
 *
 * `isLegacyTokenEnabled` is the load-bearing predicate that decides whether the
 * gate runs, so this drives the actual compiled reader from dist/ and the
 * contracts AUTH_TOKEN schema. The boot gate itself is a pure decision over
 * (isLegacyTokenEnabled, authTokenConfigSchema), reproduced here exactly as
 * main.ts evaluates it (no app bootstrap / DI / network needed).
 *
 * Requires `pnpm --filter @cap/api build` first. Run: `node main.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const { isLegacyTokenEnabled } = require(
  path.resolve(here, '../dist/auth/auth-config.js'),
);
const { authTokenConfigSchema } = require(
  path.resolve(here, '../../../packages/contracts/dist/index.js'),
);

/**
 * The EXACT boot-gate decision from main.ts bootstrap(): the fatal AUTH_TOKEN
 * check runs ONLY when the legacy path is enabled. Returns true when bootstrap
 * would refuse to boot (process.exit(1)), false when it proceeds.
 */
function wouldRefuseToBoot(env) {
  if (isLegacyTokenEnabled(env)) {
    return !authTokenConfigSchema.safeParse(env.AUTH_TOKEN).success;
  }
  return false;
}

test('local-account auth (legacy path NOT enabled, no AUTH_TOKEN) boots', () => {
  // The headline requirement: a clean local-account env with NO legacy token
  // must not refuse to boot — the gate is skipped entirely.
  assert.equal(
    wouldRefuseToBoot({
      SESSION_SECRET: 'a'.repeat(64),
      ADMIN_EMAIL: 'admin@example.com',
      // no AUTH_TOKEN, no AUTH_TOKEN_LEGACY_ENABLED
    }),
    false,
  );
});

test('local-account auth boots even with legacy explicitly disabled', () => {
  for (const disabled of [undefined, '', 'false', 'FALSE', '0', 'no', 'off', 'random']) {
    const env = { SESSION_SECRET: 'a'.repeat(64) };
    if (disabled !== undefined) env.AUTH_TOKEN_LEGACY_ENABLED = disabled;
    assert.equal(
      wouldRefuseToBoot(env),
      false,
      `legacy disabled (${JSON.stringify(disabled)}) must not gate on AUTH_TOKEN`,
    );
  }
});

test('legacy path ENABLED with no AUTH_TOKEN refuses to boot (unchanged fatal gate)', () => {
  for (const enabled of ['true', 'TRUE', '1', 'yes']) {
    assert.equal(
      wouldRefuseToBoot({ AUTH_TOKEN_LEGACY_ENABLED: enabled }),
      true,
      `legacy enabled (${enabled}) + unset AUTH_TOKEN must refuse to boot`,
    );
    assert.equal(
      wouldRefuseToBoot({ AUTH_TOKEN_LEGACY_ENABLED: enabled, AUTH_TOKEN: '' }),
      true,
      `legacy enabled (${enabled}) + empty AUTH_TOKEN must refuse to boot`,
    );
  }
});

test('local-dev legacy path (enabled + non-empty AUTH_TOKEN) boots, unchanged', () => {
  assert.equal(
    wouldRefuseToBoot({
      AUTH_TOKEN_LEGACY_ENABLED: 'true',
      AUTH_TOKEN: 'super-secret-operator-token-xyz',
    }),
    false,
  );
});
