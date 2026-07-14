import * as React from "react";

import type { SessionHistory } from "@cap/contracts";
import { cn } from "@/utils";

export interface TaskModelFactsProps {
  requestedModel: string | null | undefined;
  actualModel?: string | null;
  compact?: boolean;
  className?: string;
}

/** Actual model is evidence from runtime session metadata only. */
export function actualModelFromHistory(
  history: SessionHistory | null | undefined,
): string | null {
  return history?.status === "available" && history.meta.model
    ? history.meta.model
    : null;
}

/**
 * Keeps caller intent and runtime-reported fact visibly separate. Omission is
 * shown as runtime-default intent; it is never promoted into an inferred actual
 * model when session metadata is absent.
 */
export function TaskModelFacts({
  requestedModel,
  actualModel,
  compact = false,
  className,
}: TaskModelFactsProps): React.ReactElement {
  const requestedLabel = requestedModel ?? "运行时默认";
  const differs = Boolean(
    requestedModel && actualModel && requestedModel !== actualModel,
  );

  return (
    <div
      aria-label="任务模型"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground",
        compact ? "leading-tight" : "rounded-md bg-secondary/55 px-3 py-2",
        className,
      )}
    >
      <span>
        请求模型：
        <strong className="font-mono font-semibold text-foreground">
          {requestedLabel}
        </strong>
      </span>
      {actualModel ? (
        <span>
          实际模型：
          <strong className="font-mono font-semibold text-foreground">
            {actualModel}
          </strong>
        </span>
      ) : null}
      {differs ? (
        <span className="basis-full text-warning">
          运行时报告值与请求不同；请求值仍按原样保留。
        </span>
      ) : null}
    </div>
  );
}
