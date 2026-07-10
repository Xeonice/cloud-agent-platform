import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  PublicV1EventHeadersSchema,
  PublicV1IdParamsSchema,
  V1TaskEventSchema,
  type AuditEvent,
  type V1TaskEvent,
} from '@cap/contracts';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { hasScope } from '../auth/operator-principal';
import { TasksService } from '../tasks/tasks.service';
import { parseZodValue, zodParam } from '../repos/zod-validation.pipe';

/**
 * `/v1` SSE lifecycle-observation surface (public-v1-api, Track sse-observation,
 * tasks 5.1 / 5.4; design D6).
 *
 * `GET /v1/tasks/:id/events` lets an EXTERNAL caller — who cannot use the cookie
 * WebSocket — observe a task's lifecycle to a terminal state as a
 * `text/event-stream`. The events are sourced from the append-only
 * {@link AuditEvent} tail (`AuditService.queryTask`, the
 * `@@index[taskId,timestamp]` read) — NOT the live PTY/WebSocket terminal stream,
 * which is gateway/lease/container-coupled and is intentionally never exposed
 * here. Each frame carries:
 *   - an `id:` (the AuditEvent's uuid) so a dropped connection can resume with
 *     `Last-Event-ID` (the controller replays only events AFTER the last seen id);
 *   - a single `data:` line with the JSON-encoded lifecycle event.
 *
 * A keep-alive heartbeat comment (`:hb`) is written well under the 90s ceiling so
 * a proxy (and the Cloudflare tunnel, which idles a GET-SSE connection out at
 * ~100–120s — see design D6/G7) never sees the stream as hung. The stream CLOSES
 * automatically once a TERMINAL lifecycle event is emitted
 * (`task.completed` / `task.failed` / `task.cancelled` / `agent_failed_to_start`
 * / any `force_failed:*`).
 *
 * Proxy-buffering defeat headers (design D6): `text/event-stream`,
 * `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
 *
 * POLLING FLOOR (task 5.2): the GUARANTEED observation path is polling
 * `GET /v1/tasks/:id`. `TasksService.transition` persists every status change
 * BEFORE its caller returns and `TasksService.findById` reads that persisted
 * status, so a client polling `GET /v1/tasks/:id` observes EVERY lifecycle
 * transition (`pending -> queued -> running -> terminal`) with no gap — the SSE
 * stream here is the additive PUSH channel over the SAME durable AuditEvent tail,
 * never a replacement for that floor, and its delivery is best-effort (a transient
 * tail-read failure is swallowed and retried, never surfaced as a lost transition,
 * because the poll path remains authoritative).
 *
 * Registered into `V1Module` by Integration (task 3.6) alongside the Track 3
 * task/repo/transcript controllers; this file is otherwise disjoint.
 *
 * G7 LIVE PROBE (task 5.3, deploy-time — requires the wired V1Module + the live
 * Cloudflare tunnel, so it runs AFTER Integration, not from this track). Once
 * deployed, confirm the tunnel passes GET-SSE without buffering/524 by holding a
 * 2-minute stream and watching for the periodic `:hb` heartbeat:
 *
 *   curl -N -H 'Authorization: Bearer <api-key>' \
 *     https://cap-api.douglasdong.com/v1/tasks/<id>/events
 *
 * Expected: the `:ok` open comment arrives immediately, `:hb` heartbeats appear at
 * the {@link heartbeatMs} cadence (well under the tunnel's ~100–120s idle cut and
 * the 90s spec ceiling), and the connection survives past 2 minutes. If the tunnel
 * BUFFERS or 524s the GET-SSE despite the heartbeat + no-buffer headers
 * (cloudflared #1449), document polling `GET /v1/tasks/:id` as the SUPPORTED path
 * and treat this stream as best-effort — the polling floor (task 5.2) ships
 * regardless of the probe outcome.
 */
@Controller('v1/tasks')
export class V1EventsController {
  /**
   * Heartbeat cadence (ms). MUST stay well below the 90s spec ceiling AND below
   * the Cloudflare-tunnel idle timeout (~100–120s). Env-overridable for ops;
   * floored so a misconfiguration cannot disable the keep-alive.
   */
  private readonly heartbeatMs = resolveIntervalMs(
    process.env.V1_SSE_HEARTBEAT_MS,
    25_000,
    1_000,
    89_000,
  );

  /**
   * How often the AuditEvent tail is re-polled for newly-appended events (ms).
   * The tail is the durable seam; a short poll keeps push latency low without a
   * DB-level notification channel. Env-overridable; floored.
   */
  private readonly pollMs = resolveIntervalMs(
    process.env.V1_SSE_POLL_MS,
    1_000,
    100,
    30_000,
  );

  constructor(
    private readonly audit: AuditService,
    private readonly tasksService: TasksService,
  ) {}

  /**
   * Open the SSE lifecycle stream for `id`. Writes the proxy-safe headers, replays
   * the AuditEvent tail (honoring `Last-Event-ID`), then polls for newly-appended
   * events and heartbeats until a terminal event closes the stream or the client
   * disconnects.
   *
   * Uses `@Res({ passthrough: false })` so this handler owns the response stream
   * end-to-end (no Nest serialization); it never resolves a value.
   */
  @Get(':id/events')
  async events(
    @Param('id', zodParam(PublicV1IdParamsSchema.shape.id)) taskId: string,
    @Res({ passthrough: false }) res: Response,
    @Req() req: AuthenticatedRequest,
    @Headers('last-event-id') lastEventIdHeader?: string,
  ): Promise<void> {
    // Scope gate (V.2): streaming a task's lifecycle events is a `tasks:read`
    // operation, gated like every sibling /v1 read so an api-key lacking
    // `tasks:read` cannot observe task lifecycle. A scopeless session/legacy
    // principal carries no scopes and is allow-all. Checked BEFORE any response
    // byte is written, so a denial is a plain Nest 403 (the exception filter
    // serializes it) rather than a half-open event-stream.
    const principal = req.operatorPrincipal;
    if (!principal) {
      throw new ForbiddenException('Missing operator principal');
    }
    if (!hasScope(principal, 'tasks:read')) {
      throw new ForbiddenException('Insufficient scope: tasks:read required');
    }
    const lastEventId = parseZodValue(
      PublicV1EventHeadersSchema.shape['Last-Event-ID'],
      lastEventIdHeader,
    );
    // Resolve before writing the SSE headers/open comment. An unknown task stays
    // an ordinary 404 response rather than a misleading 200 stream of heartbeats.
    await this.tasksService.findById(taskId);
    await this.streamEvents(res, {
      taskId,
      lastEventId,
      heartbeatMs: this.heartbeatMs,
      pollMs: this.pollMs,
    });
  }

  /**
   * The transport-agnostic SSE loop, factored out of the route handler so it is
   * unit-testable with a fake response sink and fast (injected) intervals. Writes
   * the SSE headers + an initial flush comment, replays the tail after
   * `lastEventId`, then alternates polling the {@link AuditService} tail and
   * heartbeating until a terminal event or client close. Resolves when the stream
   * has ended (closed by terminal, or by the client disconnecting).
   */
  async streamEvents(res: SseResponse, opts: StreamOptions): Promise<void> {
    const { taskId, lastEventId, heartbeatMs, pollMs } = opts;
    // Capture the service for the hoisted `drainTail` function declaration below
    // (a `function` does not bind the enclosing `this`). The hoisted form lets the
    // `pollTimer` callback reference `drainTail` while `drainTail` references the
    // timers/`end` — a cycle only resolvable because every edge fires async.
    const audit = this.audit;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeat nginx/proxy response buffering (design D6) so the first byte and
      // every subsequent frame are flushed immediately, not held in a buffer.
      'X-Accel-Buffering': 'no',
    });
    // An initial comment flushes headers + opens the byte stream right away, so a
    // buffering proxy commits the response before the first lifecycle event.
    res.write(':ok\n\n');

    return new Promise<void>((resolve) => {
      // The id of the last event written; seeds from `Last-Event-ID` so a resumed
      // connection replays only events AFTER it (no duplicate frames).
      let lastSeenId = normalizeLastEventId(lastEventId);
      let ended = false;
      // Guards re-entrant polls (a slow DB read must not overlap the next tick).
      let polling = false;

      // Heartbeat: a comment line carries no event but keeps the connection (and
      // every proxy hop) from idling the stream out. Created BEFORE `cleanup` so
      // both timers are in scope for it (the callbacks fire asynchronously, after
      // `drainTail` below is defined).
      const heartbeatTimer = setInterval(() => {
        if (ended) return;
        res.write(':hb\n\n');
      }, heartbeatMs);

      const pollTimer = setInterval(() => {
        void drainTail();
      }, pollMs);

      const cleanup = (): void => {
        if (ended) return;
        ended = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        resolve();
      };

      const end = (): void => {
        cleanup();
        try {
          res.end();
        } catch {
          // The socket may already be torn down; ending is best-effort.
        }
      };

      // A client disconnect (browser nav, `curl -N` Ctrl-C) stops the poll/HB
      // loop so we don't keep querying for a gone reader.
      res.on('close', cleanup);

      async function drainTail(this: void): Promise<void> {
        if (ended || polling) return;
        polling = true;
        try {
          // The full ordered (oldest -> newest) tail; cheap, bounded by a task's
          // lifecycle-event count. Replaying from the start each tick + filtering
          // on `lastSeenId` keeps the resume logic in one place.
          const events = await audit.queryTask(taskId);
          if (ended) return;

          const fresh = eventsAfter(events, lastSeenId);
          for (const event of fresh) {
            // The audit timeline also contains operational detail rows (for
            // example `task.exited`) that are not task status transitions. The
            // public stream is deliberately the lifecycle projection only.
            const lifecycleEvent = auditEventToV1TaskEvent(event);
            lastSeenId = event.id;
            if (lifecycleEvent === null) continue;

            res.write(serializeSseEvent(lifecycleEvent));
            if (isTerminalAuditType(event.type)) {
              // Auto-close on the terminal lifecycle event (task 5.1): the task
              // has settled, nothing more will be appended.
              end();
              return;
            }
          }
        } catch {
          // A transient tail-read failure must not kill the stream; the next poll
          // tick retries. (The durable polling floor `GET /v1/tasks/:id` is the
          // guarantee — this push channel is best-effort over the same tail.)
        } finally {
          polling = false;
        }
      }

      // Replay the existing tail immediately so a caller attaching to an
      // already-terminal task gets its events (and the close) without waiting a
      // poll interval.
      void drainTail();
    });
  }
}

/**
 * The subset of the Express `Response` the SSE loop needs. Declared structurally
 * so the unit test can drive {@link V1EventsController.streamEvents} with a fake
 * sink that records the written frames, no HTTP boot required.
 */
export interface SseResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: 'close', listener: () => void): unknown;
}

/** Options for {@link V1EventsController.streamEvents}. */
export interface StreamOptions {
  readonly taskId: string;
  /** The `Last-Event-ID` header value (resume point), if the client sent one. */
  readonly lastEventId?: string;
  readonly heartbeatMs: number;
  readonly pollMs: number;
}

/**
 * The AuditEvent `type`s that are TERMINAL lifecycle states — emitting one closes
 * the stream (task 5.1). Mirrors the terminal task statuses
 * (`completed`/`failed`/`cancelled`/`agent_failed_to_start`) plus the
 * `force_failed:*` guardrail-reclaim causes, whose audit kinds all settle the
 * task. `task.exited` is a failure DETAIL alongside `task.failed` (not itself a
 * terminal transition), so it does not close the stream on its own.
 */
const TERMINAL_AUDIT_TYPES: ReadonlySet<string> = new Set([
  'task.completed',
  'task.failed',
  'task.cancelled',
  'agent_failed_to_start',
]);

/** True when an AuditEvent `type` represents a terminal lifecycle event. */
export function isTerminalAuditType(type: string): boolean {
  return TERMINAL_AUDIT_TYPES.has(type) || type.startsWith('force_failed:');
}

/**
 * Project an audit row into the public lifecycle-event contract. Audit rows that
 * do not represent a task status transition are intentionally omitted from the
 * public SSE stream.
 */
export function auditEventToV1TaskEvent(event: AuditEvent): V1TaskEvent | null {
  const status = statusFromAuditType(event.type);
  if (status === null) return null;

  return V1TaskEventSchema.parse({
    id: event.id,
    taskId: event.taskId,
    type: event.type,
    status,
    title: event.title,
    description: event.description,
    timestamp: event.timestamp,
  });
}

/** Map the persisted audit kind to the task status transition it represents. */
function statusFromAuditType(eventType: string): V1TaskEvent['status'] | null {
  switch (eventType) {
    case 'task.created':
      return 'pending';
    case 'task.queued':
      return 'queued';
    case 'task.running':
      return 'running';
    case 'task.awaiting_input':
      return 'awaiting_input';
    case 'task.completed':
      return 'completed';
    case 'task.failed':
      return 'failed';
    case 'task.cancelled':
      return 'cancelled';
    case 'agent_failed_to_start':
      return 'agent_failed_to_start';
    default:
      return eventType.startsWith('force_failed:') ? 'failed' : null;
  }
}

/**
 * Serialize one validated {@link V1TaskEvent} to an SSE frame: an `id:` line (for
 * `Last-Event-ID` resume) followed by a single JSON `data:` line and the
 * frame-terminating blank line. The `timestamp` is emitted as an ISO string so
 * the wire stays JSON (the contracts shape carries a `Date`).
 */
export function serializeSseEvent(event: V1TaskEvent): string {
  const payload = {
    id: event.id,
    taskId: event.taskId,
    type: event.type,
    status: event.status,
    title: event.title,
    description: event.description,
    timestamp:
      event.timestamp instanceof Date
        ? event.timestamp.toISOString()
        : event.timestamp,
  };
  return `id: ${event.id}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The events that come strictly AFTER `lastSeenId` in the ordered tail. With no
 * resume point every event is fresh; with one, the events up to and INCLUDING the
 * last-seen id are skipped so a resumed connection never re-emits a frame the
 * client already saw. A `lastSeenId` not found in the tail (e.g. expired/unknown)
 * yields the full tail, which is the safe over-deliver rather than silent loss.
 */
export function eventsAfter(
  events: readonly AuditEvent[],
  lastSeenId: string | null,
): AuditEvent[] {
  if (lastSeenId === null) return [...events];
  const idx = events.findIndex((e) => e.id === lastSeenId);
  if (idx < 0) return [...events];
  return events.slice(idx + 1);
}

/**
 * Normalize a raw `Last-Event-ID` header to a resume id or `null`. An absent or
 * blank header means "from the start".
 */
function normalizeLastEventId(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse an env-override interval (ms) with a default and clamp it to
 * `[floor, ceiling]`, so a missing/garbage/out-of-range value can never disable
 * the heartbeat or hammer the DB with a sub-floor poll.
 */
function resolveIntervalMs(
  raw: string | undefined,
  fallback: number,
  floor: number,
  ceiling: number,
): number {
  const parsed = raw !== undefined ? Number(raw) : NaN;
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(Math.max(value, floor), ceiling);
}
