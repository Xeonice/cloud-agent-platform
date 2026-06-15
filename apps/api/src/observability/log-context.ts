import { AsyncLocalStorage } from 'node:async_hooks';

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
}

const storage = new AsyncLocalStorage<TaskLogContext>();

/**
 * Run `fn` with `taskId` bound to the log context. The binding propagates to all
 * synchronous AND awaited async work started within `fn` — including
 * fire-and-forget (`void this.x()`) calls, which capture the context at creation
 * time — so nested `this.logger.*` calls inherit `taskId` automatically.
 */
export function runWithTaskLog<T>(taskId: string, fn: () => T): T {
  return storage.run({ taskId }, fn);
}

/** The current task log context, or `undefined` outside any `runWithTaskLog`. */
export function getTaskLogContext(): TaskLogContext | undefined {
  return storage.getStore();
}
