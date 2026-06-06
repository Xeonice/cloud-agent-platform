/**
 * `CodexCredentialWorkspace` — the RIGHT activation card of the `#codex` section
 * (rebuild-console-tanstack-start Track 14, task 14.4).
 *
 * The prototype `.panel.codex-credential-workspace`: a panel-head ("激活方式"),
 * a `role="tablist"` of two tabs (官方 Codex 账号 / 兼容模型提供方, each with a
 * state-keyed subtitle), and a `tabpanel` per tab — the provider cards
 * (`.codex-option-panel.codex-provider-card`) with a card head (mark + title +
 * copy), a `.provider-meta` line, and a `.provider-foot` (state pill + a
 * secondary 配置 button that opens the matching dialog).
 *
 * The active tab is CLIENT-ONLY view state (which provider card is shown); the
 * tab subtitles + the provider-foot pills derive from the shared `codex-state`
 * helpers so they agree with the status card. The mode currently CONFIGURED is
 * `cred.mode`; the tab the operator is *looking at* is independent `useState`.
 *
 * a11y: `role="tablist"` / `role="tab"` with `aria-selected` + `aria-controls`,
 * `role="tabpanel"` with `aria-labelledby`; the inactive panel is `hidden`.
 * Arrow-key roving is handled by simple click/selection (the prototype's
 * contract is `aria-selected` + the hidden inactive panel).
 *
 * SSR-safe: pure render; the active-tab flag is plain `useState` (seeded from
 * the configured mode so the server renders the configured tab open).
 *
 * Fidelity (audit-refinement FINAL): tabs = `#f5f6f7` track, 3px gap/pad,
 * radius 8, inset ring; each button min-h 54, radius 6, left-aligned, title
 * 13/600 + subtitle 11 muted (success-tinted when ready); active button white +
 * a 1px ring + soft shadow. Provider card = white, radius 8, inset ring, 14px
 * pad, 14px gap; card head `36px 1fr` with the mark; provider-meta = soft tile;
 * provider-foot = space-between pill ⟷ secondary button.
 */
import * as React from "react";

import type {
  CodexCredential,
  CodexCredentialMode,
} from "@cap/contracts";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import { Panel, PanelHead } from "@/components/settings/panel";
import {
  isReady,
  providerFootLabel,
  providerFootVariant,
  providerMetaValue,
  tabSubtitle,
} from "@/components/settings/codex-state";

/** One activation tab definition (verbatim copy). */
interface TabDef {
  mode: CodexCredentialMode;
  /** The tab control id (for `aria-controls`/`aria-labelledby`). */
  tabId: string;
  /** The matching panel id. */
  panelId: string;
  title: string;
}

const TABS: readonly TabDef[] = [
  {
    mode: "official",
    tabId: "codexTabDirect",
    panelId: "codexPanelDirect",
    title: "官方 Codex 账号",
  },
  {
    mode: "compatible",
    tabId: "codexTabApiKey",
    panelId: "codexPanelApiKey",
    title: "兼容模型提供方",
  },
];

export interface CodexCredentialWorkspaceProps {
  /** The live credential (drives subtitles + pills + meta). */
  cred: CodexCredential;
  /** Open the configuration dialog for the given mode. */
  onConfigure: (mode: CodexCredentialMode) => void;
}

/** The provider card body for one mode (card head + meta + foot). */
function ProviderCard({
  mode,
  cred,
  onConfigure,
}: {
  mode: CodexCredentialMode;
  cred: CodexCredential;
  onConfigure: (mode: CodexCredentialMode) => void;
}) {
  const isOfficial = mode === "official";
  return (
    <div className="grid min-w-0 gap-3.5 rounded-md bg-card p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-9 place-items-center rounded-md font-mono text-xs font-semibold shadow-ring",
            isOfficial
              ? "bg-ink text-background"
              : "bg-[#f5f6f7] text-muted-foreground",
          )}
        >
          {isOfficial ? "C" : "Key"}
        </span>
        <div className="min-w-0">
          <h3 className="mb-1.5 text-base font-semibold tracking-[-0.32px] text-foreground">
            {isOfficial ? "官方 Codex 账号" : "兼容模型提供方"}
          </h3>
          <p className="text-[13px] leading-[1.58] text-muted-foreground">
            {isOfficial
              ? "通过官方认证建立短期运行会话，不在设置页保存模型 API Key。"
              : "使用 OpenAI-compatible Base URL 与 API Key，适合自建网关或代理服务。"}
          </p>
        </div>
      </div>
      <div className="grid gap-[5px] rounded-md bg-[#fafafa] p-3 shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="font-mono text-[11px] font-medium text-muted-foreground">
          {isOfficial ? "运行身份" : "默认模型"}
        </span>
        <strong className="min-w-0 truncate text-sm font-semibold text-foreground">
          {providerMetaValue(mode, cred)}
        </strong>
      </div>
      <div className="flex items-center justify-between gap-2.5 pt-0.5 max-[560px]:grid max-[560px]:grid-cols-1">
        <StatusPill variant={providerFootVariant(mode, cred)}>
          {providerFootLabel(mode, cred)}
        </StatusPill>
        <button
          type="button"
          onClick={() => onConfigure(mode)}
          className="inline-flex min-h-[34px] items-center justify-center rounded-md bg-secondary px-[13px] text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
        >
          {isOfficial ? "配置官方账号" : "配置提供方"}
        </button>
      </div>
    </div>
  );
}

/** The activation workspace (tablist + provider cards). */
export function CodexCredentialWorkspace({
  cred,
  onConfigure,
}: CodexCredentialWorkspaceProps) {
  // Which tab the operator is viewing (client-only; seeded from configured mode).
  const [active, setActive] = React.useState<CodexCredentialMode>(cred.mode);

  return (
    <Panel className="grid min-w-0 gap-3.5">
      <PanelHead>
        <h3 className="text-base font-semibold text-foreground">激活方式</h3>
        <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">
          切换远端 Agent 当前使用的模型凭据来源。
        </p>
      </PanelHead>

      <div
        role="tablist"
        aria-label="Agent 模型凭据"
        className="grid grid-cols-2 gap-[3px] rounded-md bg-[#f5f6f7] p-[3px] shadow-[inset_0_0_0_1px_var(--border)] max-[560px]:grid-cols-1"
      >
        {TABS.map((tab) => {
          const selected = active === tab.mode;
          const subtitle = tabSubtitle(tab.mode, cred);
          const ready = cred.mode === tab.mode && isReady(cred.state);
          return (
            <button
              key={tab.mode}
              id={tab.tabId}
              type="button"
              role="tab"
              aria-controls={tab.panelId}
              aria-selected={selected}
              onClick={() => setActive(tab.mode)}
              className={cn(
                "grid min-h-[54px] min-w-0 content-center gap-1 rounded-md px-3 py-2.5 text-left",
                selected
                  ? "bg-card shadow-[rgba(0,0,0,0.08)_0_0_0_1px,rgba(0,0,0,0.04)_0_2px_2px]"
                  : "bg-transparent",
              )}
            >
              <strong className="min-w-0 truncate text-[13px] font-semibold text-foreground">
                {tab.title}
              </strong>
              <span
                className={cn(
                  "w-fit text-[11px]",
                  ready ? "text-success" : "text-muted-foreground",
                )}
              >
                {subtitle}
              </span>
            </button>
          );
        })}
      </div>

      <div className="min-w-0">
        {TABS.map((tab) => (
          <section
            key={tab.mode}
            id={tab.panelId}
            role="tabpanel"
            aria-labelledby={tab.tabId}
            hidden={active !== tab.mode}
          >
            <ProviderCard mode={tab.mode} cred={cred} onConfigure={onConfigure} />
          </section>
        ))}
      </div>
    </Panel>
  );
}
