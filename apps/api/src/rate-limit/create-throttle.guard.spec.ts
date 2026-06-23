/**
 * Dedicated `create`-tier throttler guard spec (fix-rate-limit-create-tier-scope).
 *
 * The {@link CreateThrottleGuard} exists to FIX a production 429 regression: the
 * stricter `create` cap (10/60s) used to be retained by the
 * {@link PrincipalThrottlerGuard} and so was charged against EVERY authenticated
 * request — dashboard polling of `/auth/session`, `/metrics`, `/tasks` — tripping
 * 429s long before the intended `default` cap. The `create` tier must bound ONLY
 * task admission (`POST /v1/tasks`). The three properties this spec pins are exactly
 * what would silently regress, so they are proven BEHAVIORALLY over a booted HTTP
 * app (the same in-process `@nestjs/testing` + `fetch` style as
 * `principal.throttler-guard.spec.ts`):
 *
 *   1. `POST /v1/tasks` over the cap returns 429. With `LIMIT` creates admitted in
 *      the window, the `LIMIT + 1`-th from the SAME principal is rejected.
 *   2. A non-create route (`GET /v1/tasks`, here a probe at a DIFFERENT path) is
 *      NEVER throttled by this guard — `shouldSkip` returns true for it — so even a
 *      burst far past the create cap is admitted. This is the root-cause property:
 *      the create cap does not leak onto general traffic.
 *   3. The bucket is per-PRINCIPAL (shares `principalTrackerKey`): two distinct
 *      principals from one client IP get independent create windows.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { ThrottlerModule, Throttle, seconds } from '@nestjs/throttler';

import { CreateThrottleGuard } from './create-throttle.guard';
import { CREATE_THROTTLE_NAME } from './throttler.options';
import type { OperatorPrincipal } from '../auth/operator-principal';

/**
 * The create cap exercised here. Kept tiny so a window is exhausted in a handful of
 * serial `fetch`es; the TTL is generous so the whole window is observed within a
 * single test without any real-clock wait.
 */
const LIMIT = 3;

/**
 * A controller exposing BOTH the throttled create route (`POST /v1/tasks`, opting
 * into the `create` tier exactly as the production v1-tasks controller does) and an
 * un-throttled poll route (`GET /v1/tasks/poll`) used to prove the create cap never
 * lands on non-create traffic. The path MUST be `v1/tasks` so the guard's
 * `shouldSkip` (which only enforces on `POST /v1/tasks`) bites the create route.
 */
@Controller('v1/tasks')
class TasksProbeController {
  @Post()
  @Throttle({ [CREATE_THROTTLE_NAME]: { limit: LIMIT, ttl: seconds(60) } })
  create(): { ok: true } {
    return { ok: true };
  }

  @Get('poll')
  poll(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Stand-in for the real `AuthGuard`, registered FIRST. It attaches whatever
 * principal the current case configures, exactly as the real guard attaches the
 * resolved `operatorPrincipal`, so the create throttler (the SECOND guard) has a
 * principal to key on.
 */
let currentPrincipal: OperatorPrincipal | null = null;

@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (currentPrincipal === null) {
      return false;
    }
    const req = context.switchToHttp().getRequest();
    req.operatorPrincipal = currentPrincipal;
    return true;
  }
}

/** A `session` principal keyed (via `principalTrackerKey`) on its `user.id`. */
function sessionPrincipal(id: string): OperatorPrincipal {
  return {
    kind: 'session',
    user: {
      id,
      githubId: null,
      login: null,
      name: 'U',
      avatarUrl: null,
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
  };
}

let app: INestApplication;
let port: number;

before(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [TasksProbeController],
    imports: [
      // In-memory store, the `create`-NAMED tier (so `onModuleInit`'s narrow keeps
      // it) plus a `default` tier with a very high limit (proves the guard does NOT
      // enforce `default` — that belongs to the principal guard). The route-level
      // `@Throttle({ create })` override supplies the effective limit.
      ThrottlerModule.forRoot([
        { name: 'default', limit: 9999, ttl: seconds(60) },
        { name: CREATE_THROTTLE_NAME, limit: LIMIT, ttl: seconds(60) },
      ]),
    ],
    providers: [
      // auth guard FIRST (attaches the principal), create throttler SECOND.
      { provide: APP_GUARD, useClass: StubAuthGuard },
      { provide: APP_GUARD, useClass: CreateThrottleGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.listen(0);
  const address = app.getHttpServer().address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await app?.close();
});

beforeEach(() => {
  currentPrincipal = null;
});

/** One loopback `POST /v1/tasks` as `principal`. */
async function postCreate(principal: OperatorPrincipal): Promise<number> {
  currentPrincipal = principal;
  const res = await fetch(`http://127.0.0.1:${port}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  await res.text();
  return res.status;
}

/** One loopback `GET /v1/tasks/poll` as `principal`. */
async function getPoll(principal: OperatorPrincipal): Promise<number> {
  currentPrincipal = principal;
  const res = await fetch(`http://127.0.0.1:${port}/v1/tasks/poll`);
  await res.text();
  return res.status;
}

test('POST /v1/tasks over the create cap returns 429', async () => {
  const principal = sessionPrincipal('user-create-1');
  const statuses: number[] = [];
  for (let i = 0; i < LIMIT + 1; i += 1) {
    statuses.push(await postCreate(principal));
  }

  assert.deepEqual(
    statuses.slice(0, LIMIT),
    Array(LIMIT).fill(201),
    'the first LIMIT creates in the window are admitted',
  );
  assert.equal(
    statuses[LIMIT],
    429,
    'the create past the window cap is rejected with 429',
  );
});

test('a non-create route is NOT throttled by the create guard even at high frequency (shouldSkip)', async () => {
  const principal = sessionPrincipal('user-poll-1');
  // Burst the poll route far past the create cap — the create guard skips it.
  const statuses: number[] = [];
  for (let i = 0; i < LIMIT * 4; i += 1) {
    statuses.push(await getPoll(principal));
  }

  assert.deepEqual(
    statuses,
    Array(LIMIT * 4).fill(200),
    'GET /v1/tasks/poll is never 429ed by the create guard — the create cap does not leak onto polling',
  );
});

test('the create cap is per-principal: two principals from one IP get independent windows', async () => {
  // Exhaust principal A's create window (every fetch is loopback 127.0.0.1).
  const a: number[] = [];
  for (let i = 0; i < LIMIT + 1; i += 1) {
    a.push(await postCreate(sessionPrincipal('user-a')));
  }
  assert.equal(a[LIMIT], 429, 'principal A is throttled once its own create window is full');

  // Principal B, SAME IP, must start with a FULL fresh window — a per-IP limiter
  // would already have counted A's creates and 429 here.
  const b: number[] = [];
  for (let i = 0; i < LIMIT; i += 1) {
    b.push(await postCreate(sessionPrincipal('user-b')));
  }
  assert.deepEqual(
    b,
    Array(LIMIT).fill(201),
    'principal B from the same IP has its OWN create bucket — keyed per-principal, not per-IP',
  );
});
