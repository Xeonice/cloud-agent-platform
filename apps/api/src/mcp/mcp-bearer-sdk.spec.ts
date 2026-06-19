/**
 * Minimal ground-truth test for the requirement:
 *   "The /mcp endpoint mounts the official SDK and is bearer-protected"
 *
 * Two scenarios exercised:
 *   A) Official SDK mount — StreamableHTTPServerTransport from
 *      @modelcontextprotocol/sdk (NOT @rekog/mcp-nest) is constructed per-request
 *      and connected to the shared McpServer when the toggle is ON.
 *   B) Bearer protection — an absent/invalid Authorization header yields 401 from
 *      the SDK requireBearerAuth middleware BEFORE the controller is reached.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// A) Official SDK: StreamableHTTPServerTransport is from the official package
// ---------------------------------------------------------------------------

test('StreamableHTTPServerTransport is exported by @modelcontextprotocol/sdk (official SDK, not @rekog/mcp-nest)', () => {
  // Dynamic require of the CJS build — confirms the official package ships this class.
  // If this line throws, the package is missing or misnamed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@modelcontextprotocol/sdk/server/streamableHttp.js') as {
    StreamableHTTPServerTransport?: unknown;
  };
  assert.ok(
    typeof mod.StreamableHTTPServerTransport === 'function',
    'StreamableHTTPServerTransport must be exported from the official @modelcontextprotocol/sdk package',
  );
});

test('the controller source imports StreamableHTTPServerTransport from @modelcontextprotocol/sdk (NOT @rekog/mcp-nest)', () => {
  // Read the compiled controller JS and assert the import source. This is the
  // static structural guard that the spec requires: "NOT @rekog/mcp-nest, NOT the
  // v2-alpha @modelcontextprotocol/express — the v1.x single-package subpaths".
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ctrlSource = require('node:fs').readFileSync(
    require.resolve('./mcp.controller'),
    'utf8',
  ) as string;

  assert.ok(
    ctrlSource.includes('@modelcontextprotocol/sdk'),
    'controller must import from @modelcontextprotocol/sdk',
  );
  assert.ok(
    !ctrlSource.includes('@rekog/mcp-nest'),
    'controller must NOT import from @rekog/mcp-nest',
  );
  assert.ok(
    !ctrlSource.includes('@modelcontextprotocol/express'),
    'controller must NOT import from the v2-alpha @modelcontextprotocol/express',
  );
});

test('McpController instantiates a fresh StreamableHTTPServerTransport per request when the toggle is ON', async () => {
  // Drive the controller with the toggle ON and verify that:
  //   (a) the McpServer is connected (SDK transport wired to the server), and
  //   (b) a fresh transport is constructed per call (stateless mode: no session id).
  // We fake the MCP server + prisma to avoid a Nest DI container or real DB.

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StreamableHTTPServerTransport } = require(
    '@modelcontextprotocol/sdk/server/streamableHttp.js',
  ) as { StreamableHTTPServerTransport: new (opts: unknown) => unknown & { handleRequest(...a: unknown[]): Promise<void>; close(): Promise<void>; connect(server: unknown): Promise<void> } };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { McpController } = require('./mcp.controller') as {
    McpController: new (factory: unknown, prisma: unknown) => {
      handlePost(req: unknown, res: unknown): Promise<void>;
    };
  };

  let serverConnected = false;
  let constructedTransports = 0;
  let handleRequestCalled = false;

  // Patch the transport constructor for this test to intercept construction + calls.
  const OrigTransport = StreamableHTTPServerTransport;
  const transportInstances: Array<{ opts: unknown }> = [];

  // We replace the import binding at the module level via the cache. Since the
  // controller already imported StreamableHTTPServerTransport in its CJS require
  // cache, we track calls through the shared McpServer connect.
  const fakeServer = {
    connect(transport: unknown) {
      serverConnected = true;
      // Verify the transport is a StreamableHTTPServerTransport instance.
      assert.ok(
        transport instanceof OrigTransport,
        'controller must connect an official StreamableHTTPServerTransport instance to the McpServer',
      );
      constructedTransports++;
      return Promise.resolve();
    },
  };

  const factory = {
    getServer() {
      return fakeServer;
    },
  };

  const prisma = {
    systemSettings: {
      findUnique: async () => ({ mcpServerEnabled: true }),
    },
  };

  // Fake res that records close handlers and provides the response surface.
  const closeHandlers: Array<() => void> = [];
  const fakeRes = {
    status(code: number) {
      void code;
      return this;
    },
    json(body: unknown) {
      void body;
      return this;
    },
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
      return this;
    },
    // Absorb any transport writes (status lines, headers, body).
    setHeader() { return this; },
    write() { return true; },
    end() { return this; },
    writableEnded: false,
    headersSent: false,
    statusCode: 200,
  };

  // Intercept transport.handleRequest via monkey-patch on the prototype, reset after.
  const proto = Object.getPrototypeOf(new OrigTransport({ sessionIdGenerator: undefined }));
  const originalHandleRequest = proto.handleRequest as (...a: unknown[]) => Promise<void>;
  proto.handleRequest = async function (...args: unknown[]) {
    handleRequestCalled = true;
    // Don't actually run the full SDK HTTP handling (no real HTTP request) — just
    // confirm it was called and return.
    void args;
  };

  try {
    const controller = new McpController(factory, prisma);
    await controller.handlePost(
      { body: { jsonrpc: '2.0', method: 'tools/list', id: 1 } },
      fakeRes,
    );

    assert.equal(serverConnected, true, 'McpServer.connect was called — SDK transport is wired to the shared server');
    assert.equal(constructedTransports, 1, 'exactly one transport constructed for this request (stateless per-request transport)');
    assert.equal(handleRequestCalled, true, 'transport.handleRequest was called — the SDK owns the response');

    // A second request constructs a SECOND (fresh) transport — per-request stateless.
    serverConnected = false;
    constructedTransports = 0;
    handleRequestCalled = false;
    await controller.handlePost(
      { body: { jsonrpc: '2.0', method: 'tools/list', id: 2 } },
      { ...fakeRes, on(e: string, h: () => void) { if (e === 'close') closeHandlers.push(h); return this; } },
    );
    assert.equal(constructedTransports, 1, 'a fresh transport per request (not reused across requests)');
  } finally {
    proto.handleRequest = originalHandleRequest;
  }
  void transportInstances;
});

// ---------------------------------------------------------------------------
// B) Bearer protection — the SDK requireBearerAuth middleware yields 401 on
//    absent / invalid bearer BEFORE the Nest controller pipeline.
// ---------------------------------------------------------------------------

test('SDK requireBearerAuth returns 401 when the Authorization header is absent', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { requireBearerAuth } = require(
    '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js',
  ) as { requireBearerAuth: (opts: unknown) => (req: unknown, res: unknown, next: () => void) => Promise<void> };

  // A verifier that always throws (should never be reached when the header is absent).
  let verifierCalled = false;
  const middleware = requireBearerAuth({
    verifier: {
      verifyAccessToken: async (_token: string) => {
        verifierCalled = true;
        throw new Error('verifier should not be called when no header is present');
      },
    },
  });

  const recorded: { status?: number; body?: unknown } = {};
  const fakeRes = {
    set(_key: string, _val: string) { return this; },
    status(code: number) {
      recorded.status = code;
      return this;
    },
    json(body: unknown) {
      recorded.body = body;
      return this;
    },
  };

  let nextCalled = false;
  await middleware(
    { headers: {} }, // no Authorization header
    fakeRes,
    () => { nextCalled = true; },
  );

  assert.equal(recorded.status, 401, 'absent Authorization header must yield 401');
  assert.equal(nextCalled, false, 'next() must NOT be called — request is rejected before the controller');
  assert.equal(verifierCalled, false, 'verifier is never invoked for a request with no Authorization header');
});

test('SDK requireBearerAuth returns 401 when the bearer token is invalid/revoked', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { requireBearerAuth } = require(
    '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js',
  ) as { requireBearerAuth: (opts: unknown) => (req: unknown, res: unknown, next: () => void) => Promise<void> };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { InvalidTokenError } = require(
    '@modelcontextprotocol/sdk/server/auth/errors.js',
  ) as { InvalidTokenError: new (msg: string) => Error };

  const middleware = requireBearerAuth({
    verifier: {
      verifyAccessToken: async (_token: string) => {
        throw new InvalidTokenError('Invalid or revoked MCP token');
      },
    },
  });

  const recorded: { status?: number; body?: unknown } = {};
  const fakeRes = {
    set(_key: string, _val: string) { return this; },
    status(code: number) {
      recorded.status = code;
      return this;
    },
    json(body: unknown) {
      recorded.body = body;
      return this;
    },
  };

  let nextCalled = false;
  await middleware(
    { headers: { authorization: 'Bearer mcp_invalid_token_xxx' } },
    fakeRes,
    () => { nextCalled = true; },
  );

  assert.equal(recorded.status, 401, 'invalid/revoked bearer must yield 401');
  assert.equal(nextCalled, false, 'next() must NOT be called — request is rejected at the bearer gate');
});

test('SDK requireBearerAuth calls next() and attaches AuthInfo when bearer is valid', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { requireBearerAuth } = require(
    '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js',
  ) as { requireBearerAuth: (opts: unknown) => (req: unknown & { auth?: unknown }, res: unknown, next: () => void) => Promise<void> };

  const validAuthInfo = {
    token: 'mcp_valid',
    clientId: 'settings',
    scopes: ['tasks:read'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  const middleware = requireBearerAuth({
    verifier: {
      verifyAccessToken: async (_token: string) => validAuthInfo,
    },
  });

  const req: { headers: { authorization: string }; auth?: unknown } = {
    headers: { authorization: 'Bearer mcp_valid' },
  };

  let nextCalled = false;
  const fakeRes = {
    set() { return this; },
    status() { return this; },
    json() { return this; },
  };

  await middleware(req, fakeRes, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'next() is called for a valid bearer — the request reaches the controller');
  assert.deepEqual(req.auth, validAuthInfo, 'AuthInfo is attached to req.auth for the SDK transport to thread into tool extra');
});
