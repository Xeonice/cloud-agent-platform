import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../prisma/prisma.service';
import { encryptToStored } from '../settings/secret-storage';
import { PrismaRuntimeModelCredentialResolver } from './prisma-runtime-model-credential.resolver';

const OWNER_A = '00000000-0000-4000-a000-000000000101';
const OWNER_B = '00000000-0000-4000-a000-000000000102';
const OWNER_C = '00000000-0000-4000-a000-000000000103';
const KEY = '0'.repeat(64);

function officialRow(authJson: string) {
  return {
    mode: 'official',
    state: 'connected',
    baseUrl: null,
    apiKeyCiphertext: null,
    defaultModel: null,
    authJsonCiphertext: encryptToStored(authJson, {
      CODEX_CRED_ENC_KEY: KEY,
    }),
  };
}

function buildResolver(input: {
  readonly codex?: Map<string, ReturnType<typeof officialRow> | Record<string, unknown>>;
  readonly claude?: Map<string, Record<string, unknown>>;
  readonly env?: NodeJS.ProcessEnv;
}) {
  let codexQueries = 0;
  let claudeQueries = 0;
  const prisma = {
    codexCredential: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        codexQueries += 1;
        return input.codex?.get(where.userId) ?? null;
      },
    },
    claudeCredential: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        claudeQueries += 1;
        return input.claude?.get(where.userId) ?? null;
      },
    },
  } as unknown as PrismaService;
  return {
    resolver: new PrismaRuntimeModelCredentialResolver(prisma, {
      env: { CODEX_CRED_ENC_KEY: KEY, ...(input.env ?? {}) },
      revisionKey: Buffer.alloc(32, 7),
    }),
    codexQueries: () => codexQueries,
    claudeQueries: () => claudeQueries,
  };
}

test('official Codex credentials are resolved strictly by authenticated owner', async () => {
  const rows = new Map([
    [OWNER_A, officialRow('{"auth_mode":"chatgpt","owner":"a"}')],
    [OWNER_B, officialRow('{"auth_mode":"chatgpt","owner":"b"}')],
  ]);
  const harness = buildResolver({ codex: rows });
  const a = await harness.resolver.resolve(OWNER_A, 'codex');
  const b = await harness.resolver.resolve(OWNER_B, 'codex');
  assert.equal(a.status, 'ready');
  assert.equal(b.status, 'ready');
  if (a.status !== 'ready' || b.status !== 'ready') return;
  assert.match(a.credential.mode === 'official' ? a.credential.authJson : '', /"a"/);
  assert.match(b.credential.mode === 'official' ? b.credential.authJson : '', /"b"/);
  assert.notEqual(a.credential.revision, b.credential.revision);
});

test('existing incomplete owner credential never falls back to deployment secret', async () => {
  const rows = new Map<string, Record<string, unknown>>([
    [
      OWNER_A,
      {
        mode: 'official',
        state: 'not_connected',
        baseUrl: null,
        apiKeyCiphertext: null,
        defaultModel: null,
        authJsonCiphertext: null,
      },
    ],
  ]);
  const harness = buildResolver({
    codex: rows,
    env: {
      CODEX_CHATGPT_AUTH_JSON_B64: Buffer.from(
        '{"auth_mode":"chatgpt","scope":"deployment"}',
      ).toString('base64'),
    },
  });
  const result = await harness.resolver.resolve(OWNER_A, 'codex');
  assert.equal(result.status, 'unready');
  if (result.status === 'unready') assert.equal(result.reason, 'incomplete');
});

test('missing owner row may use an explicit deployment credential', async () => {
  const harness = buildResolver({
    env: {
      CODEX_CHATGPT_AUTH_JSON_B64: Buffer.from(
        '{"auth_mode":"chatgpt","scope":"deployment"}',
      ).toString('base64'),
    },
  });
  const result = await harness.resolver.resolve(OWNER_C, 'codex');
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.credential.scope, 'deployment');
  assert.equal(result.credential.ownerUserId, OWNER_C);
});

test('stored Claude API-key mode remains unready even when another env token exists', async () => {
  const rows = new Map<string, Record<string, unknown>>([
    [
      OWNER_A,
      {
        mode: 'api_key',
        state: 'connected',
        setupTokenCiphertext: null,
        apiKeyCiphertext: encryptToStored('sk-ant-owner-a', {
          CODEX_CRED_ENC_KEY: KEY,
        }),
        defaultModel: 'claude-sonnet',
      },
    ],
  ]);
  const harness = buildResolver({
    claude: rows,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'deployment-oauth' },
  });
  const result = await harness.resolver.resolve(OWNER_A, 'claude-code');
  assert.equal(result.status, 'unready');
  if (result.status === 'unready') {
    assert.equal(result.reason, 'unsupported-mode');
    assert.equal(result.configuredMode, 'api_key');
  }
});

test('ciphertext rotation invalidates the opaque cache revision', async () => {
  const rows = new Map([[OWNER_A, officialRow('{"auth_mode":"chatgpt","v":1}')]]);
  const harness = buildResolver({ codex: rows });
  const first = await harness.resolver.resolve(OWNER_A, 'codex');
  rows.set(OWNER_A, officialRow('{"auth_mode":"chatgpt","v":2}'));
  const second = await harness.resolver.resolve(OWNER_A, 'codex');
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  if (first.status === 'ready' && second.status === 'ready') {
    assert.notEqual(first.credential.revision, second.credential.revision);
  }
});

test('missing authenticated owner fails before querying either credential table', async () => {
  const harness = buildResolver({});
  const result = await harness.resolver.resolve('   ', 'codex');
  assert.equal(result.status, 'unready');
  assert.equal(harness.codexQueries(), 0);
  assert.equal(harness.claudeQueries(), 0);
});
