/**
 * `CodexDirectDialog` — the 官方 Codex 账号 connect dialog (OAuth device-code flow).
 *
 * The official ChatGPT credential is connected via OpenAI's DEVICE-CODE flow (the
 * only remote-web-compatible path — codex's first-party OAuth client cannot
 * redirect back to this web app). On "连接官方账号" the server runs
 * `codex login --device-auth` in a transient sandbox and returns a verification
 * URL + one-time code; this dialog displays them, auto-opens the URL, and polls
 * until the operator authorizes (in their ChatGPT browser session) and codex's
 * tokens are captured + stored encrypted server-side. No secret is ever entered
 * here or echoed back.
 *
 * SSR-safe: Radix portals on the client; all network/clipboard/window touches are
 * in handlers/effects, never during render.
 */
import * as React from "react";

import {
  Dialog,
  DialogClose,
  DialogBody,
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

/** One credential-scope row (label ⟷ value). */
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

/** Device-login UI phases. */
type Phase = "idle" | "starting" | "awaiting" | "connected" | "error";

export interface CodexDirectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the official credential is currently connected. */
  connected: boolean;
  /** The console login shown in the connected strip (from settings). */
  login: string;
  /** Whether the real settings backend is wired (device login needs it). */
  capable: boolean;
  /** Called once the device login completes + the credential is stored. */
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
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [verificationUri, setVerificationUri] = React.useState<string>("");
  const [userCode, setUserCode] = React.useState<string>("");
  const [message, setMessage] = React.useState<string>("");
  const [copied, setCopied] = React.useState(false);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // Refs so the close/unmount cleanups read the LATEST phase/capable without
  // re-subscribing, and a re-entrancy guard for the connect button.
  const phaseRef = React.useRef<Phase>(phase);
  phaseRef.current = phase;
  const capableRef = React.useRef(capable);
  capableRef.current = capable;
  const startingRef = React.useRef(false);

  const stopPoll = React.useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Reset + cancel the in-flight server session whenever the dialog closes, so a
  // transient login container is never left running and the dialog reopens clean.
  // Only cancel when a login was ACTIVE (starting/awaiting) — after `connected`
  // the server already tore the session down on harvest, so a cancel here is a
  // pointless extra request.
  React.useEffect(() => {
    if (open) return;
    const wasActive =
      phaseRef.current === "starting" || phaseRef.current === "awaiting";
    stopPoll();
    setPhase("idle");
    setVerificationUri("");
    setUserCode("");
    setMessage("");
    setCopied(false);
    if (capable && wasActive) void cancelCodexDeviceLogin().catch(() => undefined);
  }, [open, capable, stopPoll]);

  // On UNMOUNT (e.g. navigating away from /settings while a login is awaiting —
  // the dialog is permanently mounted, so the close effect above does NOT run),
  // stop polling AND cancel the server session so the transient container is
  // reclaimed immediately rather than waiting for the sweep/TTL.
  React.useEffect(
    () => () => {
      stopPoll();
      if (
        capableRef.current &&
        (phaseRef.current === "starting" || phaseRef.current === "awaiting")
      ) {
        void cancelCodexDeviceLogin().catch(() => undefined);
      }
    },
    [stopPoll],
  );

  const beginPolling = React.useCallback(() => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const status = await pollCodexDeviceLogin();
        if (status.status === "connected") {
          stopPoll();
          setPhase("connected");
          onConnected();
        } else if (status.status === "expired" || status.status === "error") {
          stopPoll();
          setPhase("error");
          setMessage(status.message ?? "登录未完成，请重试。");
        }
        // awaiting_authorization → keep polling
      } catch {
        // transient poll error — keep polling; the window/expiry guard will stop it
      }
    }, 3000);
  }, [stopPoll, onConnected]);

  const startConnect = React.useCallback(async () => {
    // Re-entrancy guard: a fast double-click on 连接/重试 must not fire two starts
    // (the server also serializes per operator, this is defense-in-depth).
    if (startingRef.current) return;
    if (!capable) {
      setPhase("error");
      setMessage("设备登录需要已部署的后端（当前为本地模拟模式）。");
      return;
    }
    startingRef.current = true;
    // Open the verification tab SYNCHRONOUSLY here, inside the click gesture, so
    // the popup blocker allows it; we navigate it to the real URL once start()
    // resolves. Opening it AFTER the `await` (the previous bug) lost the
    // user-gesture context and the browser blocked the popup. No `noopener` so we
    // keep the handle to set its location; the dialog also shows the URL as a
    // fallback link if the popup is blocked outright.
    const authTab =
      typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    setPhase("starting");
    setMessage("");
    setCopied(false);
    try {
      const res = await startCodexDeviceLogin();
      setVerificationUri(res.verificationUri);
      setUserCode(res.userCode);
      setPhase("awaiting");
      if (authTab && !authTab.closed) {
        authTab.location.href = res.verificationUri;
      } else if (typeof window !== "undefined") {
        // Popup was blocked/closed — best-effort re-open (also shown as a link).
        window.open(res.verificationUri, "_blank", "noopener,noreferrer");
      }
      beginPolling();
    } catch (err) {
      if (authTab && !authTab.closed) authTab.close();
      setPhase("error");
      setMessage(
        err instanceof Error
          ? err.message
          : "无法发起设备登录，请稍后重试。",
      );
    } finally {
      startingRef.current = false;
    }
  }, [capable, beginPolling]);

  async function copyCode() {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(userCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // clipboard may be unavailable; the code is shown for manual copy anyway.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-labelledby="codexDirectTitle"
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-modal sm:max-w-[720px]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 p-[22px_22px_14px]">
          <div className="min-w-0">
            <span className="font-mono text-[11px] font-medium text-muted-foreground">
              官方账号
            </span>
            <DialogTitle
              id="codexDirectTitle"
              className="mt-1 mb-1.5 text-[22px] font-semibold tracking-[-0.8px] text-ink"
            >
              连接官方 Codex 账号
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-[1.55] text-muted-foreground">
              通过 ChatGPT 的设备码授权连接（无需 API Key）。点「连接官方账号」会打开 OpenAI 授权页，登录并确认后，登录态加密存于服务端，每个任务的沙箱按它认证 codex。
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
            <ScopeRow label="登录态存储" value="auth.json 经 AES-256-GCM 加密存于服务端，永不回显" />
            <ScopeRow label="仓库权限" value="沿用 GitHub OAuth 与仓库导入范围" />
          </div>

          {connected && phase === "idle" ? (
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

          {phase === "awaiting" ? (
            <div className="grid gap-2.5 rounded-md bg-[#fafafa] p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
              <p className="text-[13px] leading-[1.55] text-foreground">
                1. 已打开 OpenAI 授权页（未弹出请点
                <a
                  href={verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mx-1 underline decoration-dotted underline-offset-2"
                >
                  这里
                </a>
                ），登录你的 ChatGPT 账号。
              </p>
              <p className="text-[13px] leading-[1.55] text-foreground">
                2. 在页面输入这个一次性码（15 分钟内有效）：
              </p>
              <div className="flex items-center gap-2">
                <code className="select-all rounded-md bg-background px-3 py-2 font-mono text-[18px] font-bold tracking-[2px] text-ink shadow-[inset_0_0_0_1px_var(--border)]">
                  {userCode}
                </code>
                <button
                  type="button"
                  onClick={copyCode}
                  className="inline-flex min-h-8 items-center rounded-md bg-secondary px-2.5 text-[12px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
                >
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
              <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--success)]" />
                授权完成后会自动连接，请勿关闭此窗口…
              </p>
            </div>
          ) : null}

          {phase === "connected" ? (
            <p className="text-[13px] font-medium text-[var(--success)]">
              ✓ 已连接官方账号，登录态已加密存储。
            </p>
          ) : null}

          {phase === "error" ? (
            <p className="text-[13px] leading-[1.55] text-[var(--destructive)]">
              {message}
            </p>
          ) : null}

          {phase === "idle" && !connected ? (
            <p className="text-[13px] leading-[1.55] text-muted-foreground">
              前提：先在 ChatGPT「设置 → 安全」里启用「设备码登录」，再点下方连接。
            </p>
          ) : null}
        </div>
        </DialogBody>

        <div className="flex shrink-0 flex-wrap gap-2.5 border-t border-border p-[14px_22px_18px] max-[560px]:grid max-[560px]:grid-cols-1">
          <button
            type="button"
            disabled={phase === "starting" || phase === "awaiting"}
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
              {phase === "starting"
                ? "准备中…"
                : phase === "awaiting"
                  ? "等待授权…"
                  : phase === "error"
                    ? "重试"
                    : connected
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
