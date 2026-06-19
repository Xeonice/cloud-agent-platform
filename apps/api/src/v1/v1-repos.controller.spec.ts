/**
 * Tests for `V1ReposController` (public-v1-api, tasks 3.1 / 3.2 / 3.4 / 3.7).
 *
 * Covers:
 *   1. Keyset pagination (`GET /v1/repos`) walks the full set in `(createdAt,id)`
 *      order with NO drop/dup and `nextCursor` null on the last page (3.2).
 *   2. Scope gates (3.4): a `tasks:read`-only api-key (no `repos:read`) is 403'd
 *      on `GET /v1/repos`; an api-key WITH `repos:read` passes; a scopeless
 *      session principal passes (allow-all).
 *   3. `GET /v1/repos/:id` delegates to `ReposService.findById`.
 *
 * Run from apps/api with `pnpm test` (nest build → node --test dist/**\/*.spec.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';

import { V1ReposController } from './v1-repos.controller';
import { PrismaService } from '../prisma/prisma.service';
import { ReposService } from '../repos/repos.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import type { RepoResponse } from '@cap/contracts';

const SESSION_PRINCIPAL = {
  kind: 'session',
  user: { githubId: 1, login: 'u', name: 'U', avatarUrl: '', allowed: true },
} as OperatorPrincipal;

const READS_REPOS_KEY = {
  kind: 'api-key',
  user: { githubId: 2, login: 'k', name: 'K', avatarUrl: '', allowed: true },
  scopes: ['repos:read'],
  keyId: 'k1',
} as OperatorPrincipal;

const NO_REPOS_KEY = {
  kind: 'api-key',
  user: { githubId: 3, login: 'k2', name: 'K2', avatarUrl: '', allowed: true },
  scopes: ['tasks:read'],
  keyId: 'k2',
} as OperatorPrincipal;

const reqWith = (p?: OperatorPrincipal): AuthenticatedRequest =>
  ({ operatorPrincipal: p }) as AuthenticatedRequest;

/**
 * A valid v4-shaped UUID whose final hex digit encodes `i`, so ids pass the
 * contract's `z.string().uuid()` validation AND sort lexicographically by `i`
 * (the keyset tie-break the pagination walk exercises).
 */
function repoUuid(i: number): string {
  return `00000000-0000-4000-c000-00000000000${i.toString(16)}`;
}

function makeRepoRow(i: number, createdAt: Date): RepoResponse {
  return {
    id: repoUuid(i),
    name: `r${i}`,
    gitSource: `https://github.com/x/r${i}`,
    createdAt,
    description: null,
    defaultBranch: null,
    branchCount: null,
    updatedAt: null,
    githubId: null,
    isDefault: false,
  } as RepoResponse;
}

test('a tasks:read-only api-key is 403 on GET /v1/repos', async () => {
  const controller = new V1ReposController(
    {} as ReposService,
    { repo: { async findMany() { return []; } } } as unknown as PrismaService,
  );
  await assert.rejects(
    () => controller.list({ limit: 50 } as never, reqWith(NO_REPOS_KEY)),
    (err: unknown) => err instanceof ForbiddenException,
  );
});

test('an api-key with repos:read passes GET /v1/repos', async () => {
  const controller = new V1ReposController(
    {} as ReposService,
    { repo: { async findMany() { return []; } } } as unknown as PrismaService,
  );
  const page = await controller.list({ limit: 50 } as never, reqWith(READS_REPOS_KEY));
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
});

test('GET /v1/repos/:id delegates to ReposService.findById', async () => {
  let asked: string | undefined;
  const repos = {
    async findById(id: string) {
      asked = id;
      return makeRepoRow(9, new Date());
    },
  } as unknown as ReposService;
  const controller = new V1ReposController(repos, {} as PrismaService);

  const repo = await controller.findById('repo-9', reqWith(SESSION_PRINCIPAL));
  assert.equal(asked, 'repo-9', 'the path :id is delegated verbatim to ReposService.findById');
  assert.equal(repo.id, repoUuid(9), 'the service result is returned unchanged');
});

test('GET /v1/repos paginates the full set in (createdAt,id) order with no drop/dup', async () => {
  const base = Date.parse('2026-06-19T00:00:00.000Z');
  const all: RepoResponse[] = [];
  for (let i = 0; i < 7; i += 1) {
    all.push(makeRepoRow(i, new Date(base + Math.floor(i / 2) * 1000)));
  }
  const sorted = [...all].sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const prisma = {
    repo: {
      async findMany({
        where,
        take,
      }: {
        where: Record<string, unknown>;
        orderBy: unknown;
        take: number;
      }) {
        let rows = sorted;
        const or = (where as { OR?: unknown[] }).OR;
        if (or) {
          const gtClause = or[0] as { createdAt: { gt: Date } };
          const eqClause = or[1] as { createdAt: Date; id: { gt: string } };
          rows = sorted.filter(
            (r) =>
              r.createdAt.getTime() > gtClause.createdAt.gt.getTime() ||
              (r.createdAt.getTime() === eqClause.createdAt.getTime() &&
                r.id > eqClause.id.gt),
          );
        }
        return rows.slice(0, take);
      },
    },
  } as unknown as PrismaService;

  const controller = new V1ReposController({} as ReposService, prisma);

  const seen: string[] = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const page = await controller.list(
      { limit: 2, cursor } as never,
      reqWith(SESSION_PRINCIPAL),
    );
    for (const r of page.items) seen.push(r.id);
    cursor = page.nextCursor ?? undefined;
    guard += 1;
    assert.ok(guard < 20, 'pagination must terminate');
  } while (cursor);

  assert.equal(seen.length, sorted.length, 'no dropped rows');
  assert.equal(new Set(seen).size, sorted.length, 'no duplicate rows');
  assert.deepEqual(seen, sorted.map((r) => r.id), '(createdAt,id) order preserved');
});
