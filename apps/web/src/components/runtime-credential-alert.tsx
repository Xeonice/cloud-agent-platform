import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleAlert } from "lucide-react";

import type { TaskResponse } from "@cap/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils";

export type RuntimeAuthFailure = NonNullable<TaskResponse["failure"]>;

export interface RuntimeAuthFailurePresentation {
  title: string;
  description: string;
  actionLabel: string;
  credentialRuntime: RuntimeAuthFailure["runtime"];
}

/** User-facing recovery copy for a structured, secret-free runtime auth failure. */
export function runtimeAuthFailurePresentation(
  failure: RuntimeAuthFailure,
): RuntimeAuthFailurePresentation {
  if (failure.runtime === "claude-code") {
    return {
      title:
        failure.code === "runtime_auth_expired"
          ? "Claude Code 凭据已过期"
          : "Claude Code 凭据已失效",
      description:
        "可更新订阅 setup-token 或 Anthropic API Key；本次任务不会自动重试。",
      actionLabel: "更新 Claude Code 凭据",
      credentialRuntime: "claude-code",
    };
  }

  return {
    title:
      failure.code === "runtime_auth_expired"
        ? "Codex 登录已过期"
        : "Codex 登录凭据已失效",
    description:
      "可重新连接 Codex 官方账号或更新兼容提供方凭据；本次任务不会自动重试。",
      actionLabel: "更新 Codex 凭据",
    credentialRuntime: "codex",
  };
}

/** Compact reason badge used beside the existing dispatch/task status badges. */
export function RuntimeAuthFailureBadge({
  failure,
}: {
  failure: RuntimeAuthFailure;
}): React.ReactElement {
  return (
    <Badge variant="destructive">
      {runtimeAuthFailurePresentation(failure).title}
    </Badge>
  );
}

/**
 * Explicit recovery surface shared by task detail and schedule-run history.
 * The API has already classified the failure; this component never parses raw
 * terminal output or guesses from an error message.
 */
export function RuntimeCredentialAlert({
  failure,
  compact = false,
  announce = false,
  contextLabel,
  className,
}: {
  failure: RuntimeAuthFailure | null | undefined;
  compact?: boolean;
  announce?: boolean;
  contextLabel?: string;
  className?: string;
}): React.ReactElement | null {
  if (!failure || failure.action !== "reconnect_runtime") return null;
  const presentation = runtimeAuthFailurePresentation(failure);

  return (
    <section
      role={announce ? "alert" : undefined}
      data-runtime-auth-alert={failure.runtime}
      className={cn(
        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 border-l-4 border-danger bg-danger-soft px-4 py-3 text-sm min-[641px]:grid-cols-[auto_minmax(0,1fr)_auto]",
        compact && "rounded-md border border-danger/25 border-l-4 px-3 py-2.5",
        className,
      )}
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 flex-none text-danger"
      />
      <div className="min-w-0">
        {contextLabel ? (
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {contextLabel}
          </span>
        ) : null}
        <strong className="block font-semibold text-danger">
          {presentation.title}
        </strong>
        <p className="mt-1 break-words leading-relaxed text-foreground/80">
          {failure.message}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {presentation.description}
        </p>
      </div>
      <Button
        asChild
        variant="secondary"
        size="sm"
        className="col-start-2 gap-1.5 min-[641px]:col-start-auto"
      >
        <Link
          to="/settings"
          search={{
            credentialRuntime: presentation.credentialRuntime,
            credentialIssue: failure.code,
          }}
          hash="codex"
        >
          {presentation.actionLabel}
          <ArrowRight className="size-3.5" />
        </Link>
      </Button>
    </section>
  );
}
