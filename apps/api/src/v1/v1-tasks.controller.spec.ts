/**
 * Tests for `V1TasksController` (public-v1-api, tasks 3.1 / 3.2 / 3.4 / 3.7).
 *
 * Covers:
 *   1. `POST /v1/tasks` delegates to the SAME `TasksService.create(repoId, body)`
 *      admission path (D1 — one admission path), passing the body's `repoId` and
 *      the principal's githubId, and runs through the idempotency layer.
 *   2. Keyset pagination (`GET /v1/tasks`) walks the full set in `(createdAt,id)`
 *      order across pages with NO dropped or duplicated row, `nextCursor` null on
 *      the last page (3.2).
 *   3. Scope gates (3.4): a `tasks:read`-only api-key is 403'd on `POST /v1/tasks`
 *      (a write); a scopeless session principal passes every gate; an api-key
 *      WITH `tasks:write` passes create.
 *
 * Run from apps/api with `pnpm test` (nest build → node --test dist/**\/*.spec.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';

import { V1TasksController } from './v1-tasks.controller';
import { IdempotencyService } from './idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import {
  RuntimeExecutionEnvironmentSnapshotSchema,
  type TaskResponse,
} from '@cap/contracts';
import type { CreateTaskBody } from '@cap/contracts';
import type { PreparedTaskCreate } from '../tasks/prepared-task-create';
import { RuntimeModelPreflightError } from '../runtime-models/runtime-model-preflight.error';

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

const SESSION_PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    id: 'acct-4242',
    githubId: 4242,
    login: 'octocat',
    name: 'Octo Cat',
    avatarUrl: '',
    allowed: true,
  },
} as OperatorPrincipal;

/**
 * A LOCAL account (password/OTP) session principal — `githubId === null` but a
 * real account `id` (fix-local-account-task-attribution).
 */
const LOCAL_SESSION_PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    id: 'acct-local-1',
    githubId: null,
    login: null,
    name: 'Local Operator',
    avatarUrl: null,
    allowed: true,
  },
} as OperatorPrincipal;

const READ_ONLY_KEY: OperatorPrincipal = {
  kind: 'api-key',
  user: { id: 'acct-7', githubId: 7, login: 'bot', name: 'Bot', avatarUrl: '', allowed: true },
  scopes: ['tasks:read'],
  keyId: 'key-read',
} as OperatorPrincipal;

const WRITE_KEY: OperatorPrincipal = {
  kind: 'api-key',
  user: { id: 'acct-8', githubId: 8, login: 'bot2', name: 'Bot2', avatarUrl: '', allowed: true },
  scopes: ['tasks:read', 'tasks:write'],
  keyId: 'key-write',
} as OperatorPrincipal;

const reqWith = (principal?: OperatorPrincipal): AuthenticatedRequest =>
  ({ operatorPrincipal: principal }) as AuthenticatedRequest;

const MODEL_SNAPSHOT = RuntimeExecutionEnvironmentSnapshotSchema.parse({
  schemaVersion: 1,
  kind: 'deployment-default',
  managedEnvironmentId: null,
  validationId: null,
  validationContractVersion: null,
  provider: 'aio-local',
  providerFamily: 'aio',
  source: {
    kind: 'aio-docker-image',
    locator: 'sha256:image-before-retarget',
    digest: 'sha256:image-before-retarget',
    checksum: null,
  },
  immutableIdentity: 'sha256:image-before-retarget',
  fingerprint: 'environment-before-retarget',
  sandboxMetadata: {
    schemaVersion: 1,
    sandboxVersion: '1.0.0',
    dependencies: { codex: '0.144.1' },
  },
  sandboxMetadataChecksum: `sha256:${'a'.repeat(64)}`,
  cliVersion: '0.144.1',
  cliArtifactChecksum: `sha256:${'b'.repeat(64)}`,
  resolvedAt: '2026-07-14T00:00:00.000Z',
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A valid v4-shaped UUID whose final hex digit encodes `i`, so ids both pass the
 * contract's `z.string().uuid()` validation AND sort lexicographically by `i`
 * (the keyset tie-break the pagination walk exercises). `i` is bounded to one hex
 * digit (0–15), which is plenty for these fixtures.
 */
function uuidFor(prefix: 'a' | 'b', i: number): string {
  return `00000000-0000-4000-${prefix}000-00000000000${i.toString(16)}`;
}

function makeTaskRow(i: number, createdAt: Date): TaskResponse {
  return {
    id: uuidFor('a', i),
    repoId: '00000000-0000-4000-b000-0000000000ff',
    prompt: `p${i}`,
    status: 'pending',
    createdAt,
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
  } as TaskResponse;
}

/**
 * A passthrough idempotency stub that just runs the admit callback and reports the
 * task as NEWLY created (so the controller runs the post-row admission), mirroring
 * `IdempotencyService.run`'s `{ task, created }` contract.
 */
function passthroughIdempotency(): IdempotencyService {
  return {
    async lookup(): Promise<{ kind: 'missing'; requestHash: string }> {
      return { kind: 'missing', requestHash: 'request-hash' };
    },
    async commit(args: {
      create: (tx: unknown) => Promise<TaskResponse>;
    }): Promise<{ task: TaskResponse; created: boolean }> {
      return { task: await args.create(undefined), created: true };
    },
    async waitForWinner(): Promise<null> {
      return null;
    },
  } as unknown as IdempotencyService;
}

function preparedTask(
  repoId: string,
  body: CreateTaskBody,
  executionMode: 'interactive-pty' | 'headless-exec',
  userId?: string,
): PreparedTaskCreate {
  return {
    repoId,
    ownerUserId: userId ?? null,
    body,
    runtime: body.runtime ?? 'codex',
    executionMode,
    sandboxEnvironmentId: body.sandboxEnvironmentId ?? null,
    model: body.model ?? null,
    executionEnvironmentSnapshot: null,
  };
}

// ---------------------------------------------------------------------------
// Create — delegation + scope gate (3.1 / 3.4)
// ---------------------------------------------------------------------------

test('POST /v1/tasks delegates to TasksService.acceptPreparedTask + admitCreatedTask (one admission path)', async () => {
  const rowCalls: Array<{ repoId: string; body: unknown }> = [];
  const admitCalls: Array<{ taskId: string; userId?: string }> = [];
  const tasksService = {
    // V.1 — the admit callback creates the ROW (on the idempotency tx); the
    // provision is the separate post-commit step.
    async prepareTaskCreate(
      repoId: string,
      body: CreateTaskBody,
      mode: 'interactive-pty' | 'headless-exec',
      userId?: string,
    ) {
      return preparedTask(repoId, body, mode, userId);
    },
    async acceptPreparedTask(prepared: PreparedTaskCreate) {
      rowCalls.push({ repoId: prepared.repoId, body: prepared.body });
      return makeTaskRow(1, new Date());
    },
    async admitCreatedTask(taskId: string, _body: unknown, userId?: string) {
      admitCalls.push({ taskId, userId });
    },
  } as unknown as TasksService;

  const controller = new V1TasksController(
    tasksService,
    {} as PrismaService,
    passthroughIdempotency(),
  );

  await controller.create(
    { repoId: 'repo-1', prompt: 'hello' } as never,
    reqWith(SESSION_PRINCIPAL),
    undefined,
  );

  assert.equal(rowCalls.length, 1, 'exactly one canonical acceptance write');
  assert.equal(rowCalls[0].repoId, 'repo-1', 'repoId comes from the body');
  assert.ok(
    !(rowCalls[0].body as { repoId?: string }).repoId,
    'repoId is stripped from the create body (it is a route/service arg)',
  );
  assert.equal(admitCalls.length, 1, 'the newly-created task is admitted exactly once');
  assert.equal(
    admitCalls[0].userId,
    'acct-4242',
    'admission attributes to the session account id (users.id)',
  );
});

test('an exact replay returns the current Task without current preparation or admission work', async () => {
  const currentTask = {
    ...makeTaskRow(1, new Date('2026-07-15T00:00:00.000Z')),
    status: 'running',
  } as TaskResponse;
  let taskReads = 0;
  let preparations = 0;
  let acceptanceWrites = 0;
  let postCommitAdmissions = 0;
  let commits = 0;
  const tasksService = {
    async findById(taskId: string) {
      taskReads += 1;
      assert.equal(taskId, currentTask.id);
      return currentTask;
    },
    async prepareTaskCreate() {
      preparations += 1;
      throw new Error('an exact replay must not run current preparation');
    },
    async acceptPreparedTask() {
      acceptanceWrites += 1;
      throw new Error('an exact replay must not write another acceptance');
    },
    async admitCreatedTask() {
      postCommitAdmissions += 1;
      throw new Error('an exact replay must not wake or run admission');
    },
  } as unknown as TasksService;
  const idempotency = {
    async lookup(args: {
      loadTask: (taskId: string) => Promise<TaskResponse>;
    }) {
      return {
        kind: 'replay' as const,
        requestHash: 'persisted-request-hash',
        task: await args.loadTask(currentTask.id),
      };
    },
    async commit() {
      commits += 1;
      throw new Error('an exact replay must not open a write transaction');
    },
    async waitForWinner() {
      throw new Error('an already committed replay does not need race polling');
    },
  } as unknown as IdempotencyService;
  const controller = new V1TasksController(
    tasksService,
    {} as PrismaService,
    idempotency,
  );

  const response = await controller.create(
    { repoId: currentTask.repoId, prompt: currentTask.prompt } as never,
    reqWith(WRITE_KEY),
    'already-committed-key',
  );

  assert.equal(response, currentTask, 'the replay returns the current canonical projection');
  assert.equal(taskReads, 1, 'the current Task is loaded exactly once');
  assert.equal(preparations, 0, 'catalog/provider preparation is skipped');
  assert.equal(acceptanceWrites, 0, 'no second Task or admission work is written');
  assert.equal(postCommitAdmissions, 0, 'no wake or provider admission is restarted');
  assert.equal(commits, 0, 'no idempotency write transaction is opened');
});

test('POST /v1/tasks by a LOCAL account attributes to its account id (not undefined)', async () => {
  // fix-local-account-task-attribution: a local-account (githubId=null) /v1 create
  // must thread its `user.id` so the task is owner-attributed and its stored Codex
  // credential resolves — previously the null githubId collapsed to undefined.
  const admitCalls: Array<{ taskId: string; userId?: string }> = [];
  const tasksService = {
    async prepareTaskCreate(
      repoId: string,
      body: CreateTaskBody,
      mode: 'interactive-pty' | 'headless-exec',
      userId?: string,
    ) {
      return preparedTask(repoId, body, mode, userId);
    },
    async acceptPreparedTask() {
      return makeTaskRow(1, new Date());
    },
    async admitCreatedTask(taskId: string, _body: unknown, userId?: string) {
      admitCalls.push({ taskId, userId });
    },
  } as unknown as TasksService;

  const controller = new V1TasksController(
    tasksService,
    {} as PrismaService,
    passthroughIdempotency(),
  );

  await controller.create(
    { repoId: 'repo-1', prompt: 'hello' } as never,
    reqWith(LOCAL_SESSION_PRINCIPAL),
    undefined,
  );

  assert.equal(admitCalls.length, 1, 'the local-account task is admitted once');
  assert.equal(
    admitCalls[0].userId,
    'acct-local-1',
    'a local account create attributes to its account id (not collapsed to undefined)',
  );
});

test('a tasks:read-only api-key is 403 on POST /v1/tasks and admits nothing', async () => {
  let admitted = false;
  const tasksService = {
    async prepareTaskCreate(
      repoId: string,
      body: CreateTaskBody,
      mode: 'interactive-pty' | 'headless-exec',
      userId?: string,
    ) {
      return preparedTask(repoId, body, mode, userId);
    },
    async acceptPreparedTask() {
      admitted = true;
      return makeTaskRow(1, new Date());
    },
    async admitCreatedTask() {
      admitted = true;
    },
  } as unknown as TasksService;

  const controller = new V1TasksController(
    tasksService,
    {} as PrismaService,
    passthroughIdempotency(),
  );

  await assert.rejects(
    () =>
      controller.create(
        { repoId: 'repo-1', prompt: 'hi' } as never,
        reqWith(READ_ONLY_KEY),
        undefined,
      ),
    (err: unknown) => err instanceof ForbiddenException,
  );
  assert.equal(admitted, false, 'no task created when the scope gate rejects');
});

test('an api-key WITH tasks:write passes POST /v1/tasks', async () => {
  let rowCreated = false;
  let admitted = false;
  const tasksService = {
    async prepareTaskCreate(
      repoId: string,
      body: CreateTaskBody,
      mode: 'interactive-pty' | 'headless-exec',
      userId?: string,
    ) {
      return preparedTask(repoId, body, mode, userId);
    },
    async acceptPreparedTask() {
      rowCreated = true;
      return makeTaskRow(1, new Date());
    },
    async admitCreatedTask() {
      admitted = true;
    },
  } as unknown as TasksService;

  const controller = new V1TasksController(
    tasksService,
    {} as PrismaService,
    passthroughIdempotency(),
  );

  await controller.create(
    { repoId: 'repo-1', prompt: 'hi' } as never,
    reqWith(WRITE_KEY),
    undefined,
  );
  assert.equal(rowCreated, true, 'a tasks:write key creates the task row');
  assert.equal(admitted, true, 'and the newly-created task is admitted (provisioned)');
});

test('V1 explicit-model create pins the prepared digest outside the idempotency transaction', async () => {
  const phases: string[] = [];
  const transactionClient = { task: {} };
  let inTransaction = false;
  let mutableDeploymentTag = 'sha256:image-before-retarget';
  const persisted: { value: PreparedTaskCreate | null } = { value: null };
  const tasksService = {
    async prepareTaskCreate(
      repoId: string,
      body: CreateTaskBody,
      mode: 'headless-exec',
      userId?: string,
    ): Promise<PreparedTaskCreate> {
      assert.equal(inTransaction, false, 'catalog work must precede the transaction');
      phases.push('prepare');
      return {
        repoId,
        ownerUserId: userId ?? null,
        body,
        runtime: 'codex',
        executionMode: mode,
        sandboxEnvironmentId: null,
        model: body.model ?? null,
        executionEnvironmentSnapshot: MODEL_SNAPSHOT,
      };
    },
    async acceptPreparedTask(prepared: PreparedTaskCreate, tx: unknown) {
      phases.push('write');
      assert.equal(inTransaction, true);
      assert.equal(tx, transactionClient);
      assert.equal(mutableDeploymentTag, 'sha256:image-after-retarget');
      assert.equal(
        prepared.executionEnvironmentSnapshot?.immutableIdentity,
        'sha256:image-before-retarget',
        'a mutable deployment tag cannot replace the cataloged launch identity',
      );
      persisted.value = prepared;
      return {
        ...makeTaskRow(1, new Date()),
        model: prepared.model,
      };
    },
    async admitCreatedTask() {
      phases.push('admit');
      assert.equal(inTransaction, false, 'admission starts only after commit');
    },
    async findById() {
      throw new Error('unexpected replay lookup');
    },
  } as unknown as TasksService;
  const idempotency = {
    async lookup() {
      phases.push('lookup');
      return { kind: 'missing' as const, requestHash: 'request-hash' };
    },
    async commit(args: { create: (tx: unknown) => Promise<TaskResponse> }) {
      phases.push('commit');
      mutableDeploymentTag = 'sha256:image-after-retarget';
      inTransaction = true;
      try {
        return { task: await args.create(transactionClient), created: true };
      } finally {
        inTransaction = false;
      }
    },
    async waitForWinner() {
      return null;
    },
  } as unknown as IdempotencyService;
  const controller = new V1TasksController(
    tasksService,
    {} as PrismaService,
    idempotency,
  );

  const response = await controller.create(
    {
      repoId: makeTaskRow(1, new Date()).repoId,
      prompt: 'model-aware task',
      runtime: 'codex',
      model: 'provider/model:v1',
      sandboxEnvironmentId: null,
    },
    reqWith(WRITE_KEY),
    'model-key-1',
  );

  assert.equal(response.model, 'provider/model:v1');
  assert.equal(persisted.value?.model, 'provider/model:v1');
  assert.deepEqual(phases, ['lookup', 'prepare', 'commit', 'write', 'admit']);
});

test('V1 immutable-identity preflight failure creates and admits nothing', async () => {
  let commitCalls = 0;
  let admissionCalls = 0;
  const error = new RuntimeModelPreflightError({
    code: 'runtime_model_catalog_unavailable',
    message: 'The immutable execution identity is unavailable.',
    retryable: true,
    context: {
      runtime: 'codex',
      sandboxEnvironmentId: null,
      model: 'provider/model:v1',
    },
  });
  const controller = new V1TasksController(
    {
      async prepareTaskCreate() {
        throw error;
      },
      async acceptPreparedTask() {
        commitCalls += 1;
        return makeTaskRow(1, new Date());
      },
      async admitCreatedTask() {
        admissionCalls += 1;
      },
      async findById() {
        throw new Error('unexpected replay lookup');
      },
    } as unknown as TasksService,
    {} as PrismaService,
    {
      async lookup() {
        return { kind: 'missing' as const, requestHash: 'request-hash' };
      },
      async waitForWinner() {
        return null;
      },
      async commit() {
        commitCalls += 1;
        throw new Error('commit must not run');
      },
    } as unknown as IdempotencyService,
  );

  await assert.rejects(
    () =>
      controller.create(
        {
          repoId: makeTaskRow(1, new Date()).repoId,
          prompt: 'must fail before persistence',
          runtime: 'codex',
          model: 'provider/model:v1',
          sandboxEnvironmentId: null,
        },
        reqWith(WRITE_KEY),
        'model-key-2',
      ),
    (caught: unknown) => caught === error,
  );
  assert.equal(commitCalls, 0);
  assert.equal(admissionCalls, 0);
});

test('a scopeless session principal passes the read gate on GET /v1/tasks', async () => {
  const prisma = {
    task: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const controller = new V1TasksController(
    {} as TasksService,
    prisma,
    passthroughIdempotency(),
  );

  const page = await controller.list({ limit: 50 } as never, reqWith(SESSION_PRINCIPAL));
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
});

test('GET /v1/tasks projects persisted Codex and Claude auth failures', async () => {
  const failureAt = new Date('2026-07-12T12:32:31.000Z');
  const rows = [
    {
      ...makeTaskRow(1, new Date('2026-07-12T12:30:00.000Z')),
      status: 'failed',
      runtime: 'codex',
      failureCode: 'runtime_auth_expired',
      failureAt,
      failureExitCode: 1,
    },
    {
      ...makeTaskRow(2, new Date('2026-07-12T12:31:00.000Z')),
      status: 'failed',
      runtime: 'claude-code',
      failureCode: 'runtime_auth_rejected',
      failureAt,
      failureExitCode: 1,
    },
  ];
  const prisma = {
    task: {
      async findMany() {
        return rows;
      },
    },
  } as unknown as PrismaService;
  const controller = new V1TasksController(
    {} as TasksService,
    prisma,
    passthroughIdempotency(),
  );

  const page = await controller.list(
    { limit: 10 } as never,
    reqWith(SESSION_PRINCIPAL),
  );

  assert.equal(page.items[0].failure?.code, 'runtime_auth_expired');
  assert.ok(page.items[0].failure && 'runtime' in page.items[0].failure);
  assert.equal(page.items[0].failure.runtime, 'codex');
  assert.equal(page.items[0].failure?.action, 'reconnect_runtime');
  assert.equal(page.items[1].failure?.code, 'runtime_auth_rejected');
  assert.ok(page.items[1].failure && 'runtime' in page.items[1].failure);
  assert.equal(page.items[1].failure.runtime, 'claude-code');
  assert.equal(page.items[1].failure?.exitCode, 1);
});

// ---------------------------------------------------------------------------
// Keyset pagination walks the set with no drop/dup (3.2)
// ---------------------------------------------------------------------------

test('GET /v1/tasks paginates the full set in (createdAt,id) order with no drop/dup', async () => {
  // 10 rows where adjacent PAIRS share a timestamp, so every page boundary that
  // lands mid-pair forces the `(createdAt, id)` id tie-break — the case a
  // createdAt-only cursor would drop or duplicate.
  const base = Date.parse('2026-06-19T00:00:00.000Z');
  const all: TaskResponse[] = [];
  for (let i = 0; i < 10; i += 1) {
    all.push(makeTaskRow(i, new Date(base + Math.floor(i / 2) * 1000)));
  }
  // Sort the source by the same keyset the controller orders on.
  const sorted = [...all].sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const prisma = {
    task: {
      async findMany({
        where,
        take,
      }: {
        where: Record<string, unknown>;
        orderBy: unknown;
        take: number;
      }) {
        // Emulate the keyset WHERE against the in-memory sorted set.
        let rows = sorted;
        const or = (where as { OR?: Array<Record<string, { gt?: Date }> | Record<string, unknown>> }).OR;
        if (or) {
          // cursor row = the last returned; reconstruct the boundary from the OR.
          const gtClause = or[0] as { createdAt: { gt: Date } };
          const eqClause = or[1] as { createdAt: Date; id: { gt: string } };
          rows = sorted.filter(
            (r) =>
              r.createdAt.getTime() > gtClause.createdAt.gt.getTime() ||
              (r.createdAt.getTime() === eqClause.createdAt.getTime() &&
                r.id > eqClause.id.gt),
          );
        }
        return rows.slice(0, take);
      },
    },
  } as unknown as PrismaService;

  const controller = new V1TasksController(
    {} as TasksService,
    prisma,
    passthroughIdempotency(),
  );

  // Walk in pages of 3, following nextCursor.
  const seen: string[] = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const page = await controller.list(
      { limit: 3, cursor } as never,
      reqWith(SESSION_PRINCIPAL),
    );
    for (const t of page.items) seen.push(t.id);
    cursor = page.nextCursor ?? undefined;
    guard += 1;
    assert.ok(guard < 20, 'pagination must terminate');
  } while (cursor);

  // No drop: every row seen. No dup: each id once. Correct order.
  assert.equal(seen.length, sorted.length, 'every row returned exactly once (no drop)');
  assert.equal(new Set(seen).size, sorted.length, 'no duplicate rows across pages');
  assert.deepEqual(
    seen,
    sorted.map((r) => r.id),
    'rows walked in (createdAt,id) order',
  );
});
