/**
 * `NewTaskDialog` — the dashboard 派发远端 Agent dialog (Track 16, task 16.5;
 * reused by Track 17 later).
 *
 * A two-column shadcn `Dialog` (Radix supplies Esc / backdrop close, focus trap,
 * `aria-modal`, `aria-labelledby`, focus-return — so no manual wiring). LEFT is
 * the create form (repo / branch / strategy / Agent 运行时 selects, a 任务描述
 * textarea with a live 字数 count, and a non-interactive 安全边界 advisory note).
 * The runtime selector (`Codex | Claude Code`, default `codex`,
 * add-claude-code-runtime) is gated on a booleans-only readiness read: an
 * unconfigured runtime is shown DISABLED with a configure hint rather than
 * selectable-and-failing. The former 破坏性写入前停止 CHECKBOX is REMOVED — it was
 * unwired at every layer (the agent runs ungated inside the sandbox, the trust
 * boundary), so it falsely implied an enforced per-write gate (design D8). RIGHT
 * is a live preview: the 3-step launch review and a `CommandPreview` that
 * re-renders an `agentctl run …` line — reflecting the selected runtime (claude
 * vs codex) and ONLY the fields the operator has actually entered (it does not
 * present unsent fields as confirmed).
 *
 * Submit calls the SHARED `createTaskMutation` (REAL `POST /repos/:repoId/tasks`)
 * with a `CreateTaskBody` composed strictly from the contract (prompt + optional
 * branch/strategy + optional `runtime`). On success it shows the `TaskResult` (a green
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import type { Repo, SandboxEnvironment } from "@cap/contracts";
import { createTaskMutation } from "@/lib/api/mutations";
import {
  runtimesQuery,
  sandboxEnvironmentsQuery,
  settingsQuery,
} from "@/lib/api/queries";
import type { CreateTaskBody, RuntimeId } from "@/lib/api/real";
import { setState } from "@/lib/store";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import {
  Dialog,
  DialogBody,
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

/**
 * The selectable agent runtimes (add-claude-code-runtime). `id` is the value sent
 * in the create body as `runtime`; DEFAULT is `codex` (omitted ⇒ codex server-side).
 * Each option is gated on a booleans-only readiness read (`runtimesQuery`): an
 * un-ready runtime is shown disabled with a configure hint rather than selectable
 * and failing at launch (frontend-console spec "runtime selector gated on readiness").
 * Exported so `/tasks/new` shares the same catalog (one module, no drift).
 */
export const RUNTIME_CATALOG: ReadonlyArray<{
  id: RuntimeId;
  label: string;
  hint: string;
}> = [
  { id: "codex", label: "Codex", hint: "OpenAI Codex CLI（默认）" },
  { id: "claude-code", label: "Claude Code", hint: "Anthropic Claude Code CLI" },
];

/** The default runtime when the operator makes no explicit choice. */
export const DEFAULT_RUNTIME: RuntimeId = "codex";

/**
 * Selectable preinstall skills (task-preinstall-skills). The `id`s MUST match the
 * server-side skill allowlist (`apps/api/src/sandbox/skill-allowlist.ts`) — the
 * backend only executes allowlisted ids, so an id here that the server does not
 * know is simply ignored at provision time. Exported so `/tasks/new` shares it.
 */
export const SKILL_CATALOG: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: "openspec", label: "OpenSpec", hint: "spec-driven 变更工作流 (/opsx:)" },
  { id: "bmad", label: "BMAD", hint: "Agile AI 开发方法 (agent 人设)" },
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Sentinel Select value for "no guardrail" (Radix Select needs a non-empty value). */
export const GUARDRAIL_OFF = "off";

/**
 * Idle-reclaim presets (console-design-pixel-merge design ladder: 关闭 / 15 分钟 /
 * 30 分钟). DEFAULT is OFF: a task created with no idle timeout is never reclaimed
 * for idleness. `ms: null` is the off choice and submits NO field. Exported so
 * `/tasks/new` shares the same catalog (one module, no drift).
 */
export const IDLE_TIMEOUT_OPTIONS: ReadonlyArray<{ label: string; ms: number | null }> = [
  { label: "关闭（默认，不自动回收）", ms: null },
  { label: "15 分钟", ms: 15 * MINUTE },
  { label: "30 分钟", ms: 30 * MINUTE },
];

/**
 * Wall-clock deadline presets (console-design-pixel-merge design ladder: 无 /
 * 1 小时 / 4 小时). DEFAULT is none. `ms: null` is the none choice and submits NO
 * field. Exported so `/tasks/new` shares the same catalog (one module, no drift).
 */
export const DEADLINE_OPTIONS: ReadonlyArray<{ label: string; ms: number | null }> = [
  { label: "无（默认，不限运行时长）", ms: null },
  { label: "1 小时", ms: HOUR },
  { label: "4 小时", ms: 4 * HOUR },
];

const ENVIRONMENT_DEFAULT = "__default__";
const ENVIRONMENT_SERVER_DEFAULT = "__server_default__";

/** The Select value (string) for a guardrail ms, or the OFF sentinel for null. */
export function guardrailSelectValue(ms: number | null): string {
  return ms == null ? GUARDRAIL_OFF : String(ms);
}

/** Parse a guardrail Select value back to ms, or null for the OFF sentinel. */
export function parseGuardrailSelectValue(value: string): number | null {
  return value === GUARDRAIL_OFF ? null : Number(value);
}

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
 *
 * The preview reflects the SELECTED runtime (add-claude-code-runtime): a
 * `--runtime <id>` line is emitted whenever a non-default runtime is chosen, and
 * the trailing comment names the underlying CLI the sandbox launches (`claude` for
 * Claude Code, `codex` otherwise) so the preview shows the claude-based invocation
 * vs the codex-based one (frontend-console spec). `runtime` defaults to `codex` to
 * stay backward-compatible with existing callers/tests that omit it.
 */
export function buildCommandPreview(input: {
  repoFullName: string | null;
  branch: string | null;
  strategy: string | null;
  prompt: string;
  stopOnWrite: boolean;
  skills?: readonly string[];
  idleTimeoutMs?: number | null;
  deadlineMs?: number | null;
  runtime?: RuntimeId;
  sandboxEnvironmentName?: string | null;
}): string[] {
  const runtime = input.runtime ?? DEFAULT_RUNTIME;
  // Lead with a comment naming the underlying CLI the sandbox launches for the
  // chosen runtime, so the preview unambiguously shows the claude-based vs
  // codex-based invocation (frontend-console spec) without an awkward trailing
  // continuation. The codex case keeps the same `codex`-based framing as before.
  const lines = [
    runtime === "claude-code"
      ? "# 沙箱内启动 claude"
      : "# 沙箱内启动 codex",
    "agentctl run \\",
  ];
  if (input.repoFullName) lines.push(`  --repo ${input.repoFullName} \\`);
  if (input.branch) lines.push(`  --branch ${input.branch} \\`);
  // Reflect the selected runtime. Emit the flag only for the NON-default runtime
  // so the codex path's flag list stays as it was (no implied flag the operator
  // never chose); claude-code surfaces the `--runtime claude-code` line so the
  // operator sees the claude invocation that will launch.
  if (runtime !== DEFAULT_RUNTIME) lines.push(`  --runtime ${runtime} \\`);
  if (input.sandboxEnvironmentName) {
    lines.push(`  --sandbox-environment "${input.sandboxEnvironmentName}" \\`);
  }
  if (input.strategy) lines.push(`  --strategy "${input.strategy}" \\`);
  if (input.skills && input.skills.length > 0)
    lines.push(`  --skills ${input.skills.join(",")} \\`);
  // Guardrails are opt-in: only emit a line when the operator chose a value
  // (flag names mirror the contract fields idleTimeoutMs/deadlineMs — honest, no
  // implied default).
  if (input.idleTimeoutMs != null)
    lines.push(`  --idle-timeout-ms ${input.idleTimeoutMs} \\`);
  if (input.deadlineMs != null) lines.push(`  --deadline-ms ${input.deadlineMs} \\`);
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
      className="flex max-h-[230px] min-w-0 flex-col gap-1.5 overflow-auto rounded-md bg-[#080808] p-3.5 font-mono text-xs leading-[1.6] text-[#e8e8e8]"
    >
      {lines.map((line, i) => (
        // `whitespace-pre-wrap` keeps the command indentation but WRAPS long
        // content (a long --prompt) inside the box; `overflow-wrap:anywhere`
        // breaks an unbroken token so the line can never force the preview wider
        // than its column (which previously broke the whole new-task layout).
        <code key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
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

export function environmentCompatibleWithRuntime(
  environment: SandboxEnvironment,
  runtime: RuntimeId,
): boolean {
  const runtimeIds = environment.compatibility.runtimeIds;
  return (
    environment.status === "ready" &&
    (!runtimeIds || runtimeIds.length === 0 || runtimeIds.includes(runtime))
  );
}

/** The new-task dialog. */
export function NewTaskDialog({ open, onOpenChange, repos }: NewTaskDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation(createTaskMutation(queryClient));

  // Per-runtime readiness (add-claude-code-runtime). Booleans only — never a
  // secret. While the read is in flight `data` is undefined; we treat an UNKNOWN
  // runtime as NOT ready so the selector never offers a runtime the api has not
  // vouched for (the default `codex` is corrected back if it ever reports un-ready).
  const runtimesReadiness = useQuery(runtimesQuery());
  const sandboxEnvironments = useQuery(sandboxEnvironmentsQuery());
  const settings = useQuery(settingsQuery());
  const readyById = React.useMemo(() => {
    const map = new Map<RuntimeId, boolean>();
    for (const r of runtimesReadiness.data ?? []) map.set(r.id, r.ready);
    return map;
  }, [runtimesReadiness.data]);
  const isRuntimeReady = (id: RuntimeId): boolean => readyById.get(id) === true;

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
  const [skills, setSkills] = React.useState<string[]>([]);
  const [prompt, setPrompt] = React.useState("");
  // Agent runtime selection (add-claude-code-runtime), DEFAULT codex. Gated on the
  // readiness read below so an unconfigured runtime can't be selected.
  const [runtime, setRuntime] = React.useState<RuntimeId>(DEFAULT_RUNTIME);
  const [sandboxEnvironmentId, setSandboxEnvironmentId] =
    React.useState(ENVIRONMENT_DEFAULT);
  // stopOnWrite is RETAINED as a preview-only/advisory note, never an enforced
  // gate: the control is unwired at every layer for both runtimes (the agent runs
  // ungated inside the sandbox, which is the trust boundary) — see design D8. It
  // is force-off so it never emits the misleading `--confirm-before-write` line.
  const stopOnWrite = false;
  // Guardrails are OPT-IN, default off/none (task-guardrail-controls).
  const [idleTimeoutMs, setIdleTimeoutMs] = React.useState<number | null>(null);
  const [deadlineMs, setDeadlineMs] = React.useState<number | null>(null);
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
    setSkills([]);
    setRuntime(DEFAULT_RUNTIME);
    setSandboxEnvironmentId(ENVIRONMENT_DEFAULT);
    setIdleTimeoutMs(null);
    setDeadlineMs(null);
    resetMutation();
  }, [open, resetMutation]);

  // Keep the selection on a READY runtime: if the currently-selected runtime
  // reports un-ready once readiness resolves (e.g. the Claude token was removed),
  // fall back to the first ready runtime so the form can never submit a runtime
  // the api would fail-closed. Runs only after readiness data is present.
  React.useEffect(() => {
    if (runtimesReadiness.data === undefined) return;
    if (isRuntimeReady(runtime)) return;
    const fallback = RUNTIME_CATALOG.find((r) => isRuntimeReady(r.id));
    if (fallback && fallback.id !== runtime) setRuntime(fallback.id);
    // isRuntimeReady is derived from readyById, itself memoized on
    // runtimesReadiness.data, so depending on the data + runtime is sufficient.
  }, [runtimesReadiness.data, runtime]);

  const readyEnvironments = React.useMemo(
    () =>
      (sandboxEnvironments.data?.environments ?? []).filter((environment) =>
        environmentCompatibleWithRuntime(environment, runtime),
      ),
    [sandboxEnvironments.data?.environments, runtime],
  );
  const selectedEnvironment =
    readyEnvironments.find((environment) => environment.id === sandboxEnvironmentId) ??
    null;
  const accountDefaultEnvironmentId =
    settings.data?.defaultSandboxEnvironmentId ?? null;
  const accountDefaultEnvironment =
    accountDefaultEnvironmentId === null
      ? null
      : readyEnvironments.find(
          (environment) => environment.id === accountDefaultEnvironmentId,
        ) ?? null;
  const accountDefaultUnavailable =
    sandboxEnvironmentId === ENVIRONMENT_DEFAULT &&
    accountDefaultEnvironmentId !== null &&
    sandboxEnvironments.isSuccess &&
    !accountDefaultEnvironment;
  const previewEnvironment =
    selectedEnvironment ??
    (sandboxEnvironmentId === ENVIRONMENT_DEFAULT
      ? accountDefaultEnvironment
      : null);

  React.useEffect(() => {
    if (
      sandboxEnvironmentId === ENVIRONMENT_DEFAULT ||
      sandboxEnvironmentId === ENVIRONMENT_SERVER_DEFAULT
    ) {
      return;
    }
    if (readyEnvironments.some((environment) => environment.id === sandboxEnvironmentId)) {
      return;
    }
    setSandboxEnvironmentId(ENVIRONMENT_DEFAULT);
  }, [readyEnvironments, sandboxEnvironmentId]);

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
    skills,
    idleTimeoutMs,
    deadlineMs,
    runtime,
    sandboxEnvironmentName: previewEnvironment?.name ?? null,
  });

  const createdTask = mutation.data;

  function toggleSkill(id: string) {
    setSkills((cur) =>
      cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id],
    );
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repoId || prompt.trim().length === 0) return;
    // Don't submit a runtime the readiness read says is not configured — the api
    // would fail-closed; the UI already disables the option, this is the guard.
    if (!isRuntimeReady(runtime)) return;
    const body: CreateTaskBody = { prompt: prompt.trim() };
    if (branch) body.branch = branch;
    if (strategy) body.strategy = strategy;
    if (skills.length > 0) body.skills = skills;
    // Carry the selected runtime. Sent only when it diverges from the server
    // default (`codex`) so the codex create body is byte-identical to before; a
    // claude-code selection adds `runtime: "claude-code"`.
    if (runtime !== DEFAULT_RUNTIME) body.runtime = runtime;
    if (selectedEnvironment) body.sandboxEnvironmentId = selectedEnvironment.id;
    if (sandboxEnvironmentId === ENVIRONMENT_SERVER_DEFAULT) {
      body.sandboxEnvironmentId = null;
    }
    if (accountDefaultUnavailable) return;
    // Opt-in guardrails: only send when the operator chose a value.
    if (idleTimeoutMs != null) body.idleTimeoutMs = idleTimeoutMs;
    if (deadlineMs != null) body.deadlineMs = deadlineMs;
    mutation.mutate(
      { repoId, body },
      {
        onSuccess: (task) => {
          setCreatedTaskId(task.id);
          // Persist the operator's last selection + the created run for re-entry.
          setState({ selectedRepo: repoId });
          // Navigate straight into the created task's session instead of making
          // the operator click the "进入会话" link. CLOSE the dialog FIRST: a Radix
          // modal still `open` traps focus + overlays the route, which swallowed
          // the navigation (task landed but the URL stayed on /dashboard). Closing
          // it unmounts the modal layer so the navigate actually takes effect; the
          // session page shows a friendly pre-running state until the sandbox is up.
          onOpenChange(false);
          void navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
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
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_32px_90px_rgba(0,0,0,0.22)] sm:max-w-[1040px]"
      >
        {/* Head */}
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-card p-5">
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

        <DialogBody>
        <form
          id="new-task-form"
          onSubmit={handleSubmit}
          className="grid items-start gap-[18px] p-5 min-[821px]:grid-cols-[minmax(0,1fr)_minmax(340px,0.76fr)]"
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
              <label htmlFor="modalRuntime" className="text-[13px] font-medium text-foreground">
                Agent 运行时
              </label>
              <Select
                value={runtime}
                onValueChange={(v) => setRuntime(v as RuntimeId)}
              >
                <SelectTrigger id="modalRuntime" className="w-full">
                  <SelectValue placeholder="选择运行时" />
                </SelectTrigger>
                <SelectContent>
                  {RUNTIME_CATALOG.map((rt) => {
                    const ready = isRuntimeReady(rt.id);
                    return (
                      <SelectItem
                        key={rt.id}
                        value={rt.id}
                        disabled={!ready}
                        data-runtime-option={rt.id}
                        data-runtime-ready={ready ? "true" : "false"}
                      >
                        {rt.label}
                        <small className="ml-1.5 text-xs text-muted-foreground">
                          {ready ? rt.hint : "未配置凭据，去设置中连接后可用"}
                        </small>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <small className="text-xs text-muted-foreground">
                选择执行本任务的 Agent CLI；未配置凭据的运行时不可选。
              </small>
            </div>

            <div className="grid gap-2">
              <label htmlFor="modalEnvironment" className="text-[13px] font-medium text-foreground">
                沙箱运行环境
              </label>
              <Select
                value={sandboxEnvironmentId}
                onValueChange={setSandboxEnvironmentId}
              >
                <SelectTrigger id="modalEnvironment" className="w-full">
                  <SelectValue placeholder="使用默认环境" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ENVIRONMENT_DEFAULT}>
                    使用我的默认镜像
                    <small className="ml-1.5 text-xs text-muted-foreground">
                      未设置时沿用服务端默认
                    </small>
                  </SelectItem>
                  <SelectItem value={ENVIRONMENT_SERVER_DEFAULT}>
                    使用服务端默认
                    <small className="ml-1.5 text-xs text-muted-foreground">
                      本次任务不跟随账号默认
                    </small>
                  </SelectItem>
                  {readyEnvironments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {environment.name}
                      <small className="ml-1.5 text-xs text-muted-foreground">
                        {environment.source.kind}
                      </small>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <small className="text-xs text-muted-foreground">
                {accountDefaultUnavailable
                  ? "当前账号默认镜像不兼容此运行时，请选择其他镜像或服务端默认。"
                  : accountDefaultEnvironment
                    ? `当前账号默认：${accountDefaultEnvironment.name}`
                    : "未设置账号默认时，会沿用服务端部署默认。"}
              </small>
            </div>

            <div className="grid gap-2">
              <span className="text-[13px] font-medium text-foreground">
                预装技能（可选）
              </span>
              <div className="grid gap-2">
                {SKILL_CATALOG.map((sk) => (
                  <label
                    key={sk.id}
                    htmlFor={`modalSkill-${sk.id}`}
                    className="flex items-start gap-2.5 text-[13px] text-foreground"
                  >
                    <Checkbox
                      id={`modalSkill-${sk.id}`}
                      checked={skills.includes(sk.id)}
                      onCheckedChange={() => toggleSkill(sk.id)}
                    />
                    <span>
                      {sk.label}
                      <small className="ml-1.5 text-xs text-muted-foreground">
                        {sk.hint}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <small className="text-xs text-muted-foreground">
                选中的技能会在沙箱创建时预装进工作区，codex 启动即可用。
              </small>
            </div>

            <div className="grid gap-2 min-[821px]:grid-cols-2">
              <div className="grid gap-2">
                <label htmlFor="modalIdle" className="text-[13px] font-medium text-foreground">
                  空闲自动回收
                </label>
                <Select
                  value={guardrailSelectValue(idleTimeoutMs)}
                  onValueChange={(v) => setIdleTimeoutMs(parseGuardrailSelectValue(v))}
                >
                  <SelectTrigger id="modalIdle" className="w-full">
                    <SelectValue placeholder="关闭" />
                  </SelectTrigger>
                  <SelectContent>
                    {IDLE_TIMEOUT_OPTIONS.map((o) => (
                      <SelectItem key={o.label} value={guardrailSelectValue(o.ms)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <label htmlFor="modalDeadline" className="text-[13px] font-medium text-foreground">
                  运行时限
                </label>
                <Select
                  value={guardrailSelectValue(deadlineMs)}
                  onValueChange={(v) => setDeadlineMs(parseGuardrailSelectValue(v))}
                >
                  <SelectTrigger id="modalDeadline" className="w-full">
                    <SelectValue placeholder="无" />
                  </SelectTrigger>
                  <SelectContent>
                    {DEADLINE_OPTIONS.map((o) => (
                      <SelectItem key={o.label} value={guardrailSelectValue(o.ms)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <small className="text-xs text-muted-foreground min-[821px]:col-span-2">
                默认不回收、不限时；仅在此选择后，任务空闲 / 超时才会被自动结束。运行中可随时手动停止。
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

            {/* Advisory note (add-claude-code-runtime task 6.4 / design D8). The
                interactive "破坏性写入前停止" CHECKBOX is REMOVED: it was unwired at
                every layer for both runtimes (the agent runs ungated inside the
                sandbox, which is the trust boundary), so presenting it as a toggle
                falsely implied an enforced per-write gate. This non-interactive note
                states the real safety boundary honestly instead. */}
            <div
              data-safety-note
              className="flex items-start gap-2.5 rounded-md bg-[#fafafa] p-3 shadow-ring"
            >
              <span>
                <strong className="text-[13px] font-semibold text-foreground">
                  安全边界：沙箱即信任边界
                </strong>
                <br />
                <small className="text-xs text-muted-foreground">
                  Agent 在隔离沙箱内自主执行（含 commit / push 等写操作），平台不在单次写入前逐项拦截。
                  如需中止，可在会话中随时手动停止任务。
                </small>
              </span>
            </div>
          </div>

          {/* Right: preview */}
          <aside className="grid min-w-0 content-start gap-3.5 rounded-md bg-[#fafafa] p-3.5">
            <div className="grid gap-2">
              <ReviewStep index="01" title="仓库已导入" caption="只使用当前授权范围内的仓库。" />
              <ReviewStep index="02" title="Runner 可接入" caption="创建后进入 iad-02 队列。" />
              {/* 03 no longer claims a write-confirm gate (task 6.4 / design D8):
                  writes are not intercepted; the sandbox is the trust boundary. */}
              <ReviewStep
                index="03"
                title="沙箱隔离"
                caption="Agent 在隔离沙箱内自主执行，可随时手动停止。"
              />
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

          </aside>
        </form>
        </DialogBody>

        {/* Pinned footer action area — buttons live OUTSIDE the scrolling body so
            they stay reachable at any scroll position; the submit button binds to
            the form via the `form` attribute since it is no longer a descendant. */}
        <footer className="flex shrink-0 justify-end gap-2.5 border-t border-border p-5">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 items-center justify-center rounded-md bg-card px-4 text-sm font-medium text-foreground shadow-ring hover:bg-secondary"
          >
            取消
          </button>
          <button
            type="submit"
            form="new-task-form"
            disabled={
              mutation.isPending ||
              prompt.trim().length === 0 ||
              accountDefaultUnavailable
            }
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {mutation.isPending ? "创建中…" : "创建任务"}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
