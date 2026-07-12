import {
  DEFAULT_TASK_RUNTIME,
  TaskFailureCodeSchema,
  TaskFailureSchema,
  type Runtime,
  type TaskFailure,
  type TaskFailureCode,
} from '@cap/contracts';

export interface PersistedTaskFailureFields {
  readonly runtime?: string | null;
  readonly failureCode?: string | null;
  readonly failureAt?: Date | null;
  readonly failureExitCode?: number | null;
}

export interface RuntimeFailureWrite {
  readonly code: TaskFailureCode;
  readonly occurredAt: Date;
  readonly exitCode: number | null;
}

export function runtimeFailureMessage(
  runtime: Runtime,
  code: TaskFailureCode,
): string {
  const runtimeLabel = runtime === 'claude-code' ? 'Claude Code' : 'Codex';
  if (code === 'runtime_auth_expired') {
    return `${runtimeLabel} 登录凭据已过期，请前往设置重新连接后创建新任务。`;
  }
  return `${runtimeLabel} 登录凭据已失效或被拒绝，请前往设置重新连接后创建新任务。`;
}

export function runtimeFailureTitle(failure: TaskFailure): string {
  const runtimeLabel = failure.runtime === 'claude-code' ? 'Claude Code' : 'Codex';
  return failure.code === 'runtime_auth_expired'
    ? `${runtimeLabel} 登录凭据已过期`
    : `${runtimeLabel} 登录凭据已失效`;
}

/** Project persisted, secret-free columns into the shared API contract. */
export function taskFailureFromRecord(
  row: PersistedTaskFailureFields,
): TaskFailure | null {
  const parsedCode = TaskFailureCodeSchema.safeParse(row.failureCode);
  if (!parsedCode.success || !row.failureAt) return null;
  const runtime: Runtime =
    row.runtime === 'claude-code' ? 'claude-code' : DEFAULT_TASK_RUNTIME;
  return TaskFailureSchema.parse({
    code: parsedCode.data,
    runtime,
    message: runtimeFailureMessage(runtime, parsedCode.data),
    action: 'reconnect_runtime',
    occurredAt: row.failureAt,
    exitCode: row.failureExitCode ?? null,
  });
}
