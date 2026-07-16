/**
 * add-multi-forge-task-delivery — ReposService source-forge detection (8.2).
 *
 * `create` records `Repo.forge`: explicit when supplied, else inferred from the
 * gitSource public host (github.com / gitlab.com / gitee.com), else null for a
 * self-hosted / unknown host. Echoed on the response. A picker/by-URL import thus
 * lands a forge-correct row (NOT github.com / NOT forge=null for gitlab/gitee).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ForgeKind } from '@cap/contracts';

import { normalizeRepoGitSource, ReposService } from './repos.service';
import type {
  ForgeTargetResolver,
  OwnerForgeTargetResolution,
} from '../forge/forge-target-resolver';
import type {
  RemoteRefsProbePort,
  RemoteRefsProbeResult,
} from '../forge/remote-refs-probe';
import type { AvailableRepo } from '../forge/forge.port';
import type { DefaultForgeRegistry } from '../forge/forge-registry';
import type { PrismaService } from '../prisma/prisma.service';

function repoRow(overrides: Partial<{
  id: string;
  name: string;
  gitSource: string;
  forge: string | null;
  defaultBranch: string | null;
  description: string | null;
  githubId: string | null;
  gitlabProjectId: string | null;
}> = {}) {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    name: overrides.name ?? 'repo',
    gitSource: overrides.gitSource ?? 'https://gitlab.com/g/p.git',
    createdAt: new Date(0),
    description: overrides.description ?? null,
    defaultBranch: overrides.defaultBranch ?? null,
    branchCount: null,
    updatedAt: null,
    githubId: overrides.githubId ?? null,
    isDefault: false,
    forge: overrides.forge ?? null,
    gitlabProjectId: overrides.gitlabProjectId ?? null,
  };
}

function service(
  existing: ReturnType<typeof repoRow> | null = null,
  resolution?: OwnerForgeTargetResolution,
  probeResult: RemoteRefsProbeResult | Promise<RemoteRefsProbeResult> = {
    ok: true,
    defaultBranch: 'master',
  },
  pickerCandidates: AvailableRepo[] = [],
) {
  let captured:
    | {
        name: string;
        gitSource: string;
        forge: string;
        defaultBranch: string;
        description?: string | null;
        githubId?: string | null;
        gitlabProjectId?: string | null;
      }
    | undefined;
  let createAttempts = 0;
  let updateAttempts = 0;
  let probeAttempts = 0;
  const probeTokens: string[] = [];
  const pickerTokens: string[] = [];
  let resolvedInput:
    | { ownerUserId: string; repo: { gitSource: string; forge?: string | null } }
    | undefined;
  const repoDelegate = {
      findFirst: async () => existing,
      create: async (args: {
        data: {
          name: string;
          gitSource: string;
          forge: string;
          defaultBranch: string;
          description?: string | null;
          githubId?: string | null;
          gitlabProjectId?: string | null;
        };
      }) => {
        createAttempts += 1;
        captured = args.data;
        return repoRow(args.data);
      },
      update: async (args: {
        data: Partial<ReturnType<typeof repoRow>>;
      }) => {
        updateAttempts += 1;
        assert.ok(existing, 'update requires an existing row');
        return repoRow({ ...existing, ...args.data });
      },
  };
  const transactionClient = {
    repo: repoDelegate,
    $queryRaw: async () => [],
  };
  const prisma = {
    repo: repoDelegate,
    $transaction: async <T>(
      callback: (tx: typeof transactionClient) => Promise<T>,
    ): Promise<T> => callback(transactionClient),
  } as unknown as PrismaService;
  const forgeTargets = {
    async resolveForOwner(
      ownerUserId: string,
      repo: { gitSource: string; forge?: string | null },
    ): Promise<OwnerForgeTargetResolution> {
      resolvedInput = { ownerUserId, repo };
      if (resolution) return resolution;
      const host = new URL(repo.gitSource).host;
      const explicitKind: ForgeKind | null =
        repo.forge === 'github' || repo.forge === 'gitlab' || repo.forge === 'gitee'
          ? repo.forge
          : null;
      const kind: ForgeKind | null =
        explicitKind ??
        (host === 'github.com'
          ? 'github'
          : host === 'gitlab.com'
            ? 'gitlab'
            : host === 'gitee.com'
              ? 'gitee'
              : null);
      if (!kind) return { ok: false, reason: 'forge_unresolved' };
      return {
        ok: true,
        target: {
          kind,
          apiBaseUrl: `https://${host}/api`,
          cloneUrl: repo.gitSource,
          repoId:
            kind === 'gitlab'
              ? { style: 'project', idOrPath: 'group/project' }
              : { style: 'owner-repo', owner: 'owner', repo: 'project' },
          token: 'owner-only-test-secret',
        },
      };
    },
  } as ForgeTargetResolver;
  const remoteRefs: RemoteRefsProbePort = {
    async resolveDefaultBranch(target): Promise<RemoteRefsProbeResult> {
      probeAttempts += 1;
      probeTokens.push(target.token);
      return probeResult;
    },
  };
  const forgeRegistry = {
    forKind: () => ({
      listRepos: async (target: { token: string }) => {
        pickerTokens.push(target.token);
        return pickerCandidates;
      },
    }),
  } as unknown as DefaultForgeRegistry;
  return {
    svc: new ReposService(prisma, forgeTargets, remoteRefs, forgeRegistry),
    captured: () => captured,
    createAttempts: () => createAttempts,
    updateAttempts: () => updateAttempts,
    probeAttempts: () => probeAttempts,
    probeTokens,
    pickerTokens,
    resolvedInput: () => resolvedInput,
  };
}

test('infers gitlab from the gitSource host and echoes it', async () => {
  const { svc, captured, resolvedInput } = service();
  const res = await svc.create('owner-a', { name: 'p', gitSource: 'https://gitlab.com/g/p.git' });
  assert.equal(captured()?.forge, 'gitlab');
  assert.equal(captured()?.defaultBranch, 'master');
  assert.equal(res.forge, 'gitlab');
  assert.equal(res.defaultBranch, 'master');
  assert.equal(resolvedInput()?.ownerUserId, 'owner-a');
  assert.equal(resolvedInput()?.repo.gitSource, 'https://gitlab.com/g/p.git');
});

test('infers github and gitee from their hosts', async () => {
  const gh = service();
  await gh.svc.create('owner-a', { name: 'r', gitSource: 'https://github.com/o/r.git' });
  assert.equal(gh.captured()?.forge, 'github');

  const ge = service();
  await ge.svc.create('owner-a', { name: 'r', gitSource: 'https://gitee.com/o/r.git' });
  assert.equal(ge.captured()?.forge, 'gitee');
});

test('explicit forge wins over host inference', async () => {
  const { svc, captured } = service();
  const res = await svc.create('owner-a', {
    name: 'app',
    gitSource: 'https://git.corp.com/team/app.git/',
    forge: 'gitlab',
  });
  assert.equal(captured()?.forge, 'gitlab');
  assert.equal(captured()?.gitSource, 'https://git.corp.com/team/app.git');
  assert.equal(res.forge, 'gitlab');
});

test('self-hosted host with no registry/explicit forge fails before persistence', async () => {
  const { svc, captured } = service();
  await assert.rejects(
    () => svc.create('owner-a', { name: 'app', gitSource: 'https://git.corp.com/team/app.git' }),
    (err: unknown) => {
      const response = (err as { getResponse?: () => unknown }).getResponse?.();
      return (response as { error?: string }).error === 'repo_forge_unresolved';
    },
  );
  assert.equal(captured(), undefined);
});

test('normalizes http clone URLs and strips query/hash/trailing slash', async () => {
  assert.equal(
    normalizeRepoGitSource(' HTTPS://GITEE.COM/team/app.git/?utm=1#readme '),
    'https://gitee.com/team/app.git',
  );
});

test('rejects credential-bearing clone URLs', async () => {
  try {
    normalizeRepoGitSource('https://token:gitee-secret@gitee.com/team/app.git');
    assert.fail('expected credential-bearing URL to throw');
  } catch (err) {
    const response = (err as { getResponse?: () => unknown }).getResponse?.();
    assert.equal(
      (response as { error?: string }).error,
      'repo_git_source_credentials_forbidden',
    );
  }
});

test('duplicate normalized gitSource returns existing repo instead of creating', async () => {
  const existing = repoRow({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'already',
    gitSource: 'https://gitee.com/team/app.git',
    forge: 'gitee',
  });
  const { svc, captured } = service(existing);
  const res = await svc.create('owner-a', {
    name: 'new name',
    gitSource: 'https://gitee.com/team/app.git/',
    forge: 'gitee',
  });
  assert.equal(captured(), undefined);
  assert.equal(res.id, existing.id);
  assert.equal(res.name, 'already');
  assert.equal(res.gitSource, 'https://gitee.com/team/app.git');
  assert.equal(res.defaultBranch, 'master', 'verified URL probe enriches the duplicate');
});

test('GitLab picker persists the owner-verified API master and numeric project id without probing HEAD', async () => {
  const candidate: AvailableRepo = {
    forge: 'gitlab',
    fullPath: 'group/private',
    gitSource: 'https://gitlab.com/group/private.git',
    visibility: 'private',
    defaultBranch: 'master',
    gitlabProjectId: '55',
  };
  const { svc, captured, pickerTokens, probeAttempts } = service(
    null,
    undefined,
    { ok: true, defaultBranch: 'should-not-be-used' },
    [candidate],
  );

  const response = await svc.create('owner-a', {
    name: candidate.fullPath,
    gitSource: candidate.gitSource,
    forge: 'gitlab',
    importSource: 'picker',
  });

  assert.deepEqual(pickerTokens, ['owner-only-test-secret']);
  assert.equal(probeAttempts(), 0);
  assert.equal(captured()?.defaultBranch, 'master');
  assert.equal(captured()?.gitlabProjectId, '55');
  assert.equal(response.defaultBranch, 'master');
});

test('private Gitee URL persists only the master returned by the owner-authenticated HEAD probe', async () => {
  const { svc, probeTokens, captured } = service();

  const response = await svc.create('owner-a', {
    name: 'team/private',
    gitSource: 'https://gitee.com/team/private.git',
    forge: 'gitee',
    importSource: 'url',
  });

  assert.deepEqual(probeTokens, ['owner-only-test-secret']);
  assert.equal(captured()?.defaultBranch, 'master');
  assert.equal(response.defaultBranch, 'master');
});

test('URL import stays unsettled and writes no Repo until the authenticated HEAD probe succeeds', async () => {
  let releaseProbe!: (result: RemoteRefsProbeResult) => void;
  const pendingProbe = new Promise<RemoteRefsProbeResult>((resolve) => {
    releaseProbe = resolve;
  });
  const {
    svc,
    captured,
    createAttempts,
    updateAttempts,
    probeAttempts,
  } = service(null, undefined, pendingProbe);
  let settled = false;

  const importing = svc
    .create('owner-a', {
      name: 'team/private',
      gitSource: 'https://gitee.com/team/private.git',
      forge: 'gitee',
      importSource: 'url',
    })
    .finally(() => {
      settled = true;
    });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probeAttempts(), 1);
  assert.equal(settled, false);
  assert.equal(createAttempts(), 0);
  assert.equal(updateAttempts(), 0);
  assert.equal(captured(), undefined);

  releaseProbe({ ok: true, defaultBranch: 'master' });
  const response = await importing;

  assert.equal(settled, true);
  assert.equal(createAttempts(), 1);
  assert.equal(captured()?.defaultBranch, 'master');
  assert.equal(response.defaultBranch, 'master');
});

test('private Gitee picker persists its owner-verified API master', async () => {
  const candidate: AvailableRepo = {
    forge: 'gitee',
    fullPath: 'team/private-picker',
    gitSource: 'https://gitee.com/team/private-picker',
    visibility: 'private',
    defaultBranch: 'master',
  };
  const { svc, pickerTokens, captured, probeAttempts } = service(
    null,
    undefined,
    { ok: true, defaultBranch: 'unused' },
    [candidate],
  );

  const response = await svc.create('owner-a', {
    name: candidate.fullPath,
    gitSource: candidate.gitSource,
    forge: 'gitee',
    importSource: 'picker',
  });

  assert.deepEqual(pickerTokens, ['owner-only-test-secret']);
  assert.equal(probeAttempts(), 0);
  assert.equal(captured()?.defaultBranch, 'master');
  assert.equal(response.defaultBranch, 'master');
});

test('picker rejects malformed default refs instead of trimming or fabricating main', async () => {
  const candidate: AvailableRepo = {
    forge: 'gitee',
    fullPath: 'team/private',
    gitSource: 'https://gitee.com/team/private.git',
    visibility: 'private',
    defaultBranch: ' master ',
  };
  const { svc, createAttempts, updateAttempts } = service(
    null,
    undefined,
    { ok: true, defaultBranch: 'unused' },
    [candidate],
  );

  await assert.rejects(
    () =>
      svc.create('owner-a', {
        name: candidate.fullPath,
        gitSource: candidate.gitSource,
        forge: 'gitee',
        importSource: 'picker',
      }),
    (error: unknown) => {
      const response = (error as { getResponse?: () => unknown }).getResponse?.();
      return (response as { error?: string }).error === 'repo_default_branch_unresolved';
    },
  );
  assert.equal(createAttempts(), 0);
  assert.equal(updateAttempts(), 0);
});

test('duplicate reconcile refreshes verified branch but never erases existing nullable metadata', async () => {
  const existing = repoRow({
    gitSource: 'https://gitee.com/team/private.git',
    forge: 'gitee',
    defaultBranch: 'main',
    description: 'keep verified description',
  });
  const { svc, createAttempts, updateAttempts } = service(existing);

  const response = await svc.reconcileVerifiedImport({
    name: 'new display name',
    gitSource: existing.gitSource,
    forge: 'gitee',
    defaultBranch: 'master',
    description: null,
  });

  assert.equal(createAttempts(), 0);
  assert.equal(updateAttempts(), 1);
  assert.equal(response.defaultBranch, 'master');
  assert.equal(response.description, 'keep verified description');
  assert.equal(response.name, existing.name);
});

test('duplicate reconcile fails closed on a conflicting non-null forge', async () => {
  const existing = repoRow({
    gitSource: 'https://code.example.com/team/private.git',
    forge: 'gitlab',
    defaultBranch: 'master',
  });
  const { svc, updateAttempts } = service(existing);

  await assert.rejects(
    () =>
      svc.reconcileVerifiedImport({
        name: 'private',
        gitSource: existing.gitSource,
        forge: 'gitee',
        defaultBranch: 'master',
      }),
    (error: unknown) => {
      const response = (error as { getResponse?: () => unknown }).getResponse?.();
      return (response as { error?: string }).error === 'repo_import_identity_conflict';
    },
  );
  assert.equal(updateAttempts(), 0);
});

test('stable GitHub id match refreshes a verified renamed clone URL while preserving display metadata', async () => {
  const existing = repoRow({
    name: 'custom display',
    gitSource: 'https://github.com/team/old-name.git',
    forge: 'github',
    defaultBranch: 'main',
    githubId: 'gh:5',
  });
  const { svc } = service(existing);

  const response = await svc.reconcileVerifiedImport({
    name: 'new-name',
    gitSource: 'https://github.com/team/new-name.git',
    forge: 'github',
    defaultBranch: 'master',
    githubId: 'gh:5',
    legacyGithubId: 'team/new-name',
  });

  assert.equal(response.gitSource, 'https://github.com/team/new-name.git');
  assert.equal(response.name, 'custom display');
  assert.equal(response.defaultBranch, 'master');
});

test('concurrent duplicate imports serialize on the database lock and create exactly one Repo', async () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  let stored: ReturnType<typeof repoRow> | null = null;
  let creates = 0;
  const firstCreateStarted = deferred();
  const allowFirstCreate = deferred();
  const lockTails = new Map<string, Promise<void>>();

  const repoDelegate = {
    findFirst: async () => stored,
    create: async (args: {
      data: {
        name: string;
        gitSource: string;
        forge: string;
        defaultBranch: string;
        description?: string | null;
        githubId?: string | null;
        gitlabProjectId?: string | null;
      };
    }) => {
      creates += 1;
      firstCreateStarted.resolve();
      await allowFirstCreate.promise;
      stored = repoRow(args.data);
      return stored;
    },
    update: async (args: { data: Partial<ReturnType<typeof repoRow>> }) => {
      assert.ok(stored);
      stored = repoRow({ ...stored, ...args.data });
      return stored;
    },
  };
  const prisma = {
    repo: repoDelegate,
    $transaction: async <T>(
      callback: (tx: {
        repo: typeof repoDelegate;
        $queryRaw: (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ) => Promise<unknown[]>;
      }) => Promise<T>,
    ): Promise<T> => {
      const releases: Array<() => void> = [];
      const tx = {
        repo: repoDelegate,
        $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
          const key = String(values[0]);
          const prior = lockTails.get(key) ?? Promise.resolve();
          let release!: () => void;
          const tail = new Promise<void>((done) => {
            release = done;
          });
          lockTails.set(key, tail);
          await prior;
          releases.push(() => {
            release();
            if (lockTails.get(key) === tail) lockTails.delete(key);
          });
          return [];
        },
      };
      try {
        return await callback(tx);
      } finally {
        for (const release of releases.reverse()) release();
      }
    },
  } as unknown as PrismaService;
  const svc = new ReposService(
    prisma,
    {} as ForgeTargetResolver,
    {} as RemoteRefsProbePort,
    {} as DefaultForgeRegistry,
  );
  const verified = {
    name: 'private',
    gitSource: 'https://gitee.com/team/private.git',
    forge: 'gitee' as const,
    defaultBranch: 'master',
  };

  const first = svc.reconcileVerifiedImport(verified);
  await firstCreateStarted.promise;
  const second = svc.reconcileVerifiedImport(verified);
  allowFirstCreate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(creates, 1);
  assert.equal(firstResult.id, secondResult.id);
  assert.equal(secondResult.defaultBranch, 'master');
});

test('missing exact-host owner credential fails safely and creates no repo', async () => {
  const { svc, captured } = service(null, {
    ok: false,
    reason: 'owner_credential_unavailable',
  });

  await assert.rejects(
    () =>
      svc.create('owner-without-token', {
        name: 'private',
        gitSource: 'https://gitee.com/team/private.git',
        forge: 'gitee',
      }),
    (err: unknown) => {
      const response = (err as { getResponse?: () => unknown }).getResponse?.();
      assert.deepEqual(response, {
        error: 'repo_forge_auth_required',
        message:
          'A connected credential for this repository host is required before import.',
      });
      assert.equal(JSON.stringify(response).includes('token'), false);
      return true;
    },
  );
  assert.equal(captured(), undefined);
});

const remoteFailureCases: Array<{
  reason: Exclude<RemoteRefsProbeResult, { ok: true }>['reason'];
  error: string;
  status: number;
}> = [
  {
    reason: 'authentication_failed',
    error: 'repo_forge_authentication_failed',
    status: 403,
  },
  { reason: 'access_denied', error: 'repo_forge_access_denied', status: 403 },
  {
    reason: 'network_unavailable',
    error: 'repo_forge_network_unavailable',
    status: 503,
  },
  {
    reason: 'default_branch_unresolved',
    error: 'repo_default_branch_unresolved',
    status: 422,
  },
];

for (const fixture of remoteFailureCases) {
  test(`remote probe ${fixture.reason} returns a stable safe failure and writes no Repo`, async () => {
    const { svc, captured, createAttempts } = service(
      null,
      undefined,
      { ok: false, reason: fixture.reason },
    );
    await assert.rejects(
      () =>
        svc.create('owner-a', {
          name: 'private',
          gitSource: 'https://gitee.com/team/private.git',
          forge: 'gitee',
        }),
      (error: unknown) => {
        const exception = error as {
          getStatus?: () => number;
          getResponse?: () => unknown;
        };
        const response = exception.getResponse?.() as {
          error?: string;
          message?: string;
        };
        assert.equal(exception.getStatus?.(), fixture.status);
        assert.equal(response.error, fixture.error);
        assert.equal(JSON.stringify(response).includes('owner-only-test-secret'), false);
        return true;
      },
    );
    assert.equal(createAttempts(), 0);
    assert.equal(captured(), undefined);
  });
}
