/**
 * Route-integration tests (api-key-machine-identity, route-integration 6.3).
 *
 * Drives the REAL TasksController + ReposController directly (no Nest DI) with
 * stub services and fabricated principals attached the way the AuthGuard attaches
 * them (`req.operatorPrincipal`). Covers the two route-integration behaviors:
 *
 *   1. ATTRIBUTION (6.1; fix-local-account-task-attribution): the controller
 *      threads the acting operator's ACCOUNT primary key (`user.id`) into the
 *      service —
 *        - an api-key principal's task create/stop attributes to the KEY OWNER;
 *        - a session principal's task create/stop attributes to the SESSION user;
 *        - a LOCAL account (no GitHub identity, `githubId === null`) STILL
 *          attributes to its `user.id` — NOT collapsed to undefined — so its stored
 *          Codex credential resolves at run time;
 *        - the legacy shared-token principal (NO account identity at all) threads
 *          `undefined` (system attribution), unchanged.
 *
 *   2. SCOPE GATING (6.2): a principal that carries scopes is admitted to a
 *      scoped route only when its scopes include the required scope —
 *        - a `tasks:read`-only api-key is 403'd on the `tasks:write` routes
 *          (create, stop) but admitted on the `tasks:read` route (list);
 *        - a `repos:read`-only api-key is admitted on `GET /repos`, and a key
 *          WITHOUT `repos:read` is 403'd there;
 *        - a scopeless session principal (`scopes === undefined`) passes EVERY
 *          scope gate (allow-all), so existing console behavior is unchanged;
 *        - insufficient scope is a 403 (ForbiddenException), distinct from the
 *          guard's 401.
 *
 * Run from apps/api with `pnpm test` (nest build → node --test dist/**\/*.spec.js),
 * so the cross-track imports (`hasScope` from operator-principal, `Scope` from
 * @cap/contracts) resolve against the merged, compiled tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';

import type { Scope, SessionUser, TaskResponse, RepoResponse } from '@cap/contracts';
import { TasksController } from './tasks.controller';
import { ReposController } from '../repos/repos.controller';
import type { TasksService } from './tasks.service';
import type { ReposService } from '../repos/repos.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ID = '00000000-0000-4000-a000-000000000001';
const TASK_ID = '00000000-0000-4000-a000-000000000002';

const SESSION_GITHUB_ID = 12345;
const KEY_OWNER_GITHUB_ID = 67890;

function makeSessionUser(githubId: number): SessionUser {
  return {
    id: `user-${githubId}`,
    githubId,
    login: `u${githubId}`,
    name: `User ${githubId}`,
    avatarUrl: 'https://example.invalid/a.png',
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  };
}

/** A human session principal — carries NO scopes (allow-all). */
function sessionPrincipal(githubId: number): OperatorPrincipal {
  return { kind: 'session', user: makeSessionUser(githubId) };
}

/**
 * A LOCAL account (password/OTP) session principal — `githubId === null` but a
 * real account `id`. Carries NO scopes (allow-all), like any session principal.
 */
function localSessionPrincipal(userId: string): OperatorPrincipal {
  return {
    kind: 'session',
    user: {
      id: userId,
      githubId: null,
      login: null,
      name: 'Local Operator',
      avatarUrl: null,
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
  };
}

/** The legacy shared-token operator — no account identity, no scopes. */
function legacyPrincipal(): OperatorPrincipal {
  return { kind: 'legacy-token', user: null };
}

/** An api-key principal owned by `ownerGithubId` carrying exactly `scopes`. */
function apiKeyPrincipal(ownerGithubId: number, scopes: Scope[]): OperatorPrincipal {
  return {
    kind: 'api-key',
    user: makeSessionUser(ownerGithubId),
    scopes,
    keyId: 'key-abc',
  };
}

/** A request with a principal attached the way the guard attaches it. */
function reqWith(principal: OperatorPrincipal | undefined): AuthenticatedRequest {
  return { operatorPrincipal: principal } as AuthenticatedRequest;
}

/**
 * Stub TasksService recording the account `userId` create/stop were called with,
 * so the attribution threaded by the controller (6.1) is asserted at the service
 * seam (fix-local-account-task-attribution: the threaded value is the account
 * primary key, NOT the numeric githubId).
 */
function makeTasksService(): {
  service: TasksService;
  calls: { create: Array<string | undefined>; stop: Array<string | undefined>; list: number };
} {
  const calls = { create: [] as Array<string | undefined>, stop: [] as Array<string | undefined>, list: 0 };
  const taskRow = { id: TASK_ID, repoId: REPO_ID } as unknown as TaskResponse;
  const service = {
    async create(_repoId: string, _body: unknown, userId?: string) {
      calls.create.push(userId);
      return taskRow;
    },
    async stop(_id: string, userId?: string) {
      calls.stop.push(userId);
      return taskRow;
    },
    async list() {
      calls.list += 1;
      return [taskRow];
    },
    async findById() {
      return taskRow;
    },
  } as unknown as TasksService;
  return { service, calls };
}

function makeReposService(): { service: ReposService; calls: { list: number } } {
  const calls = { list: 0 };
  const repoRow = { id: REPO_ID } as unknown as RepoResponse;
  const service = {
    async list() {
      calls.list += 1;
      return [repoRow];
    },
    async create() {
      return repoRow;
    },
    async findById() {
      return repoRow;
    },
  } as unknown as ReposService;
  return { service, calls };
}

const CREATE_BODY = { prompt: 'do the thing' } as never;

// ---------------------------------------------------------------------------
// 6.1 — attribution
// ---------------------------------------------------------------------------

test('an api-key-created task attributes to the key owner', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  await ctrl.create(
    REPO_ID,
    CREATE_BODY,
    reqWith(apiKeyPrincipal(KEY_OWNER_GITHUB_ID, ['tasks:write'])),
  );

  assert.deepEqual(
    calls.create,
    [`user-${KEY_OWNER_GITHUB_ID}`],
    'create attributes to the api-key owner account id',
  );
});

test('a session-created task attributes to the session user', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  await ctrl.create(REPO_ID, CREATE_BODY, reqWith(sessionPrincipal(SESSION_GITHUB_ID)));

  assert.deepEqual(
    calls.create,
    [`user-${SESSION_GITHUB_ID}`],
    'create attributes to the session user account id',
  );
});

test('a LOCAL account (githubId=null) attributes to its account id (NOT undefined)', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  // The regression this fix closes: a local account (no GitHub identity) must
  // still be owner-attributed by its `user.id`, so its `task.created` audit event
  // carries the owner FK and the owner-scoped Codex credential resolves at run
  // time — instead of collapsing to undefined and silently degrading to env.
  await ctrl.create(REPO_ID, CREATE_BODY, reqWith(localSessionPrincipal('local-acct-1')));
  await ctrl.stop(TASK_ID, reqWith(localSessionPrincipal('local-acct-1')));

  assert.deepEqual(calls.create, ['local-acct-1'], 'a local account create attributes to its account id');
  assert.deepEqual(calls.stop, ['local-acct-1'], 'a local account stop attributes to its account id');
});

test('an api-key stop attributes to the key owner', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  await ctrl.stop(TASK_ID, reqWith(apiKeyPrincipal(KEY_OWNER_GITHUB_ID, ['tasks:write'])));

  assert.deepEqual(
    calls.stop,
    [`user-${KEY_OWNER_GITHUB_ID}`],
    'stop attributes to the api-key owner account id',
  );
});

test('a session stop attributes to the session user', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  await ctrl.stop(TASK_ID, reqWith(sessionPrincipal(SESSION_GITHUB_ID)));

  assert.deepEqual(
    calls.stop,
    [`user-${SESSION_GITHUB_ID}`],
    'stop attributes to the session user account id',
  );
});

test('the legacy shared-token principal threads no account id (system attribution)', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  await ctrl.create(REPO_ID, CREATE_BODY, reqWith(legacyPrincipal()));

  assert.deepEqual(
    calls.create,
    [undefined],
    'a principal with NO account identity (machine/legacy) threads undefined',
  );
});

// ---------------------------------------------------------------------------
// 6.2 — scope gating
// ---------------------------------------------------------------------------

test('a tasks:read-only key is 403d on the tasks:write create route', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  await assert.rejects(
    () => ctrl.create(REPO_ID, CREATE_BODY, reqWith(apiKeyPrincipal(KEY_OWNER_GITHUB_ID, ['tasks:read']))),
    (err: unknown) => err instanceof ForbiddenException,
    'create requires tasks:write — a tasks:read-only key is 403d',
  );
  assert.equal(calls.create.length, 0, 'no task is created on a denied scope (no state change)');
});

test('a tasks:read-only key is 403d on the tasks:write stop route', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  await assert.rejects(
    () => ctrl.stop(TASK_ID, reqWith(apiKeyPrincipal(KEY_OWNER_GITHUB_ID, ['tasks:read']))),
    (err: unknown) => err instanceof ForbiddenException,
    'stop requires tasks:write — a tasks:read-only key is 403d',
  );
  assert.equal(calls.stop.length, 0, 'no stop is performed on a denied scope (no state change)');
});

test('a tasks:read key is admitted on the tasks:read list route', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  const res = await ctrl.list(reqWith(apiKeyPrincipal(KEY_OWNER_GITHUB_ID, ['tasks:read'])));

  assert.equal(calls.list, 1, 'a tasks:read key passes the tasks:read list gate');
  assert.ok(Array.isArray(res));
});

test('a key WITHOUT tasks:read is 403d on the tasks:read list route', async () => {
  const { service, calls } = makeTasksService();
  const ctrl = new TasksController(service);

  await assert.rejects(
    () => ctrl.list(reqWith(apiKeyPrincipal(KEY_OWNER_GITHUB_ID, ['repos:read']))),
    (err: unknown) => err instanceof ForbiddenException,
    'list requires tasks:read — a key without it is 403d',
  );
  assert.equal(calls.list, 0, 'the list is not served on a denied scope');
});

test('a repos:read key is admitted on GET /repos, a key without it is 403d', async () => {
  const { service, calls } = makeReposService();
  const ctrl = new ReposController(service);

  const res = await ctrl.list(reqWith(apiKeyPrincipal(KEY_OWNER_GITHUB_ID, ['repos:read'])));
  assert.equal(calls.list, 1, 'a repos:read key passes the repos:read gate');
  assert.ok(Array.isArray(res));

  await assert.rejects(
    () => ctrl.list(reqWith(apiKeyPrincipal(KEY_OWNER_GITHUB_ID, ['tasks:read']))),
    (err: unknown) => err instanceof ForbiddenException,
    'GET /repos requires repos:read — a key without it is 403d',
  );
  assert.equal(calls.list, 1, 'the repo list is not served a second time on a denied scope');
});

// ---------------------------------------------------------------------------
// 6.2 — scopeless session passes every gate (allow-all)
// ---------------------------------------------------------------------------

test('a scopeless session principal passes every scope gate', async () => {
  const { service: tasks, calls: taskCalls } = makeTasksService();
  const tasksCtrl = new TasksController(tasks);
  const { service: repos, calls: repoCalls } = makeReposService();
  const reposCtrl = new ReposController(repos);

  const session = () => reqWith(sessionPrincipal(SESSION_GITHUB_ID));

  // tasks:write routes
  await tasksCtrl.create(REPO_ID, CREATE_BODY, session());
  await tasksCtrl.stop(TASK_ID, session());
  // tasks:read route
  await tasksCtrl.list(session());
  // repos:read route
  await reposCtrl.list(session());

  assert.equal(taskCalls.create.length, 1, 'session passes the tasks:write create gate');
  assert.equal(taskCalls.stop.length, 1, 'session passes the tasks:write stop gate');
  assert.equal(taskCalls.list, 1, 'session passes the tasks:read list gate');
  assert.equal(repoCalls.list, 1, 'session passes the repos:read gate');
});
