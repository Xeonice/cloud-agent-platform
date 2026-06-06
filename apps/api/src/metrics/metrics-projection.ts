import type { CapacityMetrics, SlotEntry, SlotOccupancy } from '@cap/contracts';

/**
 * Pure derived-capacity projection (be-metrics, tasks 5.1 & 5.2).
 *
 * These functions turn a single LIVE reading of the concurrency semaphore into
 * the exact, point-in-time capacity figures and the slot-occupancy table that
 * the `/metrics` endpoint serves. They are deliberately pure and side-effect
 * free so they can be unit-tested against a fake semaphore: every output is a
 * function of the values read in ONE pass, never of any parallel counter that
 * could drift from the actual admission decisions.
 *
 * The single source of truth is the {@link SemaphoreProjectionSource} — a narrow
 * read-only view of {@link ConcurrencySemaphore}. The metrics layer depends on
 * THIS interface, not the concrete class, so a fake can be injected in tests.
 */

/**
 * The narrow read-only slice of the concurrency semaphore the projection needs.
 *
 * Implemented by the real `ConcurrencySemaphore` (via `GuardrailsService`) and
 * by test fakes. All four reads MUST reflect the same instant; callers read them
 * once per projection so `active + free === ceiling` holds by construction.
 */
export interface SemaphoreProjectionSource {
  /** Configured slot ceiling (`maxConcurrentTasks`). */
  readonly maxConcurrentTasks: number;
  /** Number of task ids currently holding a running slot. */
  readonly runningCount: number;
  /** Number of task ids waiting in the FIFO backlog. */
  readonly queuedCount: number;
  /** Task ids currently occupying a running slot (order not significant). */
  snapshotRunning(): string[];
  /** Queued task ids in FIFO order. */
  snapshotQueue(): string[];
}

/**
 * Projects the exact scalar capacity figures from a single live semaphore
 * reading (task 5.1).
 *
 * Invariants guaranteed for any non-pathological semaphore:
 *  - `ceiling === maxConcurrentTasks`
 *  - `active === runningCount`
 *  - `free === ceiling - active`, clamped to never go negative
 *  - `active + free === ceiling`
 *  - `queueDepth === queuedCount`
 *
 * `free` is clamped at zero defensively: a well-behaved semaphore never reports
 * `runningCount > ceiling`, but clamping guarantees the contract's
 * `nonnegative()` invariant rather than emitting a negative free count if an
 * upstream bug ever over-admitted.
 */
export function projectCapacity(
  semaphore: SemaphoreProjectionSource,
): CapacityMetrics {
  const ceiling = semaphore.maxConcurrentTasks;
  const active = semaphore.runningCount;
  // Clamp so free is never negative AND active+free===ceiling holds: if active
  // somehow exceeded ceiling we report free=0 (the table builder mirrors this).
  const free = Math.max(0, ceiling - active);
  const queueDepth = semaphore.queuedCount;
  return { ceiling, active, free, queueDepth };
}

/**
 * Builds the slot occupancy table from `snapshotRunning()` / `snapshotQueue()`
 * (task 5.2).
 *
 * The table lists EXACTLY `ceiling`-many slots, 0-indexed. Running task ids fill
 * the leading slots as `busy`; the remaining slots are `idle` (taskId `null`).
 * Queued ids are reported SEPARATELY in `queuedTaskIds`, in FIFO order — they are
 * never folded into the slot table, because a queued task holds no slot.
 *
 * By construction (mirroring {@link projectCapacity}):
 *  - `slots.length === ceiling` — never inventing identities beyond the ceiling;
 *  - count of `busy` slots `=== active`;
 *  - count of `idle` slots `=== free`;
 *  - `queuedTaskIds.length === queueDepth`.
 *
 * Defensive clamp: if `snapshotRunning()` ever returned MORE ids than `ceiling`
 * (an upstream over-admission bug), only the first `ceiling` are placed into
 * slots so the table never grows past the configured ceiling; the surplus is
 * dropped from the table (it is still counted by `active` in the scalar block,
 * surfacing the inconsistency rather than hiding it behind invented slots).
 */
export function buildSlotOccupancy(
  semaphore: SemaphoreProjectionSource,
): SlotOccupancy {
  const ceiling = semaphore.maxConcurrentTasks;
  const running = semaphore.snapshotRunning();
  const queuedTaskIds = semaphore.snapshotQueue();

  const slots: SlotEntry[] = [];
  for (let slot = 0; slot < ceiling; slot += 1) {
    const taskId = slot < running.length ? running[slot] : null;
    slots.push({
      slot,
      busy: taskId !== null,
      taskId,
    });
  }

  return { slots, queuedTaskIds };
}
