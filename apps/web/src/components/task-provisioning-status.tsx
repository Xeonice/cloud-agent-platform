import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleAlert, LoaderCircle } from "lucide-react";

import type { TaskProvisioningState, TaskResponse } from "@cap/contracts";
import { Button } from "@/components/ui/button";
import {
  TASK_PROVISIONING_STAGE_LABELS,
  TASK_PROVISIONING_STATE_LABELS,
  formatProvisioningUpdatedAt,
  isProvisioningTaskFailure,
  provisioningAttemptLabel,
  provisioningFailurePresentation,
  type ProvisioningTaskFailure,
} from "@/lib/task-provisioning";
import { cn } from "@/utils";

const STATE_TONES = {
  accepted: "bg-info-soft text-info",
  queued: "bg-secondary text-muted-foreground",
  running: "bg-info-soft text-info",
  retrying: "bg-warning-soft text-warning",
  succeeded: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  cancelled: "bg-secondary text-muted-foreground",
} satisfies Record<TaskProvisioningState, string>;

/**
 * Provider-neutral provisioning progress and structured recovery guidance.
 * This surface consumes only the canonical Task response; it never reads or
 * classifies terminal output, provider ids, commands, or raw git diagnostics.
 */
export function TaskProvisioningStatus({
  task,
  announce = false,
  className,
}: {
  task: TaskResponse | undefined;
  announce?: boolean;
  className?: string;
}): React.ReactElement | null {
  const provisioning = task?.provisioning ?? null;
  const failure = isProvisioningTaskFailure(task?.failure)
    ? task.failure
    : null;

  if (!provisioning && !failure) return null;

  return (
    <div className={cn("grid gap-3", className)}>
      {provisioning ? (
        <section
          aria-label="任务准备进度"
          role={announce ? "status" : undefined}
          aria-live={announce ? "polite" : undefined}
          data-provisioning-state={provisioning.state}
          data-provisioning-stage={provisioning.stage}
          className="grid gap-3 rounded-lg bg-card px-4 py-3 shadow-ring"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <LoaderCircle
                aria-hidden="true"
                className={cn(
                  "size-4 flex-none",
                  (provisioning.state === "running" ||
                    provisioning.state === "retrying") && "animate-spin",
                )}
              />
              <strong className="text-sm font-semibold text-foreground">
                仓库与运行环境准备
              </strong>
            </div>
            <span
              className={cn(
                "inline-flex min-h-6 items-center rounded-full px-2.5 text-xs font-semibold",
                STATE_TONES[provisioning.state],
              )}
            >
              {TASK_PROVISIONING_STATE_LABELS[provisioning.state]}
            </span>
          </div>

          <dl className="grid gap-x-5 gap-y-2 text-xs min-[641px]:grid-cols-2">
            <ProvisioningFact
              label="当前阶段"
              value={TASK_PROVISIONING_STAGE_LABELS[provisioning.stage]}
            />
            <ProvisioningFact
              label="解析分支"
              value={provisioning.resolvedBranch ?? "待解析"}
              mono={provisioning.resolvedBranch !== null}
            />
            <ProvisioningFact
              label="处理尝试"
              value={provisioningAttemptLabel(provisioning)}
              emphasize={provisioning.state === "retrying"}
            />
            <ProvisioningFact
              label="最后更新"
              value={formatProvisioningUpdatedAt(provisioning.updatedAt)}
              mono
            />
          </dl>
        </section>
      ) : null}

      {failure ? (
        <ProvisioningFailureAlert failure={failure} announce={announce} />
      ) : null}
    </div>
  );
}

function ProvisioningFact({
  label,
  value,
  mono = false,
  emphasize = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasize?: boolean;
}): React.ReactElement {
  return (
    <div className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 break-words text-foreground",
          mono && "font-mono",
          emphasize && "font-semibold text-warning",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function ProvisioningFailureAlert({
  failure,
  announce,
}: {
  failure: ProvisioningTaskFailure;
  announce: boolean;
}): React.ReactElement {
  const presentation = provisioningFailurePresentation(failure);

  return (
    <section
      role={announce ? "alert" : undefined}
      data-provisioning-failure={failure.code}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 border-l-4 border-danger bg-danger-soft px-4 py-3 text-sm min-[641px]:grid-cols-[auto_minmax(0,1fr)_auto]"
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 flex-none text-danger"
      />
      <div className="min-w-0">
        <strong className="block font-semibold text-danger">
          {presentation.title}
        </strong>
        <p className="mt-1 break-words leading-relaxed text-foreground/80">
          {failure.message}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {presentation.guidance}
        </p>
      </div>
      <ProvisioningFailureAction failure={failure} />
    </section>
  );
}

function ProvisioningFailureAction({
  failure,
}: {
  failure: ProvisioningTaskFailure;
}): React.ReactElement {
  const label = provisioningFailurePresentation(failure).actionLabel;
  const className = "col-start-2 gap-1.5 min-[641px]:col-start-auto";
  const contents = (
    <>
      {label}
      <ArrowRight className="size-3.5" />
    </>
  );

  switch (failure.action) {
    case "increase_sandbox_capacity":
      return (
        <Button asChild variant="secondary" size="sm" className={className}>
          <Link to="/images">{contents}</Link>
        </Button>
      );
    case "reconnect_forge":
      return (
        <Button asChild variant="secondary" size="sm" className={className}>
          <Link to="/settings" hash="forges">
            {contents}
          </Link>
        </Button>
      );
    case "verify_repository_ref":
      return (
        <Button asChild variant="secondary" size="sm" className={className}>
          <Link to="/repositories">{contents}</Link>
        </Button>
      );
    case "retry_task":
      return (
        <Button asChild variant="secondary" size="sm" className={className}>
          <Link to="/tasks/new" search={{ scheduleId: undefined }}>
            {contents}
          </Link>
        </Button>
      );
  }
}
