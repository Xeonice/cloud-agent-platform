/**
 * Official Codex subscription connection through CAP's asynchronous device-login
 * session. The browser stays in this dialog while CAP prepares the pinned Codex
 * App Server worker; only a fresh operator click opens the returned OpenAI URL.
 */
import * as React from "react";

import type {
  CodexDeviceLoginSessionId,
  CodexDeviceLoginStartResponse,
  CodexDeviceLoginStatus,
} from "@cap/contracts";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusPill } from "@/components/status-pill";
import {
  startCodexDeviceLogin,
  pollCodexDeviceLogin,
  cancelCodexDeviceLogin,
} from "@/lib/api/real";
import { copyText, type CopyTextResult } from "@/lib/copy-text";

const POLL_INTERVAL_MS = 3_000;

type PollDeviceLogin = (
  sessionId: CodexDeviceLoginSessionId,
  signal: AbortSignal,
) => Promise<CodexDeviceLoginStatus>;

type WaitForNextPoll = (signal: AbortSignal) => Promise<void>;

export type DeviceCodeCopyOutcome = "copied" | "manual";

function isTerminalStatus(status: CodexDeviceLoginStatus["status"]): boolean {
  return (
    status === "connected" ||
    status === "cancelled" ||
    status === "expired" ||
    status === "error"
  );
}

/**
 * Small generation guard shared by start, polling, close, retry, and unmount.
 * It keeps late promises from mutating a dismissed or superseded dialog.
 */
export class CodexDeviceLoginAttemptTracker {
  private generation = 0;
  private sessionId: CodexDeviceLoginSessionId | null = null;

  begin(): number {
    this.generation += 1;
    this.sessionId = null;
    return this.generation;
  }

  adopt(
    generation: number,
    sessionId: CodexDeviceLoginSessionId,
  ): boolean {
    if (generation !== this.generation) return false;
    this.sessionId = sessionId;
    return true;
  }

  isCurrent(
    generation: number,
    sessionId: CodexDeviceLoginSessionId,
  ): boolean {
    return generation === this.generation && sessionId === this.sessionId;
  }

  isGenerationCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  finish(
    generation: number,
    sessionId: CodexDeviceLoginSessionId,
  ): void {
    if (this.isCurrent(generation, sessionId)) this.sessionId = null;
  }

  invalidate(): CodexDeviceLoginSessionId | null {
    this.generation += 1;
    const sessionId = this.sessionId;
    this.sessionId = null;
    return sessionId;
  }
}

/** Adopt the POST result, or route its exact id to stale-attempt cleanup. */
export function adoptStartedDeviceLoginSession(
  tracker: CodexDeviceLoginAttemptTracker,
  generation: number,
  started: CodexDeviceLoginStartResponse,
  cancelStaleSession: (sessionId: CodexDeviceLoginSessionId) => void,
): boolean {
  if (tracker.adopt(generation, started.sessionId)) return true;
  cancelStaleSession(started.sessionId);
  return false;
}

function waitForPollInterval(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    timeout = setTimeout(finish, POLL_INTERVAL_MS);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Serialized recursive polling. The next GET never begins until the previous
 * GET and its delay have finished, and abort ends both an in-flight fetch and
 * the delay without publishing another status.
 */
export async function pollCodexDeviceLoginSession(options: {
  sessionId: CodexDeviceLoginSessionId;
  signal: AbortSignal;
  onStatus: (status: CodexDeviceLoginStatus) => void;
  poll?: PollDeviceLogin;
  wait?: WaitForNextPoll;
  onTransientError?: (error: unknown) => void;
}): Promise<void> {
  const poll = options.poll ?? pollCodexDeviceLogin;
  const wait = options.wait ?? waitForPollInterval;

  while (!options.signal.aborted) {
    try {
      const status = await poll(options.sessionId, options.signal);
      if (options.signal.aborted) return;

      options.onStatus(status);
      if (isTerminalStatus(status.status)) return;
    } catch (error) {
      if (options.signal.aborted) return;
      options.onTransientError?.(error);
    }

    if (options.signal.aborted) return;
    await wait(options.signal);
  }
}

/** Focus and select the rendered code so the operator can use a keyboard copy. */
export function selectVisibleDeviceCode(element: HTMLElement | null): boolean {
  if (!element) return false;

  try {
    element.focus({ preventScroll: true });
  } catch {
    try {
      element.focus();
    } catch {
      return false;
    }
  }

  try {
    const documentRef = element.ownerDocument;
    const selection = documentRef.defaultView?.getSelection();
    if (!selection) return false;

    const range = documentRef.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}

/** Copy adapter used by the component and unit tests for all three outcomes. */
export async function copyDeviceCode(
  code: string,
  element: HTMLElement | null,
  copier: (text: string) => Promise<CopyTextResult> = copyText,
): Promise<DeviceCodeCopyOutcome> {
  try {
    const result = await copier(code);
    if (result.ok) return "copied";
  } catch {
    // A future copier implementation must still fall back to manual selection.
  }

  selectVisibleDeviceCode(element);
  return "manual";
}

/** One credential-scope row (label and value). */
function ScopeRow({
  label,
  value,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(110px,0.42fr)_minmax(0,1fr)] items-center gap-3 rounded-md bg-[#fafafa] p-3 shadow-[inset_0_0_0_1px_var(--border)] max-[560px]:grid-cols-1 max-[560px]:gap-1">
      <span className="font-mono text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <strong className="text-[13px] font-semibold text-foreground">
        {value}
      </strong>
    </div>
  );
}

export interface CodexDeviceLoginStatusContentProps {
  startPending: boolean;
  status: CodexDeviceLoginStatus | null;
  localError: string;
  copied: boolean;
  manualCopy: boolean;
  codeRef: React.RefObject<HTMLElement | null>;
  onCopy: () => void;
}

/** Pure status rendering, kept separate so every server state is testable. */
export function CodexDeviceLoginStatusContent({
  startPending,
  status,
  localError,
  copied,
  manualCopy,
  codeRef,
  onCopy,
}: CodexDeviceLoginStatusContentProps) {
  if (localError) {
    return (
      <p className="text-[13px] leading-[1.55] text-[var(--destructive)]">
        {localError}
      </p>
    );
  }

  if (startPending || status?.status === "preparing") {
    return (
      <div
        role="status"
        className="grid gap-2 rounded-md bg-[#fafafa] p-3.5 text-[13px] text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
      >
        <strong>正在准备设备码…</strong>
        <span className="text-muted-foreground">
          CAP 正在启动临时 Codex 登录进程，此阶段无需打开新页面。
        </span>
      </div>
    );
  }

  if (status?.status === "awaiting_authorization") {
    return (
      <div className="grid gap-2.5 rounded-md bg-[#fafafa] p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
        <p className="text-[13px] leading-[1.55] text-foreground">
          设备码已准备好。复制下方一次性码，再通过明确的授权操作前往
          OpenAI。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code
            ref={codeRef}
            tabIndex={-1}
            data-device-code
            className="select-all rounded-md bg-background px-3 py-2 font-mono text-[18px] font-bold tracking-[2px] text-ink shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:ring-2 focus:ring-ring"
          >
            {status.userCode}
          </code>
          <button
            type="button"
            onClick={onCopy}
            disabled={!status.userCode}
            className="inline-flex min-h-8 items-center rounded-md bg-secondary px-2.5 text-[12px] font-medium text-foreground shadow-ring hover:bg-secondary/80 disabled:opacity-60"
          >
            {copied ? "已复制" : "复制设备码"}
          </button>
        </div>
        {manualCopy ? (
          <p role="alert" className="text-[12px] text-[var(--warning)]">
            浏览器未能自动复制，设备码已选中，请按 Ctrl+C / Command+C。
          </p>
        ) : null}
        <div className="grid gap-1 rounded-md bg-background p-2.5 shadow-ring">
          <span className="font-mono text-[11px] text-muted-foreground">
            OpenAI 授权地址
          </span>
          <span className="break-all text-[12px] text-foreground">
            {status.verificationUri}
          </span>
        </div>
        <a
          href={status.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          className="inline-flex min-h-9 w-fit items-center justify-center rounded-md bg-ink px-3.5 text-[13px] font-medium text-background hover:bg-ink/90"
        >
          前往 OpenAI 授权
        </a>
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--success)]" />
          授权完成后会自动连接；有效期以当前 CAP 登录会话为准。
        </p>
      </div>
    );
  }

  if (status?.status === "finalizing") {
    return (
      <p role="status" className="text-[13px] leading-[1.55] text-foreground">
        授权已完成，正在验证并加密保存登录态…
      </p>
    );
  }

  if (status?.status === "connected") {
    return (
      <p className="text-[13px] font-medium text-[var(--success)]">
        ✓ 已连接官方账号，登录态已加密存储。
      </p>
    );
  }

  if (status?.status === "cancelled") {
    return (
      <p className="text-[13px] leading-[1.55] text-muted-foreground">
        本次登录已取消，可以重新发起连接。
      </p>
    );
  }

  if (status?.status === "expired" || status?.status === "error") {
    return (
      <p className="text-[13px] leading-[1.55] text-[var(--destructive)]">
        {status.message}
      </p>
    );
  }

  return null;
}

export interface CodexDirectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connected: boolean;
  login: string;
  capable: boolean;
  onConnected: () => void;
}

/** The official-account device-code connect dialog. */
export function CodexDirectDialog({
  open,
  onOpenChange,
  connected,
  login,
  capable,
  onConnected,
}: CodexDirectDialogProps) {
  const [startPending, setStartPending] = React.useState(false);
  const [status, setStatus] = React.useState<CodexDeviceLoginStatus | null>(null);
  const [localError, setLocalError] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [manualCopy, setManualCopy] = React.useState(false);

  const codeRef = React.useRef<HTMLElement>(null);
  const pollAbortRef = React.useRef<AbortController | null>(null);
  const copyFeedbackRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation-scoped rather than boolean: closing while POST is in flight
  // releases the UI for a fresh attempt, while the stale POST's finally block
  // cannot unlock a newer request.
  const startingGenerationRef = React.useRef<number | null>(null);
  const statusRef = React.useRef<CodexDeviceLoginStatus | null>(status);
  statusRef.current = status;
  const onConnectedRef = React.useRef(onConnected);
  onConnectedRef.current = onConnected;
  const trackerRef = React.useRef<CodexDeviceLoginAttemptTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new CodexDeviceLoginAttemptTracker();
  }
  const tracker = trackerRef.current;

  const clearCopyFeedback = React.useCallback(() => {
    if (copyFeedbackRef.current) {
      clearTimeout(copyFeedbackRef.current);
      copyFeedbackRef.current = null;
    }
  }, []);

  const abortPolling = React.useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
  }, []);

  const resetView = React.useCallback(() => {
    clearCopyFeedback();
    statusRef.current = null;
    setStartPending(false);
    setStatus(null);
    setLocalError("");
    setCopied(false);
    setManualCopy(false);
  }, [clearCopyFeedback]);

  const cancelCurrentAttempt = React.useCallback(() => {
    abortPolling();
    startingGenerationRef.current = null;
    const sessionId = tracker.invalidate();
    if (sessionId) {
      void cancelCodexDeviceLogin(sessionId).catch(() => undefined);
    }
  }, [abortPolling, tracker]);

  const dismissAttempt = React.useCallback(() => {
    cancelCurrentAttempt();
    resetView();
  }, [cancelCurrentAttempt, resetView]);

  React.useEffect(() => {
    if (!open) dismissAttempt();
  }, [open, dismissAttempt]);

  React.useEffect(
    () => () => {
      cancelCurrentAttempt();
      clearCopyFeedback();
    },
    [cancelCurrentAttempt, clearCopyFeedback],
  );

  const beginPolling = React.useCallback(
    (generation: number, sessionId: CodexDeviceLoginSessionId) => {
      abortPolling();
      const controller = new AbortController();
      pollAbortRef.current = controller;

      void pollCodexDeviceLoginSession({
        sessionId,
        signal: controller.signal,
        onStatus: (next) => {
          if (!tracker.isCurrent(generation, sessionId)) return;

          const previous = statusRef.current;
          statusRef.current = next;
          setStatus(next);
          setLocalError("");
          setStartPending(false);

          if (
            next.status !== "awaiting_authorization" ||
            previous?.status !== "awaiting_authorization" ||
            previous.userCode !== next.userCode
          ) {
            clearCopyFeedback();
            setCopied(false);
            setManualCopy(false);
          }

          if (isTerminalStatus(next.status)) {
            tracker.finish(generation, sessionId);
            if (next.status === "connected") onConnectedRef.current();
          }
        },
      }).finally(() => {
        if (pollAbortRef.current === controller) pollAbortRef.current = null;
      });
    },
    [abortPolling, clearCopyFeedback, tracker],
  );

  const startConnect = React.useCallback(async () => {
    if (startingGenerationRef.current !== null) return;
    if (!capable) {
      setLocalError("设备登录需要已部署的后端（当前为本地模拟模式）。");
      return;
    }

    abortPolling();
    clearCopyFeedback();
    const generation = tracker.begin();
    startingGenerationRef.current = generation;
    statusRef.current = null;
    setStatus(null);
    setStartPending(true);
    setLocalError("");
    setCopied(false);
    setManualCopy(false);

    try {
      const started: CodexDeviceLoginStartResponse =
        await startCodexDeviceLogin();
      if (
        !adoptStartedDeviceLoginSession(
          tracker,
          generation,
          started,
          (sessionId) => {
            void cancelCodexDeviceLogin(sessionId).catch(() => undefined);
          },
        )
      ) {
        return;
      }

      statusRef.current = started;
      setStatus(started);
      setStartPending(false);
      beginPolling(generation, started.sessionId);
    } catch (error) {
      if (!tracker.isGenerationCurrent(generation)) return;

      const sessionId = tracker.invalidate();
      if (sessionId) {
        void cancelCodexDeviceLogin(sessionId).catch(() => undefined);
      }
      statusRef.current = null;
      setStatus(null);
      setStartPending(false);
      setLocalError(
        error instanceof Error
          ? error.message
          : "无法发起设备登录，请稍后重试。",
      );
    } finally {
      if (startingGenerationRef.current === generation) {
        startingGenerationRef.current = null;
      }
    }
  }, [capable, abortPolling, beginPolling, clearCopyFeedback, tracker]);

  const copyCode = React.useCallback(async () => {
    const current = statusRef.current;
    if (current?.status !== "awaiting_authorization") return;

    const outcome = await copyDeviceCode(current.userCode, codeRef.current);
    const latest = statusRef.current;
    if (
      latest?.status !== "awaiting_authorization" ||
      latest.sessionId !== current.sessionId ||
      latest.userCode !== current.userCode
    ) {
      return;
    }

    clearCopyFeedback();
    if (outcome === "copied") {
      setCopied(true);
      setManualCopy(false);
      copyFeedbackRef.current = setTimeout(() => {
        setCopied(false);
        copyFeedbackRef.current = null;
      }, 1_500);
      return;
    }

    setCopied(false);
    setManualCopy(true);
  }, [clearCopyFeedback]);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) dismissAttempt();
      onOpenChange(nextOpen);
    },
    [dismissAttempt, onOpenChange],
  );

  const phase = startPending ? "preparing" : (status?.status ?? "idle");
  const busy =
    phase === "preparing" ||
    phase === "awaiting_authorization" ||
    phase === "finalizing";
  const retryable =
    Boolean(localError) ||
    phase === "cancelled" ||
    phase === "expired" ||
    phase === "error";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-modal sm:max-w-[720px]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 p-[22px_22px_14px]">
          <div className="min-w-0">
            <span className="font-mono text-[11px] font-medium text-muted-foreground">
              官方账号
            </span>
            <DialogTitle className="mt-1 mb-1.5 text-[22px] font-semibold tracking-[-0.8px] text-ink">
              连接官方 Codex 账号
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-[1.55] text-muted-foreground">
              CAP 会先在此准备设备码；就绪后由你明确打开 OpenAI
              授权页。登录态加密存于服务端，无需填写 API Key。
            </DialogDescription>
          </div>
          <DialogClose
            aria-label="关闭"
            className="grid size-8 flex-none place-items-center rounded-md bg-transparent text-2xl leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            ×
          </DialogClose>
        </header>

        <DialogBody>
          <div className="grid gap-3.5 p-[0_22px_18px]">
            <div className="grid gap-2" aria-label="授权范围">
              <ScopeRow label="会话范围" value="仅用于远端 Agent 执行当前任务" />
              <ScopeRow
                label="登录态存储"
                value="auth.json 经 AES-256-GCM 加密存于服务端，永不回显"
              />
              <ScopeRow
                label="仓库权限"
                value="沿用已连接 GitHub PAT 与仓库导入范围"
              />
            </div>

            {connected && phase === "idle" && !localError ? (
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md bg-[color-mix(in_oklch,var(--success)_10%,white)] p-3 shadow-[color-mix(in_oklch,var(--success)_34%,rgba(0,0,0,0.08))_0_0_0_1px]">
                <span
                  aria-hidden="true"
                  className="grid size-[30px] place-items-center rounded-[7px] bg-ink font-mono text-[13px] font-bold text-background"
                >
                  C
                </span>
                <div className="min-w-0">
                  <strong className="block text-[15px] text-foreground">
                    官方账号已连接
                  </strong>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {login} · 登录态已加密存储
                  </span>
                </div>
                <StatusPill variant="green">已连接</StatusPill>
              </div>
            ) : null}

            <CodexDeviceLoginStatusContent
              startPending={startPending}
              status={status}
              localError={localError}
              copied={copied}
              manualCopy={manualCopy}
              codeRef={codeRef}
              onCopy={() => void copyCode()}
            />

            {phase === "idle" && !connected && !localError ? (
              <p className="text-[13px] leading-[1.55] text-muted-foreground">
                前提：先在 ChatGPT「设置 →
                安全」里启用「设备码登录」，再点下方连接。
              </p>
            ) : null}
          </div>
        </DialogBody>

        <div className="flex shrink-0 flex-wrap gap-2.5 border-t border-border p-[14px_22px_18px] max-[560px]:grid max-[560px]:grid-cols-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void startConnect()}
            className="inline-flex min-h-9 items-center justify-center gap-2.5 rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            <span
              aria-hidden="true"
              className="grid size-6 place-items-center rounded-md bg-background font-mono text-[11px] font-bold text-ink"
            >
              C
            </span>
            <span>
              {phase === "preparing"
                ? "准备中…"
                : phase === "awaiting_authorization"
                  ? "等待授权…"
                  : phase === "finalizing"
                    ? "正在保存…"
                    : retryable
                      ? "重试"
                      : connected || phase === "connected"
                        ? "重新连接"
                        : "连接官方账号"}
            </span>
          </button>
          <DialogClose className="inline-flex min-h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80">
            {phase === "connected" ? "完成" : "取消"}
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
