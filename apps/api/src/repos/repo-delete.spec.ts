/**
 * add-repo-content-store — "Copy lifecycle follows the Repo" (verify V.1).
 *
 * `RepoStoreService.remove()` existed but nothing operator-reachable called it,
 * so the spec scenario "Repo deletion removes the copy" could never happen in a
 * running system. These tests pin the delete chain that closes it:
 *
 *   `DELETE /repos/:repoId` -> RepoCopyService.deleteRepo -> repo row removed
 *                              AND the repo-store copy removed from the volume.
 *
 * The repo-store is the REAL service here, driven against a real temporary
 * directory, so "the copy is gone" is proven by the filesystem rather than by a
 * spy. Nothing in this file spawns `git` (deletion is pure filesystem work), so
 * no developer git configuration is reachable; the store root is pinned to an
 * OS-temp directory for the duration of each test.
 */
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import type { PrismaService } from '../prisma/prisma.service';
import {
  NodeRepoStoreCommandRunner,
  NodeRepoStoreCredentialStore,
} from '../repo-store/repo-store-git';
import {
  REPO_STORE_DIR_ENV,
  REPO_STORE_STAGING_DIRNAME,
  RepoStoreService,
} from '../repo-store/repo-store.service';
import type { LocalRepoImportService } from './local-import.service';
import { RepoCopyController } from './repo-copy.controller';
import { RepoCopyService } from './repo-copy.service';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_REPO_ID = '22222222-2222-4222-8222-222222222222';

interface DeleteFixtureRow {
  id: string;
  name: string;
}

interface DeleteFixture {
  readonly prisma: PrismaService;
  readonly rows: DeleteFixtureRow[];
  readonly settings: Array<{ userId: string; defaultRepoId: string | null }>;
  readonly taskCounts: Map<string, number>;
  readonly scheduleCounts: Map<string, number>;
}

function fixture(options: {
  rows?: DeleteFixtureRow[];
  tasks?: Record<string, number>;
  schedules?: Record<string, number>;
  settings?: Array<{ userId: string; defaultRepoId: string | null }>;
} = {}): DeleteFixture {
  const rows: DeleteFixtureRow[] = options.rows ?? [
    { id: REPO_ID, name: 'private-app' },
  ];
  const settings = options.settings ?? [];
  const taskCounts = new Map(Object.entries(options.tasks ?? {}));
  const scheduleCounts = new Map(Object.entries(options.schedules ?? {}));
  const prisma = {
    repo: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i]!.id === where.id) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
    task: {
      count: async ({ where }: { where: { repoId: string } }) =>
        taskCounts.get(where.repoId) ?? 0,
    },
    taskSchedule: {
      count: async ({ where }: { where: { repoId: string } }) =>
        scheduleCounts.get(where.repoId) ?? 0,
    },
    accountSettings: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { defaultRepoId: string };
        data: { defaultRepoId: null };
      }) => {
        let count = 0;
        for (const row of settings) {
          if (row.defaultRepoId === where.defaultRepoId) {
            row.defaultRepoId = data.defaultRepoId;
            count += 1;
          }
        }
        return { count };
      },
    },
  } as unknown as PrismaService;
  return { prisma, rows, settings, taskCounts, scheduleCounts };
}

function realStore(prisma: PrismaService): RepoStoreService {
  return new RepoStoreService(
    prisma,
    new NodeRepoStoreCommandRunner(),
    new NodeRepoStoreCredentialStore(),
  );
}

function service(prisma: PrismaService, store: RepoStoreService): RepoCopyService {
  return new RepoCopyService(
    prisma,
    store,
    {} as unknown as ForgeTargetResolver,
    {} as unknown as DefaultForgeRegistry,
  );
}

/** A store root under the OS temp dir, restored (and removed) after the test. */
async function withStoreRoot(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, 'cap-repo-delete-'));
  assert.ok(root.startsWith(base), 'store root must live under the OS temp dir');
  const previous = process.env[REPO_STORE_DIR_ENV];
  process.env[REPO_STORE_DIR_ENV] = root;
  try {
    await body(root);
  } finally {
    if (previous === undefined) delete process.env[REPO_STORE_DIR_ENV];
    else process.env[REPO_STORE_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

/** Materialize a plausible copy (plus a staging leftover) for `repoId`. */
async function seedCopy(root: string, repoId: string): Promise<string> {
  const copy = join(root, `${repoId}.git`);
  await mkdir(join(copy, 'objects'), { recursive: true });
  await writeFile(join(copy, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await mkdir(join(root, REPO_STORE_STAGING_DIRNAME, `${repoId}-abcdef`), {
    recursive: true,
  });
  return copy;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

function principal(kind: 'session' | 'api-key' | 'mcp'): OperatorPrincipal {
  return {
    kind,
    user: {
      id: 'account-owner-a',
      githubId: null,
      login: null,
      name: 'Owner A',
      avatarUrl: null,
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
    ...(kind === 'api-key' ? { keyId: 'key-a' } : {}),
  } as OperatorPrincipal;
}

function request(kind: 'session' | 'api-key' | 'mcp'): AuthenticatedRequest {
  return { operatorPrincipal: principal(kind) } as AuthenticatedRequest;
}

function controller(copies: RepoCopyService): RepoCopyController {
  return new RepoCopyController(copies, {} as unknown as LocalRepoImportService);
}

test('deleting a Repo removes its content copy from the repo-store volume', async () => {
  await withStoreRoot(async (root) => {
    const fx = fixture();
    const store = realStore(fx.prisma);
    const copy = await seedCopy(root, REPO_ID);
    assert.equal(await exists(copy), true, 'fixture seeds a real copy');

    await service(fx.prisma, store).deleteRepo(REPO_ID);

    assert.deepEqual(fx.rows, [], 'the Repo row is gone');
    assert.equal(await exists(copy), false, 'the per-repo copy path is removed');
    assert.deepEqual(
      await readdir(join(root, REPO_STORE_STAGING_DIRNAME)),
      [],
      'staging leftovers for the repo are removed too',
    );
    assert.equal(await store.hasCopy(REPO_ID), false);
  });
});

test('deleting one Repo leaves every other Repo copy untouched', async () => {
  await withStoreRoot(async (root) => {
    const fx = fixture({
      rows: [
        { id: REPO_ID, name: 'private-app' },
        { id: OTHER_REPO_ID, name: 'other-app' },
      ],
    });
    const store = realStore(fx.prisma);
    const copy = await seedCopy(root, REPO_ID);
    const otherCopy = await seedCopy(root, OTHER_REPO_ID);

    await service(fx.prisma, store).deleteRepo(REPO_ID);

    assert.equal(await exists(copy), false);
    assert.equal(await exists(otherCopy), true, "the sibling repo's copy survives");
    assert.deepEqual(
      fx.rows.map((row) => row.id),
      [OTHER_REPO_ID],
    );
  });
});

test('a Repo that still has tasks is refused, and its copy is kept', async () => {
  await withStoreRoot(async (root) => {
    const fx = fixture({ tasks: { [REPO_ID]: 3 } });
    const store = realStore(fx.prisma);
    const copy = await seedCopy(root, REPO_ID);

    const error = await service(fx.prisma, store)
      .deleteRepo(REPO_ID)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error instanceof ConflictException, 'referenced repos are a 409');
    assert.equal((error as HttpException).getStatus(), 409);
    const body = (error as HttpException).getResponse() as {
      error: string;
      message: string;
    };
    assert.equal(body.error, 'repo_has_tasks');
    assert.match(body.message, /task/i, 'the message names the blocking reference');
    assert.equal(fx.rows.length, 1, 'the Repo row survives the refusal');
    assert.equal(await exists(copy), true, 'the copy survives the refusal');
  });
});

test('a Repo that still has schedules is refused with the same stable code', async () => {
  await withStoreRoot(async (root) => {
    const fx = fixture({ schedules: { [REPO_ID]: 1 } });
    const store = realStore(fx.prisma);
    const copy = await seedCopy(root, REPO_ID);

    const error = await service(fx.prisma, store)
      .deleteRepo(REPO_ID)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error instanceof ConflictException);
    assert.equal(
      ((error as HttpException).getResponse() as { error: string }).error,
      'repo_has_tasks',
    );
    assert.equal(fx.rows.length, 1);
    assert.equal(await exists(copy), true);
  });
});

test('deleting an unknown Repo is a 404 and touches no copy', async () => {
  await withStoreRoot(async (root) => {
    const fx = fixture({ rows: [] });
    const store = realStore(fx.prisma);
    const orphan = await seedCopy(root, REPO_ID);

    const error = await service(fx.prisma, store)
      .deleteRepo(REPO_ID)
      .then(
        () => null,
        (err: unknown) => err,
      );

    assert.ok(error instanceof NotFoundException);
    assert.equal((error as HttpException).getStatus(), 404);
    assert.equal(
      await exists(orphan),
      true,
      'a 404 never deletes volume content for a repo the caller does not own a row for',
    );
  });
});

test('a stale default-repo preference pointing at the deleted Repo is cleared', async () => {
  await withStoreRoot(async (root) => {
    const fx = fixture({
      settings: [
        { userId: 'account-owner-a', defaultRepoId: REPO_ID },
        { userId: 'account-owner-b', defaultRepoId: OTHER_REPO_ID },
      ],
    });
    const store = realStore(fx.prisma);
    await seedCopy(root, REPO_ID);

    await service(fx.prisma, store).deleteRepo(REPO_ID);

    assert.deepEqual(
      fx.settings.map((row) => row.defaultRepoId),
      [null, OTHER_REPO_ID],
      "only the deleted repo's selection is cleared",
    );
  });
});

test('a failing copy removal does not undo (or fail) the delete', async () => {
  const fx = fixture();
  const store = {
    remove: async () => {
      throw new Error('repo-store volume is read-only');
    },
  } as unknown as RepoStoreService;

  await service(fx.prisma, store).deleteRepo(REPO_ID);

  assert.deepEqual(
    fx.rows,
    [],
    'the row stays deleted: the volume can be cleaned up later, a half-deleted repo cannot',
  );
});

test('DELETE /repos/:repoId requires a human Console session', async () => {
  const fx = fixture();
  const store = { remove: async () => undefined } as unknown as RepoStoreService;
  const routes = controller(service(fx.prisma, store));

  for (const kind of ['api-key', 'mcp'] as const) {
    const error = await routes.remove(request(kind), REPO_ID).then(
      () => null,
      (err: unknown) => err,
    );
    assert.ok(error instanceof HttpException, `${kind} principals are rejected`);
    assert.equal(error.getStatus(), 403);
    assert.equal(
      (error.getResponse() as { error: string }).error,
      'session_operator_required',
    );
  }
  assert.equal(fx.rows.length, 1, 'no machine principal ever deleted the row');

  await routes.remove(request('session'), REPO_ID);
  assert.deepEqual(fx.rows, [], 'a Console session deletes the repo');
});
