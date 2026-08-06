/**
 * Minimal test for the requirement:
 *   "Delivery is opt-in and defaults to no-op"
 *   (add-multi-forge-task-delivery, tasks.md 8.2)
 *
 * Exercises the TasksService.create path directly with a fake Prisma,
 * covering:
 *   1. Omitted `deliver` → stored as null → echoes back as `'none'` (the
 *      default no-op; byte-identical to a task with no delivery configured).
 *   2. Explicit `deliver: 'none'` → echoes back as `'none'`.
 *   3. Explicit `deliver: 'branch'` → echoes back as `'branch'` (opt-in works).
 *   4. Explicit `deliver: 'pr'` → echoes back as `'pr'` (opt-in works).
 *
 * Run from apps/api with `pnpm test` (nest build → node --test dist/**\/\*.spec.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TasksService } from './tasks.service';
import { PrismaService } from '@/prisma/prisma.service';
import type { Deliver } from '@cap-console/contracts';
import type { SandboxEnvironmentsService } from '@/sandbox-environments/sandbox-environments.service';
import type { TaskBranchResolver } from '@/forge/task-branch-resolver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = '00000000-0000-4000-a000-000000000011';
const TASK_ID = '00000000-0000-4000-a000-000000000012';

/**
 * Minimal fake Prisma.  The `task.create` handler echoes back `deliver`
 * exactly as the service stores it (null when omitted), mirroring the real
 * Prisma behaviour so `toResponse` is exercised faithfully.
 */
function makeFakePrisma(): PrismaService {
  const repoRow = {
    id: REPO_ID,
    name: 'Deliver Test Repo',
    gitSource: 'https://github.com/test/deliver-repo',
    createdAt: new Date(),
    description: null,
    defaultBranch: null,
    branchCount: null,
    updatedAt: null,
    githubId: null,
    isDefault: false,
    forge: null,
    gitlabProjectId: null,
  };

  const client = {
    repo: {
      findUnique: async () => repoRow,
    },
    accountSettings: {
      findUnique: async () => null,
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: TASK_ID,
        repoId: REPO_ID,
        prompt: String(data.prompt ?? ''),
        status: 'pending',
        createdAt: new Date(),
        branch: data.branch ?? null,
        strategy: data.strategy ?? null,
        skills: (data.skills as string[] | undefined) ?? [],
        idleTimeoutMs: data.idleTimeoutMs ?? null,
        deadlineMs: data.deadlineMs ?? null,
        runtime: data.runtime ?? null,
        // The real Prisma stores null when deliver is omitted/coalesced to null.
        deliver: data.deliver ?? null,
        deliverStatus: null,
        branchPushed: null,
        commitSha: null,
        changeRequestUrl: null,
        changeRequestNumber: null,
      }),
      findMany: async () => [],
      findUnique: async () => ({ ownerUserId: null }),
    },
    // Acceptance commits the Task, its unique admission work item, and the
    // creation audit in one transaction — there is one admission path left, so
    // even a fixture that only cares about `deliver` goes through it.
    taskAdmissionWork: {
      create: async ({ data }: { data: { taskId: string } }) => ({
        ...data,
        state: 'accepted',
        stage: 'accepted',
        attempt: 0,
        updatedAt: new Date(),
      }),
      findUnique: async ({ where }: { where: { taskId: string } }) => ({
        taskId: where.taskId,
      }),
    },
    auditEvent: {
      upsert: async () => ({}),
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(client),
  };
  return client as unknown as PrismaService;
}

/** Build TasksService with no guardrails / audit / sandbox — the delivery
 *  selector is purely a store-and-echo field at creation time. The environment
 *  and branch resolvers are not optional any more: durable admission is the
 *  only path a create can take, so every acceptance resolves a provisioning
 *  policy and a branch before it writes. */
function buildService(): TasksService {
  const sandboxEnvironments = {
    async resolveTaskAdmission() {
      return {
        environment: null,
        providerId: 'aio-local',
        providerFamily: 'aio',
        provisioningPolicy: {
          resources: {},
          workspaceMaterializationDeadlineMs: 900_000,
        },
      };
    },
  } as unknown as SandboxEnvironmentsService;
  const taskBranchResolver = {
    async prepareForCreate() {
      return { resolvedBranch: 'main' };
    },
  } as unknown as TaskBranchResolver;
  // Constructor signature (positional DI):
  //   (prisma, guardrails?, audit?, sandbox?, runtimes?, claudeReadiness?,
  //    sandboxOwners?, sandboxEnvironments?, runtimeModelPreflight?,
  //    taskModelCapability?, taskAdmissionGate?, taskBranchResolver?)
  return new TasksService(
    makeFakePrisma(),
    undefined, // guardrails
    undefined, // audit
    undefined, // sandbox
    undefined, // runtimes
    undefined, // claudeReadiness
    undefined, // sandboxOwners
    sandboxEnvironments,
    undefined, // runtimeModelPreflight
    undefined, // taskModelCapability
    undefined, // taskAdmissionGate
    taskBranchResolver,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('deliver omitted → response.deliver equals "none" (default no-op)', async () => {
  const svc = buildService();
  const result = await svc.create(REPO_ID, { prompt: 'hello' });
  assert.equal(
    result.deliver,
    'none' satisfies Deliver,
    'omitted deliver must echo back as the default "none"',
  );
});

test('deliver:"none" explicit → response.deliver equals "none"', async () => {
  const svc = buildService();
  const result = await svc.create(REPO_ID, { prompt: 'hello', deliver: 'none' });
  assert.equal(result.deliver, 'none' satisfies Deliver);
});

test('deliver:"branch" explicit → response.deliver equals "branch" (opt-in)', async () => {
  const svc = buildService();
  const result = await svc.create(REPO_ID, { prompt: 'hello', deliver: 'branch' });
  assert.equal(result.deliver, 'branch' satisfies Deliver);
});

test('deliver:"pr" explicit → response.deliver equals "pr" (opt-in)', async () => {
  const svc = buildService();
  const result = await svc.create(REPO_ID, { prompt: 'hello', deliver: 'pr' });
  assert.equal(result.deliver, 'pr' satisfies Deliver);
});
