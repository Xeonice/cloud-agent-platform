import { createHash } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import type { TaskResponse } from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';

/**
 * `Idempotency-Key` dedup for `POST /v1/tasks` (public-v1-api, D5 / task 3.3).
 *
 * A machine caller retries a create (network blip, at-least-once delivery) by
 * re-sending it with the SAME `Idempotency-Key` header. Without dedup each retry
 * admits a fresh sandbox — exactly the double-admission the running-task
 * semaphore does NOT prevent (it bounds RUNNING, not CREATED, tasks). This
 * service makes a retry resolve to the FIRST task instead.
 *
 * Mechanism (D5):
 *   - The dedup record is the `IdempotencyKey` row, scoped per principal
 *     (`@@unique([scopeUserId, key])`) so two principals may reuse the same key
 *     string without colliding while the task POOL stays shared.
 *   - The row is inserted in the SAME transaction as the canonical acceptance
 *     callback. With durable admission enabled that callback writes the Task,
 *     its unique admission work item, and creation audit, so a concurrent retry
 *     that loses the unique-constraint race (`P2002`) rolls all of its staged
 *     acceptance state back and resolves to the WINNER's task.
 *   - `requestHash` is the SHA-256 of the canonicalized request body; a reuse of
 *     the same key with a DIFFERENT body is a client mistake and is rejected 409
 *     (never silently aliased to the first task).
 *   - Records expire 24h after creation; an expired row no longer dedups.
 *
 * The service is body-shape agnostic: the controller prepares the request before
 * entering this short transaction and supplies the SINGLE canonical acceptance
 * writer. This layer owns only deduplication and transaction composition, never
 * task-domain preparation or provisioning semantics.
 */
@Injectable()
export class IdempotencyService {
  /** Dedup window: a key is honored for 24h after first use. */
  static readonly WINDOW_MS = 24 * 60 * 60 * 1000;
  /** Short bound used only to resolve a same-key winner racing a failed preflight. */
  static readonly WINNER_WAIT_MS = 250;
  static readonly WINNER_POLL_MS = 10;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Canonical SHA-256 hash of a request body, stable across key ordering so a
   * semantically-identical retry hashes equal. Keys are sorted recursively before
   * stringifying, so `{a,b}` and `{b,a}` produce the same digest.
   */
  static hashBody(body: unknown): string {
    return createHash('sha256')
      .update(canonicalize(body))
      .digest('hex');
  }

  /**
   * Side-effect-free first phase for V1 create. It only reads the idempotency row
   * and, on an exact replay, the already-committed Task. No callback, catalog,
   * provider, or write transaction runs here.
   */
  async lookup(args: {
    key: string | null;
    scopeUserId: string;
    body: unknown;
    loadTask: (taskId: string) => Promise<TaskResponse>;
  }): Promise<IdempotencyLookupResult> {
    const { key, scopeUserId, body, loadTask } = args;
    const requestHash = IdempotencyService.hashBody(body);
    const replay = await this.lookupByHash({
      key,
      scopeUserId,
      requestHash,
      loadTask,
    });
    if (replay) {
      return { kind: 'replay', requestHash, task: replay };
    }
    return { kind: 'missing', requestHash };
  }

  /**
   * Short write phase. `create` must only persist already-prepared acceptance
   * state on the supplied transaction client; it must not perform catalog,
   * provider, workspace, or runtime work. The transaction rechecks the key so
   * two requests that both preflight after an initial miss still commit at most
   * one Task and one admission work item.
   */
  async commit(args: {
    key: string | null;
    scopeUserId: string;
    requestHash: string;
    create: (tx: TaskCreator) => Promise<TaskResponse>;
    loadTask: (taskId: string) => Promise<TaskResponse>;
  }): Promise<IdempotentCreateResult> {
    const { key, scopeUserId, requestHash, create, loadTask } = args;

    if (key === null || key.length === 0) {
      // Even without a dedup key, the canonical acceptance writer may need to
      // commit Task + admission work + creation audit atomically.
      const task = await this.prisma.$transaction((tx) =>
        create(tx as unknown as TaskCreator),
      );
      return { task, created: true };
    }

    const now = new Date();

    try {
      const outcome:
        | { kind: 'created'; task: TaskResponse }
        | { kind: 'replay'; taskId: string } =
        await this.prisma.$transaction(async (tx) => {
          const current = await tx.idempotencyKey.findUnique({
            where: { scopeUserId_key: { scopeUserId, key } },
          });
          if (current && current.expiresAt > now) {
            assertMatchingRequestHash(current.requestHash, requestHash);
            return { kind: 'replay' as const, taskId: current.taskId };
          }
          if (current) {
            // Delete only the row observed by this transaction. A concurrent
            // replacement is protected by the unique constraint and causes this
            // whole transaction (including a staged Task) to roll back.
            await tx.idempotencyKey.deleteMany({
              where: {
                scopeUserId,
                key,
                requestHash: current.requestHash,
                taskId: current.taskId,
                expiresAt: { lte: now },
              },
            });
          }
          const task = await create(tx as unknown as TaskCreator);
          await tx.idempotencyKey.create({
            data: {
              key,
              scopeUserId,
              requestHash,
              taskId: task.id,
              expiresAt: new Date(now.getTime() + IdempotencyService.WINDOW_MS),
            },
          });
          return { kind: 'created' as const, task };
        });
      if (outcome.kind === 'replay') {
        return { task: await loadTask(outcome.taskId), created: false };
      }
      return { task: outcome.task, created: true };
    } catch (err) {
      // The winner may commit while this request is inside its acceptance
      // transaction even when the loser fails before reaching the unique-key
      // insert (for example a final model gate or transient acceptance write).
      // Resolve any now-visible winner before surfacing the local error so an
      // exact retry still returns the canonical Task and a mismatched body still
      // receives the required 409. `waitForWinner` is side-effect-free and
      // bounded; if no winner exists, preserve the original failure exactly.
      const winner = await this.waitForWinner({
        key,
        scopeUserId,
        requestHash,
        loadTask,
      });
      if (winner) return { task: winner, created: false };
      throw err;
    }
  }

  /**
   * Bounded side-effect-free polling used after external preflight fails. A
   * concurrent exact-body winner is replayed; a different-body winner still
   * raises the ordinary 409. No Task or idempotency row is created here.
   */
  async waitForWinner(args: {
    key: string | null;
    scopeUserId: string;
    requestHash: string;
    loadTask: (taskId: string) => Promise<TaskResponse>;
    maxWaitMs?: number;
    pollMs?: number;
  }): Promise<TaskResponse | null> {
    if (!args.key) return null;
    const maxWaitMs = Math.max(
      0,
      args.maxWaitMs ?? IdempotencyService.WINNER_WAIT_MS,
    );
    const pollMs = Math.max(
      1,
      args.pollMs ?? IdempotencyService.WINNER_POLL_MS,
    );
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const winner = await this.lookupByHash(args);
      if (winner) return winner;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await delay(Math.min(pollMs, remaining));
    }
  }

  private async lookupByHash(args: {
    key: string | null;
    scopeUserId: string;
    requestHash: string;
    loadTask: (taskId: string) => Promise<TaskResponse>;
  }): Promise<TaskResponse | null> {
    if (!args.key) return null;
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: {
        scopeUserId_key: {
          scopeUserId: args.scopeUserId,
          key: args.key,
        },
      },
    });
    if (!existing || existing.expiresAt <= new Date()) return null;
    assertMatchingRequestHash(existing.requestHash, args.requestHash);
    return args.loadTask(existing.taskId);
  }
}

/**
 * The minimal transaction-bound Prisma surface needed by the canonical
 * acceptance writer. Keeping this structural type narrow prevents the callback
 * from accidentally reaching non-transactional dependencies.
 */
export type TaskCreator = Pick<
  PrismaService,
  'task' | 'taskAdmissionWork' | 'auditEvent'
>;

/**
 * Result of an idempotent create. `created` is `true` when the task was NEWLY
 * persisted by this call (so the caller may issue the best-effort post-commit
 * worker wake) and `false` on a dedup hit (the task and its durable work already
 * exist, so current admission/provisioning must NOT be restarted).
 */
export interface IdempotentCreateResult {
  task: TaskResponse;
  created: boolean;
}

export type IdempotencyLookupResult =
  | {
      readonly kind: 'missing';
      readonly requestHash: string;
    }
  | {
      readonly kind: 'replay';
      readonly requestHash: string;
      readonly task: TaskResponse;
    };

function assertMatchingRequestHash(
  persistedHash: string,
  requestHash: string,
): void {
  if (persistedHash !== requestHash) {
    throw new ConflictException(
      'Idempotency-Key reused with a different request body',
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic JSON canonicalization: object keys are sorted recursively so a
 * body re-serialized in a different key order hashes identically. Arrays keep
 * their order (semantically significant); primitives pass through `JSON`.
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}
