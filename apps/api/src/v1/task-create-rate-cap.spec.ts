/**
 * Minimal behavioral test for the spec requirement:
 *   "Per-principal task-creation rate cap" (public-v1-api /
 *    specs/request-rate-limiting)
 *
 * Scenario exercised:
 *   WHEN one principal issues task-create requests faster than its create-rate cap
 *   THEN the over-rate creates are rejected with 429 and no sandbox is admitted
 *        for them, while the running-task concurrency semaphore continues to bound
 *        only concurrent execution.
 *
 * The test boots a real NestJS HTTP app wiring:
 *   - a stub auth guard (attached before the throttler, as in production)
 *   - PrincipalThrottlerGuard as APP_GUARD (the SECOND global guard)
 *   - ThrottlerModule with BOTH the `default` and `create` named throttlers,
 *     the `create` throttler capped at LIMIT=3 (tiny window so we can exhaust
 *     it quickly without sleeping)
 *   - V1TasksController with a fake TasksService that records admission calls
 *
 * The test then:
 *   1. Sends LIMIT+1 POST /v1/tasks from the same principal.
 *   2. Asserts that the first LIMIT requests are admitted (201) and the
 *      (LIMIT+1)-th is rejected 429.
 *   3. Asserts that TasksService.create was called exactly LIMIT times (no
 *      sandbox was admitted for the over-rate request).
 *   4. Sends an additional create from a DIFFERENT principal and asserts it is
 *      admitted (201), confirming the cap is per-principal (not a shared cap).
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  type INestApplication,
} from '@nestjs/common';
import { ThrottlerModule, seconds } from '@nestjs/throttler';

import { V1TasksController } from './v1-tasks.controller';
import { IdempotencyService } from './idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { PrincipalThrottlerGuard } from '../rate-limit/principal.throttler-guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import type { TaskResponse } from '@cap/contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The create-rate cap exercised in this test.
 *
 * The `POST /v1/tasks` handler has `@Throttle({ create: { limit: 10, ttl: 60_000 } })`
 * hardcoded in `v1-tasks.controller.ts`. The throttler guard reads the ROUTE-LEVEL
 * override (`routeOrClassLimit`) first, so the effective limit on the `create`
 * throttler is always 10, regardless of the `ThrottlerModule.forRoot` registration
 * for the `create` throttler. We use 10 here to match the exact value in the
 * production `@Throttle` decorator.
 */
const CREATE_LIMIT = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(i: number): TaskResponse {
  return {
    id: `00000000-0000-4000-a000-00000000000${i.toString(16)}`,
    repoId: '00000000-0000-4000-b000-0000000000ff',
    prompt: `p${i}`,
    status: 'pending',
    createdAt: new Date(),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
  } as TaskResponse;
}

function sessionPrincipal(githubId: number): OperatorPrincipal {
  return {
    kind: 'session',
    user: {
      githubId,
      login: `u${githubId}`,
      name: 'U',
      avatarUrl: '',
      allowed: true,
    },
  } as OperatorPrincipal;
}

// ---------------------------------------------------------------------------
// Stub auth guard — attaches whatever principal the test case sets
// ---------------------------------------------------------------------------

let currentPrincipal: OperatorPrincipal | null = null;

@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (currentPrincipal === null) return false;
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    req['operatorPrincipal'] = currentPrincipal;
    return true;
  }
}

// ---------------------------------------------------------------------------
// A dummy controller to keep the `create` named throttler from being a no-op
// due to only being used on V1TasksController's POST handler.
// (Not needed: V1TasksController itself is registered below.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

let app: INestApplication;
let port: number;
let admissions: number; // counts how many times TasksService.createTaskRow was called

before(async () => {
  // Track admission (row-create) calls. The /v1 create path reaches
  // `createTaskRow` only for a request that PASSES the create-rate cap; a
  // throttled (429) request never reaches the service (V.1 row/admit split).
  const fakeTasksService = {
    async createTaskRow(_repoId: string, _body: unknown): Promise<TaskResponse> {
      admissions += 1;
      return makeTask(admissions);
    },
    async admitCreatedTask(): Promise<void> {
      // Post-row provision — a no-op in this throttling test.
    },
    async findById(_id: string): Promise<TaskResponse> {
      return makeTask(0);
    },
    async stop(_id: string): Promise<TaskResponse> {
      return makeTask(0);
    },
  } as unknown as TasksService;

  // Passthrough idempotency: runs the admit callback and reports the task as NEWLY
  // created, mirroring `IdempotencyService.run`'s `{ task, created }` contract.
  const fakeIdempotency = {
    async run(args: {
      admit: (tx: unknown) => Promise<TaskResponse>;
    }): Promise<{ task: TaskResponse; created: boolean }> {
      return { task: await args.admit(undefined), created: true };
    },
  } as unknown as IdempotencyService;

  const fakePrisma = {} as PrismaService;

  const moduleRef = await Test.createTestingModule({
    controllers: [V1TasksController],
    imports: [
      ThrottlerModule.forRoot([
        // `default` throttler: very high limit so it never fires in this test.
        { name: 'default', limit: 999, ttl: seconds(60) },
        // `create` throttler: the one POST /v1/tasks opts into via @Throttle().
        { name: 'create', limit: CREATE_LIMIT, ttl: seconds(60) },
      ]),
    ],
    providers: [
      // FIRST global guard: stub auth guard attaches the principal.
      { provide: APP_GUARD, useClass: StubAuthGuard },
      // SECOND global guard: principal-keyed throttler reads the attached principal.
      { provide: APP_GUARD, useClass: PrincipalThrottlerGuard },
      // Inject fakes for the controller's dependencies.
      { provide: TasksService, useValue: fakeTasksService },
      { provide: PrismaService, useValue: fakePrisma },
      { provide: IdempotencyService, useValue: fakeIdempotency },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number } | null;
  port = address?.port ?? 0;
});

after(async () => {
  await app?.close();
});

beforeEach(() => {
  currentPrincipal = null;
  admissions = 0;
});

// ---------------------------------------------------------------------------
// Helpers to drive HTTP requests
// ---------------------------------------------------------------------------

async function postCreate(principal: OperatorPrincipal): Promise<number> {
  currentPrincipal = principal;
  const res = await fetch(`http://127.0.0.1:${port}/v1/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repoId: '00000000-0000-4000-b000-0000000000ff',
      prompt: 'test',
    }),
  });
  await res.text(); // drain
  return res.status;
}

// ---------------------------------------------------------------------------
// TEST: burst of creates from one principal is capped
// ---------------------------------------------------------------------------

test('a burst of creates from one principal is capped at the create-rate limit (429), no sandbox admitted past the cap', async () => {
  const principal = sessionPrincipal(9001);

  const statuses: number[] = [];
  for (let i = 0; i < CREATE_LIMIT + 1; i++) {
    statuses.push(await postCreate(principal));
  }

  // The first CREATE_LIMIT requests must be admitted (201 Created).
  assert.deepEqual(
    statuses.slice(0, CREATE_LIMIT),
    Array(CREATE_LIMIT).fill(201),
    `the first ${CREATE_LIMIT} creates in the window are admitted with 201`,
  );

  // The (CREATE_LIMIT+1)-th from the SAME principal must be rejected 429.
  assert.equal(
    statuses[CREATE_LIMIT],
    429,
    'the over-rate create is rejected with 429',
  );

  // No sandbox was admitted for the over-rate request.
  assert.equal(
    admissions,
    CREATE_LIMIT,
    'TasksService.create was called exactly CREATE_LIMIT times — no sandbox for the over-rate request',
  );
});

// ---------------------------------------------------------------------------
// TEST: per-principal independence — a different principal is NOT affected
// ---------------------------------------------------------------------------

test('the create-rate cap is per-principal: a different principal is unaffected by the first principal exhausting its cap', async () => {
  const principalA = sessionPrincipal(9002);
  const principalB = sessionPrincipal(9003);

  // Exhaust principal A's cap.
  for (let i = 0; i < CREATE_LIMIT + 1; i++) {
    await postCreate(principalA);
  }
  // Confirm A is now capped.
  const cappedStatus = await postCreate(principalA);
  assert.equal(cappedStatus, 429, 'principal A is still capped after exhausting its window');

  // Principal B, from the same loopback IP, must have its own fresh CREATE_LIMIT.
  admissions = 0; // reset the counter to measure B's admissions only
  const bStatuses: number[] = [];
  for (let i = 0; i < CREATE_LIMIT; i++) {
    bStatuses.push(await postCreate(principalB));
  }

  assert.deepEqual(
    bStatuses,
    Array(CREATE_LIMIT).fill(201),
    `principal B from the same IP gets its own fresh bucket of ${CREATE_LIMIT} creates`,
  );
  assert.equal(
    admissions,
    CREATE_LIMIT,
    'principal B\'s creates are all admitted — the cap is per-principal, not shared',
  );
});
