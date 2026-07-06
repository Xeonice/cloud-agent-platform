/**
 * Minimal test for the requirement:
 *   "Create-task API accepts and echoes runtime, and dispatches to it"
 *   (add-claude-code-runtime, tasks-api 4.1 / 4.2)
 *
 * Exercises the TasksService.create path directly with a fake Prisma + fake
 * AgentRuntimeRegistry + fake ClaudeReadiness, covering:
 *   1. runtime='claude-code' is echoed back in the 201 response
 *   2. omitted runtime echoes back as the default 'codex'
 *   3. registry.resolve() is called with the correct runtime value
 *   4. a claude-code create with unconfigured Claude readiness throws 503
 *
 * Run from apps/api with `pnpm test` (nest build → node --test dist/**\/*.spec.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';

import {
  TasksService,
  RuntimeNotConfiguredException,
  type IAgentRuntimeRegistry,
  type IRuntimeReadiness,
} from './tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Runtime } from '@cap/contracts';
import type { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = '00000000-0000-4000-a000-000000000001';
const TASK_ID = '00000000-0000-4000-a000-000000000002';

/** Minimal fake Prisma that returns a canned repo + task row. */
function makeFakePrisma(runtimeOverride?: string | null): PrismaService {
  const repoRow = {
    id: REPO_ID,
    name: 'Test Repo',
    gitSource: 'https://github.com/test/repo',
    createdAt: new Date(),
    description: null,
    defaultBranch: null,
    branchCount: null,
    updatedAt: null,
    githubId: null,
    isDefault: false,
  };

  function makeTaskRow(body: {
    prompt: string;
    runtime?: Runtime | null;
    branch?: string | null;
    strategy?: string | null;
    skills?: string[];
    idleTimeoutMs?: number | null;
    deadlineMs?: number | null;
  }) {
    return {
      id: TASK_ID,
      repoId: REPO_ID,
      prompt: body.prompt,
      status: 'pending',
      createdAt: new Date(),
      branch: body.branch ?? null,
      strategy: body.strategy ?? null,
      skills: body.skills ?? [],
      idleTimeoutMs: body.idleTimeoutMs ?? null,
      deadlineMs: body.deadlineMs ?? null,
      runtime: runtimeOverride !== undefined ? runtimeOverride : (body.runtime ?? null),
    };
  }

  return {
    repo: {
      findUnique: async () => repoRow,
    },
    task: {
      create: async ({ data }: { data: Parameters<typeof makeTaskRow>[0] }) =>
        makeTaskRow(data),
      findMany: async () => [],
      findUnique: async () => null,
    },
  } as unknown as PrismaService;
}

/** A fake registry that records every resolve() call. */
function makeFakeRegistry(): { registry: IAgentRuntimeRegistry; calls: Runtime[] } {
  const calls: Runtime[] = [];
  const registry: IAgentRuntimeRegistry = {
    resolve(runtime) {
      const id: Runtime = runtime ?? 'codex';
      calls.push(id);
      return {
        id,
        executionModes: new Set(['interactive-pty', 'headless-exec'] as const),
      };
    },
  };
  return { registry, calls };
}

/** A fake readiness source that returns a configurable boolean. */
function makeFakeReadiness(configured: boolean): IRuntimeReadiness {
  return {
    async configured() {
      return configured;
    },
  };
}

/** Build a TasksService with the given optional collaborators (no guardrails, no audit, no sandbox). */
function buildService(opts: {
  prisma: PrismaService;
  registry?: IAgentRuntimeRegistry;
  claudeReadiness?: IRuntimeReadiness;
  sandboxEnvironments?: SandboxEnvironmentsService;
}): TasksService {
  // TasksService constructor signature (positional DI):
  //   (prisma, guardrails?, audit?, sandbox?, runtimes?, claudeReadiness?, sandboxOwners?, sandboxEnvironments?)
  return new TasksService(
    opts.prisma,
    undefined,       // guardrails (optional)
    undefined,       // audit (optional)
    undefined,       // sandbox (optional)
    opts.registry,
    opts.claudeReadiness,
    undefined,       // sandboxOwners (optional)
    opts.sandboxEnvironments,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('create with runtime=claude-code echoes claude-code in the response', async () => {
  const { registry } = makeFakeRegistry();
  const svc = buildService({
    prisma: makeFakePrisma('claude-code'),
    registry,
    claudeReadiness: makeFakeReadiness(true),
  });

  const result = await svc.create(REPO_ID, {
    prompt: 'hello',
    runtime: 'claude-code',
  });

  assert.equal(result.runtime, 'claude-code', 'response.runtime must echo back claude-code');
});

test('create with omitted runtime echoes codex (the default)', async () => {
  const { registry } = makeFakeRegistry();
  const svc = buildService({
    prisma: makeFakePrisma(null),
    registry,
  });

  const result = await svc.create(REPO_ID, { prompt: 'hello' });

  assert.equal(result.runtime, 'codex', 'omitted runtime must echo back as the default codex');
});

test('create calls registry.resolve() with the runtime value from the body', async () => {
  const { registry, calls } = makeFakeRegistry();
  const svc = buildService({
    prisma: makeFakePrisma('claude-code'),
    registry,
    claudeReadiness: makeFakeReadiness(true),
  });

  await svc.create(REPO_ID, { prompt: 'hello', runtime: 'claude-code' });

  assert.ok(calls.length >= 1, 'registry.resolve must be called at least once');
  assert.equal(calls[0], 'claude-code', 'resolve must receive the requested runtime');
});

test('create dispatches omitted runtime to registry as codex', async () => {
  const { registry, calls } = makeFakeRegistry();
  const svc = buildService({
    prisma: makeFakePrisma(null),
    registry,
  });

  await svc.create(REPO_ID, { prompt: 'hello' });

  // The service internally coalesces undefined → 'codex' before calling resolve.
  assert.ok(calls.length >= 1, 'registry.resolve must be called');
  assert.equal(calls[0], 'codex', 'absent runtime dispatches to codex');
});

test('create with claude-code and unconfigured readiness throws RuntimeNotConfiguredException (503)', async () => {
  const { registry } = makeFakeRegistry();
  const svc = buildService({
    prisma: makeFakePrisma('claude-code'),
    registry,
    claudeReadiness: makeFakeReadiness(false), // NOT configured
  });

  await assert.rejects(
    () => svc.create(REPO_ID, { prompt: 'hello', runtime: 'claude-code' }),
    (err: unknown) => {
      assert.ok(
        err instanceof RuntimeNotConfiguredException,
        `expected RuntimeNotConfiguredException, got ${String(err)}`,
      );
      assert.equal(
        (err as RuntimeNotConfiguredException).runtime,
        'claude-code',
        'exception carries the runtime that was rejected',
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// add-headless-execution-track — execution-mode routing + fail-closed guard
// ---------------------------------------------------------------------------

/** A fake Prisma whose `task.create` CAPTURES the persisted `data` for assertion. */
function makeCapturingPrisma(options: {
  defaultSandboxEnvironmentId?: string | null;
} = {}): {
  prisma: PrismaService;
  box: { value: Record<string, unknown> | null };
} {
  const box: { value: Record<string, unknown> | null } = { value: null };
  const prisma = {
    repo: { findUnique: async () => ({ id: REPO_ID }) },
    accountSettings: {
      findUnique: async () => ({
        defaultSandboxEnvironmentId: options.defaultSandboxEnvironmentId ?? null,
      }),
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        box.value = data;
        return {
          id: TASK_ID,
          repoId: REPO_ID,
          prompt: data.prompt,
          status: 'pending',
          createdAt: new Date(),
          branch: null,
          strategy: null,
          skills: [],
          idleTimeoutMs: null,
          deadlineMs: null,
          runtime: data.runtime ?? null,
          sandboxEnvironmentId: data.sandboxEnvironmentId ?? null,
        };
      },
    },
  } as unknown as PrismaService;
  return { prisma, box };
}

/** A registry whose runtimes do NOT support headless-exec. */
function makeNoHeadlessRegistry(): IAgentRuntimeRegistry {
  return {
    resolve(runtime) {
      return {
        id: runtime ?? 'codex',
        executionModes: new Set(['interactive-pty'] as const),
      };
    },
  };
}

test('programmatic create persists executionMode=headless-exec', async () => {
  const { prisma, box } = makeCapturingPrisma();
  const svc = buildService({ prisma, registry: makeFakeRegistry().registry });
  await svc.createTaskRow(REPO_ID, { prompt: 'go' }, prisma, 'headless-exec');
  assert.equal(box.value?.executionMode, 'headless-exec');
});

test('console (default) create persists executionMode=null → reads back interactive-pty', async () => {
  const { prisma, box } = makeCapturingPrisma();
  const svc = buildService({ prisma, registry: makeFakeRegistry().registry });
  await svc.createTaskRow(REPO_ID, { prompt: 'go' }, prisma);
  assert.equal(box.value?.executionMode, null);
});

test('headless create on a runtime without headless-exec fails closed (BadRequest)', async () => {
  const { prisma } = makeCapturingPrisma();
  const svc = buildService({ prisma, registry: makeNoHeadlessRegistry() });
  await assert.rejects(
    () => svc.createTaskRow(REPO_ID, { prompt: 'go' }, prisma, 'headless-exec'),
    (err: unknown) => err instanceof BadRequestException,
  );
});

test('create with sandboxEnvironmentId resolves and persists the selected environment', async () => {
  const { prisma, box } = makeCapturingPrisma();
  const calls: Array<{
    requestedEnvironmentId?: string | null;
    runtimeId: string;
  }> = [];
  const sandboxEnvironmentId = '00000000-0000-4000-a000-000000000777';
  const sandboxEnvironments = {
    async resolveForTask(args: { requestedEnvironmentId?: string | null; runtimeId: string }) {
      calls.push(args);
      return {
        environmentId: args.requestedEnvironmentId,
        sourceKind: 'aio-docker-image',
        sourceRef: 'cap/aio:latest',
        providerFamily: 'aio',
      };
    },
  } as unknown as SandboxEnvironmentsService;
  const svc = buildService({
    prisma,
    registry: makeFakeRegistry().registry,
    sandboxEnvironments,
  });

  const response = await svc.createTaskRow(
    REPO_ID,
    {
      prompt: 'go',
      sandboxEnvironmentId,
    },
    prisma,
  );

  assert.deepEqual(calls, [{ requestedEnvironmentId: sandboxEnvironmentId, runtimeId: 'codex' }]);
  assert.equal(box.value?.sandboxEnvironmentId, sandboxEnvironmentId);
  assert.equal(response.sandboxEnvironmentId, sandboxEnvironmentId);
});

test('create without sandboxEnvironmentId resolves the current user default image', async () => {
  const defaultSandboxEnvironmentId = '00000000-0000-4000-a000-000000000778';
  const { prisma, box } = makeCapturingPrisma({ defaultSandboxEnvironmentId });
  const calls: Array<{
    requestedEnvironmentId?: string | null;
    runtimeId: string;
  }> = [];
  const sandboxEnvironments = {
    async resolveForTask(args: { requestedEnvironmentId?: string | null; runtimeId: string }) {
      calls.push(args);
      return {
        environmentId: args.requestedEnvironmentId,
        sourceKind: 'aio-docker-image',
        sourceRef: 'cap/aio:latest',
        providerFamily: 'aio',
      };
    },
  } as unknown as SandboxEnvironmentsService;
  const svc = buildService({
    prisma,
    registry: makeFakeRegistry().registry,
    sandboxEnvironments,
  });

  const response = await svc.createTaskRow(
    REPO_ID,
    { prompt: 'go' },
    prisma,
    'interactive-pty',
    'user-1',
  );

  assert.deepEqual(calls, [
    { requestedEnvironmentId: defaultSandboxEnvironmentId, runtimeId: 'codex' },
  ]);
  assert.equal(box.value?.sandboxEnvironmentId, defaultSandboxEnvironmentId);
  assert.equal(response.sandboxEnvironmentId, defaultSandboxEnvironmentId);
});

test('create with sandboxEnvironmentId=null bypasses the current user default image', async () => {
  const { prisma, box } = makeCapturingPrisma({
    defaultSandboxEnvironmentId: '00000000-0000-4000-a000-000000000779',
  });
  const calls: Array<{
    requestedEnvironmentId?: string | null;
    runtimeId: string;
  }> = [];
  const sandboxEnvironments = {
    async resolveForTask(args: { requestedEnvironmentId?: string | null; runtimeId: string }) {
      calls.push(args);
      return null;
    },
  } as unknown as SandboxEnvironmentsService;
  const svc = buildService({
    prisma,
    registry: makeFakeRegistry().registry,
    sandboxEnvironments,
  });

  const response = await svc.createTaskRow(
    REPO_ID,
    { prompt: 'go', sandboxEnvironmentId: null },
    prisma,
    'interactive-pty',
    'user-1',
  );

  assert.deepEqual(calls, [{ requestedEnvironmentId: null, runtimeId: 'codex' }]);
  assert.equal(box.value?.sandboxEnvironmentId, null);
  assert.equal(response.sandboxEnvironmentId, null);
});

// ---------------------------------------------------------------------------
// headless-task-conversation-view — executionMode is echoed on the read path so
// the console can branch the session view by mode (toResponse round-trip).
// ---------------------------------------------------------------------------

/** A fake Prisma whose `findUnique` returns a row with the given executionMode. */
function makeReadbackPrisma(executionMode: string | null): PrismaService {
  return {
    task: {
      findUnique: async () => ({
        id: TASK_ID,
        repoId: REPO_ID,
        prompt: 'x',
        status: 'completed',
        createdAt: new Date(),
        branch: null,
        strategy: null,
        skills: [],
        idleTimeoutMs: null,
        deadlineMs: null,
        runtime: null,
        executionMode,
      }),
    },
  } as unknown as PrismaService;
}

test('findById echoes executionMode=headless-exec on the read path', async () => {
  const svc = buildService({ prisma: makeReadbackPrisma('headless-exec') });
  const res = await svc.findById(TASK_ID);
  assert.equal(res.executionMode, 'headless-exec', 'a headless task reads back headless-exec');
});

test('findById on a null executionMode column reads back interactive-pty (default)', async () => {
  const svc = buildService({ prisma: makeReadbackPrisma(null) });
  const res = await svc.findById(TASK_ID);
  assert.equal(
    res.executionMode,
    'interactive-pty',
    'a null column reads back as the interactive-pty default (never stale/fabricated)',
  );
});
