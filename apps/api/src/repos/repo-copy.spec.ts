/**
 * add-repo-content-store, Track import-flows (3.1/3.2/3.3/3.4/3.5).
 *
 * Covers the seam between the import surfaces and the repo-store:
 *   - every import mode lands a content copy, with the operator's own forge
 *     credential as the clone auth header;
 *   - an acquisition failure is VISIBLE (typed failure + a Repo row that reads
 *     as non-ready) and RETRYABLE through the copy-refresh route;
 *   - the local-path import is fail-closed and creates no Repo row when its gate
 *     rejects, and the row it does create is forge-less.
 *
 * The repo-store itself is faked here — it is covered against real git by
 * `repo-store.service.spec.ts`; what these tests pin is the wiring.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import {
  RepoResponseSchema,
  isLocalRepoGitSource,
  repoOffersForgeDelivery,
} from '@cap/contracts';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { GiteeForge } from '../forge/gitee-forge';
import { GithubForge } from '../forge/github-forge';
import { GitlabForge } from '../forge/gitlab-forge';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  RepoStoreResult,
  RepoStoreService,
} from '../repo-store/repo-store.service';
import { LocalRepoImportService } from './local-import.service';
import { RepoCopyController } from './repo-copy.controller';
import { RepoCopyService } from './repo-copy.service';

const ENV = 'CAP_LOCAL_IMPORT_ROOT';
const REPO_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-a';

interface RepoRow {
  id: string;
  name: string;
  gitSource: string;
  createdAt: Date;
  description: string | null;
  defaultBranch: string | null;
  branchCount: number | null;
  updatedAt: Date | null;
  githubId: string | null;
  isDefault: boolean;
  forge: string | null;
  gitlabProjectId: string | null;
  copyStatus: string;
  copyUpdatedAt: Date | null;
}

function repoRow(overrides: Partial<RepoRow> = {}): RepoRow {
  return {
    id: REPO_ID,
    name: 'repo',
    gitSource: 'https://gitee.com/team/private-app.git',
    createdAt: new Date(0),
    description: null,
    defaultBranch: 'master',
    branchCount: null,
    updatedAt: null,
    githubId: null,
    isDefault: false,
    forge: 'gitee',
    gitlabProjectId: null,
    copyStatus: 'missing',
    copyUpdatedAt: null,
    ...overrides,
  };
}

/** In-memory Repo table with the advisory-lock transaction the services use. */
function fakePrisma(rows: RepoRow[]): {
  prisma: PrismaService;
  rows: RepoRow[];
  locks: string[];
} {
  const locks: string[] = [];
  const delegate = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      rows.find((row) => row.id === where.id) ?? null,
    findFirst: async ({ where }: { where: { gitSource: string } }) =>
      rows.find((row) => row.gitSource === where.gitSource) ?? null,
    create: async ({ data }: { data: Partial<RepoRow> }) => {
      const created = repoRow({
        // Prisma generates a uuid; the response schema enforces that shape.
        id: randomUUID(),
        copyStatus: 'missing',
        copyUpdatedAt: null,
        ...data,
      });
      rows.push(created);
      return created;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<RepoRow>;
    }) => {
      const row = rows.find((item) => item.id === where.id);
      assert.ok(row, 'update targets an existing row');
      Object.assign(row, data);
      return row;
    },
  };
  const prisma = {
    repo: delegate,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        repo: delegate,
        $executeRaw: async (
          _strings: TemplateStringsArray,
          key: string,
        ): Promise<number> => {
          locks.push(key);
          return 1;
        },
      }),
  } as unknown as PrismaService;
  return { prisma, rows, locks };
}

interface StoreCall {
  readonly kind: 'acquire' | 'refresh';
  readonly repoId: string;
  readonly source?: string;
  readonly authHeader?: string;
}

function fakeStore(
  outcomes: {
    acquire?: RepoStoreResult;
    refresh?: RepoStoreResult;
    hasCopy?: boolean;
  } = {},
  rows: RepoRow[] = [],
): { store: RepoStoreService; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const ok: RepoStoreResult = {
    ok: true,
    path: `/repo-store/${REPO_ID}.git`,
    subpath: `${REPO_ID}.git`,
    copyUpdatedAt: new Date(1_000),
  };
  const settle = (
    kind: 'acquire' | 'refresh',
    request: { repoId: string; source?: string; authHeader?: string },
  ): RepoStoreResult => {
    calls.push({ kind, ...request });
    const result = outcomes[kind] ?? ok;
    // Mirror the real service: it owns the Repo row's copy columns.
    const row = rows.find((item) => item.id === request.repoId);
    if (row) {
      row.copyStatus = result.ok ? 'ready' : 'failed';
      if (result.ok) row.copyUpdatedAt = result.copyUpdatedAt;
    }
    return result;
  };
  const store = {
    acquire: async (request: {
      repoId: string;
      source: string;
      authHeader?: string;
    }) => settle('acquire', request),
    refresh: async (request: {
      repoId: string;
      source?: string;
      authHeader?: string;
    }) => settle('refresh', request),
    hasCopy: async () => outcomes.hasCopy ?? false,
  } as unknown as RepoStoreService;
  return { store, calls };
}

function forgeSeam(token: string | null): {
  forgeTargets: ForgeTargetResolver;
  forgeRegistry: DefaultForgeRegistry;
} {
  const forgeTargets = {
    resolveForOwner: async (ownerUserId: string) => {
      assert.equal(ownerUserId, OWNER);
      return token === null
        ? { ok: false as const, reason: 'owner_credential_unavailable' as const }
        : {
            ok: true as const,
            target: {
              kind: 'gitee' as const,
              apiBaseUrl: 'https://gitee.com/api/v5',
              cloneUrl: 'https://gitee.com/team/private-app.git',
              repoId: { owner: 'team', name: 'private-app' },
              token,
            },
          };
    },
  } as unknown as ForgeTargetResolver;
  const forgeRegistry = {
    forKind: () => ({
      cloneAuthHeader: (target: { token: string }) =>
        `Authorization: Basic ${target.token}`,
    }),
  } as unknown as DefaultForgeRegistry;
  return { forgeTargets, forgeRegistry };
}

function copyService(
  rows: RepoRow[],
  storeOutcomes: Parameters<typeof fakeStore>[0] = {},
  token: string | null = 'gitee-pat',
): {
  service: RepoCopyService;
  prisma: PrismaService;
  calls: StoreCall[];
  rows: RepoRow[];
} {
  const { prisma } = fakePrisma(rows);
  const { store, calls } = fakeStore(storeOutcomes, rows);
  const { forgeTargets, forgeRegistry } = forgeSeam(token);
  return {
    service: new RepoCopyService(prisma, store, forgeTargets, forgeRegistry),
    prisma,
    calls,
    rows,
  };
}

function sessionRequest(): AuthenticatedRequest {
  return {
    operatorPrincipal: { kind: 'session', user: { id: OWNER } },
  } as unknown as AuthenticatedRequest;
}

async function expectHttpFailure(
  run: () => Promise<unknown>,
): Promise<{ status: number; error: string; message: string }> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HttpException, `expected HttpException, got ${error}`);
    const body = error.getResponse() as { error: string; message: string };
    return { status: error.getStatus(), error: body.error, message: body.message };
  }
  throw new assert.AssertionError({ message: 'expected the call to fail' });
}

// ---------------------------------------------------------------------------
// Acquisition on import
// ---------------------------------------------------------------------------

test('an import acquires the copy and reports it ready on the import response', async () => {
  const rows = [repoRow()];
  const { service, calls } = copyService(rows);

  const imported = await service.acquireOnImport(
    RepoResponseSchema.parse(rows[0]),
    'Authorization: Basic gitee-pat',
  );

  assert.deepEqual(calls, [
    {
      kind: 'acquire',
      repoId: REPO_ID,
      source: 'https://gitee.com/team/private-app.git',
      authHeader: 'Authorization: Basic gitee-pat',
    },
  ]);
  assert.equal(imported.copyStatus, 'ready');
  assert.deepEqual(imported.copyUpdatedAt, new Date(1_000));
  // Import completion = metadata row + ready copy, on the wire too.
  assert.equal(RepoResponseSchema.parse(imported).copyStatus, 'ready');
});

test('an acquisition failure is typed, keeps the Repo row, and stays retryable', async () => {
  const rows = [repoRow()];
  const { service, calls } = copyService(rows, {
    acquire: {
      ok: false,
      reason: 'authentication_failed',
      stage: 'transferring',
      detail: 'remote: HTTP 401',
    },
  });

  const failure = await expectHttpFailure(() =>
    service.acquireOnImport(RepoResponseSchema.parse(rows[0])),
  );
  assert.equal(failure.status, 403);
  assert.equal(failure.error, 'repo_copy_authentication_failed');
  assert.match(failure.message, /transferring/u);

  // The row survives — visibly non-ready, which is what the console renders and
  // what task creation gates on.
  assert.equal(rows[0].copyStatus, 'failed');
  assert.equal(RepoResponseSchema.parse(rows[0]).copyStatus, 'failed');

  // Retry path: the same operator action succeeds once the cause is fixed.
  const retry = copyService(rows, { hasCopy: false });
  const refreshed = await retry.service.refreshCopy(OWNER, REPO_ID);
  assert.equal(refreshed.copyStatus, 'ready');
  assert.equal(calls.length, 1);
  assert.deepEqual(retry.calls, [
    {
      kind: 'acquire',
      repoId: REPO_ID,
      source: 'https://gitee.com/team/private-app.git',
      authHeader: 'Authorization: Basic gitee-pat',
    },
  ]);
});

test('every repo-store failure reason maps to its own stable, secret-free code', async () => {
  const expected: Array<[string, number, string]> = [
    ['authentication_failed', 403, 'repo_copy_authentication_failed'],
    ['access_denied', 403, 'repo_copy_access_denied'],
    ['network_unavailable', 503, 'repo_copy_network_unavailable'],
    ['source_invalid', 400, 'repo_copy_source_invalid'],
    ['copy_missing', 409, 'repo_copy_missing'],
    ['store_unavailable', 503, 'repo_copy_store_unavailable'],
    [
      'platform_dependency_unavailable',
      503,
      'repo_copy_platform_dependency_unavailable',
    ],
    ['aborted', 503, 'repo_copy_acquisition_aborted'],
  ];
  for (const [reason, status, code] of expected) {
    const rows = [repoRow()];
    const { service } = copyService(rows, {
      acquire: {
        ok: false,
        reason: reason as never,
        stage: 'preparing',
        detail: 'bounded redacted detail',
      },
    });
    const failure = await expectHttpFailure(() =>
      service.acquireOnImport(RepoResponseSchema.parse(rows[0])),
    );
    assert.equal(failure.status, status, reason);
    assert.equal(failure.error, code, reason);
  }
});

// ---------------------------------------------------------------------------
// Manual refresh
// ---------------------------------------------------------------------------

test('refresh fetches into an existing copy and acquires when none exists', async () => {
  const withCopy = copyService([repoRow({ copyStatus: 'ready' })], {
    hasCopy: true,
  });
  await withCopy.service.refreshCopy(OWNER, REPO_ID);
  assert.equal(withCopy.calls[0].kind, 'refresh');
  assert.equal(withCopy.calls[0].authHeader, 'Authorization: Basic gitee-pat');

  // The upgrade backfill path: a legacy Repo reads as `missing` and the same
  // operator action performs the initial acquisition.
  const legacy = copyService([repoRow()], { hasCopy: false });
  const refreshed = await legacy.service.refreshCopy(OWNER, REPO_ID);
  assert.equal(legacy.calls[0].kind, 'acquire');
  assert.equal(refreshed.copyStatus, 'ready');
});

test('refresh of an unknown repo is a 404 and never touches the store', async () => {
  const { service, calls } = copyService([]);
  const failure = await expectHttpFailure(() =>
    service.refreshCopy(OWNER, REPO_ID),
  );
  assert.equal(failure.status, 404);
  assert.deepEqual(calls, []);
});

test('refresh without a resolvable credential still runs (anonymous clone), not a crash', async () => {
  const { service, calls } = copyService([repoRow()], { hasCopy: true }, null);
  await service.refreshCopy(OWNER, REPO_ID);
  assert.equal(calls[0].authHeader, undefined);
});

// ---------------------------------------------------------------------------
// Local-path import
// ---------------------------------------------------------------------------

async function localFixture(): Promise<{ root: string; repo: string }> {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, 'cap-local-import-svc-'));
  const repo = join(root, 'acme-app');
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return { root, repo: await realpath(repo) };
}

function localService(rows: RepoRow[], storeOutcomes: Parameters<typeof fakeStore>[0] = {}) {
  const { prisma, locks } = fakePrisma(rows);
  const { store, calls } = fakeStore(storeOutcomes, rows);
  const { forgeTargets, forgeRegistry } = forgeSeam('gitee-pat');
  const copies = new RepoCopyService(prisma, store, forgeTargets, forgeRegistry);
  return {
    service: new LocalRepoImportService(prisma, copies),
    copies,
    calls,
    locks,
    rows,
  };
}

test('local import is disabled end to end when the allowlist root is unset', async () => {
  const { service, rows, calls } = localService([]);
  assert.deepEqual(service.availability({}), {
    enabled: false,
    root: null,
    envVar: 'CAP_LOCAL_IMPORT_ROOT',
  });

  const failure = await expectHttpFailure(() =>
    service.import({ path: '/anything' }, {}),
  );
  assert.equal(failure.status, 403);
  assert.equal(failure.error, 'repo_local_import_disabled');
  assert.match(failure.message, /CAP_LOCAL_IMPORT_ROOT/u);
  // Fail-closed means nothing is persisted and nothing is cloned.
  assert.deepEqual(rows, []);
  assert.deepEqual(calls, []);
});

test('a valid local repo imports as a forge-less repo with the source path and a ready copy', async () => {
  const { root, repo } = await localFixture();
  const { service, rows, calls, locks } = localService([]);

  assert.deepEqual(service.availability({ [ENV]: root }), {
    enabled: true,
    root,
    envVar: 'CAP_LOCAL_IMPORT_ROOT',
  });

  const imported = await service.import({ path: 'acme-app' }, { [ENV]: root });

  assert.equal(imported.gitSource, repo);
  assert.equal(imported.name, 'acme-app');
  assert.equal(imported.defaultBranch, 'main');
  assert.equal(imported.copyStatus, 'ready');
  // No forge provenance: forge-side delivery must never be offered for it.
  assert.equal(imported.forge, null);
  assert.equal(imported.githubId, null);
  assert.equal(isLocalRepoGitSource(imported.gitSource), true);
  assert.equal(repoOffersForgeDelivery(imported), false);
  assert.equal(rows.length, 1);
  assert.deepEqual(locks, [`repo-path:${repo}`]);

  // The copy is acquired git-natively from the path, with no credential.
  assert.deepEqual(calls, [
    { kind: 'acquire', repoId: rows[0].id, source: repo },
  ]);

  // Re-importing the same path reuses the row instead of duplicating it.
  const again = await service.import({ path: repo }, { [ENV]: root });
  assert.equal(again.id, imported.id);
  assert.equal(rows.length, 1);
});

test('a rejected local target creates no Repo row', async () => {
  const { root } = await localFixture();
  const plain = join(root, 'not-a-repo');
  await mkdir(plain, { recursive: true });
  const { service, rows, calls } = localService([]);

  const failure = await expectHttpFailure(() =>
    service.import({ path: 'not-a-repo' }, { [ENV]: root }),
  );
  assert.equal(failure.status, 422);
  assert.equal(failure.error, 'repo_local_import_not_a_git_repository');
  assert.match(failure.message, /git/iu);
  assert.deepEqual(rows, []);
  assert.deepEqual(calls, []);

  const escape = await expectHttpFailure(() =>
    service.import({ path: '../elsewhere' }, { [ENV]: root }),
  );
  assert.equal(escape.status, 403);
  assert.equal(escape.error, 'repo_local_import_path_outside_root');
  // The rejection names no path outside the root.
  assert.equal(escape.message.includes('..'), false);
  assert.deepEqual(rows, []);
});

test('refreshing a local repo re-runs the gate instead of trusting the stored path', async () => {
  const { root, repo } = await localFixture();
  const rows = [repoRow({ gitSource: repo, forge: null, copyStatus: 'ready' })];
  const { service, calls } = copyService(rows, { hasCopy: true });

  const original = process.env[ENV];
  process.env[ENV] = root;
  try {
    const refreshed = await service.refreshCopy(OWNER, REPO_ID);
    assert.equal(refreshed.copyStatus, 'ready');
    // A local source never carries a credential.
    assert.equal(calls[0].authHeader, undefined);

    // Turning the feature off must also close the refresh path for rows that
    // were imported while it was on.
    delete process.env[ENV];
    const failure = await expectHttpFailure(() =>
      service.refreshCopy(OWNER, REPO_ID),
    );
    assert.equal(failure.error, 'repo_local_import_disabled');
    assert.equal(calls.length, 1);
  } finally {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  }
});

// ---------------------------------------------------------------------------
// Console-internal routes
// ---------------------------------------------------------------------------

test('the copy routes require a human Console session', async () => {
  const rows = [repoRow()];
  const { service } = copyService(rows);
  const local = localService(rows);
  const controller = new RepoCopyController(service, local.service);
  const machine = {
    operatorPrincipal: { kind: 'api-key', user: { id: OWNER } },
  } as unknown as AuthenticatedRequest;

  for (const call of [
    () => controller.refreshCopy(machine, REPO_ID),
    () => controller.importLocal(machine, { path: 'acme-app' }),
  ]) {
    const failure = await expectHttpFailure(call);
    assert.equal(failure.status, 403);
    assert.equal(failure.error, 'session_operator_required');
  }

  // The availability probe is an ordinary authenticated read.
  assert.equal(controller.availability().envVar, ENV);

  const refreshed = await controller.refreshCopy(sessionRequest(), REPO_ID);
  assert.equal(refreshed.copyStatus, 'ready');
});

// ---------------------------------------------------------------------------
// Local repos stay outside forge delivery (3.4)
// ---------------------------------------------------------------------------

test('a locally imported repo resolves to no forge, so PR/MR delivery is unavailable', async () => {
  const prisma = {
    forgeConnection: {
      findUnique: async () => {
        throw new Error('a local path must never reach forge-connection lookup');
      },
    },
    forgeCredential: {
      findUnique: async () => {
        throw new Error('a local path must never reach credential lookup');
      },
    },
  } as unknown as PrismaService;
  const registry = new DefaultForgeRegistry(
    prisma,
    new GithubForge(),
    new GiteeForge(),
    new GitlabForge(),
  );

  for (const forge of [null, 'github'] as const) {
    // Detection is what drives change-request push-back; a filesystem source has
    // no forge location, and a stray `forge` column cannot invent one.
    assert.equal(
      await registry.detect({ gitSource: '/local-repos/acme-app', forge }),
      null,
    );
  }

  // The owner-scoped resolver every delivery path shares agrees.
  const resolver = new ForgeTargetResolver(prisma, registry);
  const resolution = await resolver.resolveForOwner(OWNER, {
    gitSource: '/local-repos/acme-app',
    forge: null,
  });
  assert.deepEqual(resolution, { ok: false, reason: 'forge_unresolved' });

  // A remote repo of the same shape still resolves a forge location, proving the
  // exclusion is about the LOCAL source, not a broken fixture.
  assert.ok(
    await registry.detect({
      gitSource: 'https://github.com/o/r.git',
      forge: null,
    }),
  );
});
