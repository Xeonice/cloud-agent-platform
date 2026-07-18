import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest } from './auth.guard';
import { hasScope, type OperatorPrincipal } from './operator-principal';
import {
  PublicV1Operation,
  PublicV1OperationGuard,
  publicV1OperationById,
  type PublicV1Handler,
} from '../public-surface/public-v1-operation';

const OWNER = {
  id: 'diagnostics-owner',
  githubId: null,
  login: null,
  name: 'Diagnostics owner',
  avatarUrl: null,
  allowed: true as const,
  role: 'member' as const,
  mustChangePassword: false,
};

class ExistingRequiredOwnerBoundary {
  @PublicV1Operation('runtimeModels.query')
  queryRuntimeModels(): undefined {
    return undefined;
  }
}

function request(principal: OperatorPrincipal): AuthenticatedRequest {
  return {
    operatorPrincipal: principal,
    params: {},
    query: {},
    headers: {},
    body: { runtime: 'codex' },
  } as unknown as AuthenticatedRequest;
}

function context(
  handler: PublicV1Handler,
  req: AuthenticatedRequest,
): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

test('old API-key and MCP scopes do not imply tasks:diagnostics', () => {
  const oldApiKey: OperatorPrincipal = {
    kind: 'api-key',
    user: OWNER,
    scopes: ['tasks:read', 'tasks:write'],
    keyId: 'old-api-key',
  };
  const oldMcpToken: OperatorPrincipal = {
    kind: 'mcp',
    user: OWNER,
    scopes: ['tasks:read', 'tasks:write'],
  };

  assert.equal(hasScope(oldApiKey, 'tasks:diagnostics'), false);
  assert.equal(hasScope(oldMcpToken, 'tasks:diagnostics'), false);
});

test('tasks:diagnostics is granted only when explicitly persisted on a scoped principal', () => {
  for (const principal of [
    {
      kind: 'api-key',
      user: OWNER,
      scopes: ['tasks:diagnostics'],
      keyId: 'diagnostics-api-key',
    },
    {
      kind: 'mcp',
      user: OWNER,
      scopes: ['tasks:read', 'tasks:diagnostics'],
    },
  ] satisfies OperatorPrincipal[]) {
    assert.equal(hasScope(principal, 'tasks:diagnostics'), true);
  }
});

test('scopeless compatibility does not satisfy an independent required-owner boundary', () => {
  const session: OperatorPrincipal = { kind: 'session', user: OWNER };
  const identitylessLegacy: OperatorPrincipal = {
    kind: 'legacy-token',
    user: null,
  };

  assert.equal(hasScope(session, 'tasks:diagnostics'), true);
  assert.equal(hasScope(identitylessLegacy, 'tasks:diagnostics'), true);

  // Task 5.2 owns the diagnostics operation registration. Exercise the same real
  // Public V1 required-owner guard through an already-registered operation here
  // so 5.1 proves scope compatibility and owner identity remain independent.
  assert.equal(
    publicV1OperationById('runtimeModels.query').ownerPolicy,
    'required',
  );
  assert.throws(
    () =>
      new PublicV1OperationGuard().canActivate(
        context(
          ExistingRequiredOwnerBoundary.prototype.queryRuntimeModels,
          request(identitylessLegacy),
        ),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ForbiddenException);
      assert.deepEqual(error.getResponse(), {
        message:
          'Runtime model catalogs require an authenticated account owner',
        error: 'Forbidden',
        statusCode: 403,
      });
      return true;
    },
  );
});
