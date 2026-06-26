/**
 * Claude Code execution-credential UI (pixel-restore-console-to-od Track 10.2).
 *
 * The runtime sibling of the Codex credential workspace: a status card + two
 * configure entries (Claude 订阅 `setup-token` / Anthropic API Key) and a
 * mode-aware dialog that saves through `saveClaudeCredentialMutation` →
 * `PUT /settings/claude` (the backend from Track 3). Secrets are WRITE-ONLY:
 * the read shape exposes only presence + a masked suffix, never the value.
 *
 * SSR-safe: pure render off the credential read shape; the dialog's secret field
 * is transient `useState`, wiped on close, never pre-filled from a saved value.
 */
import * as React from "react";

import type {
  ClaudeCredential,
  ClaudeCredentialMode,
  SaveClaudeCredentialRequest,
} from "@cap/contracts";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

/** Map the credential read state to a status pill (mirrors the codex panel). */
function statePill(cred: ClaudeCredential) {
  if (cred.state === "connected") {
    return <StatusPill variant="green">已连接</StatusPill>;
  }
  if (cred.state === "not_saved") {
    return <StatusPill variant="warn">未保存</StatusPill>;
  }
  return <StatusPill variant="neutral">未连接</StatusPill>;
}

export interface ClaudeCredentialCardProps {
  cred: ClaudeCredential;
  onConfigure: (mode: ClaudeCredentialMode) => void;
}

/** Status card + the two by-mode configure entries (subscription / api_key). */
export function ClaudeCredentialCard({
  cred,
  onConfigure,
}: ClaudeCredentialCardProps) {
  return (
    <div className="grid scroll-mt-24 gap-6">
      {/* Status panel */}
      <section className="rounded-lg bg-card p-[18px] shadow-card">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-foreground">
            Claude Code 运行时
          </h3>
          {statePill(cred)}
        </div>
        <p className="mt-2 text-[13px] leading-[1.55] text-muted-foreground">
          远端 Claude Code 运行任务时使用的凭据；控制台登录决定谁能操作平台，这里决定用什么登录跑 <span className="font-mono">claude -p</span>。
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          当前模式：
          <strong className="text-foreground">
            {cred.mode === "api_key" ? "Anthropic API Key" : "Claude 订阅"}
          </strong>
        </p>
      </section>

      {/* By-mode entries */}
      <section className="grid gap-3 rounded-lg bg-card p-[18px] shadow-card">
        <ClaudeEntry
          title="Claude 订阅（setup-token）"
          desc={
            <>
              在本机运行 <span className="font-mono">claude setup-token</span> 生成长期令牌并粘贴；远端 Claude Code 以订阅额度运行。
            </>
          }
          active={cred.mode === "subscription" && cred.hasSetupToken}
          suffix={cred.mode === "subscription" ? cred.setupTokenSuffix : null}
          onConfigure={() => onConfigure("subscription")}
          cta="连接订阅"
        />
        <ClaudeEntry
          title="Anthropic API Key"
          desc="使用 sk-ant- API Key 以按量计费方式运行 Claude Code。"
          active={cred.mode === "api_key" && cred.hasApiKey}
          suffix={cred.mode === "api_key" ? cred.apiKeySuffix : null}
          onConfigure={() => onConfigure("api_key")}
          cta="配置 API Key"
        />
      </section>
    </div>
  );
}

function ClaudeEntry({
  title,
  desc,
  active,
  suffix,
  onConfigure,
  cta,
}: {
  title: string;
  desc: React.ReactNode;
  active: boolean;
  suffix?: string | null;
  onConfigure: () => void;
  cta: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md bg-subtle p-3 shadow-ring">
      <div className="min-w-0">
        <strong className="text-[13px] font-semibold text-foreground">{title}</strong>
        <p className="mt-1 text-xs leading-[1.5] text-muted-foreground">{desc}</p>
        {active && suffix ? (
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
            已保存 · ••••{suffix}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onConfigure}
        className="inline-flex min-h-8 flex-none items-center rounded-md bg-card px-3 text-xs font-medium text-foreground shadow-ring transition-colors hover:bg-secondary"
      >
        {cta}
      </button>
    </div>
  );
}

export interface ClaudeCredentialDialogProps {
  open: boolean;
  mode: ClaudeCredentialMode;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (body: SaveClaudeCredentialRequest) => void;
}

/** Mode-aware save dialog: a setup-token paste OR an Anthropic API key. */
export function ClaudeCredentialDialog({
  open,
  mode,
  saving,
  onOpenChange,
  onSave,
}: ClaudeCredentialDialogProps) {
  const [secret, setSecret] = React.useState("");
  // Wipe the transient secret whenever the dialog closes (never persisted/echoed).
  React.useEffect(() => {
    if (!open) setSecret("");
  }, [open]);

  const isSubscription = mode === "subscription";
  const canSave = secret.trim().length > 0 && !saving;

  function submit() {
    if (!canSave) return;
    onSave(
      isSubscription
        ? { mode: "subscription", setupToken: secret.trim() }
        : { mode: "api_key", apiKey: secret.trim() },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(560px,100vw-32px)]">
        <DialogTitle>
          {isSubscription ? "连接 Claude 订阅" : "配置 Anthropic API Key"}
        </DialogTitle>
        <DialogDescription>
          {isSubscription ? (
            <>
              在本机执行 <span className="font-mono">claude setup-token</span>，把输出的长期令牌粘贴到此处；远端 Claude Code 将以你的订阅额度运行。
            </>
          ) : (
            <>使用 Anthropic <span className="font-mono">sk-ant-</span> API Key 以按量计费运行 Claude Code。</>
          )}
        </DialogDescription>
        <DialogBody className="grid gap-3">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">
              {isSubscription ? "setup-token" : "API Key"}
            </span>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                isSubscription
                  ? "粘贴 claude setup-token 输出的令牌"
                  : "sk-ant-..."
              }
              className="min-h-9 rounded-md bg-card px-3 font-mono text-[13px] text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-[inset_0_0_0_1px_var(--foreground)]"
            />
            <span className="text-[11px] text-muted-foreground">
              保存后只显示后四位，不再回显明文。
            </span>
          </label>
        </DialogBody>
        <div className="flex items-center justify-end gap-2 border-t border-border px-[22px] py-3.5">
          <DialogClose className="inline-flex min-h-8 items-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary">
            取消
          </DialogClose>
          <button
            type="button"
            disabled={!canSave}
            onClick={submit}
            className={cn(
              "inline-flex min-h-8 items-center rounded-md bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-[#2a2a2a]",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {saving ? "保存中…" : "保存凭据"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
