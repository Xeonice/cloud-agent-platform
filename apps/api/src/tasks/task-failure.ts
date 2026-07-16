import {
  DEFAULT_TASK_RUNTIME,
  TaskFailureCodeSchema,
  TaskFailureSchema,
  type Runtime,
  type TaskFailure,
} from '@cap/contracts';

type RuntimeTaskFailure = Extract<TaskFailure, { runtime: Runtime }>;
type ProvisioningTaskFailure = Exclude<TaskFailure, RuntimeTaskFailure>;

export type RuntimeTaskFailureCode = RuntimeTaskFailure['code'];
export type ProvisioningTaskFailureCode = ProvisioningTaskFailure['code'];

const RUNTIME_TASK_FAILURE_CODES: Readonly<
  Record<RuntimeTaskFailureCode, true>
> = {
  runtime_auth_expired: true,
  runtime_auth_rejected: true,
  runtime_model_setup_failed: true,
  runtime_model_rejected: true,
};

const PROVISIONING_TASK_FAILURE_CODES: Readonly<
  Record<ProvisioningTaskFailureCode, true>
> = {
  provisioning_capacity_exhausted: true,
  provisioning_workspace_timeout: true,
  provisioning_forge_auth_failed: true,
  provisioning_tls_network_failed: true,
  provisioning_ref_not_found: true,
  provisioning_platform_dependency_unavailable: true,
  provisioning_unknown: true,
};

export function isRuntimeTaskFailureCode(
  value: unknown,
): value is RuntimeTaskFailureCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(RUNTIME_TASK_FAILURE_CODES, value)
  );
}

export function isProvisioningTaskFailureCode(
  value: unknown,
): value is ProvisioningTaskFailureCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVISIONING_TASK_FAILURE_CODES, value)
  );
}

export interface PersistedTaskFailureFields {
  readonly runtime?: string | null;
  readonly failureCode?: string | null;
  readonly failureAt?: Date | null;
  readonly failureExitCode?: number | null;
}

export interface TaskFailureWrite {
  readonly code: RuntimeTaskFailureCode | ProvisioningTaskFailureCode;
  readonly occurredAt: Date;
  readonly exitCode: number | null;
}

export interface RuntimeFailureWrite extends TaskFailureWrite {
  readonly code: RuntimeTaskFailureCode;
}

export interface ProvisioningFailureWrite extends TaskFailureWrite {
  readonly code: ProvisioningTaskFailureCode;
  readonly exitCode: null;
}

export function runtimeFailureMessage(
  runtime: Runtime,
  code: RuntimeTaskFailureCode,
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

export function runtimeFailureTitle(failure: RuntimeTaskFailure): string {
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

function runtimeFailureAction(
  code: RuntimeTaskFailureCode,
): RuntimeTaskFailure['action'] {
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

interface ProvisioningFailurePresentation {
  readonly title: string;
  readonly message: string;
  readonly action: ProvisioningTaskFailure['action'];
}

function provisioningFailurePresentation(
  code: ProvisioningTaskFailureCode,
): ProvisioningFailurePresentation {
  switch (code) {
    case 'provisioning_capacity_exhausted':
      return {
        title: '沙箱存储空间不足',
        message: '沙箱存储空间不足，请增加磁盘容量后重试任务。',
        action: 'increase_sandbox_capacity',
      };
    case 'provisioning_workspace_timeout':
      return {
        title: '仓库工作区准备超时',
        message: '仓库工作区准备超时，请重试任务；若持续失败，请检查仓库大小和网络连接。',
        action: 'retry_task',
      };
    case 'provisioning_forge_auth_failed':
      return {
        title: '代码仓库身份验证失败',
        message: '代码仓库身份验证失败，请重新连接对应代码托管平台后重试。',
        action: 'reconnect_forge',
      };
    case 'provisioning_tls_network_failed':
      return {
        title: '代码仓库网络连接失败',
        message: '连接代码仓库时发生 TLS 或网络错误，请检查网络和证书配置后重试。',
        action: 'retry_task',
      };
    case 'provisioning_ref_not_found':
      return {
        title: '未找到仓库分支或引用',
        message: '未找到任务指定的分支或引用，请确认仓库默认分支或任务分支后重试。',
        action: 'verify_repository_ref',
      };
    case 'provisioning_platform_dependency_unavailable':
      return {
        title: '部署缺少仓库置备依赖',
        message: '当前部署缺少仓库置备所需的控制面依赖，请修复或升级部署后再创建任务。',
        action: 'repair_deployment',
      };
    case 'provisioning_unknown':
      return {
        title: '任务环境准备失败',
        message: '任务环境准备失败，请重试；若持续失败，请联系管理员。',
        action: 'retry_task',
      };
  }
}

/** Fixed, secret-free title for both runtime and provisioning failures. */
export function taskFailureTitle(failure: TaskFailure): string {
  switch (failure.code) {
    case 'runtime_auth_expired':
    case 'runtime_auth_rejected':
    case 'runtime_model_setup_failed':
    case 'runtime_model_rejected':
      return runtimeFailureTitle(failure);
    case 'provisioning_capacity_exhausted':
    case 'provisioning_workspace_timeout':
    case 'provisioning_forge_auth_failed':
    case 'provisioning_tls_network_failed':
    case 'provisioning_ref_not_found':
    case 'provisioning_platform_dependency_unavailable':
    case 'provisioning_unknown':
      return provisioningFailurePresentation(failure.code).title;
  }
}

/** Fixed, secret-free message; never forwards a persisted/provider diagnostic. */
export function taskFailureMessage(failure: TaskFailure): string {
  switch (failure.code) {
    case 'runtime_auth_expired':
    case 'runtime_auth_rejected':
    case 'runtime_model_setup_failed':
    case 'runtime_model_rejected':
      return runtimeFailureMessage(failure.runtime, failure.code);
    case 'provisioning_capacity_exhausted':
    case 'provisioning_workspace_timeout':
    case 'provisioning_forge_auth_failed':
    case 'provisioning_tls_network_failed':
    case 'provisioning_ref_not_found':
    case 'provisioning_platform_dependency_unavailable':
    case 'provisioning_unknown':
      return provisioningFailurePresentation(failure.code).message;
  }
}

/** Project persisted, secret-free columns into the shared API contract. */
export function taskFailureFromRecord(
  row: PersistedTaskFailureFields,
): TaskFailure | null {
  const parsedCode = TaskFailureCodeSchema.safeParse(row.failureCode);
  if (!parsedCode.success || !row.failureAt) return null;
  switch (parsedCode.data) {
    case 'runtime_auth_expired':
    case 'runtime_auth_rejected':
    case 'runtime_model_setup_failed':
    case 'runtime_model_rejected': {
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
    case 'provisioning_capacity_exhausted':
    case 'provisioning_workspace_timeout':
    case 'provisioning_forge_auth_failed':
    case 'provisioning_tls_network_failed':
    case 'provisioning_ref_not_found':
    case 'provisioning_platform_dependency_unavailable':
    case 'provisioning_unknown': {
      const presentation = provisioningFailurePresentation(parsedCode.data);
      return TaskFailureSchema.parse({
        code: parsedCode.data,
        message: presentation.message,
        action: presentation.action,
        occurredAt: row.failureAt,
      });
    }
  }
}
