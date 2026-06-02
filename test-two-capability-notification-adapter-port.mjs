/**
 * Minimal test: Two-capability notification adapter port
 * (agent-events-and-approvals spec)
 *
 * Requirement summary:
 *   - The port exposes two DISTINCT capabilities: `notify` (one-way push) and
 *     `requestDecision` (round-trip approval).
 *   - ALL adapters implement `notify`.
 *   - `requestDecision` is OPTIONAL; one-way-only adapters omit it.
 *   - `supportsRequestDecision()` type guard returns true iff adapter has the
 *     round-trip capability.
 *   - `NotificationRouter.notify()` fans out to EVERY registered adapter.
 *   - `NotificationRouter.requestDecision()` is routed ONLY to decision-capable
 *     adapters; one-way-only adapters are never asked to decide.
 *   - When no decision-capable adapter is registered, `requestDecision` returns
 *     `null` (so the caller can fall back).
 */

import assert from 'node:assert/strict';

// -- Import compiled dist files (no transpile needed) --
import { supportsRequestDecision } from './apps/runner/dist/notify/adapter.port.js';
import { NotificationRouter } from './apps/runner/dist/notify/notification-router.js';

// ── helpers ───────────────────────────────────────────────────────────────

const TASK_ID = '00000000-0000-0000-0000-000000000001';

function makeNotifyPayload(level = 'info') {
  return { taskId: TASK_ID, title: 'Test', body: 'body', level };
}

function makeDecisionPayload() {
  return {
    taskId: TASK_ID,
    requestId: 'req-1',
    title: 'Approve?',
    body: 'details',
    choices: ['allow', 'deny'],
  };
}

// ── test cases ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => { console.log(`  PASS  ${name}`); passed++; },
        (err) => { console.error(`  FAIL  ${name}\n         ${err.message}`); failed++; }
      );
    }
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}\n         ${err.message}`);
    failed++;
  }
}

// ── 1. supportsRequestDecision type guard ────────────────────────────────

const oneWayAdapter = {
  name: 'one-way',
  async notify(_p) {},
};

const decisionAdapter = {
  name: 'decision-capable',
  async notify(_p) {},
  async requestDecision(_p) { return { behavior: 'allow' }; },
};

test('supportsRequestDecision returns false for one-way-only adapter', () => {
  assert.equal(supportsRequestDecision(oneWayAdapter), false);
});

test('supportsRequestDecision returns true for decision-capable adapter', () => {
  assert.equal(supportsRequestDecision(decisionAdapter), true);
});

// ── 2. notify fans out to every adapter ──────────────────────────────────

async function testNotifyFanOut() {
  const calls = [];
  const a1 = { name: 'a1', async notify(p) { calls.push('a1:' + p.level); } };
  const a2 = { name: 'a2', async notify(p) { calls.push('a2:' + p.level); }, async requestDecision(_p) { return { behavior: 'deny' }; } };

  const router = new NotificationRouter([a1, a2]);
  await router.notify(makeNotifyPayload('awaiting_input'));

  assert.deepEqual(calls.sort(), ['a1:awaiting_input', 'a2:awaiting_input']);
}

// ── 3. notify continues even when one adapter throws ─────────────────────

async function testNotifyFaultIsolation() {
  const calls = [];
  const bad = { name: 'bad', async notify(_p) { throw new Error('network down'); } };
  const good = { name: 'good', async notify(p) { calls.push('good:' + p.level); } };

  const router = new NotificationRouter([bad, good]);
  // Must not throw even though 'bad' throws
  await router.notify(makeNotifyPayload('warning'));

  assert.deepEqual(calls, ['good:warning']);
}

// ── 4. requestDecision routed ONLY to decision-capable adapter ────────────

async function testRequestDecisionOnlyToCapable() {
  const oneWayCalled = [];
  const ow = { name: 'ow', async notify(_p) {}, };
  // deliberately do NOT add requestDecision

  const capable = {
    name: 'cap',
    async notify(_p) {},
    async requestDecision(_p) { return { behavior: 'allow' }; },
  };

  const router = new NotificationRouter([ow, capable]);
  const decision = await router.requestDecision(makeDecisionPayload());

  assert.equal(oneWayCalled.length, 0, 'one-way adapter must not receive requestDecision');
  assert.deepEqual(decision, { behavior: 'allow' });
}

// ── 5. requestDecision returns null when no capable adapters ──────────────

async function testRequestDecisionNullWhenNoCapable() {
  const router = new NotificationRouter([oneWayAdapter]);
  const result = await router.requestDecision(makeDecisionPayload());
  assert.equal(result, null);
}

// ── 6. decisionCapableAdapters() returns only capable subset ─────────────

function testDecisionCapableAdaptersFilter() {
  const router = new NotificationRouter([oneWayAdapter, decisionAdapter]);
  const capable = router.decisionCapableAdapters();
  assert.equal(capable.length, 1);
  assert.equal(capable[0].name, 'decision-capable');
}

// ── run async tests ───────────────────────────────────────────────────────

console.log('\nTwo-capability notification adapter port\n');

const promises = [];
promises.push(test('notify fans out to every registered adapter', testNotifyFanOut));
promises.push(test('notify fault isolation: adapter failure does not block others', testNotifyFaultIsolation));
promises.push(test('requestDecision is routed only to decision-capable adapter', testRequestDecisionOnlyToCapable));
promises.push(test('requestDecision returns null when no capable adapter registered', testRequestDecisionNullWhenNoCapable));
test('decisionCapableAdapters() returns only the capable subset', testDecisionCapableAdaptersFilter);

await Promise.all(promises.filter(Boolean));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
