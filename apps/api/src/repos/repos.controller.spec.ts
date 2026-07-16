/**
 * fix-large-repo-task-provisioning 4.1 — owner-aware Console repo import.
 *
 * The write boundary must derive the account id from a human session and must
 * not turn the existing `repos:read` machine scope into write authority. Public
 * V1 and MCP remain read-only for repositories.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import {
  PUBLIC_V1_OPERATIONS,
  type CreateRepoBody,
  type RepoResponse,
} from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { ReposController } from './repos.controller';
import type { ReposService } from './repos.service';

const BODY: CreateRepoBody = {
  name: 'private-app',
  gitSource: 'https://gitee.com/team/private-app.git',
  forge: 'gitee',
};

const REPO = {
  id: '11111111-1111-4111-8111-111111111111',
  name: BODY.name,
  gitSource: BODY.gitSource,
  createdAt: new Date(0),
  forge: 'gitee',
  isDefault: false,
} as RepoResponse;

function request(principal: OperatorPrincipal): AuthenticatedRequest {
  return { operatorPrincipal: principal } as AuthenticatedRequest;
}

function principal(
  kind: 'session' | 'api-key' | 'mcp',
  scopes?: Array<'repos:read'>,
): OperatorPrincipal {
  return {
    kind,
    user: {
      id: 'account-owner-a',
      githubId: null,
      login: null,
      name: 'Owner A',
      avatarUrl: null,
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
    scopes,
    ...(kind === 'api-key' ? { keyId: 'key-a' } : {}),
  } as OperatorPrincipal;
}

test('Console import forwards only the authenticated session account id', async () => {
  const calls: Array<{ ownerUserId: string; body: CreateRepoBody }> = [];
  const service = {
    async create(ownerUserId: string, body: CreateRepoBody) {
      calls.push({ ownerUserId, body });
      return REPO;
    },
  } as unknown as ReposService;
  const controller = new ReposController(service);

  const result = await controller.create(request(principal('session')), BODY);

  assert.equal(result.id, REPO.id);
  assert.deepEqual(calls, [{ ownerUserId: 'account-owner-a', body: BODY }]);
  assert.equal('ownerUserId' in BODY, false, 'the body cannot select a credential owner');
});

test('Console refresh forwards the route repo id with only the session account id', async () => {
  const calls: Array<{ ownerUserId: string; repoId: string }> = [];
  const service = {
    async refreshDefaultBranch(ownerUserId: string, repoId: string) {
      calls.push({ ownerUserId, repoId });
      return REPO;
    },
  } as unknown as ReposService;
  const controller = new ReposController(service);

  const result = await controller.refreshDefaultBranch(
    request(principal('session')),
    REPO.id,
  );

  assert.equal(result.id, REPO.id);
  assert.deepEqual(calls, [
    { ownerUserId: 'account-owner-a', repoId: REPO.id },
  ]);
});

test('repos:read machine principals cannot call the Console import write', async () => {
  let createCalls = 0;
  const service = {
    async create() {
      createCalls += 1;
      return REPO;
    },
  } as unknown as ReposService;
  const controller = new ReposController(service);

  for (const kind of ['api-key', 'mcp'] as const) {
    await assert.rejects(
      () => controller.create(request(principal(kind, ['repos:read'])), BODY),
      (err: unknown) => {
        assert.equal(err instanceof ForbiddenException, true);
        const response = (err as ForbiddenException).getResponse();
        return (
          typeof response === 'object' &&
          response !== null &&
          (response as { error?: string }).error === 'session_operator_required'
        );
      },
    );
  }
  assert.equal(createCalls, 0, 'no repo write occurs for a read-scoped machine credential');
});

test('repos:read machine principals cannot refresh a repository', async () => {
  let refreshCalls = 0;
  const service = {
    async refreshDefaultBranch() {
      refreshCalls += 1;
      return REPO;
    },
  } as unknown as ReposService;
  const controller = new ReposController(service);

  for (const kind of ['api-key', 'mcp'] as const) {
    await assert.rejects(
      () =>
        controller.refreshDefaultBranch(
          request(principal(kind, ['repos:read'])),
          REPO.id,
        ),
      (err: unknown) => {
        assert.equal(err instanceof ForbiddenException, true);
        const response = (err as ForbiddenException).getResponse();
        return (
          typeof response === 'object' &&
          response !== null &&
          (response as { error?: string }).error === 'session_operator_required'
        );
      },
    );
  }
  assert.equal(refreshCalls, 0);
});

test('public V1 and MCP repository inventories remain read-only', () => {
  const repoOperations = PUBLIC_V1_OPERATIONS.filter((operation) =>
    operation.id.startsWith('repos.'),
  );

  assert.deepEqual(
    repoOperations.map(({ id, method, scope }) => ({ id, method, scope })),
    [
      { id: 'repos.list', method: 'get', scope: 'repos:read' },
      { id: 'repos.get', method: 'get', scope: 'repos:read' },
    ],
  );
  assert.deepEqual(
    repoOperations.map((operation) => operation.mcp && 'tool' in operation.mcp
      ? operation.mcp.tool
      : null),
    ['list_repos', 'get_repo'],
  );
  assert.equal(
    PUBLIC_V1_OPERATIONS.some(
      (operation) => operation.scope === 'repos:read' && operation.method !== 'get',
    ),
    false,
    '`repos:read` must never authorize a public write operation',
  );
});
