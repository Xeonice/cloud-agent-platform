import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';

import { APP_GUARD } from '@nestjs/core';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  type INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CodexDeviceLoginStartResponseSchema,
  CodexDeviceLoginStatusSchema,
  type CodexDeviceLoginStartResponse,
  type CodexDeviceLoginStatus,
  type SessionUser,
} from '@cap/contracts';

import type { OperatorPrincipal } from '../auth/operator-principal';
import { CodexDeviceLoginService } from './codex-device-login.service';
import { ForgeCredentialService } from './forge-credential.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { DeviceLoginNoStoreMiddleware } from './device-login-no-store.middleware';

const ACCOUNT_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const EXPIRES_AT = '2026-07-13T12:30:00.000Z';

function sessionPrincipal(accountId: string): OperatorPrincipal {
  return {
    kind: 'session',
    user: {
      id: accountId,
      githubId: null,
      login: null,
      name: `${accountId}@example.test`,
      avatarUrl: null,
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
  };
}

let currentPrincipal: OperatorPrincipal | null = sessionPrincipal(ACCOUNT_A_ID);

@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (currentPrincipal === null) return false;
    context.switchToHttp().getRequest().operatorPrincipal = currentPrincipal;
    return true;
  }
}

class FakeDeviceLoginService {
  readonly owners = new Map<string, string>();
  readonly cancelled = new Set<string>();
  readonly startCalls: SessionUser[] = [];
  readonly statusCalls: Array<{ operator: SessionUser; sessionId: string }> = [];
  readonly cancelCalls: Array<{ operator: SessionUser; sessionId: string }> = [];
  getStatusFailure: Error | null = null;

  reset(): void {
    this.owners.clear();
    this.owners.set(SESSION_ID, ACCOUNT_A_ID);
    this.cancelled.clear();
    this.startCalls.length = 0;
    this.statusCalls.length = 0;
    this.cancelCalls.length = 0;
    this.getStatusFailure = null;
  }

  async start(operator: SessionUser): Promise<CodexDeviceLoginStartResponse> {
    this.startCalls.push(operator);
    this.owners.set(SESSION_ID, operator.id);
    return {
      sessionId: SESSION_ID,
      status: 'preparing',
      expiresAt: EXPIRES_AT,
    };
  }

  async getStatus(
    operator: SessionUser,
    sessionId: string,
  ): Promise<CodexDeviceLoginStatus> {
    this.statusCalls.push({ operator, sessionId });
    if (this.getStatusFailure) throw this.getStatusFailure;
    if (this.owners.get(sessionId) !== operator.id) {
      throw new NotFoundException({
        error: 'device_login_session_not_found',
        message: '登录会话不存在或已结束，请重新发起连接。',
      });
    }
    if (this.cancelled.has(sessionId)) {
      return { sessionId, status: 'cancelled', expiresAt: EXPIRES_AT };
    }
    return {
      sessionId,
      status: 'awaiting_authorization',
      expiresAt: EXPIRES_AT,
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    };
  }

  async cancel(operator: SessionUser, sessionId: string): Promise<void> {
    this.cancelCalls.push({ operator, sessionId });
    if (this.owners.get(sessionId) === operator.id) {
      this.cancelled.add(sessionId);
    }
  }
}

const fakeDeviceLogin = new FakeDeviceLoginService();
let app: INestApplication;
let origin: string;

before(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [SettingsController],
    providers: [
      { provide: SettingsService, useValue: {} },
      { provide: CodexDeviceLoginService, useValue: fakeDeviceLogin },
      { provide: ForgeCredentialService, useValue: {} },
      { provide: APP_GUARD, useClass: StubAuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  const noStore = new DeviceLoginNoStoreMiddleware();
  app.use('/settings/codex/device-login', noStore.use.bind(noStore));
  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
});

beforeEach(() => {
  currentPrincipal = sessionPrincipal(ACCOUNT_A_ID);
  fakeDeviceLogin.reset();
});

after(async () => {
  await app?.close();
});

function deviceLoginRequest(
  method: 'GET' | 'POST' | 'DELETE',
  sessionId?: string,
): Promise<Response> {
  const suffix = sessionId === undefined ? '' : `/${encodeURIComponent(sessionId)}`;
  return fetch(`${origin}/settings/codex/device-login${suffix}`, { method });
}

test('POST starts the authenticated account session with HTTP 202 and no-store', async () => {
  const response = await deviceLoginRequest('POST');

  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = CodexDeviceLoginStartResponseSchema.parse(await response.json());
  assert.deepEqual(body, {
    sessionId: SESSION_ID,
    status: 'preparing',
    expiresAt: EXPIRES_AT,
  });
  assert.equal(fakeDeviceLogin.startCalls.length, 1);
  assert.equal(fakeDeviceLogin.startCalls[0]?.id, ACCOUNT_A_ID);
});

test('pre-guard middleware keeps an authentication rejection non-cacheable', async () => {
  currentPrincipal = null;

  const response = await deviceLoginRequest('POST');

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(fakeDeviceLogin.startCalls.length, 0);
});

test('GET passes the authenticated operator and exact session id to the service', async () => {
  const response = await deviceLoginRequest('GET', SESSION_ID);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = CodexDeviceLoginStatusSchema.parse(await response.json());
  assert.equal(body.status, 'awaiting_authorization');
  assert.deepEqual(fakeDeviceLogin.statusCalls.map(({ operator, sessionId }) => ({
    accountId: operator.id,
    sessionId,
  })), [{ accountId: ACCOUNT_A_ID, sessionId: SESSION_ID }]);
});

test('DELETE passes the exact account/session pair and returns idempotent 204 no-store', async () => {
  const first = await deviceLoginRequest('DELETE', SESSION_ID);
  const second = await deviceLoginRequest('DELETE', SESSION_ID);

  assert.equal(first.status, 204);
  assert.equal(second.status, 204);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(second.headers.get('cache-control'), 'no-store');
  assert.deepEqual(fakeDeviceLogin.cancelCalls.map(({ operator, sessionId }) => ({
    accountId: operator.id,
    sessionId,
  })), [
    { accountId: ACCOUNT_A_ID, sessionId: SESSION_ID },
    { accountId: ACCOUNT_A_ID, sessionId: SESSION_ID },
  ]);
});

test('invalid session-id paths fail 400 before the service and remain no-store', async () => {
  const getResponse = await deviceLoginRequest('GET', 'not-a-uuid');
  const deleteResponse = await deviceLoginRequest('DELETE', 'not-a-uuid');

  assert.equal(getResponse.status, 400);
  assert.equal(deleteResponse.status, 400);
  assert.equal(getResponse.headers.get('cache-control'), 'no-store');
  assert.equal(deleteResponse.headers.get('cache-control'), 'no-store');
  assert.equal(fakeDeviceLogin.statusCalls.length, 0);
  assert.equal(fakeDeviceLogin.cancelCalls.length, 0);
});

test('another account cannot observe or cancel an owned session', async () => {
  currentPrincipal = sessionPrincipal(ACCOUNT_B_ID);

  const getResponse = await deviceLoginRequest('GET', SESSION_ID);
  assert.equal(getResponse.status, 404);
  assert.equal(getResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await getResponse.json(), {
    error: 'device_login_session_not_found',
    message: '登录会话不存在或已结束，请重新发起连接。',
  });

  const deleteResponse = await deviceLoginRequest('DELETE', SESSION_ID);
  assert.equal(deleteResponse.status, 204);
  assert.equal(deleteResponse.headers.get('cache-control'), 'no-store');
  assert.equal(fakeDeviceLogin.cancelled.has(SESSION_ID), false);
  assert.deepEqual(fakeDeviceLogin.cancelCalls.map(({ operator, sessionId }) => ({
    accountId: operator.id,
    sessionId,
  })), [{ accountId: ACCOUNT_B_ID, sessionId: SESSION_ID }]);

  currentPrincipal = sessionPrincipal(ACCOUNT_A_ID);
  const ownerResponse = await deviceLoginRequest('GET', SESSION_ID);
  assert.equal(ownerResponse.status, 200, 'cross-account DELETE did not cancel owner session');
});

test('unexpected service errors are no-store and do not expose raw secret text', async () => {
  fakeDeviceLogin.getStatusFailure = new Error(
    'authJson={"tokens":{"access_token":"must-not-leak"}}',
  );

  const response = await deviceLoginRequest('GET', SESSION_ID);
  const body = await response.text();

  assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(body, /must-not-leak|access_token|authJson/i);
});
