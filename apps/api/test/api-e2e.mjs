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
async function createTaskViaRest(prompt = 'do a thing') {
  const repoRes = await fetch(`${base()}/repos`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: `e2e-${randomUUID().slice(0, 6)}`, gitSource: 'https://x/y.git' }),
  });
  const repo = await repoRes.json();
  const taskRes = await fetch(`${base()}/repos/${repo.id}/tasks`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ prompt }),
  });
  const task = await taskRes.json();
  return { repoId: repo.id, taskId: task.id };
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
