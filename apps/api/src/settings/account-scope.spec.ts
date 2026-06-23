/**
 * fix-local-account-settings-scope — per-account settings are scoped on the
 * account primary key `user.id`, NOT the GitHub identity.
 *
 * The single per-account scope key changed from `githubId` (which a LOCAL
 * password/OTP account does not have) to `user.id` (present for both account
 * kinds). These tests prove the gate end-to-end through the REAL services with an
 * in-memory Prisma fake keyed by `userId`:
 *
 *   - a LOCAL account (`githubId === null`) can read/write its Codex credential,
 *     forge credentials, and account preferences — no `account_scope_required`;
 *   - an existing GitHub account still resolves ITS rows (no regression — same
 *     `user.id`);
 *   - per-account isolation: account A never sees account B's rows;
 *   - an IDENTITY-LESS principal (a machine/legacy token with no `user.id`) is
 *     still rejected with `account_scope_required` — the defensive branch the
 *     widening must not accidentally admit;
 *   - the Codex device-login key gate accepts a local account and rejects the
 *     identity-less principal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SessionUser } from '@cap/contracts';
import { SettingsService } from './settings.service';
import { ForgeCredentialService } from './forge-credential.service';
import { CodexDeviceLoginService } from './codex-device-login.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelDiscoveryClient } from './model-discovery.client';
import type { GuardrailsService } from '../guardrails/guardrails.service';
import type { DefaultForgeRegistry } from '../forge/forge-registry';

/** AES key so a forge `connect`/codex compatible save can encrypt at rest. */
const ENC_KEY = '0'.repeat(64);
const ENV: NodeJS.ProcessEnv = { CODEX_CRED_ENC_KEY: ENC_KEY };

/** A LOCAL account: password/OTP, NO github identity (`githubId === null`). */
const LOCAL: SessionUser = {
  id: 'user-local',
  githubId: null,
  login: null,
  name: 'local@example.test',
  avatarUrl: null,
  allowed: true,
  role: 'member',
  mustChangePassword: false,
};

/** An existing GitHub account — has a numeric githubId AND a user.id. */
const GITHUB: SessionUser = {
  id: 'user-github',
  githubId: 4242,
  login: 'octocat',
  name: 'Octo Cat',
  avatarUrl: 'https://example.test/a.png',
  allowed: true,
  role: 'member',
  mustChangePassword: false,
};

/** A second account, to prove per-account isolation. */
const OTHER: SessionUser = { ...LOCAL, id: 'user-other', name: 'other@example.test' };

/**
 * An IDENTITY-LESS principal (a machine/legacy token): no account primary key.
 * The cast models the historical shared-token operator that has no per-account
 * settings; the gate must still reject it (`account_scope_required`).
 */
const IDENTITY_LESS = {
  githubId: null,
  login: null,
  name: 'machine',
} as unknown as SessionUser;

// ---------------------------------------------------------------------------
// In-memory Prisma fake — every per-account table is keyed by `userId`.
// ---------------------------------------------------------------------------

interface Row {
  userId: string;
  [k: string]: unknown;
}

function makeTable() {
  const rows: Row[] = [];
  const match = (where: Record<string, unknown>) => (r: Row) =>
    Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    rows,
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      // Unwrap a compound unique selector (e.g. userId_kind_host) into its parts.
      const flat = flattenWhere(where);
      return rows.find(match(flat)) ?? null;
    },
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      where ? rows.filter(match(where)) : [...rows],
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: Record<string, unknown>;
      create: Row;
      update: Record<string, unknown>;
    }) => {
      const flat = flattenWhere(where);
      const existing = rows.find(match(flat));
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row = { ...create } as Row;
      rows.push(row);
      return row;
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const flat = flattenWhere(where);
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (match(flat)(rows[i])) {
          rows.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
  };
}

/** Unwrap Prisma compound-unique selectors (`{ userId_kind_host: {...} }`). */
function flattenWhere(where: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function makePrisma() {
  const accountSettings = makeTable();
  const codexCredential = makeTable();
  const forgeCredential = makeTable();
  const prisma = {
    accountSettings,
    codexCredential,
    forgeCredential,
    // resolveApiBase reads this for a self-hosted host; none registered → inferred.
    forgeConnection: { findUnique: async () => null },
    // Slot ceiling + default-repo validation read these; empty is fine.
    systemSettings: { findUnique: async () => null },
    repo: { findMany: async () => [] },
  };
  return { prisma: prisma as unknown as PrismaService, accountSettings, codexCredential, forgeCredential };
}

/** A guardrails stub: only the slot setter is touched (never on these paths). */
const GUARDRAILS = { setMaxConcurrentTasks: () => undefined } as unknown as GuardrailsService;
/** Model discovery is only hit by a compatible save; unused here. */
const DISCOVERY = {} as unknown as ModelDiscoveryClient;
/** Forge registry is only hit by listAvailableRepos; unused here. */
const REGISTRY = {} as unknown as DefaultForgeRegistry;

function settingsOf(prisma: PrismaService): SettingsService {
  return new SettingsService(prisma, DISCOVERY, GUARDRAILS);
}
function forgeOf(prisma: PrismaService): ForgeCredentialService {
  return new ForgeCredentialService(prisma, REGISTRY);
}

/** Stub global fetch so a forge connect's validation probe returns ok. */
function stubFetchOk(): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

// ---------------------------------------------------------------------------
// LOCAL account (githubId === null) can use every per-account setting.
// ---------------------------------------------------------------------------

test('LOCAL account can read + write account preferences (no account_scope_required)', async () => {
  const { prisma } = makePrisma();
  const settings = settingsOf(prisma);

  // A read on a fresh account returns defaults — it does NOT throw.
  const before = await settings.readSettings(LOCAL);
  assert.equal(before.writeConfirm, true, 'default preferences read for a local account');

  const after = await settings.updateSettings(LOCAL, { writeConfirm: false });
  assert.equal(after.writeConfirm, false, 'a local account can persist a preference');
});

test('LOCAL account can read + write its Codex credential (no account_scope_required)', async () => {
  const { prisma, codexCredential } = makePrisma();
  const settings = settingsOf(prisma);

  const fresh = await settings.readCredential(LOCAL);
  assert.equal(fresh.state, 'not_connected', 'a fresh local credential reads not_connected');

  // Official mode with no auth.json: no encryption key required, exercises the scope write.
  await settings.saveCredential(LOCAL, { mode: 'official' }, ENV);
  assert.equal(codexCredential.rows.length, 1, 'a row was written');
  assert.equal(codexCredential.rows[0].userId, LOCAL.id, 'the row is scoped to the local account id');
});

test('LOCAL account can connect + list forge credentials (no account_scope_required)', async () => {
  const { prisma, forgeCredential } = makePrisma();
  const forge = forgeOf(prisma);
  const restore = stubFetchOk();
  try {
    const result = await forge.connect(
      LOCAL,
      { kind: 'gitlab', host: 'git.corp.com', token: 'glpat-supersecretvalue' },
      ENV,
    );
    assert.equal(result.state, 'connected', 'a local account connects a forge');
    assert.equal(forgeCredential.rows[0].userId, LOCAL.id, 'the forge row is scoped to the local account id');

    const list = await forge.list(LOCAL);
    assert.equal(list.length, 1, 'the local account lists its own forge credential');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// GitHub account — no regression (same user.id resolves the same rows).
// ---------------------------------------------------------------------------

test('GitHub account still resolves its own Codex credential (no regression)', async () => {
  const { prisma, codexCredential } = makePrisma();
  // Seed a row owned by the github account's user.id (as a prior save would have).
  codexCredential.rows.push({
    userId: GITHUB.id,
    mode: 'official',
    state: 'connected',
    baseUrl: null,
    apiKeyCiphertext: null,
    apiKeyLast4: null,
    defaultModel: null,
    authJsonCiphertext: 'c.i.t',
  });
  const settings = settingsOf(prisma);

  const cred = await settings.readCredential(GITHUB);
  assert.equal(cred.state, 'connected', 'the github account still resolves its stored credential');
});

// ---------------------------------------------------------------------------
// Per-account isolation — A never sees B's rows.
// ---------------------------------------------------------------------------

test('per-account isolation: account A cannot read account B credential', async () => {
  const { prisma, codexCredential } = makePrisma();
  // B owns a connected official credential.
  codexCredential.rows.push({
    userId: OTHER.id,
    mode: 'official',
    state: 'connected',
    baseUrl: null,
    apiKeyCiphertext: null,
    apiKeyLast4: null,
    defaultModel: null,
    authJsonCiphertext: 'c.i.t',
  });
  const settings = settingsOf(prisma);

  // A (LOCAL) has no row of its own — it must NOT see B's.
  const aCred = await settings.readCredential(LOCAL);
  assert.equal(aCred.state, 'not_connected', 'A does not inherit B credential');

  // And B still reads its own.
  const bCred = await settings.readCredential(OTHER);
  assert.equal(bCred.state, 'connected', 'B reads its own credential');
});

test('per-account isolation: forge list is scoped to the account id', async () => {
  const { prisma, forgeCredential } = makePrisma();
  forgeCredential.rows.push({
    userId: OTHER.id,
    kind: 'github',
    host: 'github.com',
    state: 'connected',
    tokenLast4: 'a91f',
    tokenCiphertext: 'c.i.t',
  });
  const forge = forgeOf(prisma);

  assert.deepEqual(await forge.list(LOCAL), [], 'A sees none of B forge credentials');
  assert.equal((await forge.list(OTHER)).length, 1, 'B sees its own forge credential');
});

// ---------------------------------------------------------------------------
// Identity-less principal — still rejected (the defensive branch).
// ---------------------------------------------------------------------------

test('an identity-less principal is rejected with account_scope_required (settings)', async () => {
  const { prisma } = makePrisma();
  const settings = settingsOf(prisma);
  await assert.rejects(
    () => settings.readCredential(IDENTITY_LESS),
    (err: unknown) => scopeRequired(err),
    'a machine/legacy token has no per-account settings',
  );
});

test('an identity-less principal is rejected with account_scope_required (forge)', async () => {
  const { prisma } = makePrisma();
  const forge = forgeOf(prisma);
  await assert.rejects(
    () => forge.list(IDENTITY_LESS),
    (err: unknown) => scopeRequired(err),
    'a machine/legacy token has no per-account forge credentials',
  );
});

/** Asserts the thrown error is the BadRequest `account_scope_required` body. */
function scopeRequired(err: unknown): boolean {
  const response = (err as { response?: { error?: string } })?.response;
  assert.equal(response?.error, 'account_scope_required');
  return true;
}

// ---------------------------------------------------------------------------
// Codex device-login key gate — accepts a local account, rejects identity-less.
// ---------------------------------------------------------------------------

test('codex device-login: a local account key resolves; an identity-less principal is rejected', async () => {
  // The service constructor only wires a sweep timer + a SettingsService it never
  // calls on these paths, so a bare stub is enough to reach requireKey.
  const svc = new CodexDeviceLoginService({} as unknown as SettingsService);
  try {
    // pollStatus calls requireKey(operator) first. For a LOCAL account it resolves
    // a key (no in-flight session → 'error: no session', NOT a thrown scope error).
    const status = await svc.pollStatus(LOCAL);
    assert.equal(status.status, 'error', 'local account key resolves (no in-flight session)');

    // An identity-less principal throws from requireKey (no account session).
    await assert.rejects(
      () => svc.pollStatus(IDENTITY_LESS),
      /authenticated account/,
      'an identity-less principal cannot run device login',
    );
  } finally {
    await svc.onModuleDestroy();
  }
});
