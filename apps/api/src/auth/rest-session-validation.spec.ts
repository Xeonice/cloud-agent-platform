/**
 * Ground-truth test: "Session validation on REST requests"
 * (add-private-account-identity — multi-user-oauth spec, Requirement:
 * "Session validation on REST requests").
 *
 * Requirement (verbatim from spec):
 *   Every REST endpoint other than the unauthenticated health/metadata endpoints
 *   and the public auth endpoints SHALL require a valid, non-expired session
 *   resolving to an `allowed` user. The orchestrator SHALL reject a missing,
 *   malformed, expired, revoked, or disallowed session with HTTP 401 and SHALL NOT
 *   execute the requested action. Session validation SHALL re-confirm `User.allowed`
 *   at request time, so disabling an account denies its in-flight sessions on their
 *   next request. Additionally, when the resolved user has `mustChangePassword` set,
 *   every protected action other than the change-password endpoint (and logout)
 *   SHALL be denied with a signal that a password change is required.
 *
 * Scenarios exercised (unit — no DB, no DI container; real classes over fakes):
 *
 *   1. Valid session for an allowed user is accepted — guard returns true and
 *      attaches the principal.
 *
 *   2. Missing or invalid session is rejected — guard throws 401 before reaching
 *      any route handler.
 *
 *   3. Disabled user is denied on next request — allowed=false in the DB means
 *      the next request is rejected 401, even with an otherwise valid session token.
 *
 *   4. Pending password change blocks protected actions — mustChangePassword user
 *      is denied with HTTP 403 carrying `{ error: 'password_change_required' }` on
 *      any protected route; the change-password endpoint itself is still reachable.
 *
 * Run from apps/api with: pnpm test
 * (pretest builds to dist/; node --test picks up dist/**\/*.spec.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { AuthSessionService } from './auth-session.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** A fake Prisma session row with optional overrides. */
interface FakeSessionRow {
  tokenHash: string;
  expiresAt: Date;
  user: {
    githubId: number | null;
    login: string;
    name: string;
    avatarUrl: string;
    allowed: boolean;
    role: string;
    mustChangePassword: boolean;
  };
}

const FAR_FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

/** Create a Prisma double whose session.findFirst returns `row` (or null). */
function makePrisma(row: FakeSessionRow | null) {
  return {
    session: {
      findFirst: async (_args: unknown): Promise<FakeSessionRow | null> => row,
    },
  };
}

function serviceOver(prisma: unknown): AuthSessionService {
  return new AuthSessionService(prisma as never);
}

/** Build a guard whose injected service delegates to a real AuthSessionService over `prisma`. */
function guardOverPrisma(prisma: unknown): AuthGuard {
  const svc = serviceOver(prisma);
  return new AuthGuard(svc as unknown as AuthSessionService);
}

/** Fake ExecutionContext wrapping a minimal Express-like request. */
interface FakeContext {
  request: AuthenticatedRequest;
  switchToHttp: () => { getRequest: () => unknown };
}

function ctx(opts: { path?: string; cookie?: string; authorization?: string } = {}): FakeContext {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  const request = { path: opts.path ?? '/v1/tasks', url: opts.path ?? '/v1/tasks', headers };
  return {
    request: request as unknown as AuthenticatedRequest,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

async function activate(guard: AuthGuard, context: FakeContext) {
  try {
    const ok = await guard.canActivate(
      context as unknown as Parameters<AuthGuard['canActivate']>[0],
    );
    return { ok, threw: false, status: 0, errorCode: null as string | null };
  } catch (e) {
    const status = (e as { getStatus?: () => number }).getStatus?.() ?? 0;
    const response = (e as { getResponse?: () => unknown }).getResponse?.();
    const errorCode =
      response && typeof response === 'object' && 'error' in response
        ? (response as { error: string }).error
        : null;
    return { ok: false, threw: true, status, errorCode };
  }
}

// ---------------------------------------------------------------------------
// The raw token used across all scenarios
// ---------------------------------------------------------------------------
const RAW_TOKEN = 'cap_session_rest_validation_test_token';
const SESSION_COOKIE = `cap_session=${RAW_TOKEN}`;

/** Build a default session row for the given allowed / mustChangePassword state. */
function sessionRow(opts: {
  allowed?: boolean;
  mustChangePassword?: boolean;
}): FakeSessionRow {
  return {
    tokenHash: sha256Hex(RAW_TOKEN),
    expiresAt: FAR_FUTURE,
    user: {
      githubId: 42,
      login: 'testuser',
      name: 'Test User',
      avatarUrl: '',
      allowed: opts.allowed ?? true,
      role: 'member',
      mustChangePassword: opts.mustChangePassword ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Valid session for an allowed user is accepted
// ---------------------------------------------------------------------------

test('REST session validation: valid session for an allowed user is accepted (guard returns true, principal attached)', async () => {
  const prisma = makePrisma(sessionRow({ allowed: true }));
  const guard = guardOverPrisma(prisma);
  const context = ctx({ path: '/v1/tasks', cookie: SESSION_COOKIE });

  const result = await activate(guard, context);

  assert.equal(result.ok, true, 'valid session must be admitted');
  assert.equal(result.threw, false, 'guard must not throw for a valid session');
  // Guard attaches the resolved principal to the request.
  assert.ok(
    context.request.operatorPrincipal !== undefined,
    'principal must be attached to the request for downstream handlers',
  );
  assert.equal(context.request.operatorPrincipal?.kind, 'session');
});

// ---------------------------------------------------------------------------
// Scenario 2: Missing or invalid session is rejected with 401
// ---------------------------------------------------------------------------

test('REST session validation: missing session credential → 401, no state change', async () => {
  // No DB row needed; the guard never reaches the service when no cookie is present.
  const prisma = makePrisma(null);
  const guard = guardOverPrisma(prisma);
  // No cookie, no Authorization header.
  const context = ctx({ path: '/v1/tasks' });

  const result = await activate(guard, context);

  assert.equal(result.threw, true, 'guard must throw on missing credential');
  assert.equal(result.status, 401, 'missing session must yield HTTP 401');
  assert.equal(
    context.request.operatorPrincipal,
    undefined,
    'no principal must be attached when rejected',
  );
});

test('REST session validation: invalid/revoked session cookie → 401 (not found in DB)', async () => {
  // Prisma returns null for any token (simulates unknown / revoked session).
  const prisma = makePrisma(null);
  const guard = guardOverPrisma(prisma);
  const context = ctx({
    path: '/v1/tasks',
    cookie: 'cap_session=invalid_or_revoked_token_xyz',
  });

  const result = await activate(guard, context);

  assert.equal(result.threw, true, 'guard must throw on invalid session');
  assert.equal(result.status, 401, 'invalid session must yield HTTP 401');
});

test('REST session validation: malformed Authorization header → 401', async () => {
  const prisma = makePrisma(null);
  const guard = guardOverPrisma(prisma);
  // A malformed bearer (extra spaces, wrong scheme) must not authenticate.
  const context = ctx({
    path: '/v1/tasks',
    authorization: 'Basic dXNlcjpwYXNz',
  });

  const result = await activate(guard, context);

  assert.equal(result.threw, true, 'guard must throw on malformed authorization header');
  assert.equal(result.status, 401, 'malformed bearer must yield HTTP 401');
});

// ---------------------------------------------------------------------------
// Scenario 3: Disabled user is denied on next request (allowed re-checked at request time)
// ---------------------------------------------------------------------------

test('REST session validation: user.allowed=false while holding a live session → 401 on next request', async () => {
  // Same token, same session row — ONLY allowed changed to false.
  // The gate is re-confirmed at request time (resolveSession reads User.allowed
  // from DB on every call), so the very next request is denied.
  const prisma = makePrisma(sessionRow({ allowed: false }));
  const guard = guardOverPrisma(prisma);
  const context = ctx({ path: '/v1/tasks', cookie: SESSION_COOKIE });

  const result = await activate(guard, context);

  assert.equal(result.threw, true, 'disabled user must be denied');
  assert.equal(
    result.status,
    401,
    'disabling an account denies its in-flight sessions on their next request (401)',
  );
  assert.equal(
    context.request.operatorPrincipal,
    undefined,
    'no principal must be attached when denied',
  );
});

// ---------------------------------------------------------------------------
// Scenario 4: Pending password change blocks protected actions (403)
// ---------------------------------------------------------------------------

test('REST session validation: mustChangePassword user → 403 password_change_required on a protected route', async () => {
  const prisma = makePrisma(sessionRow({ mustChangePassword: true }));
  const guard = guardOverPrisma(prisma);
  const context = ctx({ path: '/v1/tasks', cookie: SESSION_COOKIE });

  const result = await activate(guard, context);

  assert.equal(result.threw, true, 'guard must block a mustChangePassword user');
  assert.equal(
    result.status,
    403,
    'must-change block is HTTP 403 (not 401) so the client can distinguish "authenticated but must change password"',
  );
  assert.equal(
    result.errorCode,
    'password_change_required',
    'error code must be "password_change_required" so the frontend can show the forced-change dialog',
  );
});

test('REST session validation: mustChangePassword user CAN reach /auth/change-password (exempt path)', async () => {
  const prisma = makePrisma(sessionRow({ mustChangePassword: true }));
  const guard = guardOverPrisma(prisma);
  // /auth/change-password is in PUBLIC_AUTH_PATHS; the guard returns true before
  // resolving any principal, so the must-change chokepoint is never reached.
  const context = ctx({ path: '/auth/change-password', cookie: SESSION_COOKIE });

  const result = await activate(guard, context);

  assert.equal(result.ok, true, '/auth/change-password must be reachable for a must-change user');
  assert.equal(result.threw, false);
});

test('REST session validation: normal (no mustChangePassword) user passes protected routes', async () => {
  const prisma = makePrisma(sessionRow({ mustChangePassword: false }));
  const guard = guardOverPrisma(prisma);
  const context = ctx({ path: '/v1/tasks', cookie: SESSION_COOKIE });

  const result = await activate(guard, context);

  assert.equal(result.ok, true, 'normal session must be admitted to protected routes');
  assert.equal(result.threw, false);
});
