/**
 * Anonymous pre-auth throttler guard spec (add-private-account-identity, track
 * `rate-limit-auth`, task 8.2; spec `request-rate-limiting` — "Anonymous
 * brute-force throttle on pre-auth auth endpoints").
 *
 * The guard under test ({@link AuthThrottleGuard}) protects the PUBLIC auth
 * endpoints (password login, OTP request/verify, change-password) that run BEFORE
 * any principal is resolved. The three properties the spec pins are exactly what
 * would silently regress if the guard fell back to a single shared per-IP bucket
 * or somehow depended on a (non-existent) principal, so they are proven two ways:
 *
 *   1. BEHAVIORALLY over a booted HTTP app (the same in-process `@nestjs/testing`
 *      + `fetch` style as `principal.throttler-guard.spec.ts`). Every request is a
 *      loopback POST sharing the single `127.0.0.1` client IP, with NO auth guard
 *      registered — so there is never a resolved principal. The bucket therefore
 *      MUST come from IP + submitted email:
 *        - repeated attempts for the SAME email from this one IP trip the cap
 *          (brute-force / OTP-issuance is throttled — scenarios 1 & 2);
 *        - a DIFFERENT email from the SAME IP starts with a fresh window — proving
 *          the axis is IP+email, not one shared per-IP bucket, and that the
 *          decision is made with no principal in play (scenario 3).
 *   2. As a PURE unit over the exported {@link authThrottleTrackerKey}, pinning the
 *      keying axis directly: IP+email compose the key, email is case-normalized,
 *      and an absent email degrades to a stable sentinel (so the IP still buckets).
 *
 * The guard is the `ThrottlerGuard` subclass overriding `getTracker` to key on
 * IP + `req.body.email`; its registration on the auth routes is wired by the
 * integration track (10.1). This test boots it in isolation — as the ONLY guard,
 * no auth guard ahead of it — so the "no principal needed" contract is verified
 * independently of the full app assembly.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import {
  Body,
  Controller,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { ThrottlerModule, seconds } from '@nestjs/throttler';

import {
  AuthThrottleGuard,
  authThrottleTrackerKey,
} from './auth-throttle.guard';
import { AUTH_THROTTLE_NAME } from './throttler.options';

/**
 * The per-(IP, email) cap exercised here. Kept tiny so a window is exhausted in a
 * handful of synchronous `fetch`es; the TTL is generous so the whole window is
 * observed within a single test without any real-clock wait (window RESET is
 * proven via per-email independence, not by sleeping).
 */
const LIMIT = 3;

/**
 * A trivial public route the throttler guards, accepting an email body. It is
 * mounted at one of the ACTUAL throttled pre-auth paths (`/auth/password`): the
 * guard's `shouldSkip` only enforces the `auth` tier on its fixed
 * `AUTH_THROTTLED_PATHS` set, so a probe on any other path would be (correctly)
 * skipped and never throttled.
 */
@Controller('auth')
class AuthProbeController {
  @Post('password')
  password(@Body() _body: { email?: string }): { ok: true } {
    return { ok: true };
  }
}

let app: INestApplication;
let port: number;

before(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthProbeController],
    imports: [
      // In-memory store (the default), single `auth`-NAMED tier, tiny limit /
      // long TTL. The tier MUST carry `AUTH_THROTTLE_NAME`: the guard's
      // `onModuleInit` narrows `this.throttlers` to that name only (so when it is
      // one of several global guards it enforces the `auth` tier alone), and a
      // tier under any other name would be filtered out — leaving nothing to
      // enforce.
      ThrottlerModule.forRoot([
        { name: AUTH_THROTTLE_NAME, ttl: seconds(60), limit: LIMIT },
      ]),
    ],
    providers: [
      // The ONLY guard — there is deliberately no auth guard ahead of it, so the
      // throttle decision can only come from request attributes (IP + email),
      // never from a resolved principal.
      { provide: APP_GUARD, useClass: AuthThrottleGuard },
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

/** One loopback auth POST carrying `email`, returning its status. */
async function attempt(email: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  // Drain the body so the socket is released between requests.
  await res.text();
  return res.status;
}

/** Drive `count` serial attempts for `email`, returning each status in order. */
async function attemptN(email: string, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    // Serialize so the in-memory counter increments deterministically (a parallel
    // burst could race the bucket and undercount the throttle).
    statuses.push(await attempt(email));
  }
  return statuses;
}

test('repeated attempts for one IP/email are throttled without a resolved principal', async () => {
  // No auth guard is registered, so there is NO principal — the cap is reached
  // purely from IP + submitted email. LIMIT admitted, then the next is 429.
  const statuses = await attemptN('victim@example.com', LIMIT + 1);

  assert.deepEqual(
    statuses.slice(0, LIMIT),
    Array(LIMIT).fill(201),
    'the first LIMIT pre-auth attempts in the window are admitted',
  );
  assert.equal(
    statuses[LIMIT],
    429,
    'the attempt past the IP+email cap is rejected with 429 — no credential check beyond it',
  );
});

test('a different email from the same IP gets an independent bucket (axis is IP+email, not one shared per-IP bucket)', async () => {
  // Exhaust email A from this single loopback IP...
  const a = await attemptN('a@example.com', LIMIT + 1);
  assert.equal(a[LIMIT], 429, 'email A is throttled once its own window is full');

  // ...email B, SAME IP, must start with a FULL fresh bucket. A single shared
  // per-IP bucket would already have counted A's attempts and 429 here — it does
  // not, so the bucket is keyed per (IP, email), and the decision needed no
  // principal (none is ever attached in this app).
  const b = await attemptN('b@example.com', LIMIT);
  assert.deepEqual(
    b,
    Array(LIMIT).fill(201),
    'email B from the same IP has its OWN bucket — keyed per IP+email, principal-independent',
  );
});

test('OTP-style repeat issuance for one email/IP is capped (in addition to any resend cooldown)', async () => {
  // The OTP request endpoint shares this guard: repeated issuance for the same
  // email from one IP trips the same IP+email cap, so codes cannot be mass-issued
  // regardless of the OTP service's own per-email resend cooldown.
  const statuses = await attemptN('otp-target@example.com', LIMIT + 1);

  assert.deepEqual(
    statuses.slice(0, LIMIT),
    Array(LIMIT).fill(201),
    'the first LIMIT issuance requests in the window are admitted',
  );
  assert.equal(
    statuses[LIMIT],
    429,
    'issuance past the IP+email cap is throttled, on top of the resend cooldown',
  );
});

test('authThrottleTrackerKey composes IP + case-normalized email', () => {
  assert.equal(
    authThrottleTrackerKey('203.0.113.7', 'User@Example.com'),
    'ip:203.0.113.7|email:user@example.com',
    'key combines IP and a lower-cased email so case variants share one bucket',
  );
});

test('authThrottleTrackerKey degrades an absent email to a stable sentinel (IP still buckets)', () => {
  // Same IP, no email (e.g. a change-password attempt that omits it) → one stable
  // bucket per IP rather than failing open into an unlimited path.
  assert.equal(
    authThrottleTrackerKey('203.0.113.7', undefined),
    'ip:203.0.113.7|email:-',
    'an absent email degrades to a sentinel so the IP component still keys the bucket',
  );
});
