/**
 * `NewTaskDialog` — the dashboard 派发远端 Agent dialog (Track 16, task 16.5;
 * reused by Track 17 later).
 *
 * A two-column shadcn `Dialog` (Radix supplies Esc / backdrop close, focus trap,
 * `aria-modal`, `aria-labelledby`, focus-return — so no manual wiring). LEFT is
 * the create form (repo / branch / strategy selects, a 任务描述 textarea with a
 * live 字数 count, and a default-checked 破坏性写入前停止 gate). RIGHT is a live
 * preview: the 3-step launch review and a `CommandPreview` that re-renders an
 * `agentctl run …` line from the current form state — it ONLY reflects fields the
 * operator has actually entered (it does not present unsent fields as confirmed).
 *
 * Submit calls the SHARED `createTaskMutation` (REAL `POST /repos/:repoId/tasks`)
 * with a `CreateTaskRequest` body composed strictly from the contract (prompt +
 * optional branch/strategy). On success it shows the `TaskResult` (a green
 * "已创建 <runId>" pill + a 进入会话 Link) and persists `selectedRepo` /
 * `selectedBranch`-style state + `latestRunId` to the store, keeping the dialog
 * open so the operator can jump into the session — matching the prototype.
 *
 * SSR-safe: the dialog content mounts only when open (Radix portals on the
 * client); the form state is plain `useState`. No window/clock/random at module
 * scope or during render.
 *
 * Fidelity: dialog 1040px; grid `1fr / minmax(340px,0.76fr)`; left padding 20;
 * preview column soft (#fafafa); review steps ringed (01/02 green, 03 warn);
 * command-preview = dark (#080808) mono block; result = soft-green ringed strip.
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { CreateTaskRequest, Repo } from "@cap/contracts";
import { createTaskMutation } from "@/lib/api/mutations";
import { setState } from "@/lib/store";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";

/** The 3 prototype execution strategies (verbatim copy; the value == the label). */
const STRATEGIES = [
  "先读仓库与 AGENTS.md，再给出计划",
  "只做审计，不写入文件",
  "允许修改代码，但提交前停止",
] as const;

/** One launch-review step (01/02 complete green, 03 write-confirm warn). */
function ReviewStep({
  index,
  title,
  caption,
  warn = false,
}: {
  index: string;
  title: string;
  caption: string;
  warn?: boolean;
}) {
  return (
    <div className="grid grid-cols-[30px_minmax(0,1fr)] items-start gap-2.5 rounded-md bg-card p-[11px] shadow-[inset_0_0_0_1px_var(--border)]">
      <span
        className={cn(
          "row-span-2 grid size-6 place-items-center rounded-full font-mono text-[10px] font-semibold",
          warn ? "bg-[#fff8c5] text-warning" : "bg-[#ecfdf3] text-success",
        )}
      >
        {index}
      </span>
      <strong className="col-start-2 block text-[13px] text-foreground">{title}</strong>
      <small className="col-start-2 mt-[3px] block text-xs leading-[1.45] text-muted-foreground">
        {caption}
      </small>
    </div>
  );
}

/**
 * Build the live `agentctl run` preview lines from the current form state. Only
 * fields the operator has supplied are emitted, so the preview never implies an
 * unsent value. PURE — exported for unit-testing the command composition.
 */
export function buildCommandPreview(input: {
  repoFullName: string | null;
  branch: string | null;
  strategy: string | null;
  prompt: string;
  stopOnWrite: boolean;
}): string[] {
  const lines = ["agentctl run \\"];
  if (input.repoFullName) lines.push(`  --repo ${input.repoFullName} \\`);
  if (input.branch) lines.push(`  --branch ${input.branch} \\`);
  if (input.strategy) lines.push(`  --strategy "${input.strategy}" \\`);
  if (input.stopOnWrite) lines.push("  --confirm-before-write \\");
  const prompt = input.prompt.trim();
  lines.push(prompt ? `  --prompt "${prompt}"` : "  --prompt <待填写>");
  return lines;
}

/** The dark mono command-preview block. */
function CommandPreview({ lines }: { lines: readonly string[] }) {
  return (
    <pre
      data-command-preview
      className="grid max-h-[230px] gap-1.5 overflow-auto rounded-md bg-[#080808] p-3.5 font-mono text-xs leading-[1.6] text-[#e8e8e8]"
    >
      {lines.map((line, i) => (
        <code key={i} className="whitespace-pre">
          {line}
        </code>
      ))}
    </pre>
  );
}

/** The success strip shown after a task is created. */
function TaskResult({ taskId, runLabel }: { taskId: string; runLabel: string }) {
  return (
    <div
      data-task-result
      className="flex items-center justify-between gap-2.5 rounded-md bg-[#f7fbf8] p-2.5 shadow-ring"
    >
      <StatusPill variant="green">
        已创建 <span className="font-mono" data-run-id>{runLabel}</span>
      </StatusPill>
      <Link
        to="/tasks/$taskId"
        params={{ taskId }}
        className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
      >
        进入会话
      </Link>
    </div>
  );
}

export interface NewTaskDialogProps {
  /** Whether the dialog is open (controlled by the page's 新建任务 button). */
  open: boolean;
  /** Open/close callback (wired to Esc / backdrop / cancel). */
  onOpenChange: (open: boolean) => void;
  /** Importable/known repos (the form is restricted to these). */
  repos: readonly Repo[];
}

/** Resolve a repo's display full-name (`owner/name` slug from gitSource, or name). */
function repoFullName(repo: Repo): string {
  const match = repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? repo.name;
}

/** The new-task dialog. */
export function NewTaskDialog({ open, onOpenChange, repos }: NewTaskDialogProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation(createTaskMutation(queryClient));

  const firstRepoId = repos[0]?.id ?? "";
  const [repoId, setRepoId] = React.useState(firstRepoId);

  // Keep the selected repo valid as the repo list resolves/changes.
  React.useEffect(() => {
    const first = repos[0];
    if (first && !repos.some((r) => r.id === repoId)) {
      setRepoId(first.id);
    }
  }, [repos, repoId]);

  const selectedRepo = repos.find((r) => r.id === repoId) ?? null;
  const defaultBranch = selectedRepo?.defaultBranch ?? "main";

  const [branch, setBranch] = React.useState(defaultBranch);
  const [strategy, setStrategy] = React.useState<string>(STRATEGIES[0]);
  const [prompt, setPrompt] = React.useState("");
  const [stopOnWrite, setStopOnWrite] = React.useState(true);
  const [createdTaskId, setCreatedTaskId] = React.useState<string | null>(null);

  // Reset the create + prompt state whenever the dialog (re)opens, so a reopened
  // dialog always starts a FRESH dispatch instead of showing the prior run's
  // success strip / typed prompt. The hook state lives in this always-mounted
  // wrapper (not in the Radix-unmounted content), so it must be cleared on open.
  // `mutation.reset` is reference-stable across renders (TanStack Query v5).
  const resetMutation = mutation.reset;
  React.useEffect(() => {
    if (!open) return;
    setCreatedTaskId(null);
    setPrompt("");
    resetMutation();
  }, [open, resetMutation]);

  // When the selected repo changes, reset the branch to that repo's default.
  React.useEffect(() => {
    setBranch(defaultBranch);
  }, [defaultBranch]);

  const branchOptions = React.useMemo(() => {
    const set = new Set<string>([defaultBranch]);
    return [...set];
  }, [defaultBranch]);

  const charCount = [...prompt.trim()].length;
  const commandLines = buildCommandPreview({
    repoFullName: selectedRepo ? repoFullName(selectedRepo) : null,
    branch: branch || null,
    strategy: strategy || null,
    prompt,
    stopOnWrite,
  });

  const createdTask = mutation.data;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repoId || prompt.trim().length === 0) return;
    const body: CreateTaskRequest = { prompt: prompt.trim() };
    if (branch) body.branch = branch;
    if (strategy) body.strategy = strategy;
    mutation.mutate(
      { repoId, body },
      {
        onSuccess: (task) => {
          setCreatedTaskId(task.id);
          // Persist the operator's last selection + the created run for re-entry.
          setState({ selectedRepo: repoId });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-labelledby="new-task-title"
        onInteractOutside={(event) => {
          // The repo/strategy Select renders its options in a Radix PORTAL
          // OUTSIDE this DialogContent's DOM, so picking an option registers as an
          // "interact outside" and would auto-dismiss the dialog — clearing the
          // form before the create POST ever fires (the gap-4 bug: dialog closed,
          // no POST). Treat clicks landing in the portaled select-content as
          // INSIDE and cancel the dismiss.
          const original = (event.detail as { originalEvent?: Event } | undefined)
            ?.originalEvent;
          const target = (original?.target ?? event.target) as HTMLElement | null;
          if (target?.closest?.('[data-slot="select-content"]')) {
            event.preventDefault();
          }
        }}
        className="sm:max-w-[1040px] gap-0 overflow-hidden rounded-xl p-0 shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_32px_90px_rgba(0,0,0,0.22)]"
      >
        {/* Head */}
        <header className="flex items-start justify-between gap-4 border-b border-border bg-card p-5">
          <div>
            <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              新建任务
            </span>
            <DialogTitle
              id="new-task-title"
              className="mt-1 mb-1.5 text-xl font-semibold tracking-[-0.5px] text-ink"
            >
              派发远端 Agent
            </DialogTitle>
            <DialogDescription className="max-w-[620px] text-[13px] leading-[1.55] text-muted-foreground">
              选择已导入仓库，写清任务意图，创建后从任务行进入实时 CLI。
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label="关闭新建任务"
            onClick={() => onOpenChange(false)}
            className="grid size-8 place-items-center rounded-md bg-transparent text-2xl leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            ×
          </button>
        </header>

        <form
          onSubmit={handleSubmit}
          className="grid gap-[18px] p-5 min-[821px]:grid-cols-[minmax(0,1fr)_minmax(340px,0.76fr)]"
        >
          {/* Left: form */}
          <div className="grid content-start gap-3.5">
            <div className="grid gap-2">
              <label htmlFor="modalRepo" className="text-[13px] font-medium text-foreground">
                仓库
              </label>
              <Select value={repoId} onValueChange={setRepoId}>
                <SelectTrigger id="modalRepo" className="w-full">
                  <SelectValue placeholder="选择仓库" />
                </SelectTrigger>
                <SelectContent>
                  {repos.map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repoFullName(repo)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <small className="text-xs text-muted-foreground">仓库列表来自已导入仓库。</small>
            </div>

            <div className="grid gap-2">
              <label htmlFor="modalBranch" className="text-[13px] font-medium text-foreground">
                分支
              </label>
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger id="modalBranch" className="w-full">
                  <SelectValue placeholder="选择分支" />
                </SelectTrigger>
                <SelectContent>
                  {branchOptions.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <label htmlFor="modalStrategy" className="text-[13px] font-medium text-foreground">
                执行策略
              </label>
              <Select value={strategy} onValueChange={setStrategy}>
                <SelectTrigger id="modalStrategy" className="w-full">
                  <SelectValue placeholder="选择策略" />
                </SelectTrigger>
                <SelectContent>
                  {STRATEGIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <small className="text-xs text-muted-foreground">
                策略会写入派发命令，并影响会话内的停顿点。
              </small>
            </div>

            <div className="grid gap-2">
              <label htmlFor="modalTask" className="text-[13px] font-medium text-foreground">
                任务描述
              </label>
              <Textarea
                id="modalTask"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="清楚描述远端 Agent 需要完成什么。"
                className="min-h-[150px] resize-y"
              />
              <small data-task-count className="text-xs text-muted-foreground">
                {charCount} 字
              </small>
            </div>

            <label className="flex items-start gap-2.5 rounded-md bg-[#fafafa] p-3 shadow-ring">
              <Checkbox
                checked={stopOnWrite}
                onCheckedChange={(v) => setStopOnWrite(v === true)}
                className="mt-[3px]"
              />
              <span>
                <strong className="text-[13px] font-semibold text-foreground">
                  破坏性写入前停止
                </strong>
                <br />
                <small className="text-xs text-muted-foreground">
                  Commit、push、secret 变更和 PR 创建前必须等待操作者确认。
                </small>
              </span>
            </label>
          </div>

          {/* Right: preview */}
          <aside className="grid content-start gap-3.5 rounded-md bg-[#fafafa] p-3.5">
            <div className="grid gap-2">
              <ReviewStep index="01" title="仓库已导入" caption="只使用当前授权范围内的仓库。" />
              <ReviewStep index="02" title="Runner 可接入" caption="创建后进入 iad-02 队列。" />
              <ReviewStep index="03" title="写入前确认" caption="危险动作会在会话中暂停。" warn />
            </div>

            <div>
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <h3 className="text-[15px] font-semibold text-foreground">命令预览</h3>
                <StatusPill variant="dark">agentctl</StatusPill>
              </div>
              <CommandPreview lines={commandLines} />
            </div>

            {createdTask && createdTaskId ? (
              <TaskResult
                taskId={createdTaskId}
                runLabel={`task_${createdTaskId.replace(/-/g, "").slice(0, 4)}`}
              />
            ) : null}

            {mutation.isError ? (
              <p className="text-xs text-danger" role="alert">
                创建失败：{mutation.error.message}
              </p>
            ) : null}

            <div className="flex justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="inline-flex h-9 items-center justify-center rounded-md bg-card px-4 text-sm font-medium text-foreground shadow-ring hover:bg-secondary"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={mutation.isPending || prompt.trim().length === 0}
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
              >
                {mutation.isPending ? "创建中…" : "创建任务"}
              </button>
            </div>
          </aside>
        </form>
      </DialogContent>
    </Dialog>
  );
}
