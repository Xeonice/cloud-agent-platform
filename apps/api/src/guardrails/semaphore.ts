/**
 * Concurrency semaphore (guardrail 12.1).
 *
 * Bounds the number of concurrently running tasks at `MAX_CONCURRENT_TASKS`.
 * Tasks offered while the cap is full are held in a FIFO `queued` backlog rather
 * than provisioning a sandbox. When a running task reaches a terminal state the
 * oldest queued task is admitted, keeping the running count at most the cap.
 *
 * This class is intentionally a pure in-memory bookkeeping unit: it owns the
 * running set and the queue, and decides *which* task should be admitted, but it
 * never itself provisions sandboxes or writes task status. The orchestrator
 * integration (Track 14) wires {@link ConcurrencySemaphore.onAdmit} to the
 * lifecycle `queued -> running` transition + sandbox provisioning, and calls
 * {@link ConcurrencySemaphore.release} from the lifecycle terminal-state path.
 */

/** Callback invoked when a queued task is admitted to the running set. */
export type AdmitCallback = (taskId: string) => void;

export interface ConcurrencySemaphoreOptions {
  /** Maximum number of tasks allowed in the running set at once. */
  readonly maxConcurrentTasks: number;
  /**
   * Invoked exactly once per task when it transitions queued -> running, in FIFO
   * admission order. The integration layer uses this to provision the sandbox
   * and drive the lifecycle transition.
   */
  readonly onAdmit?: AdmitCallback;
}

/** Outcome of offering a task to the semaphore. */
export type AdmissionResult = 'running' | 'queued';

export class ConcurrencySemaphore {
  private readonly _maxConcurrentTasks: number;
  private readonly onAdmit?: AdmitCallback;

  /** Task ids currently occupying a running slot. */
  private readonly running = new Set<string>();
  /** FIFO backlog of task ids waiting for a free slot. */
  private readonly queue: string[] = [];

  constructor(options: ConcurrencySemaphoreOptions) {
    if (!Number.isInteger(options.maxConcurrentTasks) || options.maxConcurrentTasks < 1) {
      throw new Error(
        `MAX_CONCURRENT_TASKS must be a positive integer, received: ${String(
          options.maxConcurrentTasks,
        )}`,
      );
    }
    this._maxConcurrentTasks = options.maxConcurrentTasks;
    this.onAdmit = options.onAdmit;
  }

  /**
   * Configured slot ceiling (`MAX_CONCURRENT_TASKS`). Exposed read-only for the
   * derived capacity projection (be-metrics 5.1) so `ceiling` is read from the
   * same live instance as `runningCount`/`queuedCount`, never a separate copy.
   */
  get maxConcurrentTasks(): number {
    return this._maxConcurrentTasks;
  }

  /** Number of tasks currently holding a running slot. */
  get runningCount(): number {
    return this.running.size;
  }

  /** Number of tasks waiting in the FIFO backlog. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** True while at least one running slot is free. */
  get hasCapacity(): boolean {
    return this.running.size < this.maxConcurrentTasks;
  }

  /** True if the task currently holds a running slot. */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** True if the task currently sits in the queued backlog. */
  isQueued(taskId: string): boolean {
    return this.queue.includes(taskId);
  }

  /**
   * Offers a newly created task to the semaphore.
   *
   * - When a slot is free the task takes it and the result is `running`.
   * - When the cap is already reached the task is appended to the FIFO backlog
   *   and the result is `queued`; no sandbox should be provisioned for it.
   *
   * Idempotent for a task already tracked: re-offering a running task returns
   * `running` and a queued task returns `queued` without duplicating it.
   */
  offer(taskId: string): AdmissionResult {
    if (this.running.has(taskId)) {
      return 'running';
    }
    if (this.queue.includes(taskId)) {
      return 'queued';
    }

    if (this.hasCapacity) {
      this.running.add(taskId);
      return 'running';
    }

    this.queue.push(taskId);
    return 'queued';
  }

  /**
   * Releases the slot held by a task that has reached a terminal state and, if a
   * slot is now free and the backlog is non-empty, admits the oldest queued task
   * (FIFO), invoking {@link ConcurrencySemaphoreOptions.onAdmit} for it.
   *
   * Releasing a task that is queued-but-not-running drops it from the backlog
   * (e.g. a task cancelled before it ever ran) without admitting a replacement,
   * since it was never occupying a slot.
   *
   * Returns the id of the admitted task, or `null` when none was admitted.
   */
  release(taskId: string): string | null {
    const wasRunning = this.running.delete(taskId);
    if (!wasRunning) {
      // Not occupying a slot: just remove it from the backlog if present.
      const queueIndex = this.queue.indexOf(taskId);
      if (queueIndex !== -1) {
        this.queue.splice(queueIndex, 1);
      }
      return null;
    }

    return this.admitNext();
  }

  /**
   * Admits the oldest queued task if there is spare capacity, moving it into the
   * running set and invoking the admit callback. Returns the admitted task id or
   * `null` when the backlog is empty or no capacity is available.
   */
  private admitNext(): string | null {
    if (!this.hasCapacity || this.queue.length === 0) {
      return null;
    }

    const nextTaskId = this.queue.shift();
    if (nextTaskId === undefined) {
      return null;
    }

    this.running.add(nextTaskId);
    this.onAdmit?.(nextTaskId);
    return nextTaskId;
  }

  /** Snapshot of running task ids (defensive copy). */
  snapshotRunning(): string[] {
    return [...this.running];
  }

  /** Snapshot of queued task ids in FIFO order (defensive copy). */
  snapshotQueue(): string[] {
    return [...this.queue];
  }
}
