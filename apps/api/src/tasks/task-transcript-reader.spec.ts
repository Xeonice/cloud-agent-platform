import test from 'node:test';
import assert from 'node:assert/strict';

import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import {
  readTaskTranscript,
  type AuditTimelineReader,
  type TranscriptStore,
} from './task-transcript-reader';

const TASK_ID = '00000000-0000-4000-a000-000000000201';

const LIVE_ROLLOUT = [
  JSON.stringify({
    type: 'session_meta',
    payload: { cwd: '/workspace', timestamp: '2026-07-10T01:00:00Z' },
  }),
  JSON.stringify({
    timestamp: '2026-07-10T01:00:02Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'live prompt' },
  }),
  JSON.stringify({
    timestamp: '2026-07-10T01:00:03Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'live answer', phase: 'final_answer' },
  }),
].join('\n');

const STALE_DURABLE = [
  JSON.stringify({ type: 'session_meta', payload: { cwd: '/workspace' } }),
  JSON.stringify({
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'stale durable', phase: 'final_answer' },
  }),
].join('\n');

function sandboxWith(rollout: string | null): {
  sandbox: SandboxProvider;
  calls: { read: number; exists: number };
} {
  const calls = { read: 0, exists: 0 };
  const sandbox = {
    getSandboxMode: () => 'test',
    readRolloutFromContainer: async () => {
      calls.read += 1;
      return rollout === null
        ? null
        : { format: 'codex-rollout' as const, jsonl: rollout };
    },
    sandboxExists: async () => {
      calls.exists += 1;
      return true;
    },
  } as unknown as SandboxProvider;
  return { sandbox, calls };
}

function transcriptStore(durable: string | null): {
  store: TranscriptStore;
  calls: { read: number; backfill: number };
} {
  const calls = { read: 0, backfill: 0 };
  return {
    calls,
    store: {
      readDurable: async () => {
        calls.read += 1;
        return durable;
      },
      backfill: async () => {
        calls.backfill += 1;
      },
    },
  };
}

const audit: AuditTimelineReader = {
  queryTask: async () => [
    {
      type: 'task.running',
      title: '任务开始运行',
      description: 'sandbox ready',
      level: 'info',
      timestamp: new Date('2026-07-10T01:00:01Z'),
    },
  ],
};

test('active tasks use the live rollout and never freeze a stale durable copy', async () => {
  const { sandbox, calls: sandboxCalls } = sandboxWith(LIVE_ROLLOUT);
  const { store, calls: storeCalls } = transcriptStore(STALE_DURABLE);

  const result = await readTaskTranscript(
    {
      tasks: {
        findById: async () =>
          ({ id: TASK_ID, status: 'running', runtime: 'codex' }) as never,
      },
      sandbox,
      transcripts: store,
      audit,
    },
    TASK_ID,
  );

  assert.equal(result.status, 'available');
  assert.ok(
    result.turns.some(
      (turn) => turn.kind === 'assistant' && turn.text === 'live answer',
    ),
  );
  assert.ok(
    result.turns.some(
      (turn) => turn.kind === 'system' && turn.title === '任务开始运行',
    ),
  );
  assert.deepEqual(storeCalls, { read: 0, backfill: 0 });
  assert.equal(sandboxCalls.read, 1);
});

test('terminal tasks are durable-first and do not touch a retained sandbox on a hit', async () => {
  const { sandbox, calls: sandboxCalls } = sandboxWith(LIVE_ROLLOUT);
  const { store, calls: storeCalls } = transcriptStore(STALE_DURABLE);

  const result = await readTaskTranscript(
    {
      tasks: {
        findById: async () =>
          ({ id: TASK_ID, status: 'completed', runtime: 'codex' }) as never,
      },
      sandbox,
      transcripts: store,
      audit,
    },
    TASK_ID,
  );

  assert.equal(result.status, 'available');
  assert.ok(
    result.turns.some(
      (turn) => turn.kind === 'assistant' && turn.text === 'stale durable',
    ),
  );
  assert.deepEqual(storeCalls, { read: 1, backfill: 0 });
  assert.deepEqual(sandboxCalls, { read: 0, exists: 0 });
});

test('terminal fallback backfills once and preserves the interrupted flag', async () => {
  const { sandbox, calls: sandboxCalls } = sandboxWith(LIVE_ROLLOUT);
  const { store, calls: storeCalls } = transcriptStore(null);

  const result = await readTaskTranscript(
    {
      tasks: {
        findById: async () =>
          ({ id: TASK_ID, status: 'cancelled', runtime: 'codex' }) as never,
      },
      sandbox,
      transcripts: store,
      audit,
    },
    TASK_ID,
  );

  assert.equal(result.status, 'available');
  assert.equal(result.isInterrupted, true);
  assert.deepEqual(storeCalls, { read: 1, backfill: 1 });
  assert.equal(sandboxCalls.read, 1);
});
