/**
 * API integration suite — IN-PROCESS (no docker required beyond Postgres).
 *
 * Boots the real NestJS orchestrator in-process via @nestjs/testing against a
 * real Postgres and proves the control-plane surface that does NOT depend on a
 * live AIO sandbox:
 *   (A) the API boots and serves REST under the operator-auth gate;
 *   (B) repos/tasks CRUD against real Postgres, with the guardrails semaphore
 *       admitting a created task (pending -> running).
 *
 * NOTE on the live execution path: creating a task makes guardrails transition it
 * to `running` and THEN best-effort `provision()` an AIO sandbox (a provision
 * failure is logged, not fatal — see GuardrailsService.startRunning), so (B)
 * holds here even with no sandbox image. The live-sandbox flow — provisioning a
 * real cap-aio-<taskId> container, the AioPtyClient dialing its terminal OUT by
 * container name, command injection, write-lock, and codex+CPR startup — CANNOT
 * run in-process: the orchestrator must be ON cap-net (inside the compose api
 * container) to resolve the sandbox by name. Those assertions live in the
 * black-box compose suite `aio-e2e.mjs`, run via `scripts/aio-e2e.sh`
 * (pnpm --filter @cap/api test:e2e:aio).
 *
 * Prereqs: docker Postgres on :5433 with migrations applied. The `test:e2e`
 * script builds the api first.
 * Run:
 *   DATABASE_URL=postgresql://cap:cap@127.0.0.1:5433/cap?schema=public \
 *   AUTH_TOKEN=test-operator-token \
 *   node --test --test-force-exit apps/api/test/api-e2e.mjs
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';

import { AppModule } from '../dist/app.module.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';

const AUTH_TOKEN = process.env.AUTH_TOKEN ?? 'test-operator-token';
process.env.AUTH_TOKEN = AUTH_TOKEN;

let app;
let port;
let prisma;

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks(); // so the provider's onModuleDestroy stops sandboxes
  await app.listen(0);
  port = app.getHttpServer().address().port;
  prisma = app.get(PrismaService);
});

after(async () => {
  await app?.close();
});

const base = () => `http://127.0.0.1:${port}`;
const authHeaders = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };

async function waitFor(predicate, { timeoutMs = 15000, stepMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(stepMs);
  }
  return false;
}

/** Create a repo + task via REST. Creating the task triggers admit -> (best-effort) provision. */
async function createTaskViaRest(prompt = 'do a thing', extra = {}) {
  const repoRes = await fetch(`${base()}/repos`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: `e2e-${randomUUID().slice(0, 6)}`, gitSource: 'https://x/y.git' }),
  });
  const repo = await repoRes.json();
  const taskRes = await fetch(`${base()}/repos/${repo.id}/tasks`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ prompt, ...extra }),
  });
  const task = await taskRes.json();
  return { repoId: repo.id, taskId: task.id, task };
}

// ── (A) API up + operator-auth gate ─────────────────────────────────────────
test('A. health is open; REST is gated by the operator token', async () => {
  const health = await fetch(`${base()}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(`${base()}/tasks`)).status, 401, 'no token -> 401');
  assert.equal(
    (await fetch(`${base()}/tasks`, { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
    'wrong token -> 401',
  );
  assert.equal((await fetch(`${base()}/tasks`, { headers: authHeaders })).status, 200, 'valid -> 200');
});

// ── (B) CRUD + guardrails admit ─────────────────────────────────────────────
test('B. repos/tasks CRUD + guardrails admits the task (pending -> running)', async () => {
  const { taskId } = await createTaskViaRest('do a thing');
  const admitted = await waitFor(async () => {
    const one = await (await fetch(`${base()}/tasks/${taskId}`, { headers: authHeaders })).json();
    return one.status === 'running';
  });
  assert.ok(admitted, 'created task is admitted to running by the concurrency semaphore');

  assert.equal(
    (await fetch(`${base()}/tasks/${randomUUID()}`, { headers: authHeaders })).status,
    404,
    'unknown task -> 404',
  );
  assert.equal(
    (
      await fetch(`${base()}/repos`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: '', gitSource: 'x' }),
      })
    ).status,
    400,
    'invalid repo body -> 400',
  );
});

// ── (D) /version build-metadata: unauthenticated, env-driven, honest fallback ─
// versioned-release-pipeline (api-version track, task 1.4 / integration 5.1-5.2).
// The handler reads process.env at REQUEST time via resolveVersionResponse, so we
// mutate the version env across fetches against the SAME booted app. /version is a
// guard-exempt sibling of /health: it is served with NO Authorization header.
test('D. /version reports injected build metadata, unauthenticated + honest fallback', async () => {
  const VERSION_ENV = ['CAP_VERSION', 'GIT_SHA', 'BUILD_TIME'];
  const saved = Object.fromEntries(VERSION_ENV.map((k) => [k, process.env[k]]));
  const clearVersionEnv = () => {
    for (const k of VERSION_ENV) delete process.env[k];
  };
  try {
    // (1) all three injected -> reported verbatim, unauthenticated (no token).
    process.env.CAP_VERSION = 'v1.2.3';
    process.env.GIT_SHA = 'abc1234';
    process.env.BUILD_TIME = '2026-06-17T00:00:00Z';
    const injected = await fetch(`${base()}/version`); // deliberately no auth header
    assert.equal(injected.status, 200, '/version served unauthenticated (guard-exempt like /health)');
    assert.deepEqual(await injected.json(), {
      version: 'v1.2.3',
      gitSha: 'abc1234',
      buildTime: '2026-06-17T00:00:00Z',
    });

    // (2) only one injected -> the other two degrade honestly to "unknown".
    clearVersionEnv();
    process.env.CAP_VERSION = 'v9.9.9';
    const partial = await fetch(`${base()}/version`);
    assert.equal(partial.status, 200);
    assert.deepEqual(await partial.json(), {
      version: 'v9.9.9',
      gitSha: 'unknown',
      buildTime: 'unknown',
    });

    // (3) a no-arg source build (no version env at all) -> all "unknown", not an error.
    clearVersionEnv();
    const bare = await fetch(`${base()}/version`);
    assert.equal(bare.status, 200, '/version reports honestly rather than erroring with no env');
    assert.deepEqual(await bare.json(), {
      version: 'unknown',
      gitSha: 'unknown',
      buildTime: 'unknown',
    });
  } finally {
    for (const k of VERSION_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ── (C) guardrail params persist + echo; operator stop -> cancelled ──────────
test('C. guardrail params round-trip and operator stop cancels the task', async () => {
  const { taskId, task } = await createTaskViaRest('guardrail task', {
    idleTimeoutMs: 1_800_000,
    deadlineMs: 7_200_000,
  });
  // create response echoes the persisted guardrail params (sent == readable).
  assert.equal(task.idleTimeoutMs, 1_800_000, 'create echoes idleTimeoutMs');
  assert.equal(task.deadlineMs, 7_200_000, 'create echoes deadlineMs');

  // a subsequent GET reads back the same persisted values.
  const fetched = await (
    await fetch(`${base()}/tasks/${taskId}`, { headers: authHeaders })
  ).json();
  assert.equal(fetched.idleTimeoutMs, 1_800_000, 'GET echoes persisted idleTimeoutMs');
  assert.equal(fetched.deadlineMs, 7_200_000, 'GET echoes persisted deadlineMs');

  // a task created WITHOUT guardrail params reads them back as null (opt-in/off).
  const { task: plain } = await createTaskViaRest('plain task');
  assert.equal(plain.idleTimeoutMs ?? null, null, 'omitted idleTimeoutMs reads back null (no idle reclaim)');
  assert.equal(plain.deadlineMs ?? null, null, 'omitted deadlineMs reads back null');

  // operator stop -> cancelled (transition fires onTerminal: teardown + slot release).
  const stopRes = await fetch(`${base()}/tasks/${taskId}/stop`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(stopRes.status, 200, 'stop -> 200');
  assert.equal((await stopRes.json()).status, 'cancelled', 'stop transitions the task to cancelled');

  // idempotent: stopping a now-terminal task is a safe no-op, still cancelled.
  const again = await fetch(`${base()}/tasks/${taskId}/stop`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(again.status, 200, 'second stop -> 200 (idempotent)');
  assert.equal((await again.json()).status, 'cancelled', 'still cancelled after a repeat stop');

  // stop unknown -> 404; stop without the operator token -> 401 (gated).
  assert.equal(
    (await fetch(`${base()}/tasks/${randomUUID()}/stop`, { method: 'POST', headers: authHeaders })).status,
    404,
    'stop unknown task -> 404',
  );
  assert.equal(
    (await fetch(`${base()}/tasks/${taskId}/stop`, { method: 'POST' })).status,
    401,
    'stop without token -> 401',
  );
});
