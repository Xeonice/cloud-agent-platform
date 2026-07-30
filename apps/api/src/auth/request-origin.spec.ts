import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthGuard } from './auth.guard';
import type { AuthSessionService } from './auth-session.service';
import type { McpAuthInfo } from './auth-session.service';

/**
 * A cookie the browser attaches by itself is a cookie an attacker's page can
 * make it attach. In the cross-origin deployment shape the session cookie is
 * `SameSite=None` (console on one origin, API on another), which is precisely
 * the setting that lets a third-party page drive an authenticated state change.
 * CORS does not stop it: it governs whether a response may be READ, not whether
 * a request is SENT, and a state change needs no readable response.
 *
 * So a state-changing request that authenticated by session cookie must declare
 * an origin the deployment trusts. Requests that authenticated by a bearer
 * credential are exempt — `AuthGuard.extractBearerToken` reads them only from
 * `Authorization`, a header a browser will not attach cross-site on its own.
 *
 * These cases pin both directions: the forgery is refused, and every legitimate
 * caller still gets through.
 */

const SESSION_TOKEN = 'live-session-token';
const CONSOLE_ORIGIN = 'https://console.example.com';
const FOREIGN_ORIGIN = 'https://evil.example';
const API_HOST = 'api.example.com';

/**
 * Restores every env key a case touched, so ordering cannot leak between them.
 * AWAITS `run` before restoring — a synchronous `finally` around an async body
 * would put the env back before the assertion ever reads it, which silently
 * turns "admitted because trusted" into "refused because the list was empty".
 */
async function withEnv(
  patch: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function guard(opts: { mcpToken?: string; authInfo?: McpAuthInfo } = {}): AuthGuard {
  const fake = {
    resolveSession: async (token: string) =>
      token === SESSION_TOKEN
        ? { id: 'user-1', githubId: 99, login: 'op', name: 'Op', avatarUrl: '', allowed: true }
        : null,
    resolveApiKey: async () => null,
    resolveMcpToken: async (token: string) =>
      opts.mcpToken && token === opts.mcpToken ? (opts.authInfo ?? null) : null,
    requiresPasswordChange: () => false,
  };
  return new AuthGuard(fake as unknown as AuthSessionService);
}

function context(opts: {
  method: string;
  origin?: string;
  cookie?: string;
  authorization?: string;
  path?: string;
}) {
  const headers: Record<string, string> = { host: API_HOST };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  const path = opts.path ?? '/tasks';
  const request = { method: opts.method, path, url: path, headers };
  return {
    request,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

async function activate(g: AuthGuard, ctx: ReturnType<typeof context>) {
  try {
    const ok = await g.canActivate(
      ctx as unknown as Parameters<AuthGuard['canActivate']>[0],
    );
    return { admitted: ok === true, status: 0 };
  } catch (error) {
    const status = (error as { getStatus?: () => number }).getStatus?.() ?? 0;
    return { admitted: false, status };
  }
}

const sessionCookie = `cap_session=${SESSION_TOKEN}`;

test('a state change from a foreign origin with a session cookie is refused', async () => {
  await withEnv({ WEB_ORIGIN: CONSOLE_ORIGIN }, async () => {
    const result = await activate(
      guard(),
      context({ method: 'POST', origin: FOREIGN_ORIGIN, cookie: sessionCookie }),
    );
    assert.equal(result.admitted, false, 'a cross-site forged write must not reach the handler');
  });
});

test('a state change with a session cookie and NO origin is refused', async () => {
  await withEnv({ WEB_ORIGIN: CONSOLE_ORIGIN }, async () => {
    const result = await activate(
      guard(),
      context({ method: 'POST', cookie: sessionCookie }),
    );
    assert.equal(
      result.admitted,
      false,
      'treating an absent Origin as trusted would leave the hole open to any client that omits it',
    );
  });
});

test('the configured console origin is admitted', async () => {
  await withEnv({ WEB_ORIGIN: CONSOLE_ORIGIN }, async () => {
    const result = await activate(
      guard(),
      context({ method: 'POST', origin: CONSOLE_ORIGIN, cookie: sessionCookie }),
    );
    assert.equal(result.admitted, true, 'the console must keep working');
  });
});

test('a same-origin state change is admitted even with no WEB_ORIGIN configured', async () => {
  // An unset WEB_ORIGIN *means* a same-origin deployment (auth-config documents
  // this, and the cookie is SameSite=Lax there). Rejecting the install's own
  // console because the allow-list is empty would break every same-host deploy.
  await withEnv({ WEB_ORIGIN: undefined }, async () => {
    const result = await activate(
      guard(),
      context({ method: 'POST', origin: `https://${API_HOST}`, cookie: sessionCookie }),
    );
    assert.equal(result.admitted, true, 'same-origin is not cross-site forgery');
  });
});

test('a safe method from a foreign origin is not refused by this rule', async () => {
  await withEnv({ WEB_ORIGIN: CONSOLE_ORIGIN }, async () => {
    const result = await activate(
      guard(),
      context({ method: 'GET', origin: FOREIGN_ORIGIN, cookie: sessionCookie }),
    );
    assert.equal(
      result.admitted,
      true,
      'reads are governed by response-sharing rules, not by this check',
    );
  });
});

test('a bearer-authenticated state change with no origin is admitted', async () => {
  const authInfo = {
    token: 'mcp_live',
    clientId: 'settings',
    scopes: ['tasks:write'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: 'https://api.example.com/mcp',
    owner: {
      id: 'user-1',
      githubId: 99,
      login: 'op',
      name: 'Op',
      avatarUrl: '',
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
    ownerGithubId: 99,
    ownerId: 'user-1',
  } as unknown as McpAuthInfo;

  await withEnv({ WEB_ORIGIN: CONSOLE_ORIGIN }, async () => {
    const result = await activate(
      guard({ mcpToken: 'mcp_live', authInfo }),
      context({ method: 'POST', authorization: 'Bearer mcp_live' }),
    );
    assert.equal(
      result.admitted,
      true,
      'a browser cannot attach an Authorization header cross-site; exempting bearer callers costs nothing',
    );
  });
});

test('a legacy shared-token state change with no origin is admitted (bearer, so exempt)', async () => {
  // Encodes the decision the design left open. The legacy token enters ONLY
  // through `Authorization: Bearer` — there is no cookie or query-parameter path
  // for it — so a browser cannot attach it to a forged cross-site request and it
  // is bearer-shaped in the sense this rule cares about. If that ever changes,
  // this case is where the contradiction shows up.
  await withEnv(
    {
      WEB_ORIGIN: CONSOLE_ORIGIN,
      AUTH_TOKEN: 'legacy-operator-token',
      AUTH_TOKEN_LEGACY_ENABLED: 'true',
    },
    async () => {
      const result = await activate(
        guard(),
        context({ method: 'POST', authorization: 'Bearer legacy-operator-token' }),
      );
      assert.equal(result.admitted, true, 'a bearer-only credential is not forgeable cross-site');
    },
  );
});

test('a legacy shared-token state change from a foreign origin is also admitted', async () => {
  // Same reasoning: the exemption is about HOW the request authenticated, not
  // about what Origin it happens to declare.
  await withEnv(
    {
      WEB_ORIGIN: CONSOLE_ORIGIN,
      AUTH_TOKEN: 'legacy-operator-token',
      AUTH_TOKEN_LEGACY_ENABLED: 'true',
    },
    async () => {
      const result = await activate(
        guard(),
        context({
          method: 'POST',
          origin: FOREIGN_ORIGIN,
          authorization: 'Bearer legacy-operator-token',
        }),
      );
      assert.equal(result.admitted, true);
    },
  );
});
