/**
 * add-multi-forge-task-delivery — ForgeTargetResolver owner-scoping (8.2).
 *
 * The security-critical credential resolution: the push-back token is the TASK
 * OWNER's `ForgeCredential` for the resolved (kind, host); an unattributed task,
 * an unresolved forge, or a missing credential all resolve to null (→ push-back
 * skips). GitHub uses the same owner-scoped forge PAT path as every other forge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ForgeTargetResolver } from './forge-target-resolver';
import { encryptToStored } from '../settings/secret-storage';
import type { DefaultForgeRegistry, ForgeLocation } from './forge-registry';
import type { PrismaService } from '../prisma/prisma.service';

const ENV: NodeJS.ProcessEnv = { CODEX_CRED_ENC_KEY: '0'.repeat(64) };

const GITLAB_LOC: ForgeLocation = {
  kind: 'gitlab',
  apiBaseUrl: 'https://gitlab.com/api/v4',
  cloneUrl: 'https://gitlab.com/g/p.git',
  repoId: { style: 'project', idOrPath: '42' },
};

function resolver(opts: {
  location?: ForgeLocation | null;
  ownerId?: string | null;
  forgeCredential?: { tokenCiphertext: string } | null;
}) {
  const prisma = {
    task: { findUnique: async () => ({ repo: { gitSource: 'https://gitlab.com/g/p.git' } }) },
    auditEvent: { findFirst: async () => (opts.ownerId ? { userId: opts.ownerId } : null) },
    forgeCredential: {
      findUnique: async () => opts.forgeCredential ?? null,
      findFirst: async () => null,
    },
  } as unknown as PrismaService;
  const registry = {
    detect: async () => (opts.location === undefined ? GITLAB_LOC : opts.location),
  } as unknown as DefaultForgeRegistry;
  return new ForgeTargetResolver(prisma, registry);
}

test('owner with a forge credential resolves a credentialed target', async () => {
  const cred = { tokenCiphertext: encryptToStored('glpat-owner-secret', ENV) };
  const target = await resolver({ ownerId: 'u1', forgeCredential: cred }).getForgeTarget('t1', ENV);
  assert.equal(target?.kind, 'gitlab');
  assert.equal(target?.token, 'glpat-owner-secret');
  assert.equal(target?.apiBaseUrl, 'https://gitlab.com/api/v4');
});

test('direct owner import resolution uses the exact normalized forge host and owner', async () => {
  const stored = encryptToStored('gitee-owner-import-secret', ENV);
  const location: ForgeLocation = {
    kind: 'gitee',
    apiBaseUrl: 'https://code.example.com/api/v5',
    cloneUrl: 'https://code.example.com/team/app.git',
    repoId: { style: 'owner-repo', owner: 'team', repo: 'app' },
  };
  let credentialWhere: unknown;
  let detected: unknown;
  const prisma = {
    forgeCredential: {
      findUnique: async (args: unknown) => {
        credentialWhere = args;
        return { tokenCiphertext: stored };
      },
      findFirst: async () => {
        assert.fail('an exact owner/kind/host credential must not fall back');
      },
    },
  } as unknown as PrismaService;
  const registry = {
    detect: async (repo: unknown) => {
      detected = repo;
      return location;
    },
  } as unknown as DefaultForgeRegistry;

  const result = await new ForgeTargetResolver(prisma, registry).resolveForOwner(
    'owner-account-a',
    {
      gitSource: 'https://code.example.com/team/app.git',
      forge: 'gitee',
    },
    ENV,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(detected, {
    gitSource: 'https://code.example.com/team/app.git',
    forge: 'gitee',
  });
  assert.deepEqual(credentialWhere, {
    where: {
      userId_kind_host: {
        userId: 'owner-account-a',
        kind: 'gitee',
        host: 'code.example.com',
      },
    },
  });
  assert.equal(result.target.token, 'gitee-owner-import-secret');
  assert.equal(result.target.cloneUrl.includes('gitee-owner-import-secret'), false);
});

test('direct owner import resolution reports a safe missing-credential reason', async () => {
  const result = await resolver({
    ownerId: 'unused',
    forgeCredential: null,
  }).resolveForOwner(
    'owner-account-b',
    { gitSource: 'https://gitlab.com/g/p.git', forge: 'gitlab' },
    ENV,
  );

  assert.deepEqual(result, {
    ok: false,
    reason: 'owner_credential_unavailable',
  });
  assert.equal(JSON.stringify(result).includes('token'), false);
});

const PRIVATE_OWNER_ISOLATION_CASES: Array<{
  kind: 'github' | 'gitlab' | 'gitee';
  location: ForgeLocation;
}> = [
  {
    kind: 'github',
    location: {
      kind: 'github',
      apiBaseUrl: 'https://api.github.com',
      cloneUrl: 'https://github.com/team/private.git',
      repoId: { style: 'owner-repo', owner: 'team', repo: 'private' },
    },
  },
  {
    kind: 'gitlab',
    location: {
      kind: 'gitlab',
      apiBaseUrl: 'https://gitlab.com/api/v4',
      cloneUrl: 'https://gitlab.com/team/private.git',
      repoId: { style: 'project', idOrPath: 'team/private' },
    },
  },
  {
    kind: 'gitee',
    location: {
      kind: 'gitee',
      apiBaseUrl: 'https://gitee.com/api/v5',
      cloneUrl: 'https://gitee.com/team/private.git',
      repoId: { style: 'owner-repo', owner: 'team', repo: 'private' },
    },
  },
];

for (const fixture of PRIVATE_OWNER_ISOLATION_CASES) {
  test(`private ${fixture.kind} import reads only the authenticated owner's exact credential`, async () => {
    const queriedOwners: string[] = [];
    const exactLookups: Array<{ userId: string; kind: string; host: string }> = [];
    const credentials = new Map<string, { tokenCiphertext: string }>([
      [
        'owner-a',
        { tokenCiphertext: encryptToStored(`${fixture.kind}-owner-a`, ENV) },
      ],
      [
        'owner-b',
        { tokenCiphertext: encryptToStored(`${fixture.kind}-owner-b`, ENV) },
      ],
    ]);
    const prisma = {
      forgeCredential: {
        findUnique: async (args: {
          where: {
            userId_kind_host: { userId: string; kind: string; host: string };
          };
        }) => {
          const key = args.where.userId_kind_host;
          exactLookups.push(key);
          const owner = key.userId;
          queriedOwners.push(owner);
          return credentials.get(owner) ?? null;
        },
        findFirst: async (args: { where: { userId: string } }) => {
          queriedOwners.push(args.where.userId);
          return credentials.get(args.where.userId) ?? null;
        },
      },
    } as unknown as PrismaService;
    const registry = {
      detect: async () => fixture.location,
    } as unknown as DefaultForgeRegistry;
    const resolver = new ForgeTargetResolver(prisma, registry);

    const resolved = await resolver.resolveForOwner(
      'owner-a',
      {
        gitSource: fixture.location.cloneUrl,
        forge: fixture.kind,
      },
      ENV,
    );

    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.equal(resolved.target.token, `${fixture.kind}-owner-a`);
    assert.deepEqual(queriedOwners, ['owner-a']);
    assert.deepEqual(exactLookups, [
      {
        userId: 'owner-a',
        kind: fixture.kind,
        host: new URL(fixture.location.cloneUrl).host,
      },
    ]);

    credentials.delete('owner-a');
    queriedOwners.length = 0;
    exactLookups.length = 0;
    const missing = await resolver.resolveForOwner(
      'owner-a',
      {
        gitSource: fixture.location.cloneUrl,
        forge: fixture.kind,
      },
      ENV,
    );
    assert.deepEqual(missing, {
      ok: false,
      reason: 'owner_credential_unavailable',
    });
    assert.ok(queriedOwners.every((owner) => owner === 'owner-a'));
  });
}

test('unattributed task (no task.created owner) → null (skip)', async () => {
  const target = await resolver({ ownerId: null, forgeCredential: { tokenCiphertext: 'x' } }).getForgeTarget('t1', ENV);
  assert.equal(target, null);
});

test('unresolved forge → null (skip)', async () => {
  const target = await resolver({ location: null, ownerId: 'u1' }).getForgeTarget('t1', ENV);
  assert.equal(target, null);
});

test('owner with NO credential and non-github → null (skip)', async () => {
  const target = await resolver({ ownerId: 'u1', forgeCredential: null }).getForgeTarget('t1', ENV);
  assert.equal(target, null);
});

test('github public-host with no forge PAT resolves to null', async () => {
  const githubLoc: ForgeLocation = {
    kind: 'github',
    apiBaseUrl: 'https://api.github.com',
    cloneUrl: 'https://github.com/o/r.git',
    repoId: { style: 'owner-repo', owner: 'o', repo: 'r' },
  };
  const r = resolver({
    location: githubLoc,
    ownerId: 'u1',
    forgeCredential: null,
  });
  const target = await r.getForgeTarget('t1', ENV);
  assert.equal(target, null);
});

test('legacy scheme-prefixed credential host resolves for URL-imported repos', async () => {
  const stored = encryptToStored('gitee-legacy-host-secret', ENV);
  const giteeLoc: ForgeLocation = {
    kind: 'gitee',
    apiBaseUrl: 'https://gitee.internal/api/v5',
    cloneUrl: 'https://gitee.internal/team/app.git',
    repoId: { style: 'owner-repo', owner: 'team', repo: 'app' },
  };
  const prisma = {
    task: {
      findUnique: async () => ({ repo: { gitSource: 'https://gitee.internal/team/app.git' } }),
    },
    auditEvent: { findFirst: async () => ({ userId: 'u1' }) },
    forgeCredential: {
      findUnique: async () => null,
      findFirst: async () => ({ tokenCiphertext: stored }),
    },
  } as unknown as PrismaService;
  const registry = {
    detect: async () => giteeLoc,
  } as unknown as DefaultForgeRegistry;
  const target = await new ForgeTargetResolver(prisma, registry).getForgeTarget('t1', ENV);
  assert.equal(target?.token, 'gitee-legacy-host-secret');
  assert.equal(target?.cloneUrl, 'https://gitee.internal/team/app.git');
});
