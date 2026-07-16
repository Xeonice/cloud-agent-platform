import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

export interface TaskAdmissionTimer {
  cancel(): void;
}

export abstract class TaskAdmissionScheduler {
  abstract schedule(delayMs: number, callback: () => void): TaskAdmissionTimer;
}

@Injectable()
export class SystemTaskAdmissionScheduler extends TaskAdmissionScheduler {
  schedule(delayMs: number, callback: () => void): TaskAdmissionTimer {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }
}

export abstract class TaskAdmissionClock {
  abstract now(): Date;
}

@Injectable()
export class SystemTaskAdmissionClock extends TaskAdmissionClock {
  now(): Date {
    return new Date();
  }
}

export abstract class TaskAdmissionLeaseTokenFactory {
  abstract create(): string;
}

@Injectable()
export class RandomTaskAdmissionLeaseTokenFactory extends TaskAdmissionLeaseTokenFactory {
  constructor(private readonly clock: TaskAdmissionClock) {
    super();
  }

  create(): string {
    return `admission:${this.clock.now().getTime()}:${randomUUID()}`;
  }
}

export interface TaskAdmissionWorkerOptions {
  readonly leaseDurationMs: number;
  readonly renewIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly queuedRetryAfterMs: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly retryJitterRatio: number;
  /** Process-local dispatch width only; 5.3 owns effective capacity binding. */
  readonly maxInFlight: number;
}

export const DEFAULT_TASK_ADMISSION_WORKER_OPTIONS = Object.freeze({
  leaseDurationMs: 30_000,
  renewIntervalMs: 10_000,
  pollIntervalMs: 5_000,
  queuedRetryAfterMs: 1_000,
  maxAttempts: 5,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 60_000,
  retryJitterRatio: 0.2,
  maxInFlight: 5,
}) satisfies TaskAdmissionWorkerOptions;

export const TASK_ADMISSION_WORKER_OPTIONS = Symbol(
  'TASK_ADMISSION_WORKER_OPTIONS',
);

export function validateTaskAdmissionWorkerOptions(
  options: TaskAdmissionWorkerOptions,
): TaskAdmissionWorkerOptions {
  for (const [name, value] of Object.entries({
    leaseDurationMs: options.leaseDurationMs,
    renewIntervalMs: options.renewIntervalMs,
    pollIntervalMs: options.pollIntervalMs,
    queuedRetryAfterMs: options.queuedRetryAfterMs,
    maxAttempts: options.maxAttempts,
    retryBaseDelayMs: options.retryBaseDelayMs,
    retryMaxDelayMs: options.retryMaxDelayMs,
    maxInFlight: options.maxInFlight,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (options.renewIntervalMs >= options.leaseDurationMs) {
    throw new Error('renewIntervalMs must be shorter than leaseDurationMs');
  }
  if (options.retryBaseDelayMs > options.retryMaxDelayMs) {
    throw new Error('retryBaseDelayMs must not exceed retryMaxDelayMs');
  }
  if (
    !Number.isFinite(options.retryJitterRatio) ||
    options.retryJitterRatio < 0 ||
    options.retryJitterRatio > 1
  ) {
    throw new Error('retryJitterRatio must be from 0 through 1');
  }
  return Object.freeze({ ...options });
}

export class TaskAdmissionRetryPolicy {
  private readonly options: TaskAdmissionWorkerOptions;

  constructor(options: TaskAdmissionWorkerOptions) {
    this.options = validateTaskAdmissionWorkerOptions(options);
  }

  canRetry(attempt: number): boolean {
    return attempt < this.options.maxAttempts;
  }

  delayMs(taskId: string, attempt: number): number {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error('attempt must be a positive safe integer');
    }
    const exponent = Math.min(attempt - 1, 30);
    const base = Math.min(
      this.options.retryMaxDelayMs,
      this.options.retryBaseDelayMs * 2 ** exponent,
    );
    const digest = createHash('sha256')
      .update(`${taskId}:${attempt}`, 'utf8')
      .digest();
    const unit = digest.readUInt32BE(0) / 0xffff_ffff;
    const signed = unit * 2 - 1;
    const jitter = Math.round(
      base * this.options.retryJitterRatio * signed,
    );
    return Math.max(1, Math.min(this.options.retryMaxDelayMs, base + jitter));
  }
}
