import * as React from "react";
import { Check, LoaderCircle } from "lucide-react";

import type { TaskResponse } from "@cap/contracts";
import {
  provisioningTimelineEntries,
  taskTransferProgress,
  transferPercentLabel,
  transferProgressDetail,
  type ProvisioningStageStatus,
  type TaskTransferProgress,
} from "@/lib/task-provisioning";
import { cn } from "@/utils";

/**
 * Provisioning stage checklist for the task-detail page, derived from the
 * shared `TASK_PROVISIONING_STAGES` order vs the summary's current stage.
 * Data arrives over the existing task-detail poll (`TASK_DETAIL_POLL_INTERVAL_MS`);
 * this component introduces no transport, socket, or endpoint. Progress is
 * wired alongside — never through — the checkpoint/diagnostic event ledger.
 *
 * Rendering rules (frontend-console spec):
 * - completed / current / pending stages are visually distinct;
 * - during workspace_transfer a live bar renders from the summary's progress
 *   object: determinate when percent is known, indeterminate otherwise;
 * - unknown progress is NEVER rendered as 0%;
 * - a summary without a progress object fabricates no bar;
 * - no summary (legacy task / closed capability gate) renders nothing and the
 *   existing state/stage presentation stands alone.
 */
export function TaskProvisioningTimeline({
  task,
  className,
}: {
  task: TaskResponse | undefined;
  className?: string;
}): React.ReactElement | null {
  const provisioning = task?.provisioning ?? null;
  // Degrade gracefully with no summary; once provisioning has succeeded the
  // session surfaces take over and the checklist retires.
  if (!provisioning || provisioning.state === "succeeded") return null;

  const entries = provisioningTimelineEntries(provisioning);
  const progress = taskTransferProgress(provisioning);
  const stageActive =
    provisioning.state === "running" || provisioning.state === "retrying";

  return (
    <section
      aria-label="任务准备阶段"
      data-provisioning-timeline
      className={cn(
        "rounded-lg bg-card px-4 py-3 shadow-ring",
        className,
      )}
    >
      <ol className="grid gap-1.5 text-xs">
        {entries.map((entry) => (
          <li
            key={entry.stage}
            data-stage={entry.stage}
            data-stage-status={entry.status}
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2"
          >
            <StageMarker status={entry.status} spinning={stageActive} />
            <div className="min-w-0">
              <span
                className={cn(
                  "block leading-5",
                  entry.status === "completed" && "text-muted-foreground",
                  entry.status === "current" && "font-semibold text-foreground",
                  entry.status === "pending" && "text-muted-foreground/60",
                )}
              >
                {entry.label}
              </span>
              {entry.stage === "workspace_transfer" &&
              entry.status === "current" &&
              progress !== null ? (
                <TransferProgressBar progress={progress} />
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StageMarker({
  status,
  spinning,
}: {
  status: ProvisioningStageStatus;
  spinning: boolean;
}): React.ReactElement {
  if (status === "completed") {
    return (
      <Check aria-hidden="true" className="mt-0.5 size-4 flex-none text-success" />
    );
  }
  if (status === "current") {
    return (
      <LoaderCircle
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 flex-none text-info",
          spinning && "animate-spin",
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="mt-1 ml-1 size-2 flex-none rounded-full border border-border"
    />
  );
}

/**
 * Live transfer bar. Determinate only for a KNOWN percent; an unknown phase
 * (pre-"Receiving objects") shows an indeterminate indicator and no number —
 * indeterminate must be distinguishable from an actual 0% transfer.
 */
function TransferProgressBar({
  progress,
}: {
  progress: TaskTransferProgress;
}): React.ReactElement {
  const percentLabel = transferPercentLabel(progress);
  const detail = transferProgressDetail(progress);
  const determinate = percentLabel !== null && progress.percent !== null;

  return (
    <div className="mt-1.5 grid gap-1" data-transfer-progress>
      <div
        role="progressbar"
        aria-label="仓库传输进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? Math.round(progress.percent!) : undefined}
        data-progress-mode={determinate ? "determinate" : "indeterminate"}
        className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
      >
        {determinate ? (
          <div
            className="h-full rounded-full bg-info transition-[width] duration-500"
            style={{ width: `${progress.percent}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-info/60" />
        )}
      </div>
      <span className="text-[11px] leading-4 text-muted-foreground">
        {determinate ? (
          <>
            <strong className="font-semibold text-foreground">
              {percentLabel}
            </strong>
            {detail ? ` · ${detail}` : null}
          </>
        ) : (
          <>正在传输仓库数据…{detail ? ` · ${detail}` : null}</>
        )}
      </span>
    </div>
  );
}
