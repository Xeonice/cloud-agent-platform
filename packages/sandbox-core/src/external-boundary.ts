/**
 * Provider-neutral external actions that must be fenced by the current durable
 * task/lease authority. These are action identities, not provisioning stages:
 * callers must not project them as progress or use them to move stage state.
 */
export type SandboxExternalBoundaryAction =
  | 'environment.resolve'
  | 'sandbox.inspect'
  | 'sandbox.create'
  | 'sandbox.start'
  | 'sandbox.readiness'
  | 'runtime.preflight'
  | 'prompt.lookup'
  | 'prompt-auth.inject'
  | 'runtime.setup'
  | 'workspace.materialize'
  | 'skills.preinstall'
  | 'command.execute';

export interface SandboxExternalBoundaryEvent {
  readonly taskId: string;
  readonly action: SandboxExternalBoundaryAction;
  readonly position: 'before' | 'after';
}

/** A rejected guard is load-bearing and must abort the surrounding provider flow. */
export type SandboxExternalBoundaryGuard = (
  event: SandboxExternalBoundaryEvent,
) => Promise<void>;

/**
 * Preserve the first authority failure for the lifetime of one provision
 * attempt. Provider hooks are allowed to degrade ordinary command failures,
 * but a later boundary must still observe an authority failure that such a
 * hook caught internally.
 */
export function latchSandboxExternalBoundaryGuard(
  guard: SandboxExternalBoundaryGuard | undefined,
): SandboxExternalBoundaryGuard | undefined {
  if (!guard) return undefined;
  const notFailed = Symbol('sandbox-external-boundary-not-failed');
  let failure: unknown | typeof notFailed = notFailed;
  return async (event) => {
    if (failure !== notFailed) throw failure;
    try {
      await guard(event);
    } catch (error) {
      failure = error;
      throw error;
    }
  };
}

export interface RunSandboxExternalBoundaryArgs<T> {
  readonly taskId: string;
  readonly action: SandboxExternalBoundaryAction;
  readonly guard?: SandboxExternalBoundaryGuard;
  readonly signal?: AbortSignal;
  readonly run: () => Promise<T>;
}

/**
 * Execute one external action between two authority checks. The after-check is
 * also executed when the action rejects, so a stale owner cannot have its guard
 * failure hidden by provider-specific degradation/error mapping.
 */
export async function runSandboxExternalBoundary<T>(
  args: RunSandboxExternalBoundaryArgs<T>,
): Promise<T> {
  assertSandboxExternalBoundaryNotAborted(args.signal);
  await args.guard?.({
    taskId: args.taskId,
    action: args.action,
    position: 'before',
  });
  assertSandboxExternalBoundaryNotAborted(args.signal);

  let value: T | undefined;
  let actionError: unknown;
  let actionFailed = false;
  try {
    value = await args.run();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  await args.guard?.({
    taskId: args.taskId,
    action: args.action,
    position: 'after',
  });
  assertSandboxExternalBoundaryNotAborted(args.signal);
  if (actionFailed) throw actionError;
  return value as T;
}

function assertSandboxExternalBoundaryNotAborted(
  signal: AbortSignal | undefined,
): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error('Sandbox external boundary was aborted');
}
