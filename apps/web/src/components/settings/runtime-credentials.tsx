/**
 * `RuntimeCredentialTabs` — the unified Agent model-credential section
 * (pixel-restore-console-to-od Track 10.2, faithful to design-baseline
 * settings.html `#codex` panel; collection-driven since unlock-extension-axes).
 *
 * ONE panel — "Agent 模型凭据" — with a RUNTIME tab strip rendering one tab per
 * contracts-declared runtime (each showing its own connection state), and the
 * active runtime's provider entries (`.provider-meta` rows) generated from that
 * runtime's declared credential modes. The component takes a COLLECTION keyed by
 * runtime id (connection state + configure handler per declared runtime) instead
 * of per-runtime prop pairs, so a runtime declared in contracts with a complete
 * `RUNTIME_METADATA` row renders here with zero edits to this component — the
 * consumer is forced by the total Record to supply its group. Selecting an entry
 * opens its configuration dialog via the group's handler; the dialogs themselves
 * live in the page.
 *
 * Display copy: runtime labels come from `RUNTIME_METADATA`; per-MODE entry copy
 * stays web-side in {@link MODE_COPY}, a total Record over the unified
 * credential-mode vocabulary (adding a mode without console copy is a build
 * error). No runtime-identity branch exists in this component.
 *
 * SSR-safe: the active-runtime toggle is local `useState`; pure render off the
 * credential read shapes (presence + state only, never a secret).
 */
import * as React from "react";
import { CircleAlert } from "lucide-react";

import {
  AGENT_RUNTIME_IDS,
  DEFAULT_AGENT_RUNTIME_ID,
  RUNTIME_METADATA,
  RuntimeSchema,
  type AgentRuntimeId,
  type CodexCredentialState,
  type RuntimeCredentialMode,
  type TaskFailureCode,
} from "@cap-console/contracts";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";

/** Parse the settings deep-link runtime via the contracts vocabulary (no identity branch). */
export function parseCredentialRuntime(value: unknown): AgentRuntimeId | undefined {
  const parsed = RuntimeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseCredentialIssue(
  value: unknown,
): TaskFailureCode | undefined {
  return value === "runtime_auth_expired" || value === "runtime_auth_rejected"
    ? value
    : undefined;
}

/**
 * The connection-state vocabulary shared by every runtime's credential read
 * shape (contracts declares Claude's state as "same vocabulary as the Codex
 * credential" — this aliases that single vocabulary rather than restating it).
 */
export type RuntimeCredentialConnectionState = CodexCredentialState;

/** Short connection-state label shared by every runtime's tab. */
function stateLabel(state: RuntimeCredentialConnectionState): string {
  if (state === "connected") return "已连接";
  if (state === "not_saved") return "未保存";
  return "未连接";
}

/**
 * Tab order is a PRESENTATION rule, default-first (the same rule as the
 * create-dialog's `RUNTIME_CATALOG`): stated here so reordering the contracts
 * declaration cannot silently reorder the settings tabs.
 */
const ORDERED_RUNTIME_IDS: ReadonlyArray<AgentRuntimeId> = [
  DEFAULT_AGENT_RUNTIME_ID,
  ...AGENT_RUNTIME_IDS.filter((id) => id !== DEFAULT_AGENT_RUNTIME_ID),
];

/**
 * Web-side display copy per credential MODE (DERIVED-legal split: the mode
 * vocabulary is declared in contracts; its console copy lives here). A total
 * Record — adding a mode to the vocabulary without copy is a build error. Which
 * modes a runtime offers comes from its `RUNTIME_METADATA` row, so the entries
 * below render for any runtime declaring the mode, without a runtime branch.
 */
const MODE_COPY: Readonly<
  Record<RuntimeCredentialMode, { title: string; desc: React.ReactNode; cta: string }>
> = {
  official: {
    title: "官方 Codex 账号",
    desc: "通过 ChatGPT 订阅认证建立短期运行会话，不在设置页保存 API Key。",
    cta: "连接订阅",
  },
  compatible: {
    title: "兼容模型提供方",
    desc: "OpenAI-compatible Base URL 与 API Key，适合自建网关或代理服务。",
    cta: "配置提供方",
  },
  subscription: {
    title: "Claude 订阅（setup-token）",
    desc: (
      <>
        在本机运行 <span className="font-mono">claude setup-token</span>{" "}
        生成长期令牌并粘贴；远端 Claude Code 以订阅额度运行{" "}
        <span className="font-mono">claude -p</span>。
      </>
    ),
    cta: "连接订阅",
  },
  api_key: {
    title: "Anthropic API Key",
    desc: (
      <>
        使用 <span className="font-mono">sk-ant-</span>{" "}
        API Key 按量计费运行；保存后仅展示后缀，明文不再显示。
      </>
    ),
    cta: "配置 API Key",
  },
};

/**
 * One runtime's entry in the credential collection: its connection state
 * (presence only, never a secret) and the handler opening the configure dialog
 * for one of that runtime's declared modes.
 */
export interface RuntimeCredentialGroup {
  state: RuntimeCredentialConnectionState;
  onConfigure: (mode: RuntimeCredentialMode) => void;
}

export interface RuntimeCredentialTabsProps {
  /**
   * The per-runtime credential collection, keyed by the contracts runtime
   * vocabulary. A TOTAL Record: declaring a new runtime makes the missing group
   * an ordinary typecheck failure at the consumer — not a silent omission here.
   */
  runtimes: Readonly<Record<AgentRuntimeId, RuntimeCredentialGroup>>;
  defaultRuntime?: AgentRuntimeId;
  credentialIssue?: TaskFailureCode;
}

export function RuntimeCredentialTabs({
  runtimes,
  defaultRuntime = DEFAULT_AGENT_RUNTIME_ID,
  credentialIssue,
}: RuntimeCredentialTabsProps) {
  const [runtime, setRuntime] = React.useState<AgentRuntimeId>(defaultRuntime);

  React.useEffect(() => {
    setRuntime(defaultRuntime);
  }, [defaultRuntime]);

  const anyConnected = ORDERED_RUNTIME_IDS.some(
    (id) => runtimes[id].state === "connected",
  );
  const hasCredentialIssue = credentialIssue !== undefined;
  const issueLabel =
    credentialIssue === "runtime_auth_expired" ? "凭据已过期" : "凭据已失效";
  const issueMessage =
    `最近一次 ${RUNTIME_METADATA[defaultRuntime].label} 任务检测到${issueLabel}，` +
    "请重新保存对应凭据后再创建任务。";

  const activeGroup = runtimes[runtime];

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
            控制台登录决定谁能进入平台；这里选择远端 Agent 运行任务时使用的模型凭据。
          </p>
        </div>
        <StatusPill
          variant={
            hasCredentialIssue ? "warn" : anyConnected ? "green" : "neutral"
          }
        >
          {hasCredentialIssue ? "需更新" : anyConnected ? "已连接" : "未连接"}
        </StatusPill>
      </div>

      {/* Runtime tab strip — one tab per contracts-declared runtime */}
      <div
        role="tablist"
        aria-label="按运行时选择凭据"
        className="mt-3.5 grid gap-[3px] rounded-lg bg-[#f5f6f7] p-[3px] shadow-[inset_0_0_0_1px_var(--border)]"
        style={{
          gridTemplateColumns: `repeat(${ORDERED_RUNTIME_IDS.length}, minmax(0, 1fr))`,
        }}
      >
        {ORDERED_RUNTIME_IDS.map((id) => (
          <RuntimeTab
            key={id}
            label={RUNTIME_METADATA[id].label}
            state={
              hasCredentialIssue && defaultRuntime === id
                ? "需更新"
                : stateLabel(runtimes[id].state)
            }
            selected={runtime === id}
            onSelect={() => setRuntime(id)}
          />
        ))}
      </div>

      {/* Active runtime's provider entries — generated from its declared modes */}
      <div className="mt-3.5 grid gap-3">
        {hasCredentialIssue && runtime === defaultRuntime ? (
          <div
            role="alert"
            className="flex min-w-0 items-start gap-2 rounded-md border border-warning/25 bg-warning-soft px-3 py-2.5 text-sm text-foreground"
          >
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 flex-none text-warning"
            />
            <p className="min-w-0 break-words leading-relaxed">{issueMessage}</p>
          </div>
        ) : null}
        {RUNTIME_METADATA[runtime].credentialModes.map((mode) => {
          const copy = MODE_COPY[mode];
          return (
            <ProviderEntry
              key={mode}
              title={copy.title}
              desc={copy.desc}
              cta={copy.cta}
              onClick={() => activeGroup.onConfigure(mode)}
            />
          );
        })}
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
