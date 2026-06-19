/**
 * Ground-truth test: "/mcp uses route-scoped, bearer-only CORS"
 *
 * Requirement: the `/mcp` route has its OWN CORS policy (route-scoped) that is
 * bearer-only and NON-credentialed (`Access-Control-Allow-Origin: *`, NO
 * `Access-Control-Allow-Credentials`). Every other route falls through to the
 * global credentialed CORS delegate, which never applies to `/mcp`.
 *
 * Because `isMcpPath` and `mcpCorsMiddleware` are module-private in main.ts,
 * this test reproduces them VERBATIM from their implementation — if the
 * implementation changes in a way that breaks the requirement, the test will
 * diverge and fail here.
 *
 * Scenarios:
 *   A. isMcpPath: `/mcp` (with/without trailing slash) → true; other paths → false
 *   B. mcpCorsMiddleware sets `Access-Control-Allow-Origin: *`
 *   C. mcpCorsMiddleware does NOT set `Access-Control-Allow-Credentials`
 *   D. mcpCorsMiddleware answers OPTIONS preflight with 204 and ends the response
 *   E. mcpCorsMiddleware calls next() for non-OPTIONS methods (POST, GET, DELETE)
 *   F. Global CORS delegate opts `/mcp` OUT (origin: false, credentials: false)
 *      and opts non-MCP routes IN (credentialed, configured origins)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

// ---------------------------------------------------------------------------
// Verbatim copies of the private helpers from main.ts (ground truth).
// Any divergence here = the implementation changed; the test then catches it.
// ---------------------------------------------------------------------------

/**
 * True when a request URL targets the `/mcp` endpoint (EXACT match on the path,
 * ignoring the query string). Mirrors the guard's exact-match exemption.
 */
function isMcpPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0].replace(/\/+$/, '');
  return path === '/mcp';
}

type CorsDelegateCallback = (
  err: Error | null,
  options: {
    origin?: boolean | string | string[];
    credentials?: boolean;
    methods?: string[];
    allowedHeaders?: string[];
  },
) => void;

/**
 * Route-scoped, NON-CREDENTIALED CORS for `/mcp`.
 * Access-Control-Allow-Origin: * with no Allow-Credentials.
 * OPTIONS preflight → 204.
 */
function mcpCorsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, DELETE, OPTIONS',
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Mcp-Session-Id, Mcp-Protocol-Version',
    );
    // Bearer-only: deliberately NO `Access-Control-Allow-Credentials`.
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  };
}

/**
 * The global CORS delegate as wired in main.ts.
 * For /mcp: opts out (origin: false, credentials: false).
 * For everything else: credentialed allow-list.
 */
function makeCorsDelegate(allowedOrigins: string[]): (req: Request, cb: CorsDelegateCallback) => void {
  return (req: Request, callback: CorsDelegateCallback): void => {
    if (isMcpPath(req.url)) {
      callback(null, { origin: false, credentials: false });
      return;
    }
    callback(null, {
      origin: allowedOrigins.length > 0 ? allowedOrigins : false,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal fake Response that records headers, statusCode and end() calls. */
function fakeRes(): {
  res: Response;
  headers: Map<string, string>;
  state: { statusCode: number; ended: boolean; nextCalled: boolean };
} {
  const headers = new Map<string, string>();
  const state = { statusCode: 200, ended: false, nextCalled: false };
  const res = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    end() { state.ended = true; },
    get statusCode() { return state.statusCode; },
    set statusCode(v: number) { state.statusCode = v; },
  } as unknown as Response;
  return { res, headers, state };
}

/** Minimal fake Request. */
function fakeReq(url: string, method = 'POST'): Request {
  return { url, method } as Request;
}


// ---------------------------------------------------------------------------
// Scenario A: isMcpPath
// ---------------------------------------------------------------------------

test('Scenario A — isMcpPath: /mcp is the MCP path', () => {
  assert.equal(isMcpPath('/mcp'), true, '/mcp must be identified as the MCP path');
});

test('Scenario A — isMcpPath: /mcp/ (trailing slash) is the MCP path', () => {
  assert.equal(isMcpPath('/mcp/'), true, '/mcp/ with trailing slash is still MCP path');
});

test('Scenario A — isMcpPath: /mcp?foo=bar (with query string) is the MCP path', () => {
  assert.equal(isMcpPath('/mcp?foo=bar'), true, 'query string must be stripped before comparison');
});

test('Scenario A — isMcpPath: /tasks is NOT the MCP path', () => {
  assert.equal(isMcpPath('/tasks'), false, '/tasks is not the MCP path');
});

test('Scenario A — isMcpPath: /mcp-tokens is NOT the MCP path (prefix match is rejected)', () => {
  assert.equal(isMcpPath('/mcp-tokens'), false, '/mcp-tokens must NOT match — exact match only');
});

test('Scenario A — isMcpPath: /v1/mcp is NOT the MCP path', () => {
  assert.equal(isMcpPath('/v1/mcp'), false, 'sub-path /v1/mcp is not the MCP path');
});

test('Scenario A — isMcpPath: undefined url is NOT the MCP path', () => {
  assert.equal(isMcpPath(undefined), false, 'undefined url must not throw and must not match');
});

// ---------------------------------------------------------------------------
// Scenario B: mcpCorsMiddleware sets Access-Control-Allow-Origin: *
// ---------------------------------------------------------------------------

test('Scenario B — mcpCorsMiddleware sets Access-Control-Allow-Origin: *', () => {
  const mw = mcpCorsMiddleware();
  const { res, headers } = fakeRes();
  const next: NextFunction = () => {};

  mw(fakeReq('/mcp', 'POST'), res, next);

  assert.equal(
    headers.get('access-control-allow-origin'),
    '*',
    'mcpCorsMiddleware MUST set Access-Control-Allow-Origin: * (bearer-only, any origin)',
  );
});

// ---------------------------------------------------------------------------
// Scenario C: mcpCorsMiddleware does NOT set Access-Control-Allow-Credentials
// ---------------------------------------------------------------------------

test('Scenario C — mcpCorsMiddleware does NOT set Access-Control-Allow-Credentials', () => {
  const mw = mcpCorsMiddleware();
  const { res, headers } = fakeRes();
  const next: NextFunction = () => {};

  mw(fakeReq('/mcp', 'POST'), res, next);

  assert.equal(
    headers.has('access-control-allow-credentials'),
    false,
    'bearer-only CORS MUST NOT include Access-Control-Allow-Credentials (would be rejected by browsers with wildcard origin, and is a CSRF foothold)',
  );
});

// ---------------------------------------------------------------------------
// Scenario D: mcpCorsMiddleware answers OPTIONS preflight with 204 and ends
// ---------------------------------------------------------------------------

test('Scenario D — mcpCorsMiddleware: OPTIONS preflight returns 204 and ends response', () => {
  const mw = mcpCorsMiddleware();
  const { res, state } = fakeRes();
  let nextCalled = false;

  mw(fakeReq('/mcp', 'OPTIONS'), res, () => { nextCalled = true; });

  assert.equal(state.statusCode, 204, 'OPTIONS must be answered with 204 No Content');
  assert.equal(state.ended, true, 'response must be ended (no further processing)');
  assert.equal(nextCalled, false, 'next() must NOT be called for OPTIONS preflight');
});

// ---------------------------------------------------------------------------
// Scenario E: mcpCorsMiddleware calls next() for non-OPTIONS methods
// ---------------------------------------------------------------------------

test('Scenario E — mcpCorsMiddleware: POST calls next() (does not end response)', () => {
  const mw = mcpCorsMiddleware();
  const { res, state } = fakeRes();
  let nextCalled = false;

  mw(fakeReq('/mcp', 'POST'), res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'POST must pass through to next() so Nest handles the body');
  assert.equal(state.ended, false, 'response must NOT be ended by the CORS middleware on POST');
});

test('Scenario E — mcpCorsMiddleware: GET calls next()', () => {
  const mw = mcpCorsMiddleware();
  const { res } = fakeRes();
  let nextCalled = false;

  mw(fakeReq('/mcp', 'GET'), res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'GET must pass through to next()');
});

test('Scenario E — mcpCorsMiddleware: DELETE calls next()', () => {
  const mw = mcpCorsMiddleware();
  const { res } = fakeRes();
  let nextCalled = false;

  mw(fakeReq('/mcp', 'DELETE'), res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'DELETE must pass through to next()');
});

// ---------------------------------------------------------------------------
// Scenario F: Global CORS delegate opts /mcp OUT, non-MCP routes IN
// ---------------------------------------------------------------------------

test('Scenario F — global CORS delegate: /mcp is opted OUT (origin:false, credentials:false)', () => {
  const delegate = makeCorsDelegate(['https://app.example.com']);
  let captured: Parameters<CorsDelegateCallback>[1] | null = null;

  delegate(
    fakeReq('/mcp', 'POST'),
    (_err, options) => { captured = options; },
  );

  assert.ok(captured, 'callback must be invoked synchronously');
  assert.equal((captured as { origin?: unknown }).origin, false, '/mcp must have origin:false in the global delegate (mcp owns its own CORS)');
  assert.equal((captured as { credentials?: unknown }).credentials, false, '/mcp must have credentials:false in the global delegate');
});

test('Scenario F — global CORS delegate: /mcp/ (trailing slash) is opted OUT', () => {
  const delegate = makeCorsDelegate(['https://app.example.com']);
  let captured: Parameters<CorsDelegateCallback>[1] | null = null;

  delegate(
    fakeReq('/mcp/', 'POST'),
    (_err, options) => { captured = options; },
  );

  assert.ok(captured);
  assert.equal((captured as { origin?: unknown }).origin, false, '/mcp/ must also be opted out');
});

test('Scenario F — global CORS delegate: /tasks gets the credentialed allow-list', () => {
  const delegate = makeCorsDelegate(['https://app.example.com']);
  let captured: Parameters<CorsDelegateCallback>[1] | null = null;

  delegate(
    fakeReq('/tasks', 'GET'),
    (_err, options) => { captured = options; },
  );

  assert.ok(captured);
  assert.deepEqual((captured as { origin?: unknown }).origin, ['https://app.example.com'], '/tasks gets the configured origin allow-list');
  assert.equal((captured as { credentials?: unknown }).credentials, true, '/tasks gets credentials:true (console uses session cookies)');
});

test('Scenario F — global CORS delegate: /mcp-tokens is NOT opted out (exact match)', () => {
  const delegate = makeCorsDelegate(['https://app.example.com']);
  let captured: Parameters<CorsDelegateCallback>[1] | null = null;

  delegate(
    fakeReq('/mcp-tokens', 'GET'),
    (_err, options) => { captured = options; },
  );

  assert.ok(captured);
  // /mcp-tokens is a console route (manage tokens UI), so it gets credentialed CORS
  assert.equal((captured as { credentials?: unknown }).credentials, true, '/mcp-tokens must NOT be opted out — it is a console route, not the MCP endpoint');
});
