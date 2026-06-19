/**
 * `/v1/tasks/:id/events` SSE lifecycle-stream spec (public-v1-api, Track
 * sse-observation, task 5.4; design D6).
 *
 * Drives {@link V1EventsController.streamEvents} directly with a FAKE
 * {@link AuditService} (a scripted AuditEvent tail) and a FAKE response sink that
 * records every written chunk — no HTTP boot, no DB, fast injected intervals — so
 * the SSE contract is asserted in isolation:
 *
 *   - the stream sets the proxy-buffering-defeat headers (design D6);
 *   - it emits one `data:` per AuditEvent-derived lifecycle event, each with an
 *     `id:` line (for `Last-Event-ID` resume);
 *   - it writes at least one keep-alive heartbeat comment;
 *   - it CLOSES after a terminal event (`task.completed` / `task.failed` /
 *     `task.cancelled` / `agent_failed_to_start` / `force_failed:*`);
 *   - it sources from the append-only AuditEvent tail and NEVER exposes the raw
 *     PTY/WebSocket terminal stream — the wire carries only AuditEvent frames;
 *   - `Last-Event-ID` resumes after the last seen id (no duplicate frames).
 *
 * Plus unit coverage of the pure helpers (`isTerminalAuditType`,
 * `serializeSseEvent`, `eventsAfter`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';

import type { AuditEvent, SessionUser } from '@cap/contracts';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import {
  V1EventsController,
  type SseResponse,
  isTerminalAuditType,
  serializeSseEvent,
  eventsAfter,
} from './v1-events.controller';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

/** Build a minimal valid AuditEvent for the tail. */
function makeEvent(partial: Partial<AuditEvent> & { id: string; type: string }): AuditEvent {
  return {
    id: partial.id,
    taskId: partial.taskId ?? TASK_ID,
    userId: partial.userId ?? 0,
    type: partial.type,
    level: partial.level ?? 'info',
    title: partial.title ?? partial.type,
    description: partial.description ?? partial.type,
    timestamp: partial.timestamp ?? new Date('2026-06-19T00:00:00.000Z'),
    resultCode: partial.resultCode,
    runId: partial.runId,
  };
}

/**
 * A fake {@link AuditService} whose `queryTask` returns the events appended so
 * far. `push` appends and is how a test simulates the orchestrator recording the
 * next lifecycle event between poll ticks.
 */
class FakeAuditService {
  private events: AuditEvent[] = [];
  push(...events: AuditEvent[]): void {
    this.events.push(...events);
  }
  queryTask(_taskId: string): Promise<AuditEvent[]> {
    return Promise.resolve([...this.events]);
  }
}

/**
 * A fake SSE response sink recording every write, the header call, and end. Lets
 * the test inspect exactly what bytes hit the wire and trigger a client `close`.
 */
class FakeResponse implements SseResponse {
  status?: number;
  headers?: Record<string, string>;
  chunks: string[] = [];
  ended = false;
  private closeListener?: () => void;

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): this {
    this.ended = true;
    return this;
  }
  on(_event: 'close', listener: () => void): this {
    this.closeListener = listener;
    return this;
  }
  /** Simulate the client disconnecting. */
  triggerClose(): void {
    this.closeListener?.();
  }
  /** The whole written stream as one string. */
  body(): string {
    return this.chunks.join('');
  }
  /** All `data:` JSON payloads parsed, in order. */
  dataFrames(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const chunk of this.chunks) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          out.push(JSON.parse(line.slice('data: '.length)));
        }
      }
    }
    return out;
  }
  /** All `id:` values, in order. */
  idLines(): string[] {
    const out: string[] = [];
    for (const chunk of this.chunks) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('id: ')) out.push(line.slice('id: '.length));
      }
    }
    return out;
  }
}

function makeController(audit: FakeAuditService): V1EventsController {
  // The controller only ever calls `audit.queryTask`; the fake satisfies that.
  return new V1EventsController(audit as unknown as never);
}

// ---------------------------------------------------------------------------
// events route handler — scope gate (V.2)
// ---------------------------------------------------------------------------

const USER: SessionUser = {
  githubId: 7,
  login: 'op',
  name: 'Operator',
  avatarUrl: '',
  allowed: true,
};

/** A request carrying the given guard-attached principal (or none). */
function reqWith(principal: OperatorPrincipal | undefined): AuthenticatedRequest {
  return { operatorPrincipal: principal } as unknown as AuthenticatedRequest;
}

test('events handler is scope-gated: a tasks:read-less api-key is 403 before any stream byte', async () => {
  const audit = new FakeAuditService();
  // A terminal event is on the tail, so IF the gate were skipped the stream would
  // open + close 200 — making the "no bytes written" assertions meaningful.
  audit.push(makeEvent({ id: 'aaaaaaaa-0000-0000-0000-000000000001', type: 'task.completed' }));
  const res = new FakeResponse();
  // api-key carrying only `repos:read` — it lacks the `tasks:read` this read needs.
  const req = reqWith({ kind: 'api-key', user: USER, scopes: ['repos:read'] });

  await assert.rejects(
    () => makeController(audit).events(TASK_ID, res as unknown as Response, req, undefined),
    (err: unknown) => err instanceof ForbiddenException,
  );
  // The gate fired BEFORE the stream opened — no headers, no bytes, never streamed.
  assert.equal(res.status, undefined, 'no writeHead before the scope gate');
  assert.equal(res.chunks.length, 0, 'no bytes written before the scope gate');
});

test('events handler passes the gate for a tasks:read api-key and for a scopeless session', async () => {
  // tasks:read api-key → allowed; the pre-seeded terminal event closes the stream.
  const audit1 = new FakeAuditService();
  audit1.push(makeEvent({ id: 'aaaaaaaa-0000-0000-0000-000000000001', type: 'task.completed' }));
  const res1 = new FakeResponse();
  await makeController(audit1).events(
    TASK_ID,
    res1 as unknown as Response,
    reqWith({ kind: 'api-key', user: USER, scopes: ['tasks:read'] }),
    undefined,
  );
  assert.equal(res1.status, 200, 'tasks:read api-key passes the gate and streams');
  assert.ok(res1.ended, 'stream closed on the terminal event');

  // A scopeless session (`scopes === undefined`) is allow-all (console behavior).
  const audit2 = new FakeAuditService();
  audit2.push(makeEvent({ id: 'aaaaaaaa-0000-0000-0000-000000000001', type: 'task.completed' }));
  const res2 = new FakeResponse();
  await makeController(audit2).events(
    TASK_ID,
    res2 as unknown as Response,
    reqWith({ kind: 'session', user: USER }),
    undefined,
  );
  assert.equal(res2.status, 200, 'scopeless session passes the gate (allow-all)');
});

// ---------------------------------------------------------------------------
// streamEvents — the SSE contract
// ---------------------------------------------------------------------------

test('streams AuditEvent lifecycle events with ids + a heartbeat, closes on terminal', async () => {
  const audit = new FakeAuditService();
  // Start with only the non-terminal events on the tail so the stream stays open
  // and at least one heartbeat fires; the terminal event is appended AFTER a
  // delay (simulating the orchestrator recording it later), making the
  // heartbeat-then-terminal-close ordering deterministic rather than racy.
  audit.push(
    makeEvent({ id: 'aaaaaaaa-0000-0000-0000-000000000001', type: 'task.created' }),
    makeEvent({ id: 'aaaaaaaa-0000-0000-0000-000000000002', type: 'task.running' }),
  );
  const res = new FakeResponse();

  const done = makeController(audit).streamEvents(res, {
    taskId: TASK_ID,
    heartbeatMs: 5,
    pollMs: 5,
  });
  // Let heartbeats fire while the task is still running, THEN settle it terminal.
  await new Promise((r) => setTimeout(r, 30));
  audit.push(
    makeEvent({
      id: 'aaaaaaaa-0000-0000-0000-000000000003',
      type: 'task.completed',
    }),
  );
  await done;

  // Proxy-buffering-defeat headers (design D6).
  assert.equal(res.status, 200);
  assert.equal(res.headers?.['Content-Type'], 'text/event-stream');
  assert.equal(res.headers?.['Cache-Control'], 'no-cache, no-transform');
  assert.equal(res.headers?.['X-Accel-Buffering'], 'no');

  // Every persisted lifecycle event reached the wire, each with its id line.
  const ids = res.idLines();
  assert.deepEqual(ids, [
    'aaaaaaaa-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000002',
    'aaaaaaaa-0000-0000-0000-000000000003',
  ]);
  const types = res.dataFrames().map((f) => f.type);
  assert.deepEqual(types, ['task.created', 'task.running', 'task.completed']);

  // A heartbeat comment was written.
  assert.ok(res.body().includes(':hb\n\n'), 'a keep-alive heartbeat was emitted');

  // Auto-closed after the terminal event.
  assert.equal(res.ended, true, 'stream closed after the terminal event');
});

test('emits a heartbeat while the task is still running, before any terminal', async () => {
  const audit = new FakeAuditService();
  audit.push(
    makeEvent({ id: 'bbbbbbbb-0000-0000-0000-000000000001', type: 'task.running' }),
  );
  const res = new FakeResponse();

  // No terminal event yet: drive the loop, then disconnect so streamEvents
  // resolves. A short heartbeat guarantees at least one HB fired in the window.
  const done = makeController(audit).streamEvents(res, {
    taskId: TASK_ID,
    heartbeatMs: 5,
    pollMs: 5,
  });
  // Let a few ticks pass, then simulate the client closing the connection.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(res.ended, false, 'still open while non-terminal');
  res.triggerClose();
  await done;

  assert.ok(res.body().includes(':hb\n\n'), 'heartbeat while running');
  const types = res.dataFrames().map((f) => f.type);
  assert.deepEqual(types, ['task.running']);
});

test('does NOT expose the raw PTY/WebSocket stream — only AuditEvent frames', async () => {
  const audit = new FakeAuditService();
  audit.push(
    makeEvent({ id: 'cccccccc-0000-0000-0000-000000000001', type: 'task.running' }),
    makeEvent({ id: 'cccccccc-0000-0000-0000-000000000002', type: 'task.failed', level: 'error' }),
  );
  const res = new FakeResponse();

  await makeController(audit).streamEvents(res, {
    taskId: TASK_ID,
    heartbeatMs: 1_000, // long enough that no HB fires before the terminal close
    pollMs: 5,
  });

  // Every data frame is a structured AuditEvent (has id/taskId/type/level), NOT a
  // raw terminal chunk. There is no PTY payload / asciicast / WS frame on the wire.
  const frames = res.dataFrames();
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.equal(typeof frame.id, 'string');
    assert.equal(frame.taskId, TASK_ID);
    assert.equal(typeof frame.type, 'string');
    assert.ok('level' in frame, 'frame is an AuditEvent shape, not a raw stream chunk');
  }
  // Defensive: no marker of a terminal/PTY stream leaked into the bytes.
  assert.ok(!res.body().includes('['), 'no ANSI/PTY escape sequences on the wire');
  assert.equal(res.ended, true, 'closed on task.failed (terminal)');
});

test('Last-Event-ID resumes after the last seen event (no duplicate frames)', async () => {
  const audit = new FakeAuditService();
  audit.push(
    makeEvent({ id: 'dddddddd-0000-0000-0000-000000000001', type: 'task.created' }),
    makeEvent({ id: 'dddddddd-0000-0000-0000-000000000002', type: 'task.running' }),
    makeEvent({ id: 'dddddddd-0000-0000-0000-000000000003', type: 'task.completed' }),
  );
  const res = new FakeResponse();

  // Resume from the second event: only the third (terminal) event should be sent.
  await makeController(audit).streamEvents(res, {
    taskId: TASK_ID,
    lastEventId: 'dddddddd-0000-0000-0000-000000000002',
    heartbeatMs: 1_000,
    pollMs: 5,
  });

  assert.deepEqual(res.idLines(), ['dddddddd-0000-0000-0000-000000000003']);
  assert.deepEqual(
    res.dataFrames().map((f) => f.type),
    ['task.completed'],
  );
  assert.equal(res.ended, true);
});

test('closes on a force_failed:* guardrail-reclaim terminal event', async () => {
  const audit = new FakeAuditService();
  audit.push(
    makeEvent({ id: 'eeeeeeee-0000-0000-0000-000000000001', type: 'task.running' }),
    makeEvent({
      id: 'eeeeeeee-0000-0000-0000-000000000002',
      type: 'force_failed:deadline',
      level: 'error',
    }),
  );
  const res = new FakeResponse();

  await makeController(audit).streamEvents(res, {
    taskId: TASK_ID,
    heartbeatMs: 1_000,
    pollMs: 5,
  });

  assert.equal(res.ended, true, 'force_failed:* is terminal and closes the stream');
  assert.deepEqual(
    res.dataFrames().map((f) => f.type),
    ['task.running', 'force_failed:deadline'],
  );
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('isTerminalAuditType recognizes terminal lifecycle kinds only', () => {
  for (const t of [
    'task.completed',
    'task.failed',
    'task.cancelled',
    'agent_failed_to_start',
    'force_failed:idle',
    'force_failed:circuit_breaker',
  ]) {
    assert.equal(isTerminalAuditType(t), true, `${t} is terminal`);
  }
  for (const t of [
    'task.created',
    'task.queued',
    'task.running',
    'task.awaiting_input',
    'task.exited', // a failure DETAIL, not itself a terminal transition
  ]) {
    assert.equal(isTerminalAuditType(t), false, `${t} is not terminal`);
  }
});

test('serializeSseEvent emits id + JSON data lines with an ISO timestamp', () => {
  const frame = serializeSseEvent(
    makeEvent({
      id: 'ffffffff-0000-0000-0000-000000000001',
      type: 'task.running',
      timestamp: new Date('2026-06-19T12:34:56.000Z'),
    }),
  );
  assert.ok(frame.startsWith('id: ffffffff-0000-0000-0000-000000000001\n'));
  assert.ok(frame.endsWith('\n\n'), 'frame ends with the SSE blank line');
  const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
  const parsed = JSON.parse(dataLine.slice('data: '.length));
  assert.equal(parsed.id, 'ffffffff-0000-0000-0000-000000000001');
  assert.equal(parsed.type, 'task.running');
  assert.equal(parsed.timestamp, '2026-06-19T12:34:56.000Z');
});

test('eventsAfter returns only events strictly after the resume id', () => {
  const events = [
    makeEvent({ id: 'a', type: 'task.created' }),
    makeEvent({ id: 'b', type: 'task.running' }),
    makeEvent({ id: 'c', type: 'task.completed' }),
  ];
  assert.deepEqual(
    eventsAfter(events, null).map((e) => e.id),
    ['a', 'b', 'c'],
    'null resume -> full tail',
  );
  assert.deepEqual(
    eventsAfter(events, 'b').map((e) => e.id),
    ['c'],
    'resume after b -> only c',
  );
  assert.deepEqual(
    eventsAfter(events, 'c').map((e) => e.id),
    [],
    'resume after the last -> empty',
  );
  assert.deepEqual(
    eventsAfter(events, 'unknown').map((e) => e.id),
    ['a', 'b', 'c'],
    'unknown resume id -> safe over-deliver (full tail)',
  );
});
