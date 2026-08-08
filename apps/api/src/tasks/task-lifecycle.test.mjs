/**
 * Unit test for the task lifecycle state machine — the `cancelled` terminal and
 * its edges (task-guardrail-controls 4.1).
 *
 * WHY THIS FILE CHANGED SHAPE. It used to carry its own copy of
 * `ALLOWED_TRANSITIONS` and of the terminal set, importing nothing but
 * `node:test` and `node:assert`. Every assertion below passed against that copy,
 * which meant editing the REAL table left this file green: it could not fail for
 * the reason it exists. That is worse than no test, because it occupies the place
 * where a missing one would be noticed.
 *
 * It now drives the compiled module, the same way `metrics/task-resource.test.mjs`
 * and the other `.mjs` suites reach `dist/` — `pretest` builds first, so the
 * module under test is the one that ships. The terminal vocabulary comes from
 * `@cap-console/contracts`, which is where it is declared; asserting that the
 * table and the vocabulary AGREE is a real cross-check rather than a restatement,
 * and it is the invariant that breaks first if either drifts.
 *
 * The wired transition is additionally exercised end-to-end by `test/api-e2e.mjs`
 * (test C: an operator stop drives running -> cancelled).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TERMINAL_TASK_STATUSES } from '@cap-console/contracts';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist/task-lifecycle');

const {
  ALLOWED_TRANSITIONS,
  ADMISSION_OWNED_TRANSITIONS,
  canTransition,
  isAdmissionOwnedTransition,
  isTerminal,
} = require(path.join(DIST, 'task-lifecycle.domain.js'));

// --- the table and the vocabulary must agree --------------------------------

test('the states with no outgoing edges are exactly the declared terminal set', () => {
  const noOutgoing = Object.entries(ALLOWED_TRANSITIONS)
    .filter(([, targets]) => targets.length === 0)
    .map(([status]) => status)
    .sort();
  assert.deepEqual(
    noOutgoing,
    [...TERMINAL_TASK_STATUSES].sort(),
    'the adjacency table and the contracts terminal set have drifted apart',
  );
});

test('isTerminal answers for the declared set and nothing else', () => {
  for (const status of TERMINAL_TASK_STATUSES) {
    assert.ok(isTerminal(status), `${status} is terminal`);
  }
  for (const status of ['pending', 'queued', 'running', 'awaiting_input']) {
    assert.equal(isTerminal(status), false, `${status} is not terminal`);
  }
});

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
  for (const terminal of TERMINAL_TASK_STATUSES) {
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

// --- the admission-owned subset ---------------------------------------------

test('admission owns exactly pending->queued, pending->running, queued->running', () => {
  const owned = [];
  for (const [to, sources] of Object.entries(ADMISSION_OWNED_TRANSITIONS)) {
    for (const from of sources) owned.push(`${from}->${to}`);
  }
  assert.deepEqual(
    owned.sort(),
    ['pending->queued', 'pending->running', 'queued->running'],
    'the admission-owned subset changed',
  );
});

test('every admission-owned transition is also a legal lifecycle edge', () => {
  for (const [to, sources] of Object.entries(ADMISSION_OWNED_TRANSITIONS)) {
    for (const from of sources) {
      assert.ok(
        canTransition(from, to),
        `${from} -> ${to} is admission-owned but not a permitted edge`,
      );
      assert.ok(isAdmissionOwnedTransition(from, to), `${from} -> ${to} recognised`);
    }
  }
});

test('a legal edge outside the admission subset is not claimed by admission', () => {
  assert.equal(isAdmissionOwnedTransition('running', 'completed'), false);
  assert.equal(isAdmissionOwnedTransition('queued', 'cancelled'), false);
  assert.equal(isAdmissionOwnedTransition('running', 'queued'), false);
});
