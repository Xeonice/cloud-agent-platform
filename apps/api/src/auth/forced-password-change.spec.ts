/**
 * Ground-truth test: "Forced first-login password change"
 * (add-private-account-identity, spec password-login §Requirement:
 * "Forced first-login password change").
 *
 * Requirement summary (from spec):
 *   - An account flagged `mustChangePassword` SHALL be denied every protected
 *     action other than the change-password endpoint (and logout) until a new
 *     password is set.
 *   - The block MUST return a distinct 403 (not 401) so the client can
 *     distinguish "authenticated but must change password" from "unauthenticated".
 *
 * Exercises:
 *   1. `AuthSessionService.requiresPasswordChange`: returns `true` for a live
 *      session whose user has `mustChangePassword = true`, `false` for a normal
 *      user.
 *   2. `AuthGuard.canActivate`: a valid session with `mustChangePassword` is
 *      blocked with HTTP 403 carrying `{ error: 'password_change_required' }`
 *      on every protected route; the change-password endpoint itself is exempt
 *      (in OAUTH_EXEMPT_PATHS, so the guard returns `true` before reaching the
 *      must-change chokepoint).
 *
 * No DB, no DI container. Uses real classes over fake Prisma doubles.
 *
 * Run from apps/api with: pnpm test
 * (pretest builds to dist/; node --test picks up dist/**\/*.spec.js)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { AuthSessionService } from './auth-session.service';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Shape of a Session row as requiresPasswordChange reads it. */
interface FakeSessionRow {
  tokenHash: string;
  expiresAt: Date;
  user: {
    allowed: boolean;
    mustChangePassword: boolean;
  };
}

/**
 * Fake Prisma that stubs `session.findFirst` (used by `requiresPasswordChange`
 * and `resolveSession`) and the audit service (unused on this path).
 */
function makePrisma(row: FakeSessionRow | null) {
  return {
    session: {
      findFirst: async (_args: unknown): Promise<FakeSessionRow | null> => row,
    },
  };
}

function serviceOver(prisma: unknown): AuthSessionService {
  return new AuthSessionService(prisma as never, null as never);
}

const FAR_FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const RAW_TOKEN = 'cap_session_test_forced_change_scenario';

function sessionRow(opts: {
  allowed?: boolean;
  mustChangePassword?: boolean;
}): FakeSessionRow {
  return {
    tokenHash: sha256Hex(RAW_TOKEN),
    expiresAt: FAR_FUTURE,
    user: {
      allowed: opts.allowed ?? true,
      mustChangePassword: opts.mustChangePassword ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// Helper — fake ExecutionContext (mirrors auth.guard.spec.ts)
// ---------------------------------------------------------------------------

interface FakeContext {
  request: AuthenticatedRequest;
  switchToHttp: () => { getRequest: () => unknown };
}

function ctx(opts: { path?: string; cookie?: string } = {}): FakeContext {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  const request = { path: opts.path ?? '/tasks', url: opts.path ?? '/tasks', headers };
  return {
    request: request as unknown as AuthenticatedRequest,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

/**
 * Build a guard whose injected session service:
 *  - resolves `RAW_TOKEN` to a VALID session user (so the guard's
 *    `resolveSession` step succeeds), and
 *  - forwards `requiresPasswordChange` to the real service built on `prisma`.
 */
function guardWith(prisma: unknown): AuthGuard {
  const svc = serviceOver(prisma);
  const fake: Pick<AuthSessionService, 'resolveSession' | 'resolveApiKey' | 'resolveMcpToken' | 'requiresPasswordChange'> = {
    // resolveSession: token resolves when it matches RAW_TOKEN
    resolveSession: async (token: string | undefined | null) => {
      if (token !== RAW_TOKEN) return null;
      // We only care that the session resolves to a user — the flag is checked separately
      return {
        githubId: null,
        login: 'testuser',
        name: 'Test User',
        avatarUrl: '',
        allowed: true,
        role: 'member',
        mustChangePassword: false,
      };
    },
    // Forward requiresPasswordChange to the real service
    requiresPasswordChange: (token) => svc.requiresPasswordChange(token),
    // No API keys / MCP tokens in these tests
    resolveApiKey: async () => null,
    resolveMcpToken: async () => null,
  };
  return new AuthGuard(fake as unknown as AuthSessionService);
}

/** Run canActivate and return the result / thrown HTTP status. */
async function activate(guard: AuthGuard, context: FakeContext) {
  try {
    const ok = await guard.canActivate(context as unknown as Parameters<AuthGuard['canActivate']>[0]);
    return { ok, threw: false, status: 0, error: null as string | null };
  } catch (e) {
    const status = (e as { getStatus?: () => number }).getStatus?.() ?? 0;
    // ForbiddenException carries a `response` object
    const response = (e as { getResponse?: () => unknown }).getResponse?.();
    const errorCode =
      response && typeof response === 'object' && 'error' in response
        ? (response as { error: string }).error
        : null;
    return { ok: false, threw: true, status, error: errorCode };
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: requiresPasswordChange returns true for mustChangePassword users
// ---------------------------------------------------------------------------

test('requiresPasswordChange: returns true for a live session with mustChangePassword = true', async () => {
  const svc = serviceOver(makePrisma(sessionRow({ mustChangePassword: true })));
  const result = await svc.requiresPasswordChange(RAW_TOKEN);
  assert.equal(result, true, 'must return true when mustChangePassword is set');
});

test('requiresPasswordChange: returns false for a normal session (mustChangePassword = false)', async () => {
  const svc = serviceOver(makePrisma(sessionRow({ mustChangePassword: false })));
  const result = await svc.requiresPasswordChange(RAW_TOKEN);
  assert.equal(result, false, 'must return false for a normal authenticated user');
});

test('requiresPasswordChange: returns false for an unknown / null token', async () => {
  const svc = serviceOver(makePrisma(null)); // no session in DB
  const result = await svc.requiresPasswordChange(RAW_TOKEN);
  assert.equal(result, false, 'unknown token => no forced change');
});

test('requiresPasswordChange: returns false for an expired session', async () => {
  const expiredRow: FakeSessionRow = {
    ...sessionRow({ mustChangePassword: true }),
    expiresAt: new Date(Date.now() - 1000), // already expired
  };
  const svc = serviceOver(makePrisma(expiredRow));
  const result = await svc.requiresPasswordChange(RAW_TOKEN);
  assert.equal(result, false, 'expired session => no forced change (guard denies it first)');
});

test('requiresPasswordChange: returns false for a disabled user even with mustChangePassword = true', async () => {
  const svc = serviceOver(
    makePrisma(sessionRow({ allowed: false, mustChangePassword: true })),
  );
  const result = await svc.requiresPasswordChange(RAW_TOKEN);
  assert.equal(result, false, 'disabled user is denied by the allowed gate, not the change gate');
});

// ---------------------------------------------------------------------------
// Scenario 2 (guard-level): Blocking a protected route with a 403
// "Forced first-login password change" → must-change account is blocked
// ---------------------------------------------------------------------------

const SESSION_COOKIE = `cap_session=${RAW_TOKEN}`;

test('guard: a mustChangePassword session is BLOCKED with HTTP 403 on a protected route', async () => {
  const prisma = makePrisma(sessionRow({ mustChangePassword: true }));
  const guard = guardWith(prisma);

  const result = await activate(guard, ctx({ path: '/v1/tasks', cookie: SESSION_COOKIE }));

  assert.equal(result.threw, true, 'guard must throw (deny the request)');
  assert.equal(result.status, 403, 'blocked with HTTP 403, NOT 401');
  assert.equal(
    result.error,
    'password_change_required',
    'error code is "password_change_required" so the frontend can show the forced-change dialog',
  );
});

test('guard: a normal (no mustChangePassword) session passes a protected route', async () => {
  const prisma = makePrisma(sessionRow({ mustChangePassword: false }));
  const guard = guardWith(prisma);

  const result = await activate(guard, ctx({ path: '/v1/tasks', cookie: SESSION_COOKIE }));

  assert.equal(result.ok, true, 'normal session must be admitted to protected routes');
  assert.equal(result.threw, false);
});

// ---------------------------------------------------------------------------
// Scenario 3 (guard-level): change-password endpoint is EXEMPT
// (it is in OAUTH_EXEMPT_PATHS, so the guard returns true before the
//  must-change chokepoint is reached)
// ---------------------------------------------------------------------------

test('guard: /auth/change-password is EXEMPT from the must-change block (a mustChangePassword user can reach it)', async () => {
  const prisma = makePrisma(sessionRow({ mustChangePassword: true }));
  const guard = guardWith(prisma);

  // /auth/change-password is in OAUTH_EXEMPT_PATHS — the guard returns true
  // before resolving any principal, so requiresPasswordChange is never called.
  const result = await activate(
    guard,
    ctx({ path: '/auth/change-password', cookie: SESSION_COOKIE }),
  );

  assert.equal(result.ok, true, '/auth/change-password must be reachable even with mustChangePassword');
  assert.equal(result.threw, false);
});

test('guard: /auth/logout is EXEMPT (a mustChangePassword user can log out)', async () => {
  const prisma = makePrisma(sessionRow({ mustChangePassword: true }));
  const guard = guardWith(prisma);

  const result = await activate(
    guard,
    ctx({ path: '/auth/logout', cookie: SESSION_COOKIE }),
  );

  assert.equal(result.ok, true, '/auth/logout must be reachable even with mustChangePassword');
  assert.equal(result.threw, false);
});
