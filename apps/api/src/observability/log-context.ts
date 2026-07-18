import { AsyncLocalStorage } from 'node:async_hooks';
import {
  SANDBOX_PROVISIONING_DIAGNOSTIC_STAGES,
  type SandboxProvisioningDiagnosticAttemptContext,
  type SandboxProvisioningDiagnosticFact,
  type SandboxProvisioningDiagnosticStage,
} from '@cap/sandbox';

/**
 * Task-scoped log context (structured-logging D3a).
 *
 * Logs emitted OUTSIDE an HTTP request — lifecycle timers, terminal/WS events,
 * the `recordExit`/`forceFail` exit-handling paths that the ddba diagnosis cared
 * about — have no ambient pino-http `reqId`. This `AsyncLocalStorage` lets those
 * code paths declare the owning `taskId` ONCE at an entrypoint; the pino `mixin`
 * (see logger.options.ts) then stamps `taskId` onto every log line emitted
 * within that async scope, so "all logs for task X" is a single field filter.
 *
 * Pure-ish: it only manages async-local state; it neither logs nor does I/O.
 */
export interface TaskLogContext {
  readonly taskId: string;
  readonly attemptId?: string;
  /** Positive, attempt-local ordinal. Never a lease or ownership token. */
  readonly attempt?: number;
  readonly stage?: SandboxProvisioningDiagnosticStage;
  readonly operationId?: string;
}

/** Safe attempt correlation accepted by the async-local logger boundary. */
export type TaskProvisioningAttemptLogContext = Pick<
  SandboxProvisioningDiagnosticAttemptContext,
  'taskId' | 'attemptId' | 'attempt'
>;

/** Safe operation correlation projected from a validated diagnostic fact. */
export type TaskProvisioningOperationLogContext = Pick<
  SandboxProvisioningDiagnosticFact,
  'stage' | 'operationId'
>;

const storage = new AsyncLocalStorage<TaskLogContext>();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Run `fn` with `taskId` bound to the log context. The binding propagates to all
 * synchronous AND awaited async work started within `fn` — including
 * fire-and-forget (`void this.x()`) calls, which capture the context at creation
 * time — so nested `this.logger.*` calls inherit `taskId` automatically.
 */
export function runWithTaskLog<T>(taskId: string, fn: () => T): T {
  return storage.run(Object.freeze({ taskId }), fn);
}

/**
 * Add a validated provisioning-attempt identity to the current task scope.
 *
 * The input is projected onto the closed log-context vocabulary. Runtime
 * callers may therefore pass a larger orchestration object without copying a
 * lease token, provider id, or other raw field into async-local state.
 */
export function runWithTaskProvisioningAttemptLog<T>(
  context: TaskProvisioningAttemptLogContext,
  fn: () => T,
): T {
  assertUuid(context.taskId);
  assertUuid(context.attemptId);
  if (!Number.isSafeInteger(context.attempt) || context.attempt <= 0) {
    failValidation();
  }

  return storage.run(
    mergeSafeContext(storage.getStore(), {
      taskId: context.taskId,
      attemptId: context.attemptId,
      attempt: context.attempt,
    }),
    fn,
  );
}

/**
 * Add one logical diagnostic operation to the active provisioning attempt.
 *
 * A validated `SandboxProvisioningDiagnosticFact` is structurally compatible
 * with this input. Only its allowlisted stage and CAP-generated operation id
 * are projected; diagnostic outcome data and arbitrary runtime fields cannot
 * enter the log context through this wrapper.
 */
export function runWithTaskProvisioningOperationLog<T>(
  context: TaskProvisioningOperationLogContext,
  fn: () => T,
): T {
  const parent = storage.getStore();
  if (
    parent?.attemptId === undefined ||
    parent.attempt === undefined ||
    !Number.isSafeInteger(parent.attempt) ||
    parent.attempt <= 0
  ) {
    failValidation();
  }
  assertUuid(context.operationId);
  if (!isProvisioningStage(context.stage)) failValidation();

  return storage.run(
    mergeSafeContext(parent, {
      stage: context.stage,
      operationId: context.operationId,
    }),
    fn,
  );
}

/** The current task log context, or `undefined` outside any `runWithTaskLog`. */
export function getTaskLogContext(): TaskLogContext | undefined {
  return storage.getStore();
}

function mergeSafeContext(
  parent: TaskLogContext | undefined,
  patch: Partial<TaskLogContext>,
): TaskLogContext {
  const taskId = patch.taskId ?? parent?.taskId;
  if (taskId === undefined) failValidation();
  const attemptId = patch.attemptId ?? parent?.attemptId;
  const attempt = patch.attempt ?? parent?.attempt;
  const stage = patch.stage ?? parent?.stage;
  const operationId = patch.operationId ?? parent?.operationId;

  return Object.freeze({
    taskId,
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(stage === undefined ? {} : { stage }),
    ...(operationId === undefined ? {} : { operationId }),
  });
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) failValidation();
}

function isProvisioningStage(
  value: unknown,
): value is SandboxProvisioningDiagnosticStage {
  return (
    typeof value === 'string' &&
    SANDBOX_PROVISIONING_DIAGNOSTIC_STAGES.some((stage) => stage === value)
  );
}

function failValidation(): never {
  // Do not interpolate the rejected value: it may be provider-private data.
  throw new TypeError('Invalid task provisioning log context');
}
