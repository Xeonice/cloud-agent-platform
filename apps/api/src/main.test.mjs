/**
 * Boot-gate test for the relaxed legacy-AUTH_TOKEN requirement
 * (self-hostable-deployment — "An OAuth-first self-host boots without a legacy
 * operator token"; design D3; main.ts task 2.3).
 *
 * Requirement semantics (from main.ts bootstrap):
 *   - The orchestrator refuses to boot (the AUTH_TOKEN check fails fatally) ONLY
 *     when the legacy operator-token path is ENABLED (AUTH_TOKEN_LEGACY_ENABLED)
 *     yet AUTH_TOKEN is unset/empty.
 *   - An OAuth-FIRST instance (legacy path NOT enabled) needs no AUTH_TOKEN: the
 *     gate is skipped entirely and bootstrap proceeds, so a clean OAuth deploy
 *     boots on GitHub-OAuth config alone.
 *   - The local-dev legacy path (AUTH_TOKEN_LEGACY_ENABLED=true + a non-empty
 *     AUTH_TOKEN) is unchanged: it passes the gate exactly as before.
 *
 * `isLegacyTokenEnabled` is the load-bearing predicate that decides whether the
 * gate runs, so — mirroring redirect-target.test.mjs (a security control pins the
 * REAL compiled function, not an inline mirror) — this drives the actual compiled
 * reader from dist/ and the contracts AUTH_TOKEN schema. The boot gate itself is
 * a pure decision over (isLegacyTokenEnabled, authTokenConfigSchema), reproduced
 * here exactly as main.ts evaluates it (no app bootstrap / DI / network needed).
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
  path.resolve(here, '../dist/auth/oauth-config.js'),
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

test('OAuth-first (legacy path NOT enabled, no AUTH_TOKEN) boots', () => {
  // The headline requirement: a clean OAuth-first env with NO legacy token must
  // not refuse to boot — the gate is skipped entirely.
  assert.equal(
    wouldRefuseToBoot({
      GITHUB_CLIENT_ID: 'iv1.deadbeef',
      GITHUB_CLIENT_SECRET: 'secret',
      AUTH_ALLOWLIST: '583231',
      SESSION_SECRET: 'a'.repeat(64),
      // no AUTH_TOKEN, no AUTH_TOKEN_LEGACY_ENABLED
    }),
    false,
  );
});

test('OAuth-first boots even with legacy explicitly disabled', () => {
  for (const disabled of [undefined, '', 'false', 'FALSE', '0', 'no', 'off', 'random']) {
    const env = { GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'y' };
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
