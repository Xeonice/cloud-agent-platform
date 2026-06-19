/**
 * Per-principal throttler guard spec (public-v1-api, track rate-limiting, task 6.2;
 * spec `request-rate-limiting` — "Per-principal request rate limiting").
 *
 * The throttler is the SECOND global guard, ordered AFTER the auth guard, and it
 * keys its rate bucket on the RESOLVED PRINCIPAL the auth guard attached
 * (`req.operatorPrincipal`) — for a `session` principal that key is the owner's
 * immutable GitHub id — NOT the client IP. The three properties the spec pins are
 * exactly what would silently regress if the guard fell back to per-IP keying or
 * if the two guards were registered in the wrong order, so they are proven
 * BEHAVIORALLY over a booted HTTP app (the same in-process `@nestjs/testing` +
 * `fetch` style as `version.controller.spec.ts` / `self-update.spec.ts`):
 *
 *   1. Two DISTINCT principals issuing from ONE client IP get INDEPENDENT buckets.
 *      Every request in this file is a loopback `fetch`, so all share the single
 *      `127.0.0.1` client IP — a per-IP limiter would lump them into one bucket.
 *      We exhaust principal A's window, then show principal B from the same IP is
 *      untouched: the bucket is keyed per-principal (here on the GitHub id), not
 *      per-IP. (The spec's canonical phrasing is "two api-keys from one IP"; in
 *      this tree only the GitHub-OAuth `session` principal exists, whose tracker
 *      key is its `githubId`, so two distinct owners are the per-principal axis —
 *      identical mechanism, identical guarantee.)
 *   2. Exceeding the window returns 429. With `LIMIT` requests admitted in the
 *      TTL window, the `LIMIT + 1`-th from the SAME principal is rejected 429.
 *   3. The limiter runs AFTER auth so it can key on the principal. The stub auth
 *      guard (registered FIRST) attaches a configurable principal; flipping which
 *      principal it attaches flips which bucket the throttler charges — proving
 *      the throttler reads the principal the auth guard set, i.e. it ran after it.
 *      (If it ran before auth, no principal would be attached and it could only
 *      key on the IP, which is CONSTANT here — the buckets would NOT be
 *      independent. They are, so the principal was attached first.)
 *
 * The guard under test (`PrincipalThrottlerGuard`) is the `ThrottlerGuard`
 * subclass that overrides `getTracker` to read `req.operatorPrincipal`; it +
 * `@nestjs/throttler` are wired by the Integration track (task 6.1). This test
 * boots them in isolation behind a stub auth guard so the per-principal contract
 * is verified independently of the full app assembly.
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
  type INestApplication,
} from '@nestjs/common';
import { ThrottlerModule, seconds } from '@nestjs/throttler';

import { PrincipalThrottlerGuard } from './principal.throttler-guard';
import type { OperatorPrincipal } from '../auth/operator-principal';

/**
 * The per-principal request cap exercised here. Kept tiny so a window is
 * exhausted in a handful of synchronous `fetch`es; the TTL is generous so the
 * whole window is observed within a single test without any real-clock wait
 * (window RESET is proven via per-principal independence, not by sleeping).
 */
const LIMIT = 3;

/** A trivial protected route the throttler guards. */
@Controller('probe')
class ProbeController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Stand-in for the real `AuthGuard`, registered as the FIRST global guard. It
 * attaches whatever principal the current case configures, exactly as the real
 * guard attaches the resolved `operatorPrincipal` — so the throttler (the SECOND
 * guard) has a principal to key on. A `null` principal denies (no principal
 * attached), mirroring the real fail-closed posture.
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

/**
 * A `session` principal whose per-principal tracker key is its owner's immutable
 * `githubId`. Two distinct `githubId`s are two distinct principals — the axis the
 * spec's "two keys from one IP" scenario exercises (in this tree the GitHub
 * session is the only principal kind, and its key is the owner id).
 */
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
  };
}

let app: INestApplication;
let port: number;

before(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    imports: [
      // In-memory store (the default), single throttler, tiny limit / long TTL.
      ThrottlerModule.forRoot([{ ttl: seconds(60), limit: LIMIT }]),
    ],
    providers: [
      // Registration ORDER is the load-bearing detail (global guard order =
      // provider order, design D7): the stub auth guard FIRST so the principal is
      // attached, the per-principal throttler SECOND so it keys on that principal.
      { provide: APP_GUARD, useClass: StubAuthGuard },
      { provide: APP_GUARD, useClass: PrincipalThrottlerGuard },
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

/** One loopback request as the currently-configured principal. */
function probe(): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/probe`);
}

/** Drive `count` requests as `principal`, returning the status of each in order. */
async function probeAs(
  principal: OperatorPrincipal,
  count: number,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    currentPrincipal = principal;
    // Serialize the requests so the in-memory counter increments deterministically
    // (a parallel burst could race the bucket and undercount the throttle).
    const res = await probe();
    // Drain the body so the socket is released between requests.
    await res.text();
    statuses.push(res.status);
  }
  return statuses;
}

test('exceeding the per-principal window returns 429', async () => {
  // LIMIT admitted, then the next from the SAME principal is throttled.
  const statuses = await probeAs(sessionPrincipal(1001), LIMIT + 1);

  assert.deepEqual(
    statuses.slice(0, LIMIT),
    Array(LIMIT).fill(200),
    'the first LIMIT requests in the window are admitted',
  );
  assert.equal(
    statuses[LIMIT],
    429,
    'the request past the window cap is rejected with 429',
  );
});

test('two distinct principals from one IP get independent buckets (per-principal, not per-IP)', async () => {
  // Both principals issue from the SAME client IP (every fetch is loopback
  // 127.0.0.1), so a per-IP limiter would share one bucket across them. Exhaust
  // principal A...
  const a = await probeAs(sessionPrincipal(2001), LIMIT + 1);
  assert.equal(a[LIMIT], 429, 'principal A is throttled once its own window is full');

  // ...principal B, same IP, must start with a FULL fresh bucket: a per-IP limiter
  // would have already counted A's requests against this shared IP and 429 here.
  const b = await probeAs(sessionPrincipal(2002), LIMIT);
  assert.deepEqual(
    b,
    Array(LIMIT).fill(200),
    'principal B from the same IP has its OWN bucket — keyed per-principal, not per-IP',
  );
});

test('the throttler runs AFTER the auth guard: it keys on the attached principal', async () => {
  // Exhaust principal A's window (keyed on its githubId)...
  const exhausted = await probeAs(sessionPrincipal(3001), LIMIT + 1);
  assert.equal(exhausted[LIMIT], 429, 'principal A is throttled at its cap');

  // ...then a DIFFERENT principal, from the same IP, gets a fresh bucket. The
  // bucket changed with the PRINCIPAL the auth guard attached, not with the
  // (constant) client IP — only possible if the throttler read the principal,
  // i.e. it ran AFTER the auth guard that set it.
  const other = await probeAs(sessionPrincipal(3002), LIMIT);
  assert.deepEqual(
    other,
    Array(LIMIT).fill(200),
    'a different principal gets its own bucket — the limiter keyed on the post-auth principal',
  );
});
