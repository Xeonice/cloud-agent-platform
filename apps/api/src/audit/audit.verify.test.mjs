/**
 * Verify-phase unit test for the audit recorder + query logic, importing the
 * REAL compiled dist (apps/api/dist/audit/*) rather than re-inlining the logic
 * — so it proves what actually ships (be-audit-approvals 6.2 / 6.3 / 6.4).
 *
 * Covered requirements:
 *   6.3  resultCode <-> level mapping NEVER contradicts: a 2xx is never `error`,
 *        a 4xx/5xx is never `info`; every kind descriptor is consistent by
 *        construction and the invariant predicate agrees with the mapping.
 *   6.4  query filter by level and/or task status + limit cap + most-recent-first
 *        ordering; the single-task sequence read is oldest->newest (append-only
 *        ordering is preserved across reads).
 *   6.2  the emit path is BEST-EFFORT: a thrown audit persistence does NOT block
 *        (does not throw out of) the recorder call that a transition triggers.
 *
 * Runs under plain `node --test` against the built dist; no live provider needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  levelForResultCode,
  isSuccessCode,
  isErrorCode,
  isResultCodeLevelConsistent,
  assertResultCodeLevelConsistent,
  ResultCodeLevelMismatchError,
  AUDIT_KIND_DESCRIPTORS,
  kindForStatus,
  forceFailKind,
  applyAuditQuery,
  orderTaskSequence,
  compareMostRecentFirst,
  AUDIT_QUERY_DEFAULT_LIMIT,
} from '../../dist/audit/audit-mapping.js';
import { AuditService } from '../../dist/audit/audit.service.js';

// ---------------------------------------------------------------------------
// 6.3 — resultCode <-> level mapping never contradicts
// ---------------------------------------------------------------------------

test('6.3 levelForResultCode: every 2xx is info, every 4xx/5xx is error', () => {
  assert.equal(levelForResultCode(200), 'info');
  assert.equal(levelForResultCode(201), 'info');
  assert.equal(levelForResultCode(409), 'error');
  assert.equal(levelForResultCode(422), 'error');
});

test('6.3 a 2xx code is NEVER consistent with error; a 4xx/5xx NEVER with info', () => {
  // success codes
  for (const code of [200, 201, 204, 299]) {
    assert.equal(isSuccessCode(code), true);
    assert.equal(isResultCodeLevelConsistent('info', code), true);
    assert.equal(isResultCodeLevelConsistent('error', code), false);
    assert.equal(isResultCodeLevelConsistent('warning', code), false);
  }
  // error codes
  for (const code of [400, 409, 422, 500, 503, 599]) {
    assert.equal(isErrorCode(code), true);
    assert.equal(isResultCodeLevelConsistent('error', code), true);
    assert.equal(isResultCodeLevelConsistent('info', code), false);
    assert.equal(isResultCodeLevelConsistent('warning', code), false);
  }
});

test('6.3 a code-less event is always consistent (level stands alone)', () => {
  assert.equal(isResultCodeLevelConsistent('info', undefined), true);
  assert.equal(isResultCodeLevelConsistent('warning', undefined), true);
  assert.equal(isResultCodeLevelConsistent('error', undefined), true);
});

test('6.3 a 1xx/3xx (out-of-vocabulary) code is rejected against any level', () => {
  for (const code of [100, 304, 399]) {
    assert.equal(isResultCodeLevelConsistent('info', code), false);
    assert.equal(isResultCodeLevelConsistent('error', code), false);
    assert.equal(isResultCodeLevelConsistent('warning', code), false);
  }
});

test('6.3 EVERY kind descriptor is internally consistent (no contradiction can ship)', () => {
  for (const [kind, d] of Object.entries(AUDIT_KIND_DESCRIPTORS)) {
    assert.equal(
      isResultCodeLevelConsistent(d.level, d.resultCode),
      true,
      `descriptor "${kind}" pairs ${d.resultCode}/${d.level} — contradiction`,
    );
    // and the mapping agrees with the descriptor's declared level
    assert.equal(levelForResultCode(d.resultCode), d.level, `descriptor "${kind}" level drift`);
    // assertResultCodeLevelConsistent returns the pair unchanged for valid pairs
    assert.deepEqual(assertResultCodeLevelConsistent(d.level, d.resultCode), {
      level: d.level,
      resultCode: d.resultCode,
    });
  }
});

test('6.3 assertResultCodeLevelConsistent THROWS on a contradictory pair', () => {
  assert.throws(() => assertResultCodeLevelConsistent('error', 200), ResultCodeLevelMismatchError);
  assert.throws(() => assertResultCodeLevelConsistent('info', 422), ResultCodeLevelMismatchError);
});

test('6.2/6.3 kindForStatus + forceFailKind resolve known descriptors', () => {
  // a pending transition has no distinct audit kind
  assert.equal(kindForStatus('pending'), null);
  for (const status of ['queued', 'running', 'awaiting_input', 'completed', 'failed', 'agent_failed_to_start']) {
    const kind = kindForStatus(status);
    assert.ok(kind, `status ${status} should map to a kind`);
    assert.ok(AUDIT_KIND_DESCRIPTORS[kind], `kind ${kind} should have a descriptor`);
  }
  for (const cause of ['deadline', 'idle', 'circuit_breaker']) {
    const kind = forceFailKind(cause);
    assert.equal(kind, `force_failed:${cause}`);
    assert.ok(AUDIT_KIND_DESCRIPTORS[kind], `force-fail kind ${kind} should have a descriptor`);
  }
});

// ---------------------------------------------------------------------------
// 6.4 — query filter by level/status + limit + most-recent-first ordering
// ---------------------------------------------------------------------------

/** Build a minimal AuditEvent-shaped object the pure filter consumes. */
function ev({ id = randomUUID(), taskId = randomUUID(), level = 'info', tsMs }) {
  return {
    id,
    taskId,
    userId: 0,
    type: 'task.running',
    level,
    title: 't',
    description: 'd',
    timestamp: new Date(tsMs),
    resultCode: level === 'error' ? 422 : 200,
  };
}

test('6.4 applyAuditQuery orders most-recent-first (timestamp DESC)', () => {
  const a = ev({ tsMs: 1000 });
  const b = ev({ tsMs: 3000 });
  const c = ev({ tsMs: 2000 });
  const out = applyAuditQuery([a, b, c], { limit: AUDIT_QUERY_DEFAULT_LIMIT }, new Map());
  assert.deepEqual(out.map((e) => e.timestamp.getTime()), [3000, 2000, 1000]);
});

test('6.4 equal-timestamp events get a deterministic, stable tiebreak (id DESC)', () => {
  const a = ev({ id: 'aaaa', tsMs: 5000 });
  const b = ev({ id: 'bbbb', tsMs: 5000 });
  const out1 = applyAuditQuery([a, b], { limit: 100 }, new Map());
  const out2 = applyAuditQuery([b, a], { limit: 100 }, new Map());
  // id DESC on a tie => 'bbbb' before 'aaaa', regardless of input order
  assert.deepEqual(out1.map((e) => e.id), ['bbbb', 'aaaa']);
  assert.deepEqual(out2.map((e) => e.id), ['bbbb', 'aaaa']);
  // compareMostRecentFirst is the same total order used by the sort
  assert.ok(compareMostRecentFirst(b, a) < 0);
});

test('6.4 level filter returns only the requested severity; omitted => all', () => {
  const info1 = ev({ level: 'info', tsMs: 1000 });
  const err1 = ev({ level: 'error', tsMs: 2000 });
  const info2 = ev({ level: 'info', tsMs: 3000 });
  const all = applyAuditQuery([info1, err1, info2], { limit: 100 }, new Map());
  assert.equal(all.length, 3);
  const onlyErr = applyAuditQuery([info1, err1, info2], { level: 'error', limit: 100 }, new Map());
  assert.deepEqual(onlyErr.map((e) => e.level), ['error']);
  const onlyInfo = applyAuditQuery([info1, err1, info2], { level: 'info', limit: 100 }, new Map());
  assert.equal(onlyInfo.length, 2);
  assert.ok(onlyInfo.every((e) => e.level === 'info'));
});

test('6.4 status filter keeps only events whose owning task is in that status', () => {
  const t1 = randomUUID();
  const t2 = randomUUID();
  const e1 = ev({ taskId: t1, tsMs: 1000 });
  const e2 = ev({ taskId: t2, tsMs: 2000 });
  const statusByTaskId = new Map([
    [t1, 'running'],
    [t2, 'completed'],
  ]);
  const running = applyAuditQuery([e1, e2], { status: 'running', limit: 100 }, statusByTaskId);
  assert.deepEqual(running.map((e) => e.taskId), [t1]);
  // a task missing from the lookup drops out of a status filter
  const e3 = ev({ taskId: randomUUID(), tsMs: 3000 });
  const stillRunning = applyAuditQuery([e1, e2, e3], { status: 'running', limit: 100 }, statusByTaskId);
  assert.deepEqual(stillRunning.map((e) => e.taskId), [t1]);
});

test('6.4 limit caps the result AFTER ordering (newest kept)', () => {
  const events = [];
  for (let i = 0; i < 10; i++) events.push(ev({ tsMs: 1000 + i * 100 }));
  const out = applyAuditQuery(events, { limit: 3 }, new Map());
  assert.equal(out.length, 3);
  // the three newest by timestamp
  assert.deepEqual(out.map((e) => e.timestamp.getTime()), [1900, 1800, 1700]);
});

test('6.4 applyAuditQuery does not mutate its input array', () => {
  const events = [ev({ tsMs: 1000 }), ev({ tsMs: 3000 }), ev({ tsMs: 2000 })];
  const before = events.map((e) => e.timestamp.getTime());
  applyAuditQuery(events, { limit: 100 }, new Map());
  assert.deepEqual(events.map((e) => e.timestamp.getTime()), before);
});

test('6.4 append-only ordering: single-task sequence is oldest->newest, stable', () => {
  const t = randomUUID();
  const created = ev({ id: 'c', taskId: t, tsMs: 1000 });
  const running = ev({ id: 'r', taskId: t, tsMs: 2000 });
  const completed = ev({ id: 'z', taskId: t, tsMs: 3000 });
  // shuffled input
  const ordered = orderTaskSequence([completed, created, running]);
  assert.deepEqual(ordered.map((e) => e.timestamp.getTime()), [1000, 2000, 3000]);
  // a re-read of the same (immutable, append-only) rows yields the same order
  const reread = orderTaskSequence([running, completed, created]);
  assert.deepEqual(reread.map((e) => e.id), ordered.map((e) => e.id));
  // equal-timestamp tiebreak is id ASC (mirror of the most-recent-first DESC)
  const eqA = ev({ id: 'a1', taskId: t, tsMs: 5000 });
  const eqB = ev({ id: 'a2', taskId: t, tsMs: 5000 });
  assert.deepEqual(orderTaskSequence([eqB, eqA]).map((e) => e.id), ['a1', 'a2']);
});

// ---------------------------------------------------------------------------
// 6.2 — best-effort emit path: a thrown persistence does NOT block the caller
// ---------------------------------------------------------------------------

/** A Prisma double whose every write/read REJECTS, to prove the recorder swallows it. */
function throwingPrisma() {
  const boom = async () => {
    throw new Error('DB down');
  };
  return {
    auditEvent: { create: boom, findMany: boom },
    user: { findUnique: boom },
    task: { findMany: boom },
  };
}

test('6.2 recordTaskCreated swallows a persistence failure (never throws)', async () => {
  const svc = new AuditService(throwingPrisma());
  // would reject if the failure propagated; resolves because it is best-effort
  await assert.doesNotReject(() => svc.recordTaskCreated(randomUUID(), 123));
});

test('6.2 recordTransition (incl. cancelled) / recordForceFailed are all best-effort', async () => {
  const svc = new AuditService(throwingPrisma());
  await assert.doesNotReject(() => svc.recordTransition(randomUUID(), 'running', 1));
  await assert.doesNotReject(() => svc.recordTransition(randomUUID(), 'completed'));
  // The operator-stop terminal flows through recordTransition('cancelled') — the
  // same path stop() uses — so this covers the cancelled audit's best-effort rule.
  await assert.doesNotReject(() => svc.recordTransition(randomUUID(), 'cancelled', 7));
  for (const cause of ['deadline', 'idle', 'circuit_breaker', 'abnormal_exit']) {
    await assert.doesNotReject(() => svc.recordForceFailed(randomUUID(), cause));
  }
});

test('6.2 a `pending` transition is a no-op and still never throws', async () => {
  // pending has no audit kind; the recorder returns early without touching prisma
  const svc = new AuditService({
    auditEvent: {
      create: async () => {
        throw new Error('should not be called for pending');
      },
    },
    user: { findUnique: async () => null },
  });
  await assert.doesNotReject(() => svc.recordTransition(randomUUID(), 'pending', 1));
});
