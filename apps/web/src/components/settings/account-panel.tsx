/**
 * `AccountPanel` — the "当前身份" card (`#account` section, Track 14, task 14.3).
 *
 * The prototype `.panel.account-panel`: a panel-head ("当前身份" + a green
 * 已验证 `StatusPill`), an `.account-identity` row (large avatar with the login
 * initials + the login + the mono `github.com/<login>` handle), and a
 * `.config-list` of three read-only rows (登录方式 / 控制台范围 / 仓库来源).
 *
 * This card surfaces the READ-ONLY console login identity — the operator
 * account that is allowed into the console (governed by the allowlist / admin
 * provisioning, NOT editable here). The login is passed in from
 * `settingsQuery().allowedAccount` (never hardcoded). This is DISTINCT from the
 * Codex execution credential managed in the `#codex` section.
 *
 * add-private-account-identity (task 9.6): the card now surfaces the current
 * operator's ROLE (管理员 / 成员). Role gates only the admin panel — it does NOT
 * isolate execution; every enabled account is host-root.
 *
 * SSR-safe: pure render.
 *
 * Fidelity: `.account-identity` = soft `#fafafa` row, radius 8, ring, 14px pad,
 * 12px gap; `.avatar.large` = 40×40 dark pill, mono 13, white initials;
 * `.config-list` = ringed rounded-8 stack, each row min-h 44, 0/12 pad, hairline
 * divider, label muted 13 ⟷ value ink 13/600 right-aligned.
 */
import * as React from "react";

import { StatusPill } from "@/components/status-pill";
import { Panel, PanelHead } from "@/components/settings/panel";

/** Derive a 2-letter avatar fallback from a login (e.g. "tanghehui" → "TA"). */
function initialsFromLogin(login: string): string {
  const trimmed = login.trim();
  if (!trimmed) return "TH";
  return trimmed.slice(0, 2).toUpperCase();
}

/** One read-only `.config-list` row (label ⟷ value). */
function ConfigRow({
  label,
  value,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-line bg-card px-3 text-[13px] last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <strong className="text-right font-semibold text-foreground">
        {value}
      </strong>
    </div>
  );
}

/** A console role — gates the admin panel only (NOT execution isolation). */
export type AccountRole = "admin" | "member";

/** Verbatim role labels (design `screens/settings.html` 角色 row). */
const ROLE_LABEL: Record<AccountRole, string> = {
  admin: "管理员",
  member: "成员",
};

/** The read-only current-identity card. */
export function AccountPanel({
  login,
  role = "admin",
}: {
  login: string;
  /** The current operator's role (defaults to admin — the mock single-operator). */
  role?: AccountRole;
}) {
  const initials = initialsFromLogin(login);
  return (
    <Panel className="grid gap-4">
      <PanelHead right={<StatusPill variant="green">已验证</StatusPill>}>
        <h3 className="text-base font-semibold text-foreground">当前身份</h3>
      </PanelHead>
      <div className="flex items-center gap-3 rounded-md bg-[#fafafa] p-3.5 shadow-ring">
        <span className="grid size-10 place-items-center rounded-full bg-ink font-mono text-[13px] text-background">
          {initials}
        </span>
        <div className="min-w-0">
          <strong className="block text-foreground">{login}</strong>
          <span className="block font-mono text-muted-foreground">
            github.com/{login}
          </span>
        </div>
      </div>
      <div className="grid overflow-hidden rounded-md shadow-ring">
        <ConfigRow label="角色" value={ROLE_LABEL[role]} />
        <ConfigRow label="登录方式" value="GitHub OAuth" />
        <ConfigRow label="控制台范围" value="私有访问" />
        <ConfigRow label="仓库来源" value="已导入仓库" />
      </div>
    </Panel>
  );
}
