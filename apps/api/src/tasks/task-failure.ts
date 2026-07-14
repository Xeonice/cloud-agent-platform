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
  switch (code) {
    case 'runtime_auth_expired':
      return `${runtimeLabel} 登录凭据已过期，请前往设置重新连接后创建新任务。`;
    case 'runtime_auth_rejected':
      return `${runtimeLabel} 登录凭据已失效或被拒绝，请前往设置重新连接后创建新任务。`;
    case 'runtime_model_setup_failed':
      return `${runtimeLabel} 未能安全准备任务指定的模型，请重试任务或检查执行环境。`;
    case 'runtime_model_rejected':
      return `${runtimeLabel} 拒绝了任务指定的模型，请选择其他可用模型。`;
  }
}

export function runtimeFailureTitle(failure: TaskFailure): string {
  const runtimeLabel = failure.runtime === 'claude-code' ? 'Claude Code' : 'Codex';
  switch (failure.code) {
    case 'runtime_auth_expired':
      return `${runtimeLabel} 登录凭据已过期`;
    case 'runtime_auth_rejected':
      return `${runtimeLabel} 登录凭据已失效`;
    case 'runtime_model_setup_failed':
      return `${runtimeLabel} 模型准备失败`;
    case 'runtime_model_rejected':
      return `${runtimeLabel} 拒绝了指定模型`;
  }
}

function runtimeFailureAction(code: TaskFailureCode): TaskFailure['action'] {
  switch (code) {
    case 'runtime_auth_expired':
    case 'runtime_auth_rejected':
      return 'reconnect_runtime';
    case 'runtime_model_setup_failed':
      return 'retry_task';
    case 'runtime_model_rejected':
      return 'choose_another_model';
  }
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
    action: runtimeFailureAction(parsedCode.data),
    occurredAt: row.failureAt,
    exitCode: row.failureExitCode ?? null,
  });
}
