/**
 * Minimal test: requirement "Per-task token scope and one-task binding"
 * from openspec/changes/agent-control-platform/specs/runner-dialback-and-creds/spec.md
 *
 * Spec: "Each TASK_TOKEN SHALL be scoped to exactly one task, and SHALL NOT be
 *        reusable to authenticate a connection for a different task."
 *
 * Scenario under test:
 *   WHEN  a runner presents a TASK_TOKEN issued for task A while claiming to be task B
 *   THEN  the orchestrator rejects the handshake
 *
 * This test is self-contained: it re-implements the TaskTokenService logic
 * in plain JS (stripping the NestJS @Injectable decorator) so the script runs
 * with `node` directly — no build step, no test runner required.
 */

import { randomBytes } from 'node:crypto';

// ---------- Inline port of TaskTokenService (apps/api/src/tasks/task-token.service.ts) ----------

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

class TaskTokenService {
  byTask = new Map();
  byToken = new Map();

  constructor({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  issue(taskId) {
    const id = taskId?.trim();
    if (!id) throw new Error('Cannot issue a TASK_TOKEN without a taskId');
    this.revokeForTask(id);
    const token = randomBytes(32).toString('base64url');
    const record = { taskId: id, token, expiresAtEpochMs: this.now() + this.ttlMs };
    this.byTask.set(id, record);
    this.byToken.set(token, record);
    return token;
  }

  verify(claimedTaskId, token) {
    const id = claimedTaskId?.trim();
    if (!id || !token) return false;
    const record = this.byToken.get(token);
    if (!record) return false;
    if (record.taskId !== id) return false;          // cross-task rejection
    if (this.now() >= record.expiresAtEpochMs) {
      this.revokeForTask(record.taskId);
      return false;
    }
    return true;
  }

  revokeForTask(taskId) {
    const existing = this.byTask.get(taskId);
    if (!existing) return;
    this.byTask.delete(taskId);
    this.byToken.delete(existing.token);
  }
}

// ---------- Test harness ----------

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function assertThrows(label, fn) {
  try {
    fn();
    console.error(`  FAIL  ${label} (expected throw, got none)`);
    failed++;
  } catch {
    console.log(`  PASS  ${label}`);
    passed++;
  }
}

// ---------- Test cases ----------

console.log('\n=== Requirement: Per-task token scope and one-task binding ===\n');

// 1. Core scenario from the spec:
//    token issued for task A CANNOT authenticate task B
{
  const svc = new TaskTokenService();
  const tokenA = svc.issue('task-A');

  assert(
    'Token issued for task-A is valid when claiming task-A',
    svc.verify('task-A', tokenA) === true,
  );

  assert(
    'Token issued for task-A is REJECTED when claiming task-B (cross-task use denied)',
    svc.verify('task-B', tokenA) === false,
  );
}

// 2. Each task gets its own distinct token; tokens are not interchangeable
{
  const svc = new TaskTokenService();
  const tokenA = svc.issue('task-A');
  const tokenB = svc.issue('task-B');

  assert(
    'task-A token differs from task-B token (each task gets a unique token)',
    tokenA !== tokenB,
  );

  assert(
    'task-A token verifies for task-A',
    svc.verify('task-A', tokenA) === true,
  );

  assert(
    'task-B token verifies for task-B',
    svc.verify('task-B', tokenB) === true,
  );

  assert(
    'task-A token does NOT verify for task-B',
    svc.verify('task-B', tokenA) === false,
  );

  assert(
    'task-B token does NOT verify for task-A',
    svc.verify('task-A', tokenB) === false,
  );
}

// 3. Re-issuing for the same task revokes the old token (one live token per task)
{
  const svc = new TaskTokenService();
  const token1 = svc.issue('task-A');
  const token2 = svc.issue('task-A'); // re-issue should invalidate token1

  assert(
    'After re-issue, the new token verifies for task-A',
    svc.verify('task-A', token2) === true,
  );

  assert(
    'After re-issue, the old token no longer verifies for task-A (one-token binding)',
    svc.verify('task-A', token1) === false,
  );
}

// 4. Revoked token cannot be used for any task
{
  const svc = new TaskTokenService();
  const tokenA = svc.issue('task-A');
  svc.revokeForTask('task-A');

  assert(
    'Revoked task-A token is rejected for task-A',
    svc.verify('task-A', tokenA) === false,
  );

  assert(
    'Revoked task-A token is rejected for task-B (cannot cross-use revoked token)',
    svc.verify('task-B', tokenA) === false,
  );
}

// 5. Expired token is rejected (TTL boundary)
{
  let fakeNow = 1_000_000;
  const svc = new TaskTokenService({ ttlMs: 5000, now: () => fakeNow });
  const token = svc.issue('task-A');

  assert(
    'Token is valid before expiry',
    svc.verify('task-A', token) === true,
  );

  fakeNow += 5001; // advance past TTL

  assert(
    'Token is rejected after TTL expires',
    svc.verify('task-A', token) === false,
  );
}

// 6. Edge cases: empty/null inputs return false, not throws
{
  const svc = new TaskTokenService();
  const token = svc.issue('task-A');

  assert(
    'verify with empty claimedTaskId returns false',
    svc.verify('', token) === false,
  );

  assert(
    'verify with empty token returns false',
    svc.verify('task-A', '') === false,
  );

  assertThrows(
    'issue with empty taskId throws',
    () => svc.issue(''),
  );
}

// ---------- Summary ----------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}
