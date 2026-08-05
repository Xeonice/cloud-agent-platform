/**
 * CHARACTERIZATION test for runner-minutes derivation + ledger semantics
 * (extract-runner-minutes-ledger, track `characterization-proof`).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The runner-minutes ledger is about to change OWNER: the running-interval state
 * moves out from under `GuardrailsService` and behind a provider in this
 * directory. Nothing about the DERIVED numbers or the ledger's recorded
 * semantics is supposed to move with it. This file is the proof of that: it is
 * introduced by a commit that PRECEDES the ownership move and it must pass
 * UNMODIFIED afterwards. If it ever needs an edit to go green again, the move
 * changed behaviour and the move is what is wrong — not this file.
 *
 * WHY NOT `apps/api/src/metrics/runner-minutes.test.mjs`
 * -----------------------------------------------------
 * That file declares at its `:13` that it inlines a "mirror" of
 * `runner-minutes.ts` — its own copy of `deriveRunnerMinutes` and of
 * `RunnerMinutesLedger`. A mirror stays green even if the real implementation
 * moves, is rewired, or breaks, so it cannot serve as an equivalence proof for
 * a move. It is left exactly as it is; this file is the binding one.
 *
 * WHAT IT BINDS TO
 * ----------------
 * The COMPILED module — `dist/runner-metrics/runner-minutes.js` — loaded the way
 * `apps/api/src/metrics/metrics.verify.test.mjs` already loads `dist/`. Nothing
 * here is asserted against a locally re-declared copy of the function or of the
 * ledger. That leaf module has only an erased TYPE import from
 * `@cap-console/contracts`, so it loads under plain `node`.
 *
 * Requires `pnpm --filter @cap-console/api build` first (apps/api's `pretest`
 * does this). Mounted by apps/api's `test:src` glob (`src/**\/*.test.mjs`) —
 * no registration step exists or is needed.
 *
 * HARD CONSTRAINT — DO NOT "IMPROVE" THIS FILE BY IMPORTING THE PORT
 * ------------------------------------------------------------------
 * This file must import NOTHING that the ownership move introduces: not
 * `runner-minutes-ledger.port.ts`, not the owning `*.service.ts`, not the
 * module. It is committed BEFORE those files exist, and a test that imports a
 * symbol which only appears in a later commit cannot be green on the pre-move
 * tree. "Through the port shape" below means the three-method shape the
 * concrete ledger ALREADY has (recordStart / recordEnd / intervals), reached
 * through a narrowed view of the compiled class.
 *
 * Run standalone with: `node --test apps/api/src/runner-metrics/runner-minutes-derivation.test.mjs`
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_RUNNER = path.resolve(here, '../../dist/runner-metrics');
const COMPILED = path.join(DIST_RUNNER, 'runner-minutes.js');

if (!existsSync(COMPILED)) {
  // Fail loudly rather than skip. A characterization test that quietly does
  // nothing when dist/ is stale is worse than no test at all: it would report
  // "green" across the very move it exists to police.
  throw new Error(
    `runner-minutes-derivation: compiled module missing at ${COMPILED}. ` +
      'Run `pnpm --filter @cap-console/api build` first (apps/api `pretest` does this).',
  );
}

const compiled = require(COMPILED);
const { deriveRunnerMinutes, RunnerMinutesLedger } = compiled;

const MIN = 60_000;
/** Frozen clock. Injected everywhere, so no assertion below depends on wall time. */
const NOW = 1_000 * MIN;

/**
 * Narrow the concrete ledger to the three-method shape the port declares, so
 * every semantic assertion below is made through that surface and cannot lean
 * on a member the port does not carry.
 *
 * Arguments are forwarded verbatim: the port declares `recordStart(taskId)`,
 * while the concrete ledger additionally accepts an optional injected `at`
 * (epoch millis, defaulting to `Date.now()`). The tests inject `at` so the
 * fixtures stay deterministic; one case below exercises the port's exact
 * single-argument arity.
 */
function asPortShape(ledger) {
  assert.equal(typeof ledger.recordStart, 'function', 'ledger exposes recordStart');
  assert.equal(typeof ledger.recordEnd, 'function', 'ledger exposes recordEnd');
  assert.equal(typeof ledger.intervals, 'function', 'ledger exposes intervals');
  return {
    recordStart: (...args) => ledger.recordStart(...args),
    recordEnd: (...args) => ledger.recordEnd(...args),
    intervals: () => ledger.intervals(),
  };
}

function newPort() {
  return asPortShape(new RunnerMinutesLedger());
}

// ---------------------------------------------------------------------------
// Binding: the subject really is the compiled implementation
// ---------------------------------------------------------------------------

test('characterization subject is the COMPILED runner-minutes module, not a local mirror', () => {
  const resolved = require.resolve(COMPILED);
  assert.ok(
    resolved.split(path.sep).join('/').includes('/dist/runner-metrics/runner-minutes.js'),
    `expected the subject to be loaded from dist/runner-metrics, got ${resolved}`,
  );
  assert.equal(typeof deriveRunnerMinutes, 'function', 'deriveRunnerMinutes came from dist');
  assert.equal(typeof RunnerMinutesLedger, 'function', 'RunnerMinutesLedger came from dist');
});

// ---------------------------------------------------------------------------
// Derivation: the COMPLETE result object is pinned for every fixture
//
// deepEqual on the whole object, never a field-by-field spot check: a move that
// added, dropped, or renamed a field would slip past `r.minutes === 5`.
// ---------------------------------------------------------------------------

test('derivation pins the whole object: closed intervals only', () => {
  const intervals = [
    { taskId: 'closed-a', startedAt: NOW - 10 * MIN, endedAt: NOW - 8 * MIN },
    { taskId: 'closed-b', startedAt: NOW - 7 * MIN, endedAt: NOW - 4 * MIN },
  ];
  assert.deepEqual(deriveRunnerMinutes(intervals, NOW), { available: true, minutes: 5 });
});

test('derivation pins the whole object: in-flight intervals only, counted up to the frozen now', () => {
  const intervals = [
    { taskId: 'open-a', startedAt: NOW - 3 * MIN, endedAt: null },
    { taskId: 'open-b', startedAt: NOW - 90_000, endedAt: null },
  ];
  assert.deepEqual(deriveRunnerMinutes(intervals, NOW), { available: true, minutes: 4.5 });
});

test('derivation pins the whole object: a mix of closed and in-flight', () => {
  const intervals = [
    { taskId: 'closed-a', startedAt: NOW - 20 * MIN, endedAt: NOW - 16 * MIN },
    { taskId: 'open-a', startedAt: NOW - 3 * MIN, endedAt: null },
  ];
  assert.deepEqual(deriveRunnerMinutes(intervals, NOW), { available: true, minutes: 7 });
});

test('derivation pins the whole object: the EMPTY fixture is unavailable, never a fabricated 0', () => {
  // The distinction this pins is the point of the whole module: no timing data
  // is honestly UNAVAILABLE. A move that "helpfully" reported 0 here would be
  // asserting an exact "zero minutes used" reading that nobody measured.
  assert.deepEqual(deriveRunnerMinutes([], NOW), { available: false, minutes: null });
});

test('derivation pins the whole object: a genuine zero-elapsed reading stays available', () => {
  // Distinct from the empty case above: data EXISTS and sums to zero.
  const intervals = [{ taskId: 'instant', startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }];
  assert.deepEqual(deriveRunnerMinutes(intervals, NOW), { available: true, minutes: 0 });
});

// ---------------------------------------------------------------------------
// Ledger semantics, driven through the port shape
//
// These four are exactly the semantics the ownership move promises not to
// touch. They are asserted on recorded state, so a move that changed WHEN or
// WHETHER something is recorded shows up here rather than in a review comment.
// ---------------------------------------------------------------------------

test('ledger semantics: a duplicate recordStart for an already-open task is ignored', () => {
  const port = newPort();
  port.recordStart('t1', NOW - 10 * MIN);
  port.recordStart('t1', NOW - 2 * MIN); // ignored: no double-count, no reset
  assert.deepEqual(port.intervals(), [
    { taskId: 't1', startedAt: NOW - 10 * MIN, endedAt: null },
  ]);
  // The interval still runs from the ORIGINAL start, not the duplicate.
  assert.deepEqual(deriveRunnerMinutes(port.intervals(), NOW), {
    available: true,
    minutes: 10,
  });
});

test('ledger semantics: recordEnd for a task that never started is a no-op', () => {
  const port = newPort();
  port.recordEnd('ghost', NOW - 5 * MIN);
  assert.deepEqual(port.intervals(), []);
  assert.deepEqual(deriveRunnerMinutes(port.intervals(), NOW), {
    available: false,
    minutes: null,
  });
});

test('ledger semantics: an endedAt preceding its startedAt contributes 0, never subtracts', () => {
  const port = newPort();
  port.recordStart('skewed', NOW - 2 * MIN);
  port.recordEnd('skewed', NOW - 5 * MIN); // clock skew: end BEFORE start
  port.recordStart('honest', NOW - 4 * MIN);
  port.recordEnd('honest', NOW);
  // The skewed span is clamped at zero; the honest 4 minutes survive intact.
  assert.deepEqual(deriveRunnerMinutes(port.intervals(), NOW), {
    available: true,
    minutes: 4,
  });
  // And on its own it is a real reading of zero, not a negative one.
  const skewOnly = port.intervals().filter(({ taskId }) => taskId === 'skewed');
  assert.deepEqual(deriveRunnerMinutes(skewOnly, NOW), { available: true, minutes: 0 });
});

test('ledger semantics: intervals() returns closed intervals before open ones', () => {
  const port = newPort();
  port.recordStart('opened-first', NOW - 30 * MIN);
  port.recordStart('closed-later', NOW - 20 * MIN);
  port.recordEnd('closed-later', NOW - 15 * MIN);
  port.recordStart('opened-last', NOW - 10 * MIN);
  // Snapshot order is closed-then-open, NOT insertion order: `opened-first` was
  // recorded before `closed-later` and still comes after it.
  assert.deepEqual(port.intervals(), [
    { taskId: 'closed-later', startedAt: NOW - 20 * MIN, endedAt: NOW - 15 * MIN },
    { taskId: 'opened-first', startedAt: NOW - 30 * MIN, endedAt: null },
    { taskId: 'opened-last', startedAt: NOW - 10 * MIN, endedAt: null },
  ]);
});

test('ledger semantics: a closed interval stays closed and keeps its own end instant', () => {
  const port = newPort();
  port.recordStart('t1', NOW - 6 * MIN);
  assert.deepEqual(port.intervals(), [{ taskId: 't1', startedAt: NOW - 6 * MIN, endedAt: null }]);
  port.recordEnd('t1', NOW - 1 * MIN);
  assert.deepEqual(port.intervals(), [
    { taskId: 't1', startedAt: NOW - 6 * MIN, endedAt: NOW - 1 * MIN },
  ]);
  // Closed accounting does not drift with the clock: same fixture, later `now`.
  assert.deepEqual(deriveRunnerMinutes(port.intervals(), NOW), { available: true, minutes: 5 });
  assert.deepEqual(deriveRunnerMinutes(port.intervals(), NOW + 99 * MIN), {
    available: true,
    minutes: 5,
  });
});

test("ledger semantics: the port's single-argument arity records against the wall clock", () => {
  // Everything above injects `at` for determinism. This one case exercises the
  // arity the port itself declares — `recordStart(taskId)` / `recordEnd(taskId)`
  // — bounded by readings taken either side of the call rather than pinned to a
  // literal, so it is deterministic without being wall-clock-fragile.
  const port = newPort();
  const before = Date.now();
  port.recordStart('wall-clock');
  const after = Date.now();

  const [open] = port.intervals();
  assert.equal(port.intervals().length, 1);
  assert.equal(open.taskId, 'wall-clock');
  assert.equal(open.endedAt, null);
  assert.ok(
    open.startedAt >= before && open.startedAt <= after,
    `startedAt ${open.startedAt} outside [${before}, ${after}]`,
  );

  port.recordEnd('wall-clock');
  const [closed] = port.intervals();
  assert.equal(port.intervals().length, 1);
  assert.equal(closed.startedAt, open.startedAt);
  assert.ok(
    typeof closed.endedAt === 'number' && closed.endedAt >= open.startedAt,
    `endedAt ${closed.endedAt} did not close at or after startedAt ${open.startedAt}`,
  );
});
