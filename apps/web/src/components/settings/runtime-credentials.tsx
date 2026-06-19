/**
 * `RuntimeCredentialTabs` — the unified Agent model-credential section
 * (pixel-restore-console-to-od Track 10.2, faithful to design-baseline
 * settings.html `#codex` panel).
 *
 * ONE panel — "Agent 模型凭据" — with a RUNTIME tab strip (Codex | Claude Code,
 * each showing its own connection state), and per-runtime provider entries
 * (`.provider-meta` rows). Selecting an entry opens its configuration dialog via
 * the owner-supplied handlers; the dialogs themselves live in the page. This
 * replaces the former separate Codex workspace + Claude card with the single
 * by-runtime section the design specifies.
 *
 * SSR-safe: the active-runtime toggle is local `useState`; pure render off the
 * two credential read shapes (presence + state only, never a secret).
 */
import * as React from "react";

import type {
  ClaudeCredential,
  ClaudeCredentialMode,
  CodexCredential,
  CodexCredentialMode,
} from "@cap/contracts";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";

type Runtime = "codex" | "claude-code";

/** Short connection-state label shared by both runtimes' tabs. */
function stateLabel(state: "not_connected" | "not_saved" | "connected"): string {
  if (state === "connected") return "已连接";
  if (state === "not_saved") return "未保存";
  return "未连接";
}

export interface RuntimeCredentialTabsProps {
  codexCred: CodexCredential;
  claudeCred: ClaudeCredential;
  onConfigureCodex: (mode: CodexCredentialMode) => void;
  onConfigureClaude: (mode: ClaudeCredentialMode) => void;
}

export function RuntimeCredentialTabs({
  codexCred,
  claudeCred,
  onConfigureCodex,
  onConfigureClaude,
}: RuntimeCredentialTabsProps) {
  const [runtime, setRuntime] = React.useState<Runtime>("codex");

  const anyConnected =
    codexCred.state === "connected" || claudeCred.state === "connected";

  return (
    <section
      id="codex"
      className="scroll-mt-24 rounded-lg bg-card p-[18px] shadow-card"
    >
      {/* Head: title + overall status */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Agent 模型凭据
          </h2>
          <p className="mt-1 text-[13px] leading-[1.55] text-muted-foreground">
            GitHub OAuth 决定谁能进入控制台；这里选择远端 Agent 运行任务时使用的模型凭据。
          </p>
        </div>
        <StatusPill variant={anyConnected ? "green" : "neutral"}>
          {anyConnected ? "已连接" : "未连接"}
        </StatusPill>
      </div>

      {/* Runtime tab strip (Codex | Claude Code) */}
      <div
        role="tablist"
        aria-label="按运行时选择凭据"
        className="mt-3.5 grid grid-cols-2 gap-[3px] rounded-lg bg-[#f5f6f7] p-[3px] shadow-[inset_0_0_0_1px_var(--border)]"
      >
        <RuntimeTab
          label="Codex"
          state={stateLabel(codexCred.state)}
          selected={runtime === "codex"}
          onSelect={() => setRuntime("codex")}
        />
        <RuntimeTab
          label="Claude Code"
          state={stateLabel(claudeCred.state)}
          selected={runtime === "claude-code"}
          onSelect={() => setRuntime("claude-code")}
        />
      </div>

      {/* Active runtime's provider entries */}
      <div className="mt-3.5 grid gap-3">
        {runtime === "codex" ? (
          <>
            <ProviderEntry
              title="官方 Codex 账号"
              desc="通过 ChatGPT 订阅认证建立短期运行会话，不在设置页保存 API Key。"
              cta="连接订阅"
              onClick={() => onConfigureCodex("official")}
            />
            <ProviderEntry
              title="兼容模型提供方"
              desc="OpenAI-compatible Base URL 与 API Key，适合自建网关或代理服务。"
              cta="配置提供方"
              onClick={() => onConfigureCodex("compatible")}
            />
          </>
        ) : (
          <>
            <ProviderEntry
              title="Claude 订阅（setup-token）"
              desc={
                <>
                  在本机运行 <span className="font-mono">claude setup-token</span> 生成长期令牌并粘贴；远端 Claude Code 以订阅额度运行 <span className="font-mono">claude -p</span>。
                </>
              }
              cta="连接订阅"
              onClick={() => onConfigureClaude("subscription")}
            />
            <ProviderEntry
              title="Anthropic API Key"
              desc={
                <>
                  使用 <span className="font-mono">sk-ant-</span> API Key 按量计费运行；保存后仅展示后缀，明文不再显示。
                </>
              }
              cta="配置 API Key"
              onClick={() => onConfigureClaude("api_key")}
            />
          </>
        )}
      </div>
    </section>
  );
}

/** One runtime tab: bold label + a small state line, selected = white surface. */
function RuntimeTab({
  label,
  state,
  selected,
  onSelect,
}: {
  label: string;
  state: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "grid min-h-[54px] content-center gap-1 rounded-md px-3 py-2.5 text-left transition-colors",
        selected
          ? "bg-card shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_2px_2px_rgba(0,0,0,0.04)]"
          : "bg-transparent hover:bg-card/50",
      )}
    >
      <strong className="text-[13px] font-semibold text-foreground">{label}</strong>
      <span className="text-[11px] text-muted-foreground">{state}</span>
    </button>
  );
}

/** A `.provider-meta` row: title + description on the left, a configure button. */
function ProviderEntry({
  title,
  desc,
  cta,
  onClick,
}: {
  title: string;
  desc: React.ReactNode;
  cta: string;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-subtle p-3 shadow-ring">
      <div className="min-w-0">
        <strong className="text-[13px] font-semibold text-foreground">{title}</strong>
        <p className="mt-1 text-xs leading-[1.5] text-muted-foreground">{desc}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex min-h-8 flex-none items-center rounded-md bg-card px-3 text-xs font-medium text-foreground shadow-ring transition-colors hover:bg-secondary"
      >
        {cta}
      </button>
    </div>
  );
}
