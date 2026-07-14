import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaService } from '../prisma/prisma.service';
import {
  encryptSecret,
  resolveEncryptionKey,
} from '../settings/settings-crypto';
import { EnvClaudeAuthSource } from './env-claude-auth-source';
import { PrismaClaudeAuthSource } from './prisma-claude-auth-source';

const OWNER_A = '00000000-0000-4000-a000-000000000101';
const OWNER_B = '00000000-0000-4000-a000-000000000102';
const OWNER_MISSING = '00000000-0000-4000-a000-000000000103';
const KEY = 'ab'.repeat(32);

function encrypted(plaintext: string): string {
  const value = encryptSecret(plaintext, resolveEncryptionKey(KEY));
  return `${value.ciphertext}.${value.iv}.${value.authTag}`;
}

function buildSource() {
  const calls: string[] = [];
  const rows = new Map([
    [
      OWNER_A,
      { mode: 'subscription', setupTokenCiphertext: encrypted('owner-a-token') },
    ],
    [
      OWNER_B,
      { mode: 'subscription', setupTokenCiphertext: encrypted('owner-b-token') },
    ],
  ]);
  const prisma = {
    claudeCredential: {
      async findUnique(input: { where: { userId: string } }) {
        calls.push(input.where.userId);
        return rows.get(input.where.userId) ?? null;
      },
    },
  } as unknown as PrismaService;
  return { source: new PrismaClaudeAuthSource(prisma), calls };
}

test('Claude provisioning credentials are resolved only from the explicit owner row', async () => {
  const previousKey = process.env.CODEX_CRED_ENC_KEY;
  const previousFallback = process.env[EnvClaudeAuthSource.ENV];
  process.env.CODEX_CRED_ENC_KEY = KEY;
  delete process.env[EnvClaudeAuthSource.ENV];
  try {
    const { source, calls } = buildSource();
    assert.deepEqual(await source.getClaudeAuth(OWNER_A), {
      oauthToken: 'owner-a-token',
    });
    assert.deepEqual(await source.getClaudeAuth(OWNER_B), {
      oauthToken: 'owner-b-token',
    });
    assert.deepEqual(calls, [OWNER_A, OWNER_B]);
  } finally {
    if (previousKey === undefined) delete process.env.CODEX_CRED_ENC_KEY;
    else process.env.CODEX_CRED_ENC_KEY = previousKey;
    if (previousFallback === undefined) delete process.env[EnvClaudeAuthSource.ENV];
    else process.env[EnvClaudeAuthSource.ENV] = previousFallback;
  }
});

test('a missing owner never borrows another account credential', async () => {
  const previousKey = process.env.CODEX_CRED_ENC_KEY;
  const previousFallback = process.env[EnvClaudeAuthSource.ENV];
  process.env.CODEX_CRED_ENC_KEY = KEY;
  delete process.env[EnvClaudeAuthSource.ENV];
  try {
    const { source, calls } = buildSource();
    assert.equal(await source.getClaudeAuth(OWNER_MISSING), null);
    assert.equal(await source.configured(OWNER_MISSING), false);
    assert.deepEqual(calls, [OWNER_MISSING, OWNER_MISSING]);
  } finally {
    if (previousKey === undefined) delete process.env.CODEX_CRED_ENC_KEY;
    else process.env.CODEX_CRED_ENC_KEY = previousKey;
    if (previousFallback === undefined) delete process.env[EnvClaudeAuthSource.ENV];
    else process.env[EnvClaudeAuthSource.ENV] = previousFallback;
  }
});

test('deployment fallback remains explicit-owner scoped and does not require a DB row', async () => {
  const previousFallback = process.env[EnvClaudeAuthSource.ENV];
  process.env[EnvClaudeAuthSource.ENV] = 'deployment-token';
  try {
    const { source } = buildSource();
    assert.deepEqual(await source.getClaudeAuth(OWNER_MISSING), {
      oauthToken: 'deployment-token',
    });
    assert.equal(await source.configured(OWNER_MISSING), true);
  } finally {
    if (previousFallback === undefined) delete process.env[EnvClaudeAuthSource.ENV];
    else process.env[EnvClaudeAuthSource.ENV] = previousFallback;
  }
});

test('present unusable rows and lookup failures block deployment fallback', async () => {
  const previousKey = process.env.CODEX_CRED_ENC_KEY;
  const previousFallback = process.env[EnvClaudeAuthSource.ENV];
  process.env.CODEX_CRED_ENC_KEY = KEY;
  process.env[EnvClaudeAuthSource.ENV] = 'deployment-token-must-not-be-used';
  try {
    const cases: Array<{
      name: string;
      findUnique: () => Promise<unknown>;
    }> = [
      {
        name: 'api-key mode',
        findUnique: async () => ({
          mode: 'api_key',
          setupTokenCiphertext: null,
        }),
      },
      {
        name: 'incomplete subscription row',
        findUnique: async () => ({
          mode: 'subscription',
          setupTokenCiphertext: null,
        }),
      },
      {
        name: 'malformed ciphertext',
        findUnique: async () => ({
          mode: 'subscription',
          setupTokenCiphertext: 'not-an-envelope',
        }),
      },
      {
        name: 'database failure',
        findUnique: async () => {
          throw new Error('fixture database unavailable');
        },
      },
    ];

    for (const fixture of cases) {
      let calls = 0;
      const prisma = {
        claudeCredential: {
          async findUnique() {
            calls += 1;
            return fixture.findUnique();
          },
        },
      } as unknown as PrismaService;
      const source = new PrismaClaudeAuthSource(prisma);
      assert.equal(
        await source.getClaudeAuth(OWNER_A),
        null,
        `${fixture.name} must fail closed`,
      );
      assert.equal(
        await source.configured(OWNER_A),
        false,
        `${fixture.name} must not appear executable`,
      );
      assert.equal(calls, 2);
    }
  } finally {
    if (previousKey === undefined) delete process.env.CODEX_CRED_ENC_KEY;
    else process.env.CODEX_CRED_ENC_KEY = previousKey;
    if (previousFallback === undefined) delete process.env[EnvClaudeAuthSource.ENV];
    else process.env[EnvClaudeAuthSource.ENV] = previousFallback;
  }
});

test('configured verifies that a stored subscription token can be decrypted', async () => {
  const previousKey = process.env.CODEX_CRED_ENC_KEY;
  const previousFallback = process.env[EnvClaudeAuthSource.ENV];
  process.env.CODEX_CRED_ENC_KEY = KEY;
  process.env[EnvClaudeAuthSource.ENV] = 'deployment-token';
  try {
    const { source } = buildSource();
    assert.equal(await source.configured(OWNER_A), true);

    process.env.CODEX_CRED_ENC_KEY = 'cd'.repeat(32);
    assert.equal(await source.configured(OWNER_A), false);
  } finally {
    if (previousKey === undefined) delete process.env.CODEX_CRED_ENC_KEY;
    else process.env.CODEX_CRED_ENC_KEY = previousKey;
    if (previousFallback === undefined) delete process.env[EnvClaudeAuthSource.ENV];
    else process.env[EnvClaudeAuthSource.ENV] = previousFallback;
  }
});
