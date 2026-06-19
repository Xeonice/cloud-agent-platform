/**
 * `GET|PUT /settings/mcp-server` admin-gate spec (remote-mcp-server, tasks
 * 5.2/5.3, settings-backend track).
 *
 * The toggle that decides whether the outward-facing `/mcp` execution surface is
 * served is the dangerous knob on the settings surface, so these tests are
 * dominated by proving the ADMIN-SESSION gate, NOT by exercising persistence:
 * assert WHO is admitted and that a refusal mutates nothing, with a fake
 * {@link SettingsService} standing in for the DB so the HTTP path never touches
 * Prisma.
 *
 * The gate has two independent conditions (controller `requireAdmin`):
 *   1. the principal MUST be a GitHub-OAuth `session` — a MACHINE credential
 *      (`mcp` / `api-key`) is rejected 403 even when its owner is on the admin
 *      allowlist (no-escalation: a machine credential can never flip the surface
 *      that mints its own kind of access); and
 *   2. the session MUST be an explicitly-allowlisted admin (`SELF_UPDATE_ADMINS`)
 *      — a merely-logged-in non-admin operator is rejected 403.
 *
 * A successful read surfaces the current flag; a successful write flips it and
 * echoes the new value.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  type INestApplication,
} from '@nestjs/common';
import type { McpServerSettings } from '@cap/contracts';

import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { CodexDeviceLoginService } from './codex-device-login.service';
import { SELF_UPDATE_ADMINS_ENV } from '../auth/admin';
import type { OperatorPrincipal } from '../auth/operator-principal';

const ADMIN_ID = 4242;
const NON_ADMIN_ID = 7;

/** A guard that attaches a configurable principal, standing in for the real AuthGuard. */
let currentPrincipal: OperatorPrincipal | null = null;

@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (currentPrincipal === null) {
      return false; // the global AuthGuard would have 401'd before the handler
    }
    const req = context.switchToHttp().getRequest();
    req.operatorPrincipal = currentPrincipal;
    return true;
  }
}

function sessionPrincipal(githubId: number): OperatorPrincipal {
  return {
    kind: 'session',
    user: { githubId, login: 'op', name: 'Op', avatarUrl: '', allowed: true },
  };
}

/**
 * A MACHINE principal (`mcp` / `api-key`) whose OWNER is the admin id — proving
 * the gate refuses by KIND, not merely by owner identity (no-escalation).
 *
 * The `mcp` / `api-key` kinds + their `scopes` are introduced by sibling tracks
 * (api-key-machine-identity / mcp-auth-core); this settings-backend track's gate
 * keys ONLY on `kind !== 'session'`, so it rejects any non-session principal
 * present OR future. The cast keeps this spec compilable against the
 * settings-backend baseline (where those kinds may not yet be in the
 * `PrincipalKind` union) while still exercising a real machine principal once
 * integrated.
 */
function machinePrincipal(
  kind: 'mcp' | 'api-key',
  githubId: number,
  scopes: string[],
): OperatorPrincipal {
  return {
    kind,
    user: { githubId, login: 'bot', name: 'Bot', avatarUrl: '', allowed: true },
    scopes,
  } as unknown as OperatorPrincipal;
}

/**
 * A fake SettingsService that records flag writes and serves a mutable flag,
 * so the HTTP path exercises the admin gate without a database. Only the
 * MCP-server toggle methods are implemented; the controller never calls the
 * others on these routes.
 */
class FakeSettingsService {
  flag = false;
  writes: boolean[] = [];

  async readMcpServerSettings(): Promise<McpServerSettings> {
    return { mcpServerEnabled: this.flag };
  }

  async setMcpServerEnabled(enabled: boolean): Promise<McpServerSettings> {
    this.writes.push(enabled);
    this.flag = enabled;
    return { mcpServerEnabled: enabled };
  }
}

const fakeSettings = new FakeSettingsService();

let app: INestApplication;
let port: number;

before(async () => {
  process.env[SELF_UPDATE_ADMINS_ENV] = String(ADMIN_ID);

  const moduleRef = await Test.createTestingModule({
    controllers: [SettingsController],
    providers: [
      { provide: SettingsService, useValue: fakeSettings },
      // The controller's other dependency; unused on the /mcp-server routes.
      { provide: CodexDeviceLoginService, useValue: {} },
      { provide: APP_GUARD, useClass: StubAuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.listen(0);
  const address = app.getHttpServer().address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await app?.close();
  delete process.env[SELF_UPDATE_ADMINS_ENV];
});

function getMcpServer(): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/settings/mcp-server`, {
    method: 'GET',
    headers: { 'content-type': 'application/json' },
  });
}

function putMcpServer(mcpServerEnabled: boolean): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/settings/mcp-server`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mcpServerEnabled }),
  });
}

// ---------------------------------------------------------------------------
// WRITE gate — only an ADMIN SESSION may flip the flag
// ---------------------------------------------------------------------------

test('PUT: an admin session flips mcpServerEnabled and the new value is echoed', async () => {
  fakeSettings.flag = false;
  fakeSettings.writes = [];
  currentPrincipal = sessionPrincipal(ADMIN_ID);

  const res = await putMcpServer(true);
  assert.equal(res.status, 200, 'an admin session may toggle the MCP server');
  const body = (await res.json()) as McpServerSettings;
  assert.equal(body.mcpServerEnabled, true, 'the response echoes the new flag');
  assert.deepEqual(fakeSettings.writes, [true], 'the service persisted exactly the requested flag');
  assert.equal(fakeSettings.flag, true, 'the stored flag now reflects the write');
});

test('PUT: a NON-admin session is 403 and the flag is never mutated', async () => {
  fakeSettings.flag = false;
  fakeSettings.writes = [];
  currentPrincipal = sessionPrincipal(NON_ADMIN_ID);

  const res = await putMcpServer(true);
  assert.equal(res.status, 403, 'a non-admin operator cannot flip the MCP server');
  assert.equal(fakeSettings.writes.length, 0, 'no write reached the service');
  assert.equal(fakeSettings.flag, false, 'the flag was not mutated by a refused write');
});

test('PUT: a MACHINE principal is 403 even when its owner is an admin (no escalation)', async () => {
  for (const kind of ['mcp', 'api-key'] as const) {
    fakeSettings.flag = false;
    fakeSettings.writes = [];
    // Owner IS the admin id — only the principal KIND should block it.
    currentPrincipal = machinePrincipal(kind, ADMIN_ID, ['tasks:read', 'tasks:write']);

    const res = await putMcpServer(true);
    assert.equal(res.status, 403, `a ${kind} machine credential cannot flip the MCP server`);
    assert.equal(fakeSettings.writes.length, 0, `no write reached the service for a ${kind} principal`);
    assert.equal(fakeSettings.flag, false, `the flag was not mutated by a ${kind} principal`);
  }
});

test('PUT: an unauthenticated request (no principal) is rejected, no write', async () => {
  fakeSettings.flag = false;
  fakeSettings.writes = [];
  currentPrincipal = null; // the stub guard denies, as the real AuthGuard would 401

  const res = await putMcpServer(true);
  assert.ok(res.status === 401 || res.status === 403, 'an unauthenticated caller is denied');
  assert.equal(fakeSettings.writes.length, 0, 'no write reached the service when unauthenticated');
});

// ---------------------------------------------------------------------------
// READ gate — admin-session only, and it surfaces the current flag
// ---------------------------------------------------------------------------

test('GET: an admin session reads the CURRENT flag (false)', async () => {
  fakeSettings.flag = false;
  currentPrincipal = sessionPrincipal(ADMIN_ID);

  const res = await getMcpServer();
  assert.equal(res.status, 200, 'an admin session may read the toggle');
  const body = (await res.json()) as McpServerSettings;
  assert.equal(body.mcpServerEnabled, false, 'the read surfaces the off state');
});

test('GET: an admin session reads the CURRENT flag (true after an enable)', async () => {
  fakeSettings.flag = true;
  currentPrincipal = sessionPrincipal(ADMIN_ID);

  const res = await getMcpServer();
  assert.equal(res.status, 200, 'an admin session may read the toggle');
  const body = (await res.json()) as McpServerSettings;
  assert.equal(body.mcpServerEnabled, true, 'the read surfaces the on state');
});

test('GET: a NON-admin session is 403 (the toggle state is not even readable)', async () => {
  currentPrincipal = sessionPrincipal(NON_ADMIN_ID);

  const res = await getMcpServer();
  assert.equal(res.status, 403, 'a non-admin operator cannot read the MCP-server toggle');
});

test('GET: a MACHINE principal is 403 even when its owner is an admin', async () => {
  currentPrincipal = machinePrincipal('mcp', ADMIN_ID, ['tasks:read']);

  const res = await getMcpServer();
  assert.equal(res.status, 403, 'a machine credential cannot read the MCP-server toggle');
});
