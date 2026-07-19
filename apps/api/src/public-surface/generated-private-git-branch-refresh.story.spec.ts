import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { createGeneratedPrivateGitFixture } from '@cap/sandbox/testing';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import type { ForgeTarget } from '../forge/forge.port';
import type { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { GiteeForge } from '../forge/gitee-forge';
import { GithubForge } from '../forge/github-forge';
import { GitlabForge } from '../forge/gitlab-forge';
import { NodeRemoteRefsCommandRunner } from '../forge/remote-refs-command-runner';
import { GitRemoteRefsProbe } from '../forge/remote-refs-probe';
import { NodeRemoteRefsSecretStore } from '../forge/remote-refs-secret-store';
import { TaskBranchResolver } from '../forge/task-branch-resolver';
import {
  GuardrailsService,
  type GuardrailsConfig,
} from '../guardrails/guardrails.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ReposService } from '../repos/repos.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';
const OLD_TASK_ID = '33333333-3333-4333-8333-333333333333';
const NEW_TASK_ID = '44444444-4444-4444-8444-444444444444';
const INITIAL_NONSTANDARD_BRANCH = 'release/current';
const MOVED_NONSTANDARD_BRANCH = 'trunk';
const CREATED_AT = new Date('2026-07-16T00:00:00.000Z');

interface RepoRow extends Record<string, unknown> {
  readonly id: string;
  name: string;
  gitSource: string;
  forge: string | null;
  defaultBranch: string | null;
  description: string | null;
  githubId: string | null;
  gitlabProjectId: string | null;
  readonly createdAt: Date;
  updatedAt: Date | null;
  branchCount: number | null;
  isDefault: boolean;
}

interface TaskRow extends Record<string, unknown> {
  readonly id: string;
  readonly repoId: string;
  status: string;
  deliver: string;
  branch: string | null;
}

interface AdmissionRow extends Record<string, unknown> {
  readonly taskId: string;
  resolvedBranch: string | null;
}

class BranchRefreshStoryDatabase {
  readonly repos: RepoRow[] = [];
  readonly tasks = new Map<string, TaskRow>();
  readonly admissions = new Map<string, AdmissionRow>();
  readonly taskWrites: Array<{
    readonly taskId: string;
    readonly data: Record<string, unknown>;
  }> = [];
  readonly prisma: PrismaService;

  constructor() {
    const repo = {
      findFirst: async ({ where }: { where?: Record<string, unknown> }) =>
        this.repos.find((row) => matchesWhere(row, where ?? {})) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        this.repos.find((row) => row.id === where.id) ?? null,
      findMany: async () => [...this.repos],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: RepoRow = {
          id: REPO_ID,
          name: String(data.name),
          gitSource: String(data.gitSource),
          forge: typeof data.forge === 'string' ? data.forge : null,
          defaultBranch:
            typeof data.defaultBranch === 'string' ? data.defaultBranch : null,
          description:
            typeof data.description === 'string' ? data.description : null,
          githubId: typeof data.githubId === 'string' ? data.githubId : null,
          gitlabProjectId:
            typeof data.gitlabProjectId === 'string'
              ? data.gitlabProjectId
              : null,
          createdAt: CREATED_AT,
          updatedAt: null,
          branchCount: null,
          isDefault: false,
        };
        this.repos.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = this.repos.find((entry) => entry.id === where.id);
        assert.ok(row, `missing repo ${where.id}`);
        Object.assign(row, data, { updatedAt: CREATED_AT });
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where?: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of this.repos) {
          if (!matchesWhere(row, where ?? {})) continue;
          Object.assign(row, data, { updatedAt: CREATED_AT });
          count += 1;
        }
        return { count };
      },
    };
    const task = {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = this.tasks.get(where.id);
        if (!row) return null;
        return {
          ...row,
          repo: this.repos.find((repoRow) => repoRow.id === row.repoId) ?? null,
        };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = this.tasks.get(where.id);
        assert.ok(row, `missing task ${where.id}`);
        Object.assign(row, data);
        this.taskWrites.push({ taskId: where.id, data: { ...data } });
        return row;
      },
    };
    const taskAdmissionWork = {
      findUnique: async ({ where }: { where: { taskId: string } }) =>
        this.admissions.get(where.taskId) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { taskId: string; resolvedBranch: string | null };
        data: { resolvedBranch: string };
      }) => {
        const row = this.admissions.get(where.taskId);
        if (!row || row.resolvedBranch !== where.resolvedBranch) {
          return { count: 0 };
        }
        row.resolvedBranch = data.resolvedBranch;
        return { count: 1 };
      },
    };
    const transactionClient = {
      repo,
      async $executeRaw(_query: unknown): Promise<number> {
        return 1;
      },
    };
    this.prisma = {
      repo,
      task,
      taskAdmissionWork,
      async $transaction<T>(
        operation: (client: typeof transactionClient) => Promise<T>,
      ): Promise<T> {
        return operation(transactionClient);
      },
    } as unknown as PrismaService;
  }

  addTask(id: string): void {
    this.tasks.set(id, {
      id,
      repoId: REPO_ID,
      status: 'completed',
      deliver: id === OLD_TASK_ID ? 'pr' : 'none',
      branch: null,
    });
    this.admissions.set(id, { taskId: id, resolvedBranch: null });
  }
}

function matchesWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([field, expected]) => row[field] === expected);
}

test(
  'generated private Git symbolic HEAD refresh preserves accepted task snapshots and PR bases',
  { timeout: 60_000 },
  async (t) => {
    const fixture = await createGeneratedPrivateGitFixture({
      largeBlobBytes: 2 * 1024 * 1024,
      basicAuthUsername: 'x-access-token',
    });
    t.after(async () => {
      fixture.transferBarrier.release();
      await fixture.dispose();
      const diagnostics = fixture.diagnostics();
      assert.equal(diagnostics.disposed, true);
      assert.equal(diagnostics.activeRequests, 0);
      assert.equal(diagnostics.activeBackendProcesses, 0);
    });

    await fixture.moveSymbolicHead(INITIAL_NONSTANDARD_BRANCH);
    const database = new BranchRefreshStoryDatabase();
    const registry = new DefaultForgeRegistry(
      database.prisma,
      new GithubForge(),
      new GiteeForge(),
      new GitlabForge(),
    );
    let credentialIsValid = true;
    const target = (): ForgeTarget => ({
      kind: 'gitee',
      apiBaseUrl: `${new URL(fixture.rootUrl).origin}/api/v5`,
      cloneUrl: fixture.rootUrl,
      repoId: { style: 'owner-repo', owner: 'fixture', repo: 'root' },
      token: credentialIsValid
        ? fixture.basicAuth.password
        : `invalid-${fixture.basicAuth.password}`,
    });
    const forgeTargets = {
      async resolveForOwner(ownerUserId: string) {
        assert.equal(ownerUserId, OWNER_ID);
        return { ok: true as const, target: target() };
      },
      async getForgeTarget(taskId: string) {
        assert.equal(database.tasks.has(taskId), true);
        return target();
      },
    } as unknown as ForgeTargetResolver;
    const remoteRefs = new GitRemoteRefsProbe(
      registry,
      new NodeRemoteRefsCommandRunner(),
      new NodeRemoteRefsSecretStore(),
    );
    const repos = new ReposService(
      database.prisma,
      forgeTargets,
      remoteRefs,
      registry,
    );
    const branchResolver = new TaskBranchResolver(
      database.prisma,
      forgeTargets,
      remoteRefs,
    );

    const imported = await repos.create(OWNER_ID, {
      name: 'Generated movable private repository',
      gitSource: fixture.rootUrl,
      forge: 'gitee',
      importSource: 'url',
    });
    assert.equal(imported.id, REPO_ID);
    assert.equal(imported.defaultBranch, INITIAL_NONSTANDARD_BRANCH);
    assert.equal(database.repos.length, 1);

    database.addTask(OLD_TASK_ID);
    const accepted = await branchResolver.resolve(OLD_TASK_ID);
    assert.equal(accepted.source, 'repo-default-branch');
    assert.equal(accepted.resolvedBranch, INITIAL_NONSTANDARD_BRANCH);
    assert.equal(accepted.snapshotted, true);

    await fixture.moveSymbolicHead(MOVED_NONSTANDARD_BRANCH);
    credentialIsValid = false;
    await assert.rejects(
      repos.refreshDefaultBranch(OWNER_ID, REPO_ID),
      (error: unknown) => {
        assert.ok(error instanceof HttpException);
        assert.equal(error.getStatus(), 403);
        return true;
      },
    );
    const afterFailedRefresh = await repos.findById(REPO_ID);
    assert.equal(afterFailedRefresh.defaultBranch, INITIAL_NONSTANDARD_BRANCH);
    assert.equal(afterFailedRefresh.id, REPO_ID);
    assert.equal(database.repos.length, 1);

    credentialIsValid = true;
    const refreshed = await repos.refreshDefaultBranch(OWNER_ID, REPO_ID);
    assert.equal(refreshed.id, imported.id);
    assert.equal(refreshed.defaultBranch, MOVED_NONSTANDARD_BRANCH);
    assert.equal(database.repos.length, 1);

    const recovered = await branchResolver.resolve(OLD_TASK_ID);
    assert.equal(recovered.source, 'snapshot');
    assert.equal(recovered.resolvedBranch, INITIAL_NONSTANDARD_BRANCH);

    database.addTask(NEW_TASK_ID);
    const subsequent = await branchResolver.resolve(NEW_TASK_ID);
    assert.equal(subsequent.resolvedBranch, MOVED_NONSTANDARD_BRANCH);
    assert.equal(subsequent.source, 'repo-default-branch');

    let openedBaseBranch: string | null = null;
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['workspace.git.deliver'],
      async deliverWorkspaceChanges() {
        return { hadChanges: true, commitSha: fixture.headCommitSha, error: null };
      },
    } as unknown as SandboxProvider;
    const guardrailsConfig: GuardrailsConfig = {
      maxConcurrentTasks: 1,
      defaultIdleTimeoutMs: null,
      circuitBreakerThreshold: 3,
    };
    const guardrails = new GuardrailsService(
      {} as ModuleRef,
      { destroyForSession() {} } as unknown as SessionCredentialsService,
      sandbox,
      guardrailsConfig,
      undefined,
      undefined,
      database.prisma,
    );
    Object.assign(guardrails, {
      forgeResolver: {
        async getForgeTarget(taskId: string) {
          assert.equal(taskId, OLD_TASK_ID);
          return target();
        },
      },
      forgeRegistry: {
        forKind() {
          return {
            kind: 'gitee',
            cloneAuthHeader: () => fixture.basicAuth.authorizationHeader,
            findExistingChangeRequest: async () => null,
            openChangeRequest: async (
              _forgeTarget: ForgeTarget,
              args: { readonly headBranch: string; readonly baseBranch: string },
            ) => {
              openedBaseBranch = args.baseBranch;
              return {
                number: 7,
                url: 'https://forge.invalid/fixture/root/pulls/7',
                state: 'open' as const,
                headBranch: args.headBranch,
              };
            },
          };
        },
      },
      branchResolver,
    });
    await (
      guardrails as unknown as {
        deliverResult(taskId: string): Promise<void>;
      }
    ).deliverResult(OLD_TASK_ID);

    assert.equal(openedBaseBranch, INITIAL_NONSTANDARD_BRANCH);
    assert.equal(
      database.taskWrites.at(-1)?.data.deliverStatus,
      'pr_opened',
    );
    assert.equal(
      database.admissions.get(OLD_TASK_ID)?.resolvedBranch,
      INITIAL_NONSTANDARD_BRANCH,
    );
    assert.equal(
      database.admissions.get(NEW_TASK_ID)?.resolvedBranch,
      MOVED_NONSTANDARD_BRANCH,
    );
    assert.ok(
      fixture
        .authorizationEvidence()
        .some((entry) => entry.repository === 'root-private' && entry.authorized),
      'the story must cross the real authenticated Smart HTTP remote',
    );
  },
);
