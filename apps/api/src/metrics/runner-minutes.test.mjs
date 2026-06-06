/**
 * Tests for the pure runner-minutes derivation + ledger (be-metrics 5.4).
 *
 * Requirement semantics (from runner-minutes.ts):
 *   1. No timing data → { available: false, minutes: null } (NOT a fabricated 0).
 *   2. Closed intervals sum to their elapsed minutes.
 *   3. In-flight interval (endedAt null) counted up to `now`.
 *   4. Clock skew / negative span contributes 0 (never subtracts).
 *   5. Ledger: recordStart opens, recordEnd closes; duplicate start ignored;
 *      end for a never-started task is a no-op; intervals() exposes closed+open.
 */

// ---- inline the pure function + ledger (mirror runner-minutes.ts) ----

function deriveRunnerMinutes(intervals, now) {
  if (intervals.length === 0) return { available: false, minutes: null };
  let totalMs = 0;
  for (const interval of intervals) {
    const end = interval.endedAt ?? now;
    const elapsed = end - interval.startedAt;
    if (elapsed > 0) totalMs += elapsed;
  }
  return { available: true, minutes: totalMs / 60_000 };
}

class RunnerMinutesLedger {
  constructor() {
    this.closed = [];
    this.open = new Map();
  }
  recordStart(taskId, at) {
    if (this.open.has(taskId)) return;
    this.open.set(taskId, { taskId, startedAt: at, endedAt: null });
  }
  recordEnd(taskId, at) {
    const interval = this.open.get(taskId);
    if (!interval) return;
    this.open.delete(taskId);
    this.closed.push({ ...interval, endedAt: at });
  }
  intervals() {
    return [...this.closed, ...this.open.values()];
  }
}

// ---- assertion helpers ----

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

const MIN = 60_000;

// T1: no timing data → unavailable, null (never zero-as-exact).
{
  const r = deriveRunnerMinutes([], 1_000);
  assert(r.available === false, 'T1a: available===false with no data');
  assert(r.minutes === null, 'T1b: minutes===null (not 0)');
}

// T2: a single closed 5-minute interval sums to 5 minutes.
{
  const r = deriveRunnerMinutes([{ taskId: 't1', startedAt: 0, endedAt: 5 * MIN }], 99 * MIN);
  assert(r.available === true, 'T2a: available with data');
  assert(r.minutes === 5, 'T2b: 5 closed minutes');
}

// T3: multiple closed intervals sum.
{
  const r = deriveRunnerMinutes(
    [
      { taskId: 't1', startedAt: 0, endedAt: 2 * MIN },
      { taskId: 't2', startedAt: 0, endedAt: 3 * MIN },
    ],
    99 * MIN,
  );
  assert(r.minutes === 5, 'T3: 2+3 closed minutes === 5');
}

// T4: in-flight interval counted up to `now`.
{
  const r = deriveRunnerMinutes([{ taskId: 't1', startedAt: 10 * MIN, endedAt: null }], 13 * MIN);
  assert(r.available === true, 'T4a: available');
  assert(r.minutes === 3, 'T4b: in-flight counted to now (3 min)');
}

// T5: clock skew / negative span contributes 0, never subtracts.
{
  const r = deriveRunnerMinutes(
    [
      { taskId: 't1', startedAt: 5 * MIN, endedAt: 2 * MIN }, // negative span
      { taskId: 't2', startedAt: 0, endedAt: 4 * MIN }, // +4 min
    ],
    99 * MIN,
  );
  assert(r.minutes === 4, 'T5: negative span ignored, only +4 counted');
}

// T6: genuine zero elapsed with data present is available:true minutes:0
//     (distinct from the unavailable no-data case).
{
  const r = deriveRunnerMinutes([{ taskId: 't1', startedAt: 7 * MIN, endedAt: 7 * MIN }], 99 * MIN);
  assert(r.available === true, 'T6a: available even when sum is 0');
  assert(r.minutes === 0, 'T6b: 0 minutes is a real reading, not unavailable');
}

// T7: ledger open→close lifecycle, then derive.
{
  const ledger = new RunnerMinutesLedger();
  ledger.recordStart('t1', 0);
  ledger.recordEnd('t1', 6 * MIN);
  const r = deriveRunnerMinutes(ledger.intervals(), 99 * MIN);
  assert(r.minutes === 6, 'T7: ledger closed interval derives to 6 min');
}

// T8: duplicate recordStart ignored (no double-count / no reset).
{
  const ledger = new RunnerMinutesLedger();
  ledger.recordStart('t1', 0);
  ledger.recordStart('t1', 5 * MIN); // ignored
  const r = deriveRunnerMinutes(ledger.intervals(), 10 * MIN);
  assert(r.minutes === 10, 'T8: in-flight from original start (10 min), not reset');
}

// T9: recordEnd for a never-started task is a no-op.
{
  const ledger = new RunnerMinutesLedger();
  ledger.recordEnd('ghost', 5 * MIN); // no-op
  const r = deriveRunnerMinutes(ledger.intervals(), 10 * MIN);
  assert(r.available === false && r.minutes === null, 'T9: end without start accrues nothing');
}

// T10: intervals() exposes both closed and still-open intervals.
{
  const ledger = new RunnerMinutesLedger();
  ledger.recordStart('closed', 0);
  ledger.recordEnd('closed', 2 * MIN);
  ledger.recordStart('open', 1 * MIN); // still in-flight
  const r = deriveRunnerMinutes(ledger.intervals(), 4 * MIN);
  // closed: 2 min; open: 4-1 = 3 min → 5 total
  assert(r.minutes === 5, 'T10: closed(2)+open(3 to now)===5 min');
}

// ---- summary ----
console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
