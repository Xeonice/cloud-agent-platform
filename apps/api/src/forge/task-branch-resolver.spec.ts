import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaService } from '../prisma/prisma.service';
import { encryptToStored } from '../settings/secret-storage';
import type { DefaultForgeRegistry, ForgeLocation } from './forge-registry';
import { ForgeTargetResolver } from './forge-target-resolver';
import type { ForgeTarget } from './forge.port';
import {
  RemoteRefsProbePort,
  type RemoteRefsProbeResult,
} from './remote-refs-probe';
import {
  TaskBranchResolutionError,
  TaskBranchResolver,
} from './task-branch-resolver';

const TASK_ID = 'task-branch-resolution';
const ENV: NodeJS.ProcessEnv = { CODEX_CRED_ENC_KEY: '0'.repeat(64) };
const TARGET: ForgeTarget = {
  kind: 'gitee',
  apiBaseUrl: 'https://gitee.com/api/v5',
  cloneUrl: 'https://gitee.com/team/private.git',
  repoId: { style: 'owner-repo', owner: 'team', repo: 'private' },
  token: 'owner-a-token',
};

interface MutableFixture {
  task: {
    id: string;
    branch: string | null;
    repo: {
      id: string;
      gitSource: string;
      defaultBranch: string | null;
    } | null;
  } | null;
  workExists: boolean;
  resolvedBranch: string | null;
  probeResult: RemoteRefsProbeResult;
  probeCalls: ForgeTarget[];
  targetCalls: string[];
  snapshotWrites: string[];
  backfills: string[];
  admissionCreates: number;
}

function fixture(overrides: Partial<MutableFixture> = {}) {
  const state: MutableFixture = {
    task: {
      id: TASK_ID,
      branch: null,
      repo: { id: 'repo-1', gitSource: TARGET.cloneUrl, defaultBranch: 'master' },
    },
    workExists: true,
    resolvedBranch: null,
    probeResult: { ok: true, defaultBranch: 'master' },
    probeCalls: [],
    targetCalls: [],
    snapshotWrites: [],
    backfills: [],
    admissionCreates: 0,
    ...overrides,
  };
  const prisma = {
    task: {
      findUnique: async () => state.task,
    },
    taskAdmissionWork: {
      findUnique: async () =>
        state.workExists ? { resolvedBranch: state.resolvedBranch } : null,
      updateMany: async (args: {
        where: { resolvedBranch: null };
        data: { resolvedBranch: string };
      }) => {
        if (!state.workExists || state.resolvedBranch !== args.where.resolvedBranch) {
          return { count: 0 };
        }
        state.resolvedBranch = args.data.resolvedBranch;
        state.snapshotWrites.push(args.data.resolvedBranch);
        return { count: 1 };
      },
      create: async () => {
        state.admissionCreates += 1;
        throw new Error('branch resolution must never create admission work');
      },
    },
    repo: {
      updateMany: async (args: {
        where: { id: string; defaultBranch: null };
        data: { defaultBranch: string };
      }) => {
        if (
          state.task?.repo?.id === args.where.id &&
          state.task.repo.defaultBranch === args.where.defaultBranch
        ) {
          state.task.repo.defaultBranch = args.data.defaultBranch;
          state.backfills.push(args.data.defaultBranch);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  } as unknown as PrismaService;
  const targetResolver = {
    getForgeTarget: async (taskId: string) => {
      state.targetCalls.push(taskId);
      return TARGET;
    },
  } as unknown as ForgeTargetResolver;
  const probe = {
    resolveDefaultBranch: async (target: ForgeTarget) => {
      state.probeCalls.push(target);
      return state.probeResult;
    },
  } as RemoteRefsProbePort;
  return {
    state,
    resolver: new TaskBranchResolver(prisma, targetResolver, probe),
  };
}

for (const prepared of [
  {
    name: 'explicit caller branch',
    callerBranch: 'release/next',
    repoDefault: 'master',
    expectedBranch: 'release/next',
    expectedSource: 'explicit-task-branch' as const,
  },
  {
    name: 'persisted repository default',
    callerBranch: null,
    repoDefault: 'master',
    expectedBranch: 'master',
    expectedSource: 'repo-default-branch' as const,
  },
]) {
  test(`prepareForCreate freezes ${prepared.name} without credential or provider work`, async () => {
    const prisma = {
      repo: {
        findUnique: async () => ({
          id: 'repo-create',
          gitSource: TARGET.cloneUrl,
          forge: 'gitee',
          gitlabProjectId: null,
          defaultBranch: prepared.repoDefault,
        }),
        updateMany: async () => assert.fail('verified branch must not backfill'),
      },
    } as unknown as PrismaService;
    const targetResolver = {
      resolveForOwner: async () =>
        assert.fail('verified branch must not resolve credentials'),
    } as unknown as ForgeTargetResolver;
    const probe = {
      resolveDefaultBranch: async () =>
        assert.fail('verified branch must not probe remote refs'),
    } as unknown as RemoteRefsProbePort;
    const resolver = new TaskBranchResolver(prisma, targetResolver, probe);

    const result = await resolver.prepareForCreate({
      repoId: 'repo-create',
      ownerUserId: 'owner-a',
      callerBranch: prepared.callerBranch,
    });

    assert.deepEqual(result, {
      repositoryUrl: TARGET.cloneUrl,
      callerBranch: prepared.callerBranch,
      resolvedBranch: prepared.expectedBranch,
      source: prepared.expectedSource,
    });
  });
}

test('prepareForCreate probes a legacy null default with only the prospective owner exact-host credential', async () => {
  const cloneUrl =
    'https://code.iflytek.com/xfyun_webdev_gitee/iflytek-zhiwen/zhiwen.git';
  const exactLookups: Array<{ userId: string; kind: string; host: string }> = [];
  const backfills: string[] = [];
  const prisma = {
    repo: {
      findUnique: async () => ({
        id: 'repo-create',
        gitSource: cloneUrl,
        forge: 'gitee',
        gitlabProjectId: null,
        defaultBranch: null,
      }),
      updateMany: async (args: {
        where: { id: string; defaultBranch: null };
        data: { defaultBranch: string };
      }) => {
        assert.deepEqual(args.where, {
          id: 'repo-create',
          defaultBranch: null,
        });
        backfills.push(args.data.defaultBranch);
        return { count: 1 };
      },
    },
    task: {
      findUnique: async () => assert.fail('preparation must not require a task row'),
    },
    auditEvent: {
      findFirst: async () => assert.fail('preparation must not infer an owner'),
    },
    forgeCredential: {
      findUnique: async (args: {
        where: {
          userId_kind_host: {
            userId: string;
            kind: string;
            host: string;
          };
        };
      }) => {
        exactLookups.push(args.where.userId_kind_host);
        return {
          tokenCiphertext: encryptToStored('owner-a-token', ENV),
        };
      },
      findFirst: async () =>
        assert.fail('exact-host credential exists; legacy lookup is forbidden'),
    },
  } as unknown as PrismaService;
  const registry = {
    detect: async () => ({
      kind: 'gitee' as const,
      apiBaseUrl: 'https://code.iflytek.com/api/v5',
      cloneUrl,
      repoId: {
        style: 'owner-repo' as const,
        owner: 'xfyun_webdev_gitee/iflytek-zhiwen',
        repo: 'zhiwen',
      },
    }),
  } as unknown as DefaultForgeRegistry;
  const targetResolver = new ForgeTargetResolver(prisma, registry);
  const probeCalls: ForgeTarget[] = [];
  const probe = {
    resolveDefaultBranch: async (target: ForgeTarget) => {
      probeCalls.push(target);
      return { ok: true as const, defaultBranch: 'develop' };
    },
  } as RemoteRefsProbePort;
  const resolver = new TaskBranchResolver(prisma, targetResolver, probe);

  const result = await resolver.prepareForCreate(
    {
      repoId: 'repo-create',
      ownerUserId: 'owner-a',
      callerBranch: null,
    },
    { env: ENV },
  );

  assert.deepEqual(result, {
    repositoryUrl: cloneUrl,
    callerBranch: null,
    resolvedBranch: 'develop',
    source: 'legacy-symbolic-head',
  });
  assert.deepEqual(exactLookups, [
    { userId: 'owner-a', kind: 'gitee', host: 'code.iflytek.com' },
  ]);
  assert.equal(probeCalls[0]?.token, 'owner-a-token');
  assert.deepEqual(backfills, ['develop']);
});

test('explicit Task.branch wins, is snapshotted, and never rewrites caller intent', async () => {
  const { resolver, state } = fixture({
    task: {
      id: TASK_ID,
      branch: 'release/next',
      repo: { id: 'repo-1', gitSource: TARGET.cloneUrl, defaultBranch: 'master' },
    },
  });

  const result = await resolver.resolve(TASK_ID);

  assert.deepEqual(result, {
    taskId: TASK_ID,
    repositoryUrl: 'https://gitee.com/team/private.git',
    callerBranch: 'release/next',
    resolvedBranch: 'release/next',
    source: 'explicit-task-branch',
    snapshotted: true,
  });
  assert.equal(state.task?.branch, 'release/next');
  assert.deepEqual(state.snapshotWrites, ['release/next']);
  assert.deepEqual(state.targetCalls, []);
  assert.deepEqual(state.probeCalls, []);
});

test('nullable task intent resolves persisted master without probing or rewriting Task.branch', async () => {
  const { resolver, state } = fixture();

  const result = await resolver.resolve(TASK_ID);

  assert.equal(result.callerBranch, null);
  assert.equal(result.resolvedBranch, 'master');
  assert.equal(result.source, 'repo-default-branch');
  assert.equal(result.snapshotted, true);
  assert.equal(state.task?.branch, null);
  assert.deepEqual(state.targetCalls, []);
});

test('recovery reuses the immutable snapshot instead of a changed repo default', async () => {
  const { resolver, state } = fixture({
    resolvedBranch: 'master',
    task: {
      id: TASK_ID,
      branch: null,
      repo: { id: 'repo-1', gitSource: TARGET.cloneUrl, defaultBranch: 'trunk' },
    },
  });

  const result = await resolver.resolve(TASK_ID);

  assert.equal(result.resolvedBranch, 'master');
  assert.equal(result.source, 'snapshot');
  assert.equal(result.snapshotted, true);
  assert.deepEqual(state.snapshotWrites, []);
  assert.deepEqual(state.targetCalls, []);
});

test('a snapshot that conflicts with explicit caller intent fails closed', async () => {
  const { resolver, state } = fixture({
    resolvedBranch: 'master',
    task: {
      id: TASK_ID,
      branch: 'release/next',
      repo: {
        id: 'repo-1',
        gitSource: TARGET.cloneUrl,
        defaultBranch: 'master',
      },
    },
  });

  await assert.rejects(
    () => resolver.resolve(TASK_ID),
    (error: unknown) => {
      assert.ok(error instanceof TaskBranchResolutionError);
      assert.equal(error.reason, 'snapshot_conflict');
      assert.equal(error.failureCode, 'provisioning_ref_not_found');
      return true;
    },
  );
  assert.deepEqual(state.snapshotWrites, []);
  assert.deepEqual(state.targetCalls, []);
});

test('legacy null repo probes with the owner target, snapshots master, then safely backfills', async () => {
  const { resolver, state } = fixture({
    task: {
      id: TASK_ID,
      branch: null,
      repo: { id: 'repo-1', gitSource: TARGET.cloneUrl, defaultBranch: null },
    },
  });

  const result = await resolver.resolve(TASK_ID);

  assert.equal(result.resolvedBranch, 'master');
  assert.equal(result.source, 'legacy-symbolic-head');
  assert.deepEqual(state.targetCalls, [TASK_ID]);
  assert.deepEqual(state.probeCalls, [TARGET]);
  assert.deepEqual(state.snapshotWrites, ['master']);
  assert.deepEqual(state.backfills, ['master']);
  assert.equal(state.task?.branch, null);
});

test('legacy null-default task without an admission row probes safely but never creates a claimable outbox', async () => {
  const { resolver, state } = fixture({
    workExists: false,
    task: {
      id: TASK_ID,
      branch: null,
      repo: { id: 'repo-1', gitSource: TARGET.cloneUrl, defaultBranch: null },
    },
  });

  const result = await resolver.resolve(TASK_ID);

  assert.equal(result.resolvedBranch, 'master');
  assert.equal(result.source, 'legacy-symbolic-head');
  assert.equal(result.snapshotted, false);
  assert.deepEqual(state.targetCalls, [TASK_ID]);
  assert.deepEqual(state.probeCalls, [TARGET]);
  assert.deepEqual(state.backfills, ['master']);
  assert.deepEqual(state.snapshotWrites, []);
  assert.equal(state.admissionCreates, 0);
});

for (const invalid of [
  {
    name: 'explicit task branch',
    branch: ' master ',
    repoDefault: 'master',
    reason: 'explicit_branch_invalid' as const,
  },
  {
    name: 'persisted repo default',
    branch: null,
    repoDefault: '-legacy-invalid',
    reason: 'repo_default_branch_invalid' as const,
  },
]) {
  test(`invalid legacy ${invalid.name} fails closed without probing`, async () => {
    const { resolver, state } = fixture({
      task: {
        id: TASK_ID,
        branch: invalid.branch,
        repo: {
          id: 'repo-1',
          gitSource: TARGET.cloneUrl,
          defaultBranch: invalid.repoDefault,
        },
      },
    });

    await assert.rejects(
      () => resolver.resolve(TASK_ID),
      (error: unknown) => {
        assert.ok(error instanceof TaskBranchResolutionError);
        assert.equal(error.reason, invalid.reason);
        assert.equal(error.failureCode, 'provisioning_ref_not_found');
        return true;
      },
    );
    assert.deepEqual(state.snapshotWrites, []);
    assert.deepEqual(state.targetCalls, []);
    assert.deepEqual(state.probeCalls, []);
  });
}

test('an unresolved symbolic HEAD is a typed ref failure with no snapshot or backfill', async () => {
  const { resolver, state } = fixture({
    task: {
      id: TASK_ID,
      branch: null,
      repo: { id: 'repo-1', gitSource: TARGET.cloneUrl, defaultBranch: null },
    },
    probeResult: { ok: false, reason: 'default_branch_unresolved' },
  });

  await assert.rejects(
    () => resolver.resolve(TASK_ID),
    (error: unknown) => {
      assert.ok(error instanceof TaskBranchResolutionError);
      assert.equal(error.reason, 'branch_not_found');
      assert.equal(error.failureCode, 'provisioning_ref_not_found');
      return true;
    },
  );
  assert.deepEqual(state.snapshotWrites, []);
  assert.deepEqual(state.backfills, []);
});

for (const remoteFailure of [
  {
    reason: 'authentication_failed' as const,
    failureCode: 'provisioning_forge_auth_failed' as const,
  },
  {
    reason: 'access_denied' as const,
    failureCode: 'provisioning_forge_auth_failed' as const,
  },
  {
    reason: 'network_unavailable' as const,
    failureCode: 'provisioning_tls_network_failed' as const,
  },
]) {
  test(`legacy probe ${remoteFailure.reason} preserves its typed safe classification`, async () => {
    const { resolver, state } = fixture({
      task: {
        id: TASK_ID,
        branch: null,
        repo: { id: 'repo-1', gitSource: TARGET.cloneUrl, defaultBranch: null },
      },
      probeResult: { ok: false, reason: remoteFailure.reason },
    });

    await assert.rejects(
      () => resolver.resolve(TASK_ID),
      (error: unknown) => {
        assert.ok(error instanceof TaskBranchResolutionError);
        assert.equal(error.reason, remoteFailure.reason);
        assert.equal(error.failureCode, remoteFailure.failureCode);
        return true;
      },
    );
    assert.deepEqual(state.snapshotWrites, []);
    assert.deepEqual(state.backfills, []);
  });
}

test('concurrent legacy probes converge on the one immutable snapshot without fixed sleeps', async () => {
  let releaseBoth!: () => void;
  const bothEntered = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  let updateCalls = 0;
  let snapshot: string | null = null;
  const probeBranches = ['master', 'trunk'];
  const prisma = {
    task: {
      findUnique: async () => ({
        id: TASK_ID,
        branch: null,
        repo: {
          id: 'repo-race',
          gitSource: TARGET.cloneUrl,
          defaultBranch: null,
        },
      }),
    },
    taskAdmissionWork: {
      findUnique: async () => ({ resolvedBranch: snapshot }),
      updateMany: async (args: { data: { resolvedBranch: string } }) => {
        updateCalls += 1;
        if (updateCalls === 2) releaseBoth();
        await bothEntered;
        if (snapshot !== null) return { count: 0 };
        snapshot = args.data.resolvedBranch;
        return { count: 1 };
      },
    },
    repo: {
      updateMany: async () => ({ count: 1 }),
    },
  } as unknown as PrismaService;
  const targetResolver = {
    getForgeTarget: async () => TARGET,
  } as unknown as ForgeTargetResolver;
  const probe = {
    resolveDefaultBranch: async () => ({
      ok: true as const,
      defaultBranch: probeBranches.shift() ?? 'unexpected',
    }),
  } as RemoteRefsProbePort;
  const resolver = new TaskBranchResolver(prisma, targetResolver, probe);

  const [first, second] = await Promise.all([
    resolver.resolve(TASK_ID),
    resolver.resolve(TASK_ID),
  ]);

  assert.equal(updateCalls, 2);
  assert.equal(first.resolvedBranch, second.resolvedBranch);
  assert.equal(first.resolvedBranch, snapshot);
  assert.equal(first.snapshotted, true);
  assert.equal(second.snapshotted, true);
});

const OWNER_ISOLATION_CASES: Array<{
  readonly kind: 'github' | 'gitlab' | 'gitee';
  readonly location: ForgeLocation;
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

for (const ownerCase of OWNER_ISOLATION_CASES) {
  test(`legacy private ${ownerCase.kind} HEAD probe uses only the task owner's exact-host credential`, async () => {
    const exactLookups: Array<{ userId: string; kind: string; host: string }> = [];
    const queriedTokens: string[] = [];
    const credentials = new Map([
      [
        'owner-a',
        {
          tokenCiphertext: encryptToStored(
            `${ownerCase.kind}-owner-a-token`,
            ENV,
          ),
        },
      ],
      [
        'owner-b',
        {
          tokenCiphertext: encryptToStored(
            `${ownerCase.kind}-owner-b-token`,
            ENV,
          ),
        },
      ],
    ]);
    let snapshot: string | null = null;
    let repoDefault: string | null = null;
    const prisma = {
      task: {
        findUnique: async () => ({
          id: TASK_ID,
          ownerUserId: 'owner-a',
          branch: null,
          repo: {
            id: 'repo-owner-isolation',
            gitSource: ownerCase.location.cloneUrl,
            forge: ownerCase.kind,
            gitlabProjectId:
              ownerCase.kind === 'gitlab' ? 'team/private' : null,
            defaultBranch: repoDefault,
          },
        }),
      },
      auditEvent: {
        findFirst: async () => {
          assert.fail('the durable task owner must take precedence');
        },
      },
      forgeCredential: {
        findUnique: async (args: {
          where: {
            userId_kind_host: {
              userId: string;
              kind: string;
              host: string;
            };
          };
        }) => {
          const key = args.where.userId_kind_host;
          exactLookups.push(key);
          return credentials.get(key.userId) ?? null;
        },
        findFirst: async (args: { where: { userId: string } }) => {
          assert.equal(args.where.userId, 'owner-a');
          return null;
        },
      },
      taskAdmissionWork: {
        findUnique: async () => ({ resolvedBranch: snapshot }),
        updateMany: async (args: { data: { resolvedBranch: string } }) => {
          if (snapshot !== null) return { count: 0 };
          snapshot = args.data.resolvedBranch;
          return { count: 1 };
        },
      },
      repo: {
        updateMany: async (args: { data: { defaultBranch: string } }) => {
          if (repoDefault !== null) return { count: 0 };
          repoDefault = args.data.defaultBranch;
          return { count: 1 };
        },
      },
    } as unknown as PrismaService;
    const registry = {
      detect: async () => ownerCase.location,
    } as unknown as DefaultForgeRegistry;
    const targetResolver = new ForgeTargetResolver(prisma, registry);
    const probe = {
      resolveDefaultBranch: async (target: ForgeTarget) => {
        queriedTokens.push(target.token);
        return { ok: true as const, defaultBranch: 'master' };
      },
    } as RemoteRefsProbePort;
    const resolver = new TaskBranchResolver(prisma, targetResolver, probe);

    const result = await resolver.resolve(TASK_ID, { env: ENV });

    assert.equal(result.resolvedBranch, 'master');
    assert.deepEqual(queriedTokens, [`${ownerCase.kind}-owner-a-token`]);
    assert.deepEqual(exactLookups, [
      {
        userId: 'owner-a',
        kind: ownerCase.kind,
        host: new URL(ownerCase.location.cloneUrl).host,
      },
    ]);
    assert.ok(exactLookups.every((lookup) => lookup.userId !== 'owner-b'));

    // Removing A while B remains must fail closed, never borrow B's token.
    credentials.delete('owner-a');
    snapshot = null;
    repoDefault = null;
    await assert.rejects(
      () => resolver.resolve(TASK_ID, { env: ENV }),
      (error: unknown) => {
        assert.ok(error instanceof TaskBranchResolutionError);
        assert.equal(error.reason, 'owner_credential_unavailable');
        assert.equal(error.failureCode, 'provisioning_forge_auth_failed');
        return true;
      },
    );
    assert.deepEqual(queriedTokens, [`${ownerCase.kind}-owner-a-token`]);
    assert.ok(exactLookups.every((lookup) => lookup.userId === 'owner-a'));
  });
}
