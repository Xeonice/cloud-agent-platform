import {
  SessionHistorySchema,
  type SessionHistory,
  type SessionTurn,
  type SystemTurn,
} from '@cap/contracts';
import { selectRetainedTranscriptSandboxProvider } from '@cap/sandbox';
import {
  transcriptFormatForRuntime,
  type RuntimeId,
  type TranscriptFormat,
} from '../agent-runtime/agent-runtime.port';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import { parseTranscript } from '../sandbox/parse-transcript';
import type { TasksService } from './tasks.service';

/** Durable transcript storage used by the shared transcript read path. */
export interface TranscriptStore {
  readDurable(taskId: string): Promise<string | null>;
  backfill(taskId: string, rawJsonl: string): Promise<unknown>;
}

export const TRANSCRIPT_STORE = Symbol('TRANSCRIPT_STORE');

/** Narrow read port over a task's ordered lifecycle audit timeline. */
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

export const AUDIT_TIMELINE_READER = Symbol('AUDIT_TIMELINE_READER');

/** Dependencies shared by the console, public API, and MCP transcript adapters. */
export interface TaskTranscriptReaderDeps {
  readonly tasks: Pick<TasksService, 'findById'>;
  readonly sandbox: SandboxProvider;
  readonly transcripts: TranscriptStore;
  readonly audit: AuditTimelineReader;
}

/**
 * Read one task transcript through the canonical resolution path.
 *
 * Running tasks always read the live sandbox rollout and never backfill an
 * in-flight snapshot. Terminal tasks are durable-first, then fall back to the
 * retained sandbox with read-through backfill. Every available result merges the
 * same audit-derived system turns before it is returned.
 */
export async function readTaskTranscript(
  deps: TaskTranscriptReaderDeps,
  id: string,
): Promise<SessionHistory> {
  const task = await deps.tasks.findById(id);
  if (task.status === 'agent_failed_to_start') {
    return SessionHistorySchema.parse({
      status: 'empty',
      reason: 'agent-failed-to-start',
    });
  }

  const runtime = task.runtime as RuntimeId | null;
  const format = transcriptFormatForRuntime(runtime);
  const retained = selectRetainedSandbox(deps.sandbox);
  const isRunning =
    task.status === 'running' || task.status === 'awaiting_input';

  if (isRunning) {
    if (!retained) {
      return SessionHistorySchema.parse({ status: 'empty', reason: 'no-rollout' });
    }
    const live = await retained.readRolloutFromContainer(id, runtime);
    return live === null
      ? SessionHistorySchema.parse({ status: 'empty', reason: 'no-rollout' })
      : toAvailable(deps, id, live.jsonl, task.status, format);
  }

  const durable = await deps.transcripts.readDurable(id);
  if (durable !== null) {
    return toAvailable(deps, id, durable, task.status, format);
  }

  if (!retained) {
    return SessionHistorySchema.parse({ status: 'expired' });
  }

  const source = await retained.readRolloutFromContainer(id, runtime);
  if (source !== null) {
    await deps.transcripts.backfill(id, source.jsonl);
    return toAvailable(deps, id, source.jsonl, task.status, format);
  }

  const exists = await retained.sandboxExists(id);
  return SessionHistorySchema.parse(
    exists ? { status: 'empty', reason: 'no-rollout' } : { status: 'expired' },
  );
}

function selectRetainedSandbox(sandbox: SandboxProvider): SandboxProvider | null {
  try {
    return selectRetainedTranscriptSandboxProvider(sandbox).provider;
  } catch {
    return null;
  }
}

async function toAvailable(
  deps: TaskTranscriptReaderDeps,
  id: string,
  jsonl: string,
  status: string,
  format: TranscriptFormat,
): Promise<SessionHistory> {
  const { turns, meta } = parseTranscript(jsonl, format);
  let merged: SessionTurn[] = [...turns];
  try {
    const events = await deps.audit.queryTask(id);
    if (events.length > 0) {
      merged = mergeSystemTurns(turns, events.map(auditToSystemTurn));
    }
  } catch {
    // Audit enrichment is best-effort; the rollout remains authoritative.
  }
  return SessionHistorySchema.parse({
    status: 'available',
    turns: merged,
    meta: { taskId: id, ...meta },
    isInterrupted: status === 'cancelled',
  });
}

/** Map one lifecycle audit event to a transcript system milestone. */
export function auditToSystemTurn(event: {
  title: string;
  description: string;
  level: 'info' | 'warning' | 'error';
  timestamp: Date;
}): SystemTurn {
  const detail = event.description?.trim();
  return {
    kind: 'system',
    title: event.title,
    ...(detail ? { detail: event.description } : {}),
    level: event.level,
    at: event.timestamp.toISOString(),
  };
}

/** Merge audit milestones into rollout turns in stable timestamp order. */
export function mergeSystemTurns(
  rollout: readonly SessionTurn[],
  system: readonly SystemTurn[],
): SessionTurn[] {
  type Keyed = { turn: SessionTurn; ms: number; origin: 0 | 1; stable: number };
  const keyed: Keyed[] = [];
  let lastMs = Number.NEGATIVE_INFINITY;
  rollout.forEach((turn, stable) => {
    const parsed = turn.at ? Date.parse(turn.at) : NaN;
    const ms = Number.isNaN(parsed) ? lastMs : parsed;
    if (!Number.isNaN(parsed)) lastMs = parsed;
    keyed.push({ turn, ms, origin: 0, stable });
  });
  system.forEach((turn, stable) => {
    const parsed = turn.at ? Date.parse(turn.at) : NaN;
    keyed.push({
      turn,
      ms: Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed,
      origin: 1,
      stable,
    });
  });
  return keyed
    .sort((a, b) =>
      a.ms !== b.ms
        ? a.ms - b.ms
        : a.origin !== b.origin
          ? a.origin - b.origin
          : a.stable - b.stable,
    )
    .map(({ turn }) => turn);
}
