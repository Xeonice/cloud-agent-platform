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

import {
  TasksService,
  RuntimeNotConfiguredException,
  type IAgentRuntimeRegistry,
  type IRuntimeReadiness,
} from './tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Runtime } from '@cap/contracts';

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
      return { id };
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
}): TasksService {
  // TasksService constructor signature (positional DI):
  //   (prisma, guardrails?, audit?, sandbox?, runtimes?, claudeReadiness?)
  return new TasksService(
    opts.prisma,
    undefined,       // guardrails (optional)
    undefined,       // audit (optional)
    undefined,       // sandbox (optional)
    opts.registry,
    opts.claudeReadiness,
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
