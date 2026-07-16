import {
  isReplayableStatus,
  type TaskProvisioningStage,
  type TaskProvisioningState,
  type TaskResponse,
} from "@cap/contracts";

/**
 * Keep the detail page polling while a task can still advance through durable
 * provisioning. Terminal task states are immutable read/replay surfaces and do
 * not need another timer.
 */
export const TASK_DETAIL_POLL_INTERVAL_MS = 4_000;

export function taskDetailPollingInterval(
  task: Pick<TaskResponse, "status"> | null | undefined,
): number | false {
  return task && isReplayableStatus(task.status)
    ? false
    : TASK_DETAIL_POLL_INTERVAL_MS;
}

type TaskFailure = NonNullable<TaskResponse["failure"]>;

export type ProvisioningTaskFailure = Extract<
  TaskFailure,
  {
    code:
      | "provisioning_capacity_exhausted"
      | "provisioning_workspace_timeout"
      | "provisioning_forge_auth_failed"
      | "provisioning_tls_network_failed"
      | "provisioning_ref_not_found"
      | "provisioning_unknown";
  }
>;

export interface ProvisioningFailurePresentation {
  title: string;
  guidance: string;
  actionLabel: string;
}

/** Canonical provider-neutral stage labels. Keep this exhaustive with contracts. */
export const TASK_PROVISIONING_STAGE_LABELS = {
  accepted: "任务已接受",
  sandbox_creation: "创建沙箱",
  credential_setup: "配置仓库凭据",
  remote_ref_resolution: "解析远端分支",
  workspace_transfer: "传输仓库工作区",
  checkout: "检出目标分支",
  submodules: "准备子模块",
  credential_cleanup: "清理临时凭据",
  runtime_setup: "准备 Agent 运行时",
  readiness: "检查运行环境",
  agent_launch: "启动 Agent",
  complete: "准备完成",
} satisfies Record<TaskProvisioningStage, string>;

/** Canonical orchestration-state labels. `retrying` stays distinct from queued. */
export const TASK_PROVISIONING_STATE_LABELS = {
  accepted: "已接受",
  queued: "等待处理",
  running: "准备中",
  retrying: "自动重试中",
  succeeded: "准备完成",
  failed: "准备失败",
  cancelled: "准备已取消",
} satisfies Record<TaskProvisioningState, string>;

const PROVISIONING_FAILURE_PRESENTATIONS = {
  provisioning_capacity_exhausted: {
    title: "沙箱容量不足",
    guidance: "请增加任务运行环境的磁盘容量，或选择容量充足的环境后重试。",
    actionLabel: "检查运行环境",
  },
  provisioning_workspace_timeout: {
    title: "仓库准备超时",
    guidance: "请确认仓库可访问且网络稳定，然后重新创建任务。",
    actionLabel: "重新创建任务",
  },
  provisioning_forge_auth_failed: {
    title: "代码托管凭据不可用",
    guidance: "请重新连接仓库所属代码托管平台的凭据，然后重试。",
    actionLabel: "检查代码托管凭据",
  },
  provisioning_tls_network_failed: {
    title: "网络或 TLS 连接失败",
    guidance: "请检查服务端到代码托管平台的网络、代理和证书信任，然后重试。",
    actionLabel: "重新创建任务",
  },
  provisioning_ref_not_found: {
    title: "未找到目标分支或引用",
    guidance: "请确认仓库默认分支或任务指定分支仍存在，并且当前账号有权访问。",
    actionLabel: "检查仓库与分支",
  },
  provisioning_unknown: {
    title: "仓库准备失败",
    guidance: "系统未能安全识别具体原因；请重试，持续失败时联系管理员查看服务端诊断。",
    actionLabel: "重新创建任务",
  },
} satisfies Record<ProvisioningTaskFailure["code"], ProvisioningFailurePresentation>;

export function isProvisioningTaskFailure(
  failure: TaskResponse["failure"],
): failure is ProvisioningTaskFailure {
  switch (failure?.code) {
    case "provisioning_capacity_exhausted":
    case "provisioning_workspace_timeout":
    case "provisioning_forge_auth_failed":
    case "provisioning_tls_network_failed":
    case "provisioning_ref_not_found":
    case "provisioning_unknown":
      return true;
    default:
      return false;
  }
}

export function provisioningFailurePresentation(
  failure: ProvisioningTaskFailure,
): ProvisioningFailurePresentation {
  return PROVISIONING_FAILURE_PRESENTATIONS[failure.code];
}

/**
 * Display the backend-resolved checkout branch before caller intent. A loaded
 * legacy task with neither value remains explicitly unresolved; it never falls
 * through to mock context or an invented `main` branch.
 */
export function taskDisplayBranch(task: TaskResponse | undefined): string {
  return task?.provisioning?.resolvedBranch ?? task?.branch ?? "待解析";
}

export function provisioningAttemptLabel(
  provisioning: NonNullable<TaskResponse["provisioning"]>,
): string {
  if (provisioning.attempt === 0) return "尚未开始处理";
  if (provisioning.state === "retrying") {
    return `自动重试中 · 第 ${provisioning.attempt} 次处理尝试`;
  }
  return `第 ${provisioning.attempt} 次处理尝试`;
}

/** Stable, locale-independent timestamp for polling progress and render tests. */
export function formatProvisioningUpdatedAt(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
