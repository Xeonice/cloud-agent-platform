import type { TaskResponse } from "@cap/contracts";

export const SANDBOX_PROVIDER_PENDING_LABEL = "沙箱待启动";

export function taskSandboxProviderLabel(
  task: Pick<TaskResponse, "sandboxProvider"> | null | undefined,
): string {
  const label = task?.sandboxProvider?.label?.trim();
  return label && label.length > 0 ? label : SANDBOX_PROVIDER_PENDING_LABEL;
}
