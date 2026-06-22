/**
 * MCP-token resolution + `/mcp` guard-routing spec (remote-mcp-server,
 * tasks 3.2 / 3.3 / 3.4 / 3.5; plus the controller-escalation half of 3.7).
 *
 * Exercises the REAL composed admission decision across three units that the
 * settings-minted MCP credential threads through — none of which is fully
 * covered by a single pure helper:
 *
 *   - {@link AuthSessionService.resolveMcpToken} against a fake Prisma + explicit
 *     env: a valid non-expired token resolves to a FULL `AuthInfo` (G1:
 *     `expiresAt` populated in seconds + `scopes`); a revoked/expired token and a
 *     de-allowlisted OWNER each resolve to `null` (allowlist RE-checked every call).
 *   - {@link AuthGuard}: an `mcp_` bearer is prefix-ROUTED to `resolveMcpToken`
 *     (never tried as a session/legacy candidate) and yields an `mcp` principal
 *     carrying owner + scopes; an invalid `mcp_` bearer is 401; `/mcp` is
 *     EXACT-MATCH exempt from the SESSION guard (admitted with NO principal so
 *     `requireBearerAuth` gates it downstream), while a `/v1` data route with no
 *     credential stays 401.
 *   - {@link McpTokensController}: a non-`session` principal (an `mcp` machine
 *     credential, or the legacy shared-token operator) is 403 on mint/list/revoke
 *     — a credential cannot manage another (3.7).
 *
 * Run from apps/api with: pnpm test
 * (pretest compiles to dist/ via nest build; node --test picks up dist/**\/*.spec.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import {
  AuthSessionService,
  MCP_RESOURCE_URI,
  type McpAuthInfo,
} from './auth-session.service';
import { McpTokensController } from '../mcp-tokens/mcp-tokens.controller';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const OWNER_GITHUB_ID = 12345;
const ALLOWLIST = String(OWNER_GITHUB_ID);

/** A stored MCP-token row shape, as `resolveMcpToken` reads it (with owner). */
interface FakeMcpTokenRow {
  id: string;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  // `allowed` is the pure-DB runtime gate `resolveMcpToken` re-confirms
  // (add-private-account-identity task 2.5 / D2 — replacing the old
  // `isAllowlistedRaw(githubId, AUTH_ALLOWLIST)` gate). `githubId` is carried only
  // for `ownerGithubId` attribution; it is NULLABLE (a local-account owner has no
  // github identity).
  user: { githubId: number | null; allowed: boolean };
}

/**
 * A minimal in-memory Prisma double exposing only what `resolveMcpToken` touches:
 * `mcpToken.findUnique` (by `tokenHash`) and a best-effort `mcpToken.update`
 * (the `lastUsedAt` bump — recorded so the test can assert it is fire-and-forget).
 */
function makePrisma(row: FakeMcpTokenRow | null) {
  const calls = { updates: 0 };
  return {
    calls,
    mcpToken: {
      findUnique: async (_args: unknown): Promise<FakeMcpTokenRow | null> => row,
      update: async (_args: unknown): Promise<FakeMcpTokenRow> => {
        calls.updates += 1;
        // Resolve eagerly so the awaited `.catch()` in the bump never rejects.
        return row as FakeMcpTokenRow;
      },
    },
  };
}

/**
 * Construct a real `AuthSessionService` over a fake Prisma. The `audit`
 * dependency (added with the github-login auto-link audit, add-private-account-
 * identity) is irrelevant to the `resolveMcpToken` path this spec exercises, so a
 * `null` stand-in is passed for it — the token-resolution code never touches it.
 */
function serviceOver(prisma: unknown): AuthSessionService {
  return new AuthSessionService(prisma as never, null as never);
}

/** A fake ExecutionContext carrying the request so a test can read the attached principal. */
interface FakeContext {
  request: AuthenticatedRequest;
  switchToHttp: () => { getRequest: () => unknown };
}

/** Build a fake Nest ExecutionContext around a plain Express-like request. */
function ctx(opts: { path?: string; cookie?: string; authorization?: string } = {}): FakeContext {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  const request = { path: opts.path ?? '/tasks', url: opts.path ?? '/tasks', headers };
  return {
    request: request as unknown as AuthenticatedRequest,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

/** A guard whose injected session service admits only `liveSession`, and resolves
 *  exactly `liveMcp` to `authInfo` (every other token -> null). */
function guardWith(opts: {
  liveSession?: string;
  liveMcp?: string;
  authInfo?: McpAuthInfo;
}): AuthGuard {
  const fake = {
    resolveSession: async (token: string) =>
      opts.liveSession && token === opts.liveSession
        ? { githubId: OWNER_GITHUB_ID, login: 'op', name: 'Operator', avatarUrl: '', allowed: true }
        : null,
    resolveMcpToken: async (token: string) =>
      opts.liveMcp && token === opts.liveMcp ? (opts.authInfo ?? null) : null,
  };
  return new AuthGuard(fake as unknown as AuthSessionService);
}

async function activate(guard: AuthGuard, context: FakeContext) {
  try {
    const ok = await guard.canActivate(context as unknown as Parameters<AuthGuard['canActivate']>[0]);
    return { ok, threw: false, status: 0 };
  } catch (e) {
    const status = (e as { getStatus?: () => number }).getStatus?.() ?? 0;
    return { ok: false, threw: true, status };
  }
}

// ---------------------------------------------------------------------------
// 3.2 — resolveMcpToken returns a FULL AuthInfo / re-checks the allowlist
// ---------------------------------------------------------------------------

test('resolveMcpToken: a valid non-expired token -> a full AuthInfo (G1: expiresAt + scopes)', async () => {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const prisma = makePrisma({
    id: 'tok-1',
    scopes: ['tasks:read', 'tasks:write'],
    expiresAt,
    revokedAt: null,
    user: { githubId: OWNER_GITHUB_ID, allowed: true },
  });
  const svc = serviceOver(prisma);

  const info = await svc.resolveMcpToken('mcp_valid', { AUTH_ALLOWLIST: ALLOWLIST });
  assert.ok(info, 'a valid token resolves');
  assert.equal(info!.clientId, 'settings');
  assert.deepEqual(info!.scopes, ['tasks:read', 'tasks:write']);
  // G1: expiresAt MUST be populated (seconds since epoch), or requireBearerAuth 401s it.
  assert.equal(typeof info!.expiresAt, 'number');
  assert.equal(info!.expiresAt, Math.floor(expiresAt.getTime() / 1000));
  assert.equal(info!.resource, MCP_RESOURCE_URI);
  assert.equal(info!.ownerGithubId, OWNER_GITHUB_ID);
});

test('resolveMcpToken: a never-expiring token still gets a populated (far-future) expiresAt (G1)', async () => {
  const prisma = makePrisma({
    id: 'tok-2',
    scopes: ['repos:read'],
    expiresAt: null,
    revokedAt: null,
    user: { githubId: OWNER_GITHUB_ID, allowed: true },
  });
  const info = await serviceOver(prisma).resolveMcpToken('mcp_noexp', {
    AUTH_ALLOWLIST: ALLOWLIST,
  });
  assert.ok(info, 'a never-expiring token still resolves');
  // Never UNDEFINED — that would 401 every valid token.
  assert.equal(typeof info!.expiresAt, 'number');
  assert.ok(info!.expiresAt > Math.floor(Date.now() / 1000), 'far-future bound');
});

test('resolveMcpToken: a revoked token resolves to null', async () => {
  const prisma = makePrisma({
    id: 'tok-3',
    scopes: ['tasks:read'],
    expiresAt: null,
    revokedAt: new Date(Date.now() - 1000),
    user: { githubId: OWNER_GITHUB_ID, allowed: true },
  });
  assert.equal(
    await serviceOver(prisma).resolveMcpToken('mcp_revoked', { AUTH_ALLOWLIST: ALLOWLIST }),
    null,
  );
});

test('resolveMcpToken: an expired token resolves to null', async () => {
  const prisma = makePrisma({
    id: 'tok-4',
    scopes: ['tasks:read'],
    expiresAt: new Date(Date.now() - 1000),
    revokedAt: null,
    user: { githubId: OWNER_GITHUB_ID, allowed: true },
  });
  assert.equal(
    await serviceOver(prisma).resolveMcpToken('mcp_expired', { AUTH_ALLOWLIST: ALLOWLIST }),
    null,
  );
});

test('resolveMcpToken: a de-allowlisted OWNER is rejected on the next call (allowed re-checked)', async () => {
  // The runtime gate is now the pure-DB `user.allowed`, re-confirmed at every
  // resolution (add-private-account-identity task 2.5 / D2 — NOT `AUTH_ALLOWLIST`).
  // Same stored token, two owner states: allowed resolves; a flip to
  // `allowed: false` (the admin-driven revocation path) is rejected on the next
  // call.
  const allowed = makePrisma({
    id: 'tok-5',
    scopes: ['tasks:read'],
    expiresAt: null,
    revokedAt: null,
    user: { githubId: OWNER_GITHUB_ID, allowed: true },
  });
  const revoked = makePrisma({
    id: 'tok-5',
    scopes: ['tasks:read'],
    expiresAt: null,
    revokedAt: null,
    user: { githubId: OWNER_GITHUB_ID, allowed: false },
  });
  assert.ok(await serviceOver(allowed).resolveMcpToken('mcp_x'));
  assert.equal(await serviceOver(revoked).resolveMcpToken('mcp_x'), null);
});

test('resolveMcpToken: an unknown token (no matching hash) resolves to null', async () => {
  const prisma = makePrisma(null);
  assert.equal(
    await serviceOver(prisma).resolveMcpToken('mcp_unknown', { AUTH_ALLOWLIST: ALLOWLIST }),
    null,
  );
});

// ---------------------------------------------------------------------------
// 3.3 / 3.4 — guard prefix-routes mcp_ to an `mcp` principal; /mcp is exempt
// ---------------------------------------------------------------------------

const VALID_AUTHINFO: McpAuthInfo = {
  token: 'mcp_live',
  clientId: 'settings',
  scopes: ['tasks:read'],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  resource: MCP_RESOURCE_URI,
  ownerGithubId: OWNER_GITHUB_ID,
};

test('guard: an mcp_ bearer presented to a non-/mcp route resolves to an `mcp` machine principal carrying scopes (prefix-routed, never session)', async () => {
  const guard = guardWith({ liveMcp: 'mcp_live', authInfo: VALID_AUTHINFO });
  const c = ctx({ path: '/v1/tasks', authorization: 'Bearer mcp_live' });
  const r = await activate(guard, c);
  assert.equal(r.ok, true);
  // remote-mcp-server task 3.3: the `mcp_` bearer is prefix-ROUTED through the
  // `resolveMcp` slot of `resolveOperatorPrincipal` to an `operatorPrincipal` of
  // kind `'mcp'` (a MACHINE principal, `user === null`) carrying the token's
  // scopes — never tried as a session/legacy/api-key credential. A session-only
  // endpoint rejects it on `kind !== 'session'`.
  const principal = c.request.operatorPrincipal;
  assert.equal(principal?.kind, 'mcp');
  assert.equal(principal?.user, null);
  assert.deepEqual(principal?.scopes, ['tasks:read']);
});

test('guard: an invalid mcp_ bearer is 401 (fail-closed, no principal attached)', async () => {
  const guard = guardWith({ liveMcp: 'mcp_live', authInfo: VALID_AUTHINFO });
  const c = ctx({ path: '/v1/tasks', authorization: 'Bearer mcp_revoked' });
  const r = await activate(guard, c);
  assert.equal(r.threw, true);
  assert.equal(r.status, 401);
  assert.equal(c.request.operatorPrincipal, undefined);
});

test('guard: /mcp is EXACT-MATCH exempt from the session guard (admitted with no principal)', async () => {
  const guard = guardWith({ liveSession: 'live' });
  const c = ctx({ path: '/mcp' }); // no bearer, no cookie
  const r = await activate(guard, c);
  assert.equal(r.ok, true, '/mcp passes the session guard (requireBearerAuth gates it downstream)');
  assert.equal(c.request.operatorPrincipal, undefined, 'no operator principal attached for /mcp');
});

test('guard: a /v1 data route without a bearer stays 401 while /mcp is exempt (G8 exact-match)', async () => {
  const guard = guardWith({ liveSession: 'live' });
  const r = await activate(guard, ctx({ path: '/v1/tasks' }));
  assert.equal(r.threw, true);
  assert.equal(r.status, 401);
  // A sibling path under /mcp* is NOT exempted by an exact match.
  const sibling = await activate(guard, ctx({ path: '/mcp/extra' }));
  assert.equal(sibling.threw, true, '/mcp/extra is NOT exempt (exact match only)');
  assert.equal(sibling.status, 401);
});

// ---------------------------------------------------------------------------
// 3.7 — the MCP-token CRUD rejects a machine principal (no escalation)
// ---------------------------------------------------------------------------

/** A controller over a service that throws if reached — proves the 403 is BEFORE any call. */
function controllerNeverCalled(): McpTokensController {
  const service = {
    mint: async () => { throw new Error('service must not be reached'); },
    list: async () => { throw new Error('service must not be reached'); },
    revoke: async () => { throw new Error('service must not be reached'); },
  };
  return new McpTokensController(service as never);
}

function reqWith(slots: Partial<AuthenticatedRequest>): AuthenticatedRequest {
  return slots as unknown as AuthenticatedRequest;
}

test('CRUD: an mcp machine principal is 403 on mint/list/revoke (no escalation, service untouched)', async () => {
  const controller = controllerNeverCalled();
  // The guard resolves an `mcp_` token (via the prefix-routed `resolveMcp` slot)
  // to an `operatorPrincipal` of kind `'mcp'`; the CRUD requires a `'session'`
  // operator, so a non-session principal is refused outright (`kind !== 'session'`).
  const req = reqWith({
    operatorPrincipal: { kind: 'mcp', user: null, scopes: ['tasks:read'] } as never,
  });

  for (const call of [
    () => controller.mint(req, { name: 'x', scopes: ['tasks:read'] } as never),
    () => controller.list(req),
    () => controller.revoke(req, 'some-id'),
  ]) {
    const status = await call().then(
      () => 0,
      (e: { getStatus?: () => number }) => e.getStatus?.() ?? -1,
    );
    assert.equal(status, 403, 'machine credential is forbidden from the MCP-token CRUD');
  }
});

test('CRUD: the legacy shared-token operator (no GitHub identity) is 403 on the CRUD', async () => {
  const controller = controllerNeverCalled();
  const req = reqWith({ operatorPrincipal: { kind: 'legacy-token', user: null } });
  const status = await controller.list(req).then(
    () => 0,
    (e: { getStatus?: () => number }) => e.getStatus?.() ?? -1,
  );
  assert.equal(status, 403);
});

test('CRUD: list never leaks the raw token or its hash (only non-secret metadata)', async () => {
  const sessionPrincipal = {
    kind: 'session',
    user: { githubId: OWNER_GITHUB_ID, login: 'op', name: 'Operator', avatarUrl: '', allowed: true },
  };
  const listItem = {
    id: 'tok-1',
    name: 'CI token',
    scopes: ['tasks:read'],
    prefix: 'mcp_',
    last4: 'ab12',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
  const service = { list: async () => [listItem] };
  const controller = new McpTokensController(service as never);
  const res = await controller.list(reqWith({ operatorPrincipal: sessionPrincipal as never }));
  const serialized = JSON.stringify(res);
  assert.ok(!/token"\s*:\s*"mcp_/.test(serialized), 'no raw mcp_ token in the list payload');
  assert.ok(!/hash/i.test(serialized), 'no hash field in the list payload');
  assert.deepEqual(res.tokens[0], listItem);
});
