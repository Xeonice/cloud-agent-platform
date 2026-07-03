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
