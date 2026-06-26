/**
 * `AccountsTable` — the account-administration table (add-private-account-identity,
 * track frontend, task 9.4; design `screens/accounts.html`).
 *
 * Lists accounts with identity, role, login methods,
 * and enabled/disabled status. A search + type filter narrows the rows and the
 * count pill reflects the visible rows. Row actions differ by kind (D7):
 *   - LOCAL rows offer 重置密码 + 启用/禁用;
 *   - legacy external rows offer 启用/禁用 only (no reset).
 * The page makes clear that role gates only the admin panel and does NOT isolate
 * execution — every enabled account is host-root.
 *
 * This is the PRESENTATION layer: it is given the account rows + the action
 * callbacks by the route, which owns the data source (mock today; the admin
 * account API is backend track account-admin-api). No data fetching here.
 *
 * SSR-safe: pure render off the props + local filter state (no window/clock).
 */
import * as React from "react";

import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import { SegmentedControl } from "@/components/segmented-control";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Which account row type is rendered. */
export type AccountKind = "local" | "legacy";

/** A console role — gates the admin panel only (NOT execution isolation). */
export type AccountRole = "admin" | "member";

/** One account row rendered by the table. */
export interface AccountRow {
  /** Stable row id (the user id). */
  id: string;
  /** Primary identity, normally the email. */
  identity: string;
  /** A secondary descriptor line. */
  sublabel: string;
  /** Whether this is a local or legacy external account. */
  kind: AccountKind;
  /** The console role. */
  role: AccountRole;
  /** Human-readable login methods (e.g. "密码 · 邮箱验证码"). */
  loginMethods: string;
  /** Whether the account is currently enabled (`allowed`). */
  enabled: boolean;
}

/** The type filter segments (design order). */
type FilterValue = "all" | "admin" | "member" | "disabled";

const FILTER_OPTIONS: readonly { value: FilterValue; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "admin", label: "管理员" },
  { value: "member", label: "成员" },
  { value: "disabled", label: "已禁用" },
];

const ROLE_LABEL: Record<AccountRole, string> = {
  admin: "管理员",
  member: "成员",
};

/** Match a row against the active type filter. */
function matchesFilter(row: AccountRow, filter: FilterValue): boolean {
  switch (filter) {
    case "all":
      return true;
    case "admin":
      return row.enabled && row.role === "admin";
    case "member":
      return row.enabled && row.role === "member";
    case "disabled":
      return !row.enabled;
  }
}

/** The small row-action button (design `.acct-actions .btn`). */
const actionButton =
  "inline-flex min-h-[30px] items-center justify-center rounded-md px-2.5 text-xs font-medium shadow-ring transition-colors";

export interface AccountsTableProps {
  /** Every account row. */
  rows: readonly AccountRow[];
  /** Toggle an account's enabled state (enable/disable). */
  onToggleEnabled: (row: AccountRow) => void;
  /** Open the reset-password dialog for a local account. */
  onResetPassword: (row: AccountRow) => void;
}

export function AccountsTable({
  rows,
  onToggleEnabled,
  onResetPassword,
}: AccountsTableProps) {
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<FilterValue>("all");

  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (!matchesFilter(row, filter)) return false;
      if (!needle) return true;
      const haystack = [
        row.identity,
        row.sublabel,
        ROLE_LABEL[row.role],
        row.loginMethods,
        row.enabled ? "启用" : "已禁用",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, search, filter]);

  return (
    <section className="mt-3 rounded-[8px] bg-card p-[18px] shadow-card">
      {/* Panel head */}
      <div className="-mx-[18px] -mt-[18px] mb-3.5 flex items-center justify-between gap-3 border-b border-border px-[18px] pb-3.5 pt-[18px]">
        <div>
          <h2 className="text-sm font-semibold text-foreground">私有账号</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            仅管理员可见 · 禁用立即生效，对应会话与令牌在下次请求时被拒。
          </p>
        </div>
        <StatusPill variant="green" className="whitespace-nowrap">
          {visible.length} 个账号
        </StatusPill>
      </div>

      {/* Toolbar — search + type filter */}
      <div className="mb-3.5 grid items-center gap-3 min-[821px]:grid-cols-[minmax(280px,1fr)_auto]">
        <label className="grid min-h-9 min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center rounded-md bg-card shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]">
          <span
            aria-hidden="true"
            className="grid place-items-center font-mono text-[15px] leading-none text-muted-foreground"
          >
            ⌕
          </span>
          <input
            type="search"
            aria-label="搜索账号"
            placeholder="搜索邮箱、名称或角色"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-h-9 w-full border-0 bg-transparent pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <SegmentedControl
          compact
          ariaLabel="按类型筛选"
          options={FILTER_OPTIONS}
          value={filter}
          onValueChange={setFilter}
          className="max-[821px]:w-full"
        />
      </div>

      {/* Table */}
      {visible.length > 0 ? (
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="border-border">
              <TableHead className="text-xs font-semibold text-muted-foreground">
                账号
              </TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground">
                角色
              </TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground">
                登录方式
              </TableHead>
              <TableHead className="text-xs font-semibold text-muted-foreground">
                状态
              </TableHead>
              <TableHead className="pr-0 text-right text-xs font-semibold text-muted-foreground">
                操作
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.id} className="border-border hover:bg-transparent">
                <TableCell className="py-[13px] align-middle whitespace-normal">
                  <div className="text-sm font-semibold text-foreground">
                    {row.identity}
                  </div>
                  <div className="mt-[3px] text-xs leading-[1.4] text-muted-foreground">
                    {row.sublabel}
                  </div>
                </TableCell>
                <TableCell className="py-[13px] align-middle">
                  <StatusPill variant={row.role === "admin" ? "blue" : "neutral"}>
                    {ROLE_LABEL[row.role]}
                  </StatusPill>
                </TableCell>
                <TableCell className="py-[13px] align-middle">
                  <span className="text-xs text-muted-foreground">
                    {row.loginMethods}
                  </span>
                </TableCell>
                <TableCell className="py-[13px] align-middle">
                  <StatusPill variant={row.enabled ? "green" : "dark"}>
                    {row.enabled ? "启用" : "已禁用"}
                  </StatusPill>
                </TableCell>
                <TableCell className="py-[13px] pr-0 text-right align-middle">
                  <div className="flex flex-nowrap justify-end gap-2">
                    {/* Local rows can reset password; legacy external rows cannot. */}
                    {row.kind === "local" ? (
                      <button
                        type="button"
                        onClick={() => onResetPassword(row)}
                        className={cn(
                          actionButton,
                          "bg-secondary text-foreground hover:bg-secondary/80",
                        )}
                      >
                        重置密码
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onToggleEnabled(row)}
                      className={cn(
                        actionButton,
                        row.enabled
                          ? "bg-danger-soft text-danger ring-1 ring-danger/30"
                          : "bg-secondary text-foreground hover:bg-secondary/80",
                      )}
                    >
                      {row.enabled ? "禁用" : "启用"}
                    </button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState title="没有匹配的账号" description="换个关键词，或切换到其它类型筛选。" />
      )}
    </section>
  );
}
