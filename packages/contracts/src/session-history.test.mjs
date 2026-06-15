/**
 * Schema validation for the read-only session-history replay model
 * (session-sandbox-retention, task 1.4). Drives the REAL compiled zod schemas
 * from dist/ — the contract is the single source of truth shared by api + web,
 * so this guards that each discriminated state parses/round-trips and that an
 * `empty` state can NEVER carry fabricated transcript items.
 *
 * Requires `pnpm --filter @cap/contracts build` first. Run: `node session-history.test.mjs`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  SessionHistorySchema,
  SessionTurnSchema,
  REPLAY_PRESENTATION_STATES,
  replayPresentationState,
  isReplayableStatus,
} = require(path.join(here, '..', 'dist', 'session-history.js'));

const userTurn = { kind: 'user', text: '改个标题' };
const commentaryTurn = { kind: 'assistant', text: '先看文件', isFinalAnswer: false };
const finalTurn = { kind: 'assistant', text: '已完成', isFinalAnswer: true };
const toolTurn = { kind: 'tool', name: 'exec_command', args: '{"cmd":"ls"}', output: 'a.ts', tokenCount: 42 };
const toolInterrupted = { kind: 'tool', name: 'exec_command', args: '{"cmd":"ls"}', output: null };

test('SessionTurnSchema parses + round-trips each turn kind', () => {
  for (const turn of [userTurn, commentaryTurn, finalTurn, toolTurn, toolInterrupted]) {
    assert.deepEqual(SessionTurnSchema.parse(turn), turn);
  }
});

test('a tool turn keeps a null output (an interrupted mid-tool call is not dropped)', () => {
  const parsed = SessionTurnSchema.parse(toolInterrupted);
  assert.equal(parsed.output, null);
});

test('SessionTurnSchema rejects an unknown kind', () => {
  assert.throws(() => SessionTurnSchema.parse({ kind: 'system', text: 'x' }));
});

test('available state parses + round-trips the transcript', () => {
  const available = {
    status: 'available',
    turns: [userTurn, commentaryTurn, toolTurn, finalTurn],
    meta: { taskId: 'task-1', model: 'gpt-5-codex', cwd: '/home/gem/workspace', startedAt: '2026-06-01T10:00:00Z' },
    isInterrupted: false,
  };
  assert.deepEqual(SessionHistorySchema.parse(available), available);
});

test('available state carries the wire-level interrupted indication (V.1)', () => {
  const interrupted = {
    status: 'available',
    turns: [userTurn],
    meta: { taskId: 'task-cancel' },
    isInterrupted: true,
  };
  assert.equal(SessionHistorySchema.parse(interrupted).isInterrupted, true);
  // isInterrupted is required on the available branch (not inferred client-side).
  assert.throws(() =>
    SessionHistorySchema.parse({ status: 'available', turns: [], meta: { taskId: 't' } }),
  );
});

test('available state requires a taskId in meta', () => {
  assert.throws(() =>
    SessionHistorySchema.parse({ status: 'available', turns: [], meta: { model: 'x' }, isInterrupted: false }),
  );
});

test('empty state parses with a reason and carries NO transcript items', () => {
  for (const reason of ['no-rollout', 'agent-failed-to-start']) {
    const parsed = SessionHistorySchema.parse({ status: 'empty', reason });
    assert.equal(parsed.status, 'empty');
    assert.equal(parsed.reason, reason);
    // The empty variant has no `turns` field at all — a fabricated transcript
    // smuggled in is stripped, never surviving onto the wire.
    assert.equal('turns' in parsed, false, 'empty state must not carry turns');
  }
});

test('empty state rejects an unknown reason', () => {
  assert.throws(() => SessionHistorySchema.parse({ status: 'empty', reason: 'made-up' }));
});

test('expired state parses (no transcript, no reason)', () => {
  const parsed = SessionHistorySchema.parse({ status: 'expired' });
  assert.equal(parsed.status, 'expired');
  assert.equal('turns' in parsed, false);
});

test('SessionHistorySchema rejects an unknown status', () => {
  assert.throws(() => SessionHistorySchema.parse({ status: 'running' }));
});

test('replayPresentationState maps every terminal status to its presentation state', () => {
  assert.equal(replayPresentationState('completed'), 'completed');
  assert.equal(replayPresentationState('cancelled'), 'cancelled');
  assert.equal(replayPresentationState('failed'), 'failed');
  assert.equal(replayPresentationState('agent_failed_to_start'), 'no-start');
  // Every produced value is a declared presentation state.
  for (const s of ['completed', 'cancelled', 'failed', 'agent_failed_to_start']) {
    assert.ok(REPLAY_PRESENTATION_STATES.includes(replayPresentationState(s)));
  }
});

test('isReplayableStatus is true for terminal statuses, false for live ones', () => {
  for (const s of ['completed', 'cancelled', 'failed', 'agent_failed_to_start']) {
    assert.equal(isReplayableStatus(s), true, `${s} is replayable`);
  }
  for (const s of ['queued', 'running']) {
    assert.equal(isReplayableStatus(s), false, `${s} is not replayable`);
  }
});
