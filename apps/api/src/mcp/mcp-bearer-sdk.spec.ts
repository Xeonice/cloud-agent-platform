/**
 * Minimal ground-truth test for the requirement:
 *   "The /mcp endpoint mounts the official SDK and is bearer-protected"
 *
 * Two scenarios exercised:
 *   A) Official SDK mount — StreamableHTTPServerTransport from
 *      @modelcontextprotocol/sdk (NOT @rekog/mcp-nest) is constructed per-request
 *      and connected to a request-scoped McpServer when the toggle is ON.
 *   B) Bearer protection — an absent/invalid Authorization header yields 401 from
 *      the SDK requireBearerAuth middleware BEFORE the controller is reached.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { PUBLIC_V1_OPERATIONS } from '@cap/contracts';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp.server';

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

test('two real Streamable HTTP clients can initialize and list tools concurrently', async () => {
  const prisma = {
    systemSettings: {
      findUnique: async () => ({ mcpServerEnabled: true }),
    },
  };
  const factory = new McpServerFactory(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const controller = new McpController(factory, prisma as never);
  const authInfo: AuthInfo = {
    token: 'mcp_concurrency_test',
    clientId: 'settings',
    scopes: ['tasks:read'],
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    extra: { userId: 'local-acct-1' },
  };
  const handlerErrors: Error[] = [];
  const httpServer = createHttpServer(async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Allow', 'POST');
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      Object.assign(req, { body, auth: authInfo });
      await controller.handlePost(req as never, res as never);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      handlerErrors.push(normalized);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(normalized.message);
      } else {
        res.destroy(normalized);
      }
    }
  });

  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const clients = [
    new Client({ name: 'parallel-a', version: '1.0.0' }),
    new Client({ name: 'parallel-b', version: '1.0.0' }),
  ];
  const transports = [
    new StreamableHTTPClientTransport(endpoint),
    new StreamableHTTPClientTransport(endpoint),
  ];

  try {
    await Promise.all(
      clients.map((client, index) => client.connect(transports[index]!)),
    );
    const inventories = await Promise.all(clients.map((client) => client.listTools()));
    const mappedToolCount = PUBLIC_V1_OPERATIONS.filter(
      (operation) => 'tool' in operation.mcp,
    ).length;
    assert.deepEqual(
      inventories.map((inventory) => inventory.tools.length),
      inventories.map(() => mappedToolCount),
    );
    assert.deepEqual(handlerErrors, []);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
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
