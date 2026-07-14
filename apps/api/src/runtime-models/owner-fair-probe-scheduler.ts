export interface OwnerFairProbeSchedulerOptions {
  readonly globalConcurrency: number;
  readonly perOwnerConcurrency: number;
  readonly globalQueueLimit: number;
  readonly perOwnerQueueLimit: number;
  readonly queueWaitTimeoutMs: number;
  readonly retryAfterMs?: number;
}

export class RuntimeModelProbeCapacityError extends Error {
  constructor(
    readonly scope: 'owner' | 'global',
    readonly retryAfterMs: number,
  ) {
    super('Runtime model probe capacity is temporarily unavailable.');
    this.name = new.target.name;
  }
}

export class RuntimeModelProbeAbortedError extends Error {
  constructor() {
    super('Runtime model probe request was aborted.');
    this.name = new.target.name;
  }
}

interface QueueEntry<T> {
  readonly ownerUserId: string;
  readonly operation: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  timeout: NodeJS.Timeout | null;
  abortListener: (() => void) | null;
  active: boolean;
}

/**
 * Per-owner FIFO queues scheduled in owner round-robin order. A running slot is
 * held until the complete operation promise settles, including adapter teardown.
 */
export class OwnerFairProbeScheduler {
  private readonly queues = new Map<string, QueueEntry<unknown>[]>();
  private readonly ownerOrder: string[] = [];
  private readonly runningByOwner = new Map<string, number>();
  private runningGlobal = 0;
  private queuedGlobal = 0;

  constructor(private readonly options: OwnerFairProbeSchedulerOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (name === 'retryAfterMs') continue;
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Owner fair probe scheduler ${name} must be positive.`);
      }
    }
    if (
      options.globalConcurrency > 1 &&
      options.perOwnerConcurrency >= options.globalConcurrency
    ) {
      throw new Error(
        'Owner fair probe scheduler must preserve at least one cross-owner slot.',
      );
    }
    if (
      options.retryAfterMs !== undefined &&
      (!Number.isInteger(options.retryAfterMs) || options.retryAfterMs < 1)
    ) {
      throw new Error('Owner fair probe scheduler retryAfterMs must be positive.');
    }
  }

  run<T>(
    ownerUserId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new RuntimeModelProbeAbortedError());
    }
    const ownerQueue = this.queues.get(ownerUserId) ?? [];
    const retryAfterMs = this.options.retryAfterMs ?? this.options.queueWaitTimeoutMs;
    if (ownerQueue.length >= this.options.perOwnerQueueLimit) {
      return Promise.reject(
        new RuntimeModelProbeCapacityError('owner', retryAfterMs),
      );
    }
    if (this.queuedGlobal >= this.options.globalQueueLimit) {
      return Promise.reject(
        new RuntimeModelProbeCapacityError('global', retryAfterMs),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        ownerUserId,
        operation,
        resolve,
        reject,
        signal,
        timeout: null,
        abortListener: null,
        active: true,
      };
      entry.timeout = setTimeout(() => {
        if (!this.removeQueued(entry as QueueEntry<unknown>)) return;
        const scope =
          (this.runningByOwner.get(ownerUserId) ?? 0) >=
          this.options.perOwnerConcurrency
            ? 'owner'
            : 'global';
        reject(new RuntimeModelProbeCapacityError(scope, retryAfterMs));
      }, this.options.queueWaitTimeoutMs);
      if (signal) {
        entry.abortListener = () => {
          if (!this.removeQueued(entry as QueueEntry<unknown>)) return;
          reject(new RuntimeModelProbeAbortedError());
        };
        signal.addEventListener('abort', entry.abortListener, { once: true });
      }

      if (ownerQueue.length === 0) this.ownerOrder.push(ownerUserId);
      ownerQueue.push(entry as QueueEntry<unknown>);
      this.queues.set(ownerUserId, ownerQueue);
      this.queuedGlobal += 1;
      this.drain();
    });
  }

  private drain(): void {
    while (this.runningGlobal < this.options.globalConcurrency) {
      const entry = this.takeNext();
      if (!entry) return;
      this.start(entry);
    }
  }

  private takeNext(): QueueEntry<unknown> | null {
    const ownersToInspect = this.ownerOrder.length;
    for (let inspected = 0; inspected < ownersToInspect; inspected += 1) {
      const ownerUserId = this.ownerOrder.shift();
      if (!ownerUserId) return null;
      const queue = this.queues.get(ownerUserId);
      if (!queue || queue.length === 0) {
        this.queues.delete(ownerUserId);
        continue;
      }
      const running = this.runningByOwner.get(ownerUserId) ?? 0;
      if (running >= this.options.perOwnerConcurrency) {
        this.ownerOrder.push(ownerUserId);
        continue;
      }
      const entry = queue.shift();
      if (!entry) continue;
      if (queue.length > 0) this.ownerOrder.push(ownerUserId);
      else this.queues.delete(ownerUserId);
      this.queuedGlobal -= 1;
      this.clearEntryWaiters(entry);
      entry.active = false;
      return entry;
    }
    return null;
  }

  private start(entry: QueueEntry<unknown>): void {
    const ownerRunning = this.runningByOwner.get(entry.ownerUserId) ?? 0;
    this.runningByOwner.set(entry.ownerUserId, ownerRunning + 1);
    this.runningGlobal += 1;
    Promise.resolve()
      .then(entry.operation)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.runningGlobal -= 1;
        const nextOwnerRunning =
          (this.runningByOwner.get(entry.ownerUserId) ?? 1) - 1;
        if (nextOwnerRunning > 0) {
          this.runningByOwner.set(entry.ownerUserId, nextOwnerRunning);
        } else {
          this.runningByOwner.delete(entry.ownerUserId);
        }
        this.drain();
      });
  }

  private removeQueued(entry: QueueEntry<unknown>): boolean {
    if (!entry.active) return false;
    const queue = this.queues.get(entry.ownerUserId);
    const index = queue?.indexOf(entry) ?? -1;
    if (!queue || index < 0) return false;
    queue.splice(index, 1);
    entry.active = false;
    this.queuedGlobal -= 1;
    this.clearEntryWaiters(entry);
    if (queue.length === 0) {
      this.queues.delete(entry.ownerUserId);
      const ownerIndex = this.ownerOrder.indexOf(entry.ownerUserId);
      if (ownerIndex >= 0) this.ownerOrder.splice(ownerIndex, 1);
    }
    this.drain();
    return true;
  }

  private clearEntryWaiters(entry: QueueEntry<unknown>): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = null;
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener);
    }
    entry.abortListener = null;
  }
}
