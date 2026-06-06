/**
 * `CodexStatusPanel` — the LEFT status card of the `#codex` section
 * (rebuild-console-tanstack-start Track 14, task 14.4).
 *
 * The prototype `.panel.account-panel.codex-status-panel`: a panel-head
 * ("Agent 模型凭据" + a state-keyed mode pill), the `credential-note` clarifying
 * that OAuth login ≠ the model credential, and the `.codex-access-summary` (a
 * state-keyed dot + a title/copy reflecting the live credential).
 *
 * The mode pill, the dot, and the title/copy all derive from the SAME
 * `codexCredentialQuery().state` via the pure `codex-state` helpers, so this
 * card and the activation tabs / provider pills never disagree.
 *
 * SSR-safe: pure render off the (server-hydrated) credential.
 *
 * Fidelity: `.credential-note` = muted 13/1.55, `-2 0 12` margin;
 * `.codex-access-summary` = soft `#fafafa`, radius 8, ring, 14px pad, `auto 1fr`
 * grid, start-aligned, 12px gap; dot = 8px green (or `.warn` amber) with a soft
 * ring; strong 15 ink + p muted 13/1.56.
 */
import * as React from "react";

import type { CodexCredential } from "@cap/contracts";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import { Panel, PanelHead } from "@/components/settings/panel";
import {
  accessSummary,
  isReady,
  modePillLabel,
  statePillVariant,
} from "@/components/settings/codex-state";

/** The status card reflecting the current Codex credential state. */
export function CodexStatusPanel({ cred }: { cred: CodexCredential }) {
  const summary = accessSummary(cred);
  const ready = isReady(cred.state);
  return (
    <Panel className="grid gap-0 self-start lg:sticky lg:top-[72px]">
      <PanelHead
        right={
          <StatusPill variant={statePillVariant(cred.state)}>
            {modePillLabel(cred.state)}
          </StatusPill>
        }
      >
        <h3 className="text-base font-semibold text-foreground">
          Agent 模型凭据
        </h3>
      </PanelHead>
      <p className="mt-[-2px] mb-3 text-[13px] leading-[1.55] text-muted-foreground">
        GitHub OAuth 只决定谁能进入控制台；这里选择远端 Agent 在任务运行时使用的模型凭据。
      </p>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-md bg-[#fafafa] p-3.5 shadow-ring">
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.5 size-2 rounded-full",
            ready
              ? "bg-success shadow-[0_0_0_4px_color-mix(in_oklch,var(--success)_16%,transparent)]"
              : "bg-warning shadow-[0_0_0_4px_color-mix(in_oklch,var(--warning)_18%,transparent)]",
          )}
        />
        <div className="min-w-0">
          <strong className="mb-1 block text-[15px] text-foreground">
            {summary.title}
          </strong>
          <p className="text-[13px] leading-[1.56] text-muted-foreground">
            {summary.copy}
          </p>
        </div>
      </div>
    </Panel>
  );
}
