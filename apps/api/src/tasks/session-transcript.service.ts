import { Inject, Injectable, Logger } from '@nestjs/common';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { parseTranscript } from '../sandbox/parse-transcript';
import {
  transcriptFormatForRuntime,
  type RuntimeId,
} from '../agent-runtime/agent-runtime.port';
import { PrismaService } from '../prisma/prisma.service';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** The fixed archive file name within each task workspace (co-located with `session.log`). */
export const TRANSCRIPT_ARCHIVE_FILENAME = 'transcript.jsonl.gz';

/**
 * Resolve the workspace directory for a task. This MIRRORS the gateway's private
 * `resolveWorkspaceDir` (terminal.gateway.ts) and the runner's
 * `createTaskWorkspace`: the root comes from `WORKSPACES_DIR` — the env var every
 * deploy target sets to the persistent-volume mount — so the transcript archive
 * lands ON the durable volume alongside `session.log` and survives container
 * reaping (design D2). Legacy `WORKSPACES_ROOT` is honored as a fallback, then
 * `cwd()/workspaces` for local dev (off-volume, ephemeral — dev only).
 */
export function resolveWorkspaceDir(taskId: string): string {
  const root =
    process.env.WORKSPACES_DIR ??
    process.env.WORKSPACES_ROOT ??
    path.resolve(process.cwd(), 'workspaces');
  return path.join(root, taskId);
}

/** Outcome flag for {@link SessionTranscriptService.capture}. */
export type CaptureStatus = 'captured' | 'no-rollout' | 'error';

/**
 * Durable transcript persistence (persist-session-transcripts, design D2/D3).
 *
 * A task's codex rollout normally lives ONLY inside its retained `cap-aio-<id>`
 * container, which the retention cleaner reaps on its window — reaping loses the
 * conversation forever. This service co-locates a RAW, gzip-compressed copy of
 * the rollout JSONL on the durable per-task workspace volume (next to
 * `session.log`) and indexes it in Postgres, so the transcript outlives the
 * container and is queryable across history.
 *
 * The archive stores the RAW JSONL (NOT parsed `SessionTurn[]`) so a future
 * parser improvement can re-run over historical data; the DB `SessionTranscript`
 * row is the derivable, queryable catalog (meta + full-text content). The raw
 * archive on the volume is the source of truth.
 *
 * {@link capture} is BEST-EFFORT: every failure path is logged and swallowed, a
 * status flag is returned, and it NEVER throws — so a terminal teardown / slot-
 * free path that awaits it is never blocked or failed by a capture error.
 */
@Injectable()
export class SessionTranscriptService {
  private readonly logger = new Logger(SessionTranscriptService.name);

  /**
   * The workspace-dir resolver that already roots `session.log`. A plain class
   * field (NOT a constructor parameter) defaulting to the deploy resolver:
   * NestJS DI cannot inject a bare `Function`-typed constructor param (it would
   * try to resolve a `Function` provider and fail bootstrap), so tests override
   * this by assignment after construction rather than via the constructor.
   */
  resolveWorkspace: (taskId: string) => string = resolveWorkspaceDir;

  constructor(
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
    private readonly prisma: PrismaService,
  ) {}

  /** Absolute path to a task's transcript archive on the durable volume. */
  private archivePathFor(taskId: string): string {
    return path.join(this.resolveWorkspace(taskId), TRANSCRIPT_ARCHIVE_FILENAME);
  }

  /**
   * Capture a terminal task's rollout to the durable archive + index (D1/D2/D3).
   *
   * Reuses {@link SandboxProvider.readRolloutFromContainer} (the container is
   * still present at the terminal chokepoints), gzips the RAW JSONL, writes
   * `workspaces/<taskId>/transcript.jsonl.gz`, then parses ONCE to upsert the
   * `SessionTranscript` index row (idempotent overwrite, keyed by `taskId`).
   *
   * BEST-EFFORT: returns `'no-rollout'` when the container yielded nothing
   * (no archive written, no row), `'error'` when read/write/upsert failed
   * (logged, swallowed — no archive left behind), and `'captured'` on success.
   * NEVER throws.
   */
  async capture(taskId: string): Promise<CaptureStatus> {
    const runtime = await this.resolveRuntime(taskId);
    let jsonl: string | null;
    try {
      jsonl = await this.sandbox.readRolloutFromContainer(taskId, runtime);
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: transcript capture skipped — rollout read failed: ${(err as Error).message}`,
      );
      return 'error';
    }
    if (jsonl === null) {
      // No rollout present (codex never ran, or already reaped). Nothing to
      // archive; the read path will fall back to the container / backfill later.
      return 'no-rollout';
    }
    return this.persist(taskId, jsonl, runtime);
  }

  /**
   * Persist an already-read rollout: archive + upsert the index from a JSONL the
   * caller read elsewhere (the read-through fallback in the history controller —
   * design D4). Reuses the same archive-write + index-upsert internals as
   * {@link capture}, so a backfill and a proactive capture converge idempotently.
   *
   * BEST-EFFORT, like {@link capture}: logs + swallows all failures, returns a
   * status flag, never throws.
   */
  async backfill(taskId: string, rawJsonl: string): Promise<CaptureStatus> {
    return this.persist(taskId, rawJsonl, await this.resolveRuntime(taskId));
  }

  /**
   * Look up a task's selected runtime so the transcript read + parse are runtime-aware
   * (add-headless-execution-track). Best-effort: any lookup failure degrades to `null`
   * (codex default), never throwing into the best-effort capture/backfill path.
   */
  private async resolveRuntime(taskId: string): Promise<RuntimeId | null> {
    try {
      const row = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { runtime: true },
      });
      return (row?.runtime ?? null) as RuntimeId | null;
    } catch {
      return null;
    }
  }

  /**
   * Read the durable archive back (D4 step 1). Looks up the index row, reads +
   * gunzips the archive, and returns the RAW JSONL for the controller to parse
   * (keeping the raw archive the source of truth). Returns `null` on any miss —
   * no index row, archive unreadable, or gunzip failure — so the caller falls
   * through to the container. NEVER throws.
   */
  async readDurable(taskId: string): Promise<string | null> {
    let row: { archivePath: string } | null;
    try {
      row = await this.prisma.sessionTranscript.findUnique({
        where: { taskId },
        select: { archivePath: true },
      });
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: durable transcript lookup failed: ${(err as Error).message}`,
      );
      return null;
    }
    if (!row) return null;
    try {
      const gz = await readFile(row.archivePath);
      const raw = await gunzipAsync(gz);
      return raw.toString('utf8');
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: durable transcript archive unreadable (${row.archivePath}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The shared archive-write + index-upsert path behind {@link capture} and
   * {@link backfill}. Idempotent: the archive write overwrites in place and the
   * index row is upserted keyed by `taskId`, so re-capture never duplicates.
   */
  private async persist(
    taskId: string,
    rawJsonl: string,
    runtime: RuntimeId | null,
  ): Promise<CaptureStatus> {
    const archivePath = this.archivePathFor(taskId);
    try {
      const gz = await gzipAsync(Buffer.from(rawJsonl, 'utf8'));
      await mkdir(path.dirname(archivePath), { recursive: true });
      await writeFile(archivePath, gz);
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: transcript archive write failed (${archivePath}): ${(err as Error).message}`,
      );
      return 'error';
    }

    try {
      const { turns, meta } = parseTranscript(
        rawJsonl,
        transcriptFormatForRuntime(runtime),
      );
      // Concatenated search text over the parsed turn text (design D3 FTS source);
      // persisted into the `content` column the schema/migration declare (the
      // Postgres GIN `tsvector` FTS index is built over `content`).
      const content = turns
        .map((t) => {
          if (t.kind === 'tool') {
            return [t.name, t.args, t.output ?? ''].join(' ');
          }
          return t.text;
        })
        .join('\n');
      const data = {
        model: meta.model ?? null,
        cwd: meta.cwd ?? null,
        startedAt: meta.startedAt ?? null,
        turnCount: turns.length,
        // An interrupted (operator-cancelled) terminal frame is half-painted; the
        // index records the flag so a future surface can badge it. Derived from
        // the absence of a clean final-answer assistant turn.
        isInterrupted: !turns.some(
          (t) => t.kind === 'assistant' && t.isFinalAnswer,
        ),
        archivePath,
        capturedAt: new Date(),
        content,
      };
      await this.prisma.sessionTranscript.upsert({
        where: { taskId },
        create: { taskId, ...data },
        update: data,
      });
    } catch (err) {
      // The bytes are safely on the volume; only the index failed. Log + swallow
      // — the raw archive is the source of truth and a later capture/backfill
      // re-upserts. (Best-effort: never throws into the terminal path.)
      this.logger.warn(
        `task ${taskId}: transcript index upsert failed: ${(err as Error).message}`,
      );
      return 'error';
    }
    return 'captured';
  }
}
