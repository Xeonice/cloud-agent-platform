/**
 * ClaudeAuthSource port — environment source unit spec
 * (add-claude-code-runtime, Requirement: ClaudeAuthSource port with environment source)
 *
 * Covers the two spec scenarios:
 *  - Scenario: Env source provides the token
 *      WHEN CLAUDE_CODE_OAUTH_TOKEN is set on the API host
 *      THEN EnvClaudeAuthSource returns the token to injectAuth and reports configured = true
 *
 *  - Scenario: No secret leaks on status
 *      WHEN runtime readiness is queried
 *      THEN the response carries only a boolean and never the token value or a suffix
 *
 * Run from apps/api with: pnpm test
 * (pretest compiles to dist/ via nest build; node --test picks up dist/**\/*.spec.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EnvClaudeAuthSource } from './env-claude-auth-source';

const ENV = EnvClaudeAuthSource.ENV; // 'CLAUDE_CODE_OAUTH_TOKEN'

/** Restore env to its original state after each test. */
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) {
      saved[key] = process.env[key];
      if (vars[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = vars[key];
      }
    }
    try {
      await fn();
    } finally {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Scenario: Env source provides the token
// ---------------------------------------------------------------------------

test(
  'EnvClaudeAuthSource returns the token when CLAUDE_CODE_OAUTH_TOKEN is set',
  withEnv({ [ENV]: 'tok_abc123' }, async () => {
    const source = new EnvClaudeAuthSource();
    const material = await source.getClaudeAuth();
    assert.ok(material !== null, 'getClaudeAuth() should resolve to non-null when var is set');
    assert.equal(material.oauthToken, 'tok_abc123', 'oauthToken is the raw env value');
  }),
);

test(
  'EnvClaudeAuthSource reports configured = true when CLAUDE_CODE_OAUTH_TOKEN is set',
  withEnv({ [ENV]: 'tok_abc123' }, async () => {
    const source = new EnvClaudeAuthSource();
    const isConfigured = await source.configured();
    assert.equal(isConfigured, true, 'configured() must be true when the env var is present');
  }),
);

// ---------------------------------------------------------------------------
// Scenario: No secret leaks on status
// ---------------------------------------------------------------------------

test(
  'configured() exposes a boolean only — not the token value or any suffix',
  withEnv({ [ENV]: 'secret-token-xyz' }, async () => {
    const source = new EnvClaudeAuthSource();
    const result = await source.configured();
    // The return type must be a plain boolean, not a string or object carrying the token.
    assert.equal(typeof result, 'boolean', 'configured() return type is boolean, not string or object');
    assert.equal(result, true);
    // Confirm the token string itself is not embedded in the result in any way.
    const serialized = JSON.stringify(result);
    assert.ok(
      !serialized.includes('secret-token-xyz'),
      'the token value must not appear in the configured() return value',
    );
  }),
);

// ---------------------------------------------------------------------------
// Boundary: token absent
// ---------------------------------------------------------------------------

test(
  'EnvClaudeAuthSource returns null when CLAUDE_CODE_OAUTH_TOKEN is unset',
  withEnv({ [ENV]: undefined }, async () => {
    const source = new EnvClaudeAuthSource();
    const material = await source.getClaudeAuth();
    assert.equal(material, null, 'getClaudeAuth() must return null when var is unset');
  }),
);

test(
  'EnvClaudeAuthSource returns null when CLAUDE_CODE_OAUTH_TOKEN is blank',
  withEnv({ [ENV]: '   ' }, async () => {
    const source = new EnvClaudeAuthSource();
    const material = await source.getClaudeAuth();
    assert.equal(material, null, 'getClaudeAuth() must return null when var is blank/whitespace');
  }),
);

test(
  'EnvClaudeAuthSource reports configured = false when CLAUDE_CODE_OAUTH_TOKEN is unset',
  withEnv({ [ENV]: undefined }, async () => {
    const source = new EnvClaudeAuthSource();
    const isConfigured = await source.configured();
    assert.equal(isConfigured, false, 'configured() must be false when the env var is absent');
  }),
);
