/**
 * Minimal ground-truth test for:
 *   Requirement: "The push-back credential is owner-scoped and write-capable"
 *   (add-multi-forge-task-delivery › task-result-delivery spec)
 *
 * Verifies two orthogonal claims:
 * 1. OWNER-SCOPED: the ForgeCredential queried is keyed to the task owner's
 *    userId (from the durable Task owner), never to a different user.
 *    Concretely, when user A owns a task, the resolver must pass userId='A'
 *    when looking up the ForgeCredential — not the currently-logged-in user
 *    or any other value.
 * 2. CROSS-USER NON-BLEED: when the DB contains a credential for user B but
 *    the task's owner is user A, the resolved target is null (no bleed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ForgeTargetResolver } from './forge-target-resolver';
import { encryptToStored } from '../settings/secret-storage';
import type { DefaultForgeRegistry, ForgeLocation } from './forge-registry';
import type { PrismaService } from '../prisma/prisma.service';

const ENV: NodeJS.ProcessEnv = { CODEX_CRED_ENC_KEY: '0'.repeat(64) };

const GITHUB_LOC: ForgeLocation = {
  kind: 'github',
  apiBaseUrl: 'https://api.github.com',
  cloneUrl: 'https://github.com/o/r.git',
  repoId: { style: 'owner-repo', owner: 'o', repo: 'r' },
};

const GITLAB_LOC: ForgeLocation = {
  kind: 'gitlab',
  apiBaseUrl: 'https://gitlab.com/api/v4',
  cloneUrl: 'https://gitlab.com/g/p.git',
  repoId: { style: 'project', idOrPath: '99' },
};

/**
 * Build a ForgeTargetResolver whose prisma stub records WHICH userId was passed
 * to `forgeCredential.findUnique`.  The credential DB is a per-userId map so
 * we can prove that only the owner's slot is consulted.
 */
function buildResolver(opts: {
  location?: ForgeLocation;
  taskOwnerId: string;
  credentialsByUserId: Record<string, { tokenCiphertext: string } | null>;
}) {
  const queriedUserIds: string[] = [];

  const prisma = {
    task: {
      findUnique: async () => ({
        ownerUserId: opts.taskOwnerId,
        repo: { gitSource: opts.location?.cloneUrl ?? GITHUB_LOC.cloneUrl },
      }),
    },
    auditEvent: {
      findFirst: async () => ({ userId: opts.taskOwnerId }),
    },
    forgeCredential: {
      findUnique: async ({ where }: { where: { userId_kind_host: { userId: string; kind: string; host: string } } }) => {
        const uid = where.userId_kind_host.userId;
        queriedUserIds.push(uid);
        return opts.credentialsByUserId[uid] ?? null;
      },
      findFirst: async ({ where }: { where: { userId: string } }) => {
        queriedUserIds.push(where.userId);
        return opts.credentialsByUserId[where.userId] ?? null;
      },
    },
  } as unknown as PrismaService;

  const registry = {
    detect: async () => opts.location ?? GITHUB_LOC,
  } as unknown as DefaultForgeRegistry;

  const instance = new ForgeTargetResolver(prisma, registry);
  return { instance, queriedUserIds };
}

// ─── Test 1: credential lookup is scoped to the task owner's userId ──────────
test('owner-scoped: forgeCredential is queried with the task-owner userId only', async () => {
  const ownerCiphertext = encryptToStored('glpat-owner-secret', ENV);

  const { instance, queriedUserIds } = buildResolver({
    location: GITLAB_LOC,
    taskOwnerId: 'user-A',
    credentialsByUserId: {
      'user-A': { tokenCiphertext: ownerCiphertext },
      'user-B': { tokenCiphertext: encryptToStored('glpat-other-user-secret', ENV) },
    },
  });

  const target = await instance.getForgeTarget('task-1', ENV);

  // The resolved token must be exactly the owner's
  assert.equal(target?.token, 'glpat-owner-secret', 'token must be the task owner credential');

  // The lookup must have been scoped to user-A, never user-B
  assert.ok(
    queriedUserIds.every((id) => id === 'user-A'),
    `forgeCredential was queried for unexpected userId(s): ${queriedUserIds.join(', ')}`,
  );
});

// ─── Test 2: cross-owner non-bleed — user B's token never bleeds to user A's task ─
test('cross-owner non-bleed: user B credential not returned for user A task', async () => {
  const { instance } = buildResolver({
    location: GITLAB_LOC,
    taskOwnerId: 'user-A',
    credentialsByUserId: {
      // user-A has NO credential; user-B does
      'user-A': null,
      'user-B': { tokenCiphertext: encryptToStored('glpat-user-b-secret', ENV) },
    },
  });

  const target = await instance.getForgeTarget('task-2', ENV);

  // Must be null — user-B's token must NOT be returned for user-A's task
  assert.equal(target, null, 'user B credential must not bleed to user A task');
});
