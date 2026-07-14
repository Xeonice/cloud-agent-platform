import type {
  ReadyRuntimeModelCredential,
  RuntimeModelAdapterResult,
} from './runtime-model-catalog.types';
import type { RuntimeExecutionEnvironmentSnapshot } from '@cap/contracts';

export const RUNTIME_MODEL_TASKLESS_PROBE = Symbol(
  'RuntimeModelTasklessProbeLifecycle',
);

export interface RuntimeModelTasklessProbeHandle {
  /** Provider-owned opaque id. It must never be a Task id. */
  readonly id: string;
}

/**
 * Dedicated taskless lifecycle. Catalog discovery must never create a fake Task
 * or call the task-owned SANDBOX_PROVIDER provision path.
 */
export interface RuntimeModelTasklessProbeLifecycle {
  create(input: {
    readonly purpose: 'runtime-model-catalog';
    readonly labels: Readonly<Record<string, string>>;
    readonly ownerUserId: string;
    readonly environment: RuntimeExecutionEnvironmentSnapshot;
    readonly credential: ReadyRuntimeModelCredential;
    readonly signal?: AbortSignal;
    readonly deadlineAt: number;
  }): Promise<RuntimeModelTasklessProbeHandle>;
  discover(
    handle: RuntimeModelTasklessProbeHandle,
    input: { readonly signal?: AbortSignal; readonly deadlineAt: number },
  ): Promise<RuntimeModelAdapterResult>;
  cancel(handle: RuntimeModelTasklessProbeHandle): Promise<void>;
  destroy(handle: RuntimeModelTasklessProbeHandle): Promise<void>;
  reconcileOrphans(input: {
    readonly purpose: 'runtime-model-catalog';
    readonly olderThan: Date;
  }): Promise<number>;
}

export class RuntimeModelProbeCleanupError extends Error {
  constructor(readonly stage: 'cancel' | 'destroy') {
    super('Runtime model probe cleanup failed.');
    this.name = new.target.name;
  }
}

export class RuntimeModelTasklessProbeAbortedError extends Error {
  constructor() {
    super('Runtime model taskless probe was aborted.');
    this.name = new.target.name;
  }
}

/** One lifecycle wrapper shared by adapters so every created probe is destroyed. */
export async function runTasklessRuntimeModelProbe(input: {
  readonly lifecycle: RuntimeModelTasklessProbeLifecycle;
  readonly ownerUserId: string;
  readonly environment: RuntimeExecutionEnvironmentSnapshot;
  readonly credential: ReadyRuntimeModelCredential;
  readonly signal?: AbortSignal;
  readonly deadlineAt: number;
  readonly onCleanupError?: (
    stage: 'cancel' | 'destroy',
    error: unknown,
  ) => void;
}): Promise<RuntimeModelAdapterResult> {
  const handle = await input.lifecycle.create({
    purpose: 'runtime-model-catalog',
    labels: {
      'cap.resource-purpose': 'runtime-model-catalog',
      'cap.owner-user-id': input.ownerUserId,
    },
    ownerUserId: input.ownerUserId,
    environment: input.environment,
    credential: input.credential,
    signal: input.signal,
    deadlineAt: input.deadlineAt,
  });
  let cancelPromise: Promise<void> | null = null;
  let abortRequested = false;
  let rejectAborted: ((error: Error) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const cancel = () => {
    abortRequested = true;
    if (cancelPromise) return cancelPromise;
    cancelPromise = input.lifecycle.cancel(handle).catch((error) => {
      input.onCleanupError?.('cancel', error);
      throw new RuntimeModelProbeCleanupError('cancel');
    });
    void cancelPromise.then(
      () => rejectAborted?.(new RuntimeModelTasklessProbeAbortedError()),
      (error) => rejectAborted?.(error as Error),
    );
    return cancelPromise;
  };
  const abort = () => void cancel();
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  let result: RuntimeModelAdapterResult | undefined;
  let operationError: unknown;
  try {
    result = await Promise.race([
      input.lifecycle.discover(handle, input),
      aborted,
    ]);
  } catch (error) {
    operationError = error;
  }
  input.signal?.removeEventListener('abort', abort);
  let cancelError: unknown;
  if (cancelPromise) {
    try {
      await cancelPromise;
    } catch (error) {
      cancelError = error;
    }
  }
  let destroyError: unknown;
  try {
    await input.lifecycle.destroy(handle);
  } catch (error) {
    input.onCleanupError?.('destroy', error);
    destroyError = new RuntimeModelProbeCleanupError('destroy');
  }
  if (destroyError) throw destroyError;
  if (cancelError) throw cancelError;
  if (abortRequested) throw new RuntimeModelTasklessProbeAbortedError();
  if (operationError) throw operationError;
  if (!result) throw new Error('Runtime model probe returned no result.');
  return result;
}
