import { Controller, Get, Inject, Param } from '@nestjs/common';
import {
  SessionHistorySchema,
  type SessionHistory,
  type SessionTurn,
  type SystemTurn,
} from '@cap/contracts';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import {
  selectRetainedTranscriptSandboxProvider,
} from '../sandbox/sandbox-scheduler';
import { parseTranscript } from '../sandbox/parse-transcript';
import {
  transcriptFormatForRuntime,
  type RuntimeId,
  type TranscriptFormat,
} from '../agent-runtime/agent-runtime.port';
import { TasksService } from './tasks.service';

/**
 * Durable transcript store port (persist-session-transcripts, Track 4 read-path).
 *
 * The read endpoint depends on this NARROW shape — `readDurable` (durable-first
 * hit) and `backfill` (read-through on a container fallback) — rather than the
 * concrete `SessionTranscriptService`, so the controller compiles and unit-tests
 * standalone against a stub. The Integration track (I.1) binds
 * {@link TRANSCRIPT_STORE} to the real `SessionTranscriptService` in
 * `tasks.module.ts`; the service satisfies this interface structurally.
 */
export interface TranscriptStore {
  /**
   * The persisted RAW rollout JSONL for a task, or `null` on a miss (no index
   * row / unreadable archive). The endpoint parses it server-side; the raw
   * archive remains the source of truth.
   */
  readDurable(taskId: string): Promise<string | null>;
  /**
   * Read-through backfill: persist a rollout already read from the container
   * (archive + index upsert) so the next read is a durable hit. Best-effort —
   * implementations log and swallow; the read MUST proceed regardless.
   */
  backfill(taskId: string, rawJsonl: string): Promise<unknown>;
}

/** DI token for the durable {@link TranscriptStore}, bound by Integration I.1. */
export const TRANSCRIPT_STORE = Symbol('TRANSCRIPT_STORE');

/**
 * Narrow read port over a task's lifecycle audit timeline
 * (wire-transcript-real-data D3). The controller depends on this shape — NOT the
 * concrete `AuditService` — so it unit-tests standalone against a stub; the
 * module binds it `useExisting: AuditService`, whose `queryTask` returns a task's
 * full ordered (oldest→newest) event sequence. The rollout parser stays
 * rollout-only; system milestone turns are derived HERE and merged by timestamp.
 */
export interface AuditTimelineReader {
  queryTask(taskId: string): Promise<
    readonly {
      type: string;
      title: string;
      description: string;
      level: 'info' | 'warning' | 'error';
      timestamp: Date;
    }[]
  >;
}

/** DI token for the {@link AuditTimelineReader}, bound `useExisting: AuditService`. */
export const AUDIT_TIMELINE_READER = Symbol('AUDIT_TIMELINE_READER');

/** Map one lifecycle audit event to a `system` milestone turn (no fabrication). */
export function auditToSystemTurn(e: {
  title: string;
  description: string;
  level: 'info' | 'warning' | 'error';
  timestamp: Date;
}): SystemTurn {
  const detail = e.description?.trim();
  return {
    kind: 'system',
    title: e.title,
    ...(detail ? { detail: e.description } : {}),
    level: e.level,
    at: e.timestamp.toISOString(),
  };
}

/**
 * Merge audit-sourced system turns into the rollout turn stream by timestamp
 * (D3). Stable: equal timestamps order rollout-before-system; untimed rollout
 * turns inherit the preceding rollout turn's timestamp so they stay adjacent to
 * their neighbors. Node's `Array.sort` is stable, preserving same-origin order.
 */
export function mergeSystemTurns(
  rollout: readonly SessionTurn[],
  system: readonly SystemTurn[],
): SessionTurn[] {
  type Keyed = { turn: SessionTurn; ms: number; origin: 0 | 1; seq: number };
  const keyed: Keyed[] = [];
  let lastMs = Number.NEGATIVE_INFINITY;
  rollout.forEach((turn, seq) => {
    const parsed = turn.at ? Date.parse(turn.at) : NaN;
    const ms = Number.isNaN(parsed) ? lastMs : parsed;
    if (!Number.isNaN(parsed)) lastMs = parsed;
    keyed.push({ turn, ms, origin: 0, seq });
  });
  system.forEach((turn, seq) => {
    const parsed = turn.at ? Date.parse(turn.at) : NaN;
    keyed.push({
      turn,
      ms: Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed,
      origin: 1,
      seq,
    });
  });
  return keyed
    .map((k, i) => ({ ...k, stable: i }))
    .sort((a, b) =>
      a.ms !== b.ms
        ? a.ms - b.ms
        : a.origin !== b.origin
          ? a.origin - b.origin
          : a.stable - b.stable,
    )
    .map((k) => k.turn);
}

/**
 * Read-only session-history replay endpoint (persist-session-transcripts,
 * Track 4 read-path). `GET /tasks/:id/session-history` returns the discriminated
 * {@link SessionHistory}: the parsed codex transcript of a FINISHED task, or an
 * honest empty/expired state — never a fabricated transcript, never an error for
 * the not-running / no-rollout / aged-out cases.
 *
 * Resolution is DURABLE-FIRST (design D4):
 *   1. `transcripts.readDurable(id)` hit → parse + return, NEVER touching the
 *      container (the permanent path; survives container reaping).
 *   2. miss → fall back to `sandbox.readRolloutFromContainer(id)` (the prior
 *      behavior); on success, read-through `transcripts.backfill(...)` so the
 *      next read is a durable hit, then return.
 *   3. neither source yields a rollout → the honest `empty`/`expired` state.
 * `expired` is returned ONLY when BOTH the durable archive AND the container are
 * gone — going forward that is limited to pre-feature reaped sessions.
 *
 * This is a STANDALONE REST surface. It parses the rollout server-side
 * ({@link parseRollout}) — it NEVER touches the live WebSocket / PTY / write-lease
 * path, and the raw rollout JSONL never leaves the api.
 *
 * Auth: behind the global `APP_GUARD` (auth.module) exactly like `/tasks/:id`
 * and `/metrics` — an unauthenticated / disabled request is rejected 401
 * before any archive or container is read, so no transcript is ever served
 * without a valid operator principal.
 */
@Controller()
export class SessionHistoryController {
  constructor(
    private readonly tasksService: TasksService,
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
    @Inject(TRANSCRIPT_STORE) private readonly transcripts: TranscriptStore,
    @Inject(AUDIT_TIMELINE_READER) private readonly audit: AuditTimelineReader,
  ) {}

  @Get('tasks/:id/session-history')
  async get(@Param('id') id: string): Promise<SessionHistory> {
    // 404 (NotFoundException) when the task does not exist — same as GET /tasks/:id.
    const task = await this.tasksService.findById(id);

    // The agent never started → no transcript ever existed. Honest empty state,
    // surfaced WITHOUT reading any archive or container (there is nothing to read).
    if (task.status === 'agent_failed_to_start') {
      return SessionHistorySchema.parse({
        status: 'empty',
        reason: 'agent-failed-to-start',
      });
    }

    // (1) DURABLE-FIRST: the persisted archive outlives the container, so prefer
    // it. A hit is returned WITHOUT reading (or depending on) the container.
    // The task's runtime decides where its transcript lands + how it parses
    // (add-headless-execution-track).
    const runtime = task.runtime as RuntimeId | null;
    const format = transcriptFormatForRuntime(runtime);

    // headless-task-conversation-view: a RUNNING headless task serves its LIVE
    // transcript by reading the sandbox rollout directly each poll — full re-parse,
    // STATELESS (`readRolloutFromContainer` reads a running container's frozen layer
    // without stopping it). Deliberately NOT durable-first and NOT backfilled here:
    // backfilling an in-flight rollout would freeze an INCOMPLETE transcript as the
    // durable copy and make every later read stale. The finished path below
    // (durable-first + backfill) takes over once the task settles. No live read for
    // interactive tasks — their live view is the xterm, and their history stays the
    // finished path.
    const isRunning =
      task.status === 'running' || task.status === 'awaiting_input';
    if (isRunning && task.executionMode === 'headless-exec') {
      const selected = this.selectRetainedTranscriptSandbox();
      if (!selected) {
        return SessionHistorySchema.parse({ status: 'empty', reason: 'no-rollout' });
      }
      const live = await selected.readRolloutFromContainer(id, runtime);
      if (live !== null) {
        return this.toAvailable(id, live.jsonl, task.status, format);
      }
      // Rollout not written yet (codex just starting) — honest empty, not expired.
      return SessionHistorySchema.parse({ status: 'empty', reason: 'no-rollout' });
    }

    const durable = await this.transcripts.readDurable(id);
    if (durable !== null) {
      return this.toAvailable(id, durable, task.status, format);
    }


    // (2) FALLBACK: no durable archive → read the rollout out of the retained
    // sandbox (null = none present). The provider never throws here and never
    // exports a credential file. It returns the runtime-tagged TranscriptSource
    // (unify-transcript-parsers D3); we consume its RAW `jsonl` so the durable
    // archive stays byte-for-byte the same raw text and the parse facade keeps its
    // stable `(jsonl, format)` signature.
    const selected = this.selectRetainedTranscriptSandbox();
    if (selected) {
      const source = await selected.readRolloutFromContainer(id, runtime);
      if (source !== null) {
        // Read-through backfill so the NEXT read is a durable hit. Best-effort:
        // the persisted store logs + swallows its own failures; awaiting only
        // sequences the write before we respond and never blocks the read on it.
        await this.transcripts.backfill(id, source.jsonl);
        return this.toAvailable(id, source.jsonl, task.status, format);
      }

      // (3) Neither source yields a rollout. Distinguish a truly aged-out/reaped
      // session (`expired`) — now limited to pre-feature containers reaped before
      // a durable archive existed — from one whose sandbox is present but produced
      // no transcript (`empty` / no-rollout).
      const exists = await selected.sandboxExists(id);
      return SessionHistorySchema.parse(
        exists ? { status: 'empty', reason: 'no-rollout' } : { status: 'expired' },
      );
    }

    return SessionHistorySchema.parse({ status: 'expired' });
  }

  private selectRetainedTranscriptSandbox(): SandboxProvider | null {
    try {
      return selectRetainedTranscriptSandboxProvider(this.sandbox).provider;
    } catch {
      return null;
    }
  }

  /** Parse a raw rollout (durable or container source) into the available state. */
  private async toAvailable(
    id: string,
    jsonl: string,
    status: string,
    format: TranscriptFormat,
  ): Promise<SessionHistory> {
    const { turns, meta } = parseTranscript(jsonl, format);
    // Merge audit-sourced system milestone turns by timestamp (D3). Best-effort:
    // an audit read failure must NOT fail the transcript read — fall back to the
    // rollout-only turns. The audit timeline is live DB data (independent of the
    // durable archive), so even old archives gain their lifecycle milestones.
    let merged: SessionTurn[] = [...turns];
    try {
      const events = await this.audit.queryTask(id);
      if (events.length > 0) {
        merged = mergeSystemTurns(turns, events.map(auditToSystemTurn));
      }
    } catch {
      // keep the rollout-only turns
    }
    return SessionHistorySchema.parse({
      status: 'available',
      turns: merged,
      meta: { taskId: id, ...meta },
      // V.1 — carry the interrupted-terminal indication ON THE WIRE: an
      // operator-`cancelled` task ended mid-run (its terminal frame is a
      // half-painted interruption); a `completed`/`failed` task did not.
      isInterrupted: status === 'cancelled',
    });
  }
}
