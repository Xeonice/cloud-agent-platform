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
 *   - The row is inserted in the SAME transaction as the `task.create` admission
 *     callback, so a raced concurrent retry that loses the unique-constraint race
 *     (`P2002`) rolls its just-created task back and resolves to the WINNER's
 *     task — a raced retry can never leave two committed tasks.
 *   - `requestHash` is the SHA-256 of the canonicalized request body; a reuse of
 *     the same key with a DIFFERENT body is a client mistake and is rejected 409
 *     (never silently aliased to the first task).
 *   - Records expire 24h after creation; an expired row no longer dedups.
 *
 * The service is body-shape agnostic: the controller passes the parsed body and
 * an `admit` callback that runs the SINGLE `TasksService.create` admission path
 * (D1 — no second admission path), so this layer only owns the dedup, never the
 * task semantics.
 */
@Injectable()
export class IdempotencyService {
  /** Dedup window: a key is honored for 24h after first use. */
  static readonly WINDOW_MS = 24 * 60 * 60 * 1000;

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
   * Runs an idempotent create under the given `(scopeUserId, key)`.
   *
   * - No key (header absent) → admit unconditionally; no dedup row is written.
   * - First use of the key → admit via `admit()` and record the key + resulting
   *   `taskId` in the SAME transaction (unique-constraint race guard).
   * - Same key + same body within the window → return the FIRST task; `admit()`
   *   is NOT called again (exactly one sandbox admission).
   * - Same key + different body within the window → 409, no second task.
   *
   * `admit` MUST be the single `TasksService.create` admission path; it receives
   * the live transaction-bound Prisma client so the task row and the dedup row
   * commit or roll back together.
   */
  async run(args: {
    key: string | null;
    scopeUserId: string;
    body: unknown;
    admit: (tx: TaskCreator) => Promise<TaskResponse>;
    /** Re-fetch a previously-admitted task by id (a dedup hit returns this). */
    loadTask: (taskId: string) => Promise<TaskResponse>;
  }): Promise<IdempotentCreateResult> {
    const { key, scopeUserId, body, admit, loadTask } = args;

    // No Idempotency-Key → ordinary create, no dedup record. NEWLY created, so the
    // caller runs the post-row admission (provision) afterwards.
    if (key === null || key.length === 0) {
      return { task: await admit(this.prisma), created: true };
    }

    const requestHash = IdempotencyService.hashBody(body);
    const now = new Date();

    // Fast path: an existing, unexpired record for this principal+key.
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { scopeUserId_key: { scopeUserId, key } },
    });
    if (existing && existing.expiresAt > now) {
      if (existing.requestHash !== requestHash) {
        // Same key, different body → caller bug; never alias to the first task.
        throw new ConflictException(
          'Idempotency-Key reused with a different request body',
        );
      }
      // Dedup hit: return the FIRST task, admitting nothing new (it was already
      // admitted by the first call — `created: false` so the caller does NOT
      // re-provision).
      return { task: await loadTask(existing.taskId), created: false };
    }

    // First use (or the prior record has expired): admit + record atomically so
    // a raced concurrent retry cannot leave two committed tasks. An expired row,
    // if present, is replaced inside the same transaction.
    try {
      const task = await this.prisma.$transaction(async (tx) => {
        if (existing) {
          await tx.idempotencyKey.delete({
            where: { scopeUserId_key: { scopeUserId, key } },
          });
        }
        const task = await admit(tx as unknown as TaskCreator);
        await tx.idempotencyKey.create({
          data: {
            key,
            scopeUserId,
            requestHash,
            taskId: task.id,
            expiresAt: new Date(now.getTime() + IdempotencyService.WINDOW_MS),
          },
        });
        return task;
      });
      // The task row + dedup row committed together — NEWLY created, so the caller
      // runs the post-row admission (provision) after this transaction commits.
      return { task, created: true };
    } catch (err) {
      // Lost the unique-constraint race (a concurrent retry committed first). Our
      // transaction rolled back (no orphan task), so resolve to the winner's task
      // — same body → same task; different body → 409.
      if (isUniqueViolation(err)) {
        const winner = await this.prisma.idempotencyKey.findUnique({
          where: { scopeUserId_key: { scopeUserId, key } },
        });
        if (winner) {
          if (winner.requestHash !== requestHash) {
            throw new ConflictException(
              'Idempotency-Key reused with a different request body',
            );
          }
          // The winner committed first; our transaction rolled back (no orphan
          // task), so resolve to the winner's already-admitted task.
          return { task: await loadTask(winner.taskId), created: false };
        }
      }
      throw err;
    }
  }
}

/**
 * The minimal Prisma surface the `admit` callback needs to create a task row on
 * the transaction-bound client. `TasksService.create` uses `this.prisma.task`/
 * `this.prisma.repo`; binding it to the transaction client requires only that the
 * client expose the same shape — captured here so the callback type does not
 * leak the whole `PrismaService`.
 */
export type TaskCreator = PrismaService;

/**
 * Result of an idempotent create. `created` is `true` when the task was NEWLY
 * persisted by this call (so the caller runs the post-row admission — audit +
 * guardrails provision — AFTER the dedup transaction commits) and `false` on a
 * dedup hit (the task already exists and was already admitted by the first call,
 * so it must NOT be re-admitted).
 */
export interface IdempotentCreateResult {
  task: TaskResponse;
  created: boolean;
}

/** True for a Prisma unique-constraint violation (`P2002`). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
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
