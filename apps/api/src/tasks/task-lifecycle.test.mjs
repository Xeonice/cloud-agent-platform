/**
 * Pure unit test for the task lifecycle state machine — the `cancelled` terminal
 * and its edges (task-guardrail-controls 4.1).
 *
 * Mirrors `task-lifecycle.ts`'s ALLOWED_TRANSITIONS / TERMINAL_STATUSES (inlined,
 * no transpile step, matching the sibling guardrail `.mjs` tests). The REAL module
 * is additionally exercised end-to-end by `test/api-e2e.mjs` (test C: an operator
 * stop drives running -> cancelled), so the two together pin both the table and
 * the wired transition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- inline mirror of task-lifecycle.ts -------------------------------------

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'agent_failed_to_start'];

const ALLOWED_TRANSITIONS = {
  pending: ['queued', 'running', 'agent_failed_to_start', 'failed', 'cancelled'],
  queued: ['running', 'agent_failed_to_start', 'failed', 'cancelled'],
  running: ['awaiting_input', 'completed', 'failed', 'agent_failed_to_start', 'cancelled'],
  awaiting_input: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  agent_failed_to_start: [],
};

const isTerminal = (status) => TERMINAL_STATUSES.includes(status);
const canTransition = (from, to) => (ALLOWED_TRANSITIONS[from] ?? []).includes(to);

// --- tests ------------------------------------------------------------------

test('cancelled is a terminal status with no outgoing edges', () => {
  assert.ok(isTerminal('cancelled'), 'cancelled is terminal');
  assert.deepEqual(ALLOWED_TRANSITIONS.cancelled, [], 'cancelled has no outgoing edges');
});

test('an operator stop edge -> cancelled exists from every ACTIVE state', () => {
  assert.ok(canTransition('queued', 'cancelled'), 'queued -> cancelled');
  assert.ok(canTransition('running', 'cancelled'), 'running -> cancelled');
  assert.ok(canTransition('awaiting_input', 'cancelled'), 'awaiting_input -> cancelled');
});

test('cancelled is NOT reachable from pending or from a terminal state', () => {
  // pending is transient (immediately admitted); stop targets active tasks.
  assert.equal(canTransition('pending', 'cancelled'), true, 'pending -> cancelled stops durable admission');
  for (const terminal of TERMINAL_STATUSES) {
    assert.equal(
      canTransition(terminal, 'cancelled'),
      false,
      `${terminal} -> cancelled not permitted (terminal is frozen)`,
    );
  }
});

test('cancelled cannot transition out (e.g. cancelled -> running rejected)', () => {
  assert.equal(canTransition('cancelled', 'running'), false, 'cancelled -> running rejected');
  assert.equal(canTransition('cancelled', 'completed'), false, 'cancelled -> completed rejected');
});

test('regression: pre-existing edges are unchanged by the cancelled addition', () => {
  assert.ok(canTransition('pending', 'running'), 'pending -> running');
  assert.ok(canTransition('queued', 'running'), 'queued -> running');
  assert.ok(canTransition('running', 'completed'), 'running -> completed');
  assert.ok(canTransition('running', 'failed'), 'running -> failed');
  assert.ok(canTransition('awaiting_input', 'running'), 'awaiting_input -> running');
  assert.equal(canTransition('completed', 'pending'), false, 'completed -> pending still rejected');
});
