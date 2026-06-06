/**
 * `CodexDirectDialog` — the 官方 Codex 账号 configuration dialog (Track 14, 14.4).
 *
 * A shadcn `Dialog` (Radix supplies Esc / backdrop close / focus trap /
 * `aria-modal` / `aria-labelledby` / focus-return). Header ("连接官方 Codex
 * 账号"), a `.credential-scope-list` (会话范围 / 密钥存储 / 仓库权限), then either
 * the empty-state note OR — when the official credential is already connected —
 * the `.codex-connected-state` strip (官方账号已连接 + the login + a green pill).
 * Footer: 连接官方账号 (saves `mode:'official'` → state `connected`) + 取消.
 *
 * The official flow never accepts an API key (the dialog has no key field): it
 * establishes a short-lived run session, distinct from both the OAuth login
 * identity and the compatible-provider key.
 *
 * SSR-safe: Radix portals the content on the client only; no window/clock/random
 * during render. The connected display reflects the live credential, not local
 * state.
 *
 * Fidelity: dialog `min(720px, 100vw-32px)`; modal body 0/22/18 pad, 14px gap;
 * `.credential-scope-list` rows = soft `#fafafa`, radius 8, ring,
 * `minmax(110px,.42fr) 1fr` grid; connected strip = soft-green tinted, radius 8,
 * green ring, `auto 1fr auto` grid; modal actions = top hairline, 14/22/18 pad.
 */
import * as React from "react";

import type { SaveCodexCredentialRequest } from "@cap/contracts";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusPill } from "@/components/status-pill";

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

export interface CodexDirectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the official credential is currently connected. */
  connected: boolean;
  /** The console login shown in the connected strip (from settings). */
  login: string;
  /** Whether a save is in flight. */
  saving?: boolean;
  /** Persist the official credential (`saveCodexCredentialMutation`). */
  onConnect: (body: SaveCodexCredentialRequest) => void;
}

/** The official-account configuration dialog. */
export function CodexDirectDialog({
  open,
  onOpenChange,
  connected,
  login,
  saving = false,
  onConnect,
}: CodexDirectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-labelledby="codexDirectTitle"
        className="sm:max-w-[720px] gap-0 overflow-hidden rounded-xl p-0 shadow-modal"
      >
        <header className="flex items-start justify-between gap-4 p-[22px_22px_14px]">
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
              通过官方 OAuth 建立短期运行会话。控制台不会保存模型 API Key，GitHub 仓库权限仍由左侧账户身份控制。
            </DialogDescription>
          </div>
          <DialogClose
            aria-label="关闭"
            className="grid size-8 flex-none place-items-center rounded-md bg-transparent text-2xl leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            ×
          </DialogClose>
        </header>

        <div className="grid gap-3.5 p-[0_22px_18px]">
          <div className="grid gap-2" aria-label="授权范围">
            <ScopeRow label="会话范围" value="仅用于远端 Agent 执行当前任务" />
            <ScopeRow label="密钥存储" value="不在设置页保存模型 API Key" />
            <ScopeRow label="仓库权限" value="沿用 GitHub OAuth 与仓库导入范围" />
          </div>

          {connected ? (
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
                  {login} · 短期运行会话
                </span>
              </div>
              <StatusPill variant="green">已连接</StatusPill>
            </div>
          ) : (
            <div className="grid gap-2.5">
              <p className="text-[13px] leading-[1.55] text-muted-foreground">
                连接后，创建任务时默认使用官方短期认证会话；你仍可以随时切换到兼容提供方。
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2.5 border-t border-border p-[14px_22px_18px] max-[560px]:grid max-[560px]:grid-cols-1">
          <button
            type="button"
            disabled={saving}
            onClick={() => onConnect({ mode: "official" })}
            className="inline-flex min-h-9 items-center justify-center gap-2.5 rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            <span
              aria-hidden="true"
              className="grid size-6 place-items-center rounded-md bg-background font-mono text-[11px] font-bold text-ink"
            >
              C
            </span>
            <span>连接官方账号</span>
          </button>
          <DialogClose className="inline-flex min-h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80">
            取消
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
