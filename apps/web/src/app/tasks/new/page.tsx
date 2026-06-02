"use client";

import * as React from "react";
import Link from "next/link";
import type { Repo, Task } from "@cap/contracts";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@cap/ui";
import { listRepos, createTask, ApiError } from "@/lib/api-client";

/**
 * `/tasks/new` — new-task creation (frontend-console spec 13.5).
 *
 * Selects a registered repo + branch and a prompt/strategy, then POSTs to the
 * tasks REST API (`POST /repos/:repoId/tasks`) via the authenticated central
 * client. On success it surfaces the created task and a link into its session.
 */
export default function NewTaskPage(): React.ReactElement {
  const [repos, setRepos] = React.useState<Repo[]>([]);
  const [repoId, setRepoId] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [strategy, setStrategy] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<Task | null>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        const loaded = await listRepos();
        setRepos(loaded);
        if (loaded[0]) setRepoId(loaded[0].id);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load repos.",
        );
      }
    })();
  }, []);

  const onSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!repoId || prompt.trim().length === 0) {
        setError("Select a repo and enter a prompt.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const task = await createTask(repoId, {
          prompt: prompt.trim(),
          branch: branch.trim() || undefined,
          strategy: strategy.trim() || undefined,
        });
        setCreated(task);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setError("Selected repo no longer exists.");
        } else if (err instanceof ApiError && err.status === 401) {
          setError("Unauthorized — check the operator token (AUTH_TOKEN).");
        } else {
          setError(
            err instanceof Error ? err.message : "Failed to create task.",
          );
        }
      } finally {
        setSubmitting(false);
      }
    },
    [repoId, prompt, branch, strategy],
  );

  if (created) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Task created</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Created task{" "}
              <span className="font-mono text-foreground">{created.id}</span>{" "}
              with status{" "}
              <span className="font-medium text-foreground">
                {created.status}
              </span>
              .
            </p>
            <div className="flex gap-2">
              <Link href={`/tasks/${created.id}`}>
                <Button>Open session</Button>
              </Link>
              <Link href="/">
                <Button variant="outline">Back to fleet</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>New task</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Repository</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
              >
                {repos.length === 0 ? (
                  <option value="">No repos registered</option>
                ) : null}
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Branch (optional)</span>
              <input
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Strategy (optional)</span>
              <input
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
                placeholder="default"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Prompt</span>
              <textarea
                className="min-h-24 w-full rounded-md border border-input bg-background p-3 text-sm"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe what the agent should do…"
              />
            </label>

            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}

            <div className="flex gap-2">
              <Button type="submit" disabled={submitting || !repoId}>
                {submitting ? "Creating…" : "Create task"}
              </Button>
              <Link href="/">
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
