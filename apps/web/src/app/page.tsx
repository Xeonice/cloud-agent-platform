"use client";

import * as React from "react";
import Link from "next/link";
import type { Task } from "@cap/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  statusBadgeVariant,
} from "@cap/ui";
import { listTasks, ApiError } from "@/lib/api-client";

/**
 * `/` — the fleet dashboard (frontend-console spec 13.4).
 *
 * Lists tasks with their status (reflecting at least running / queued(pending) /
 * awaiting-input) and offers an action navigating into each task's
 * `/tasks/[id]` session.
 */

/** Human-readable label for a task status (queued surfaces the `pending` state). */
function statusLabel(status: Task["status"]): string {
  switch (status) {
    case "pending":
      return "queued";
    case "awaiting_input":
      return "awaiting input";
    case "agent_failed_to_start":
      return "failed to start";
    default:
      return status;
  }
}

export default function DashboardPage(): React.ReactElement {
  const [tasks, setTasks] = React.useState<Task[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setError(null);
      setTasks(await listTasks());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Unauthorized — check the operator token (AUTH_TOKEN).");
      } else {
        setError(err instanceof Error ? err.message : "Failed to load tasks.");
      }
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Fleet</h1>
          <p className="text-sm text-muted-foreground">
            All agent sessions and their live status.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
          <Link href="/tasks/new">
            <Button>New task</Button>
          </Link>
        </div>
      </header>

      {error ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      ) : null}

      {tasks === null && !error ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : null}

      {tasks !== null && tasks.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No tasks yet.{" "}
            <Link href="/tasks/new" className="underline">
              Create one
            </Link>
            .
          </CardContent>
        </Card>
      ) : null}

      <ul className="space-y-3">
        {(tasks ?? []).map((task) => (
          <li key={task.id}>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="truncate text-base">
                  {task.prompt}
                </CardTitle>
                <Badge variant={statusBadgeVariant(task.status)}>
                  {statusLabel(task.status)}
                </Badge>
              </CardHeader>
              <CardContent className="flex items-center justify-between pt-0">
                <span className="font-mono text-xs text-muted-foreground">
                  {task.id}
                </span>
                <Link href={`/tasks/${task.id}`}>
                  <Button size="sm" variant="secondary">
                    Open session
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  );
}
