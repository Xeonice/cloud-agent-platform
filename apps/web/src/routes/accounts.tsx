/**
 * `/accounts` — 账号管理 (account administration; add-private-account-identity,
 * track frontend, task 9.4; design `screens/accounts.html`).
 *
 * The admin-only account-administration page reached from the account menu's
 * 账号管理 entry. It lists all accounts in a filterable
 * table and offers the admin lifecycle actions: 新建账号 (create), 重置密码
 * (reset, password accounts only), and 启用/禁用 (enable/disable). Role gates only the admin panel — every enabled account is
 * host-root, called out in the lead.
 *
 * ROUTE PLACEMENT: like `/login` and `/` (and unlike the `_app/*` body pages),
 * this is a top-level route that ships its OWN app-shell chrome (the sidebar +
 * mobile nav + content inset) and its OWN auth gate in `beforeLoad`, so it is
 * self-contained while still rendering inside the cohesive console shell. The
 * gate mirrors the `_app` gate: a real session is resolved on both server and
 * client (forwarding the SSR cookie, mapping a 401 to logged-out), and the mock
 * gate decision is deferred to the client.
 *
 * DATA: the rows come from the live admin account API (`GET /accounts`) via
 * `adminAccountsQuery` — real backend when `isCapable('accounts')`, else the mock
 * store. Create / enable-disable / reset go through the account mutations, which
 * invalidate the list so the table re-reads the source of truth. Under the mock
 * gate the seeded store keeps the page interactive (pixel baseline + offline).
 *
 * SSR-safe: deterministic render off the query data; dialogs + mutations run from
 * user handlers only.
 */
import * as React from "react";
import {
  createFileRoute,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminAccountListItem } from "@cap/contracts";

import { cn } from "@/utils";
import { adminAccountsQuery, authSessionQuery } from "@/lib/api/queries";
import {
  createAdminAccountMutation,
  resetAdminAccountPasswordMutation,
  setAdminAccountEnabledMutation,
} from "@/lib/api/mutations";
import { isAuthCapable, isAuthenticated } from "@/lib/mock-session";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { Topbar } from "@/components/shell/topbar";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AccountsTable,
  type AccountRole,
  type AccountRow,
} from "@/components/accounts/accounts-table";

export const Route = createFileRoute("/accounts")({
  beforeLoad: async ({ context, location }) => {
    // Mirror the `_app` auth gate: this is a load-bearing security boundary
    // (login == host-root), so an unauthenticated visitor never sees the page.
    // ADDITIONALLY this page is admin-only — a non-admin who types the URL is sent
    // to the console rather than the (server-403'd) admin page (UX, not the
    // security boundary, which the api re-enforces on every mutation).
    if (isAuthCapable()) {
      const session = await context.queryClient.ensureQueryData(
        authSessionQuery(),
      );
      if (session == null) {
        throw redirect({ to: "/login", search: { redirect: location.href } });
      }
      if (session.mustChangePassword) {
        throw redirect({
          to: "/login",
          search: { redirect: location.href, change: true },
        });
      }
      if (session.role !== "admin") {
        throw redirect({ to: "/dashboard" });
      }
    } else {
      // Mock gate: deferred to the client (sessionStorage isn't server-readable);
      // the lone mock operator is the admin (matches the useIsAdmin mock posture).
      if (typeof document === "undefined") return;
      if (!isAuthenticated()) {
        throw redirect({ to: "/login", search: { redirect: location.href } });
      }
    }
  },
  component: AccountsPage,
});

/** Display labels for the api's `loginMethods` enum (design copy). */
const LOGIN_METHOD_LABEL: Record<"password" | "otp", string> = {
  password: "密码",
  otp: "邮箱验证码",
};

/** Map an api account row (the wire contract) into the table's display row. */
function toAccountRow(item: AdminAccountListItem): AccountRow {
  return {
    id: item.id,
    identity: item.identity,
    sublabel: item.isGithubLinked
      ? "历史外部关联 · 已停止作为登录方式"
      : item.name && item.name !== item.identity
        ? item.name
        : "本地账号",
    kind: item.isGithubLinked ? "legacy" : "local",
    role: item.role,
    loginMethods:
      item.loginMethods.map((m) => LOGIN_METHOD_LABEL[m]).join(" · ") || "—",
    enabled: item.allowed,
  };
}

function AccountsPage() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const queryClient = useQueryClient();

  // Live account list (real `GET /accounts` or the mock store, per the `accounts`
  // capability). Mapped to display rows; mutations invalidate this query so the
  // table re-reads the source of truth (the read-state/render loop).
  const { data } = useQuery(adminAccountsQuery());
  const rows = React.useMemo(
    () => (data?.accounts ?? []).map(toAccountRow),
    [data],
  );

  const [newOpen, setNewOpen] = React.useState(false);
  const [resetRow, setResetRow] = React.useState<AccountRow | null>(null);

  const createAccount = useMutation(createAdminAccountMutation(queryClient));
  const setEnabled = useMutation(setAdminAccountEnabledMutation(queryClient));
  const resetPassword = useMutation(
    resetAdminAccountPasswordMutation(queryClient),
  );

  function handleToggleEnabled(row: AccountRow) {
    setEnabled.mutate({ id: row.id, allowed: !row.enabled });
  }

  function handleCreate(account: {
    email: string;
    name: string;
    role: AccountRole;
    initialMethod: "password" | "otp";
    password: string;
  }) {
    createAccount.mutate(
      {
        email: account.email,
        name: account.name,
        role: account.role,
        initialCredential:
          account.initialMethod === "password" ? "password" : "otp-only",
        ...(account.initialMethod === "password"
          ? { password: account.password }
          : {}),
      },
      { onSuccess: () => setNewOpen(false) },
    );
  }

  function handleReset(password: string) {
    if (!resetRow) return;
    resetPassword.mutate(
      { id: resetRow.id, password },
      { onSuccess: () => setResetRow(null) },
    );
  }

  return (
    <SidebarProvider
      style={{ "--sidebar-width": "228px" } as React.CSSProperties}
      className="min-h-screen"
    >
      <AppSidebar pathname={pathname} />
      <SidebarInset className="min-w-0 bg-transparent px-[clamp(18px,3vw,40px)] pt-[18px] pb-[68px] max-[821px]:px-[14px] max-[821px]:pb-[94px]">
        <Topbar />

        {/* screen-header with action */}
        <section className="mb-[18px] flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-mono text-xs font-semibold text-muted-foreground">
              账户
            </div>
            <h1 className="max-w-[880px] text-[clamp(24px,3vw,32px)] font-semibold leading-[1.18] tracking-[-0.8px] text-foreground">
              账号管理
            </h1>
            <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
              在此统一启用 / 禁用所有本地账号：邮箱 + 密码 / 邮箱验证码由管理员开通。平台不开放公开注册。角色只控制后台权限，不隔离执行——所有启用账号都是
              host-root。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setNewOpen(true)}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            新建账号
          </button>
        </section>

        <AccountsTable
          rows={rows}
          onToggleEnabled={handleToggleEnabled}
          onResetPassword={(row) => setResetRow(row)}
        />
      </SidebarInset>
      <MobileNav pathname={pathname} />

      <NewAccountDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreate={handleCreate}
      />
      <ResetPasswordDialog
        row={resetRow}
        onReset={handleReset}
        onOpenChange={(open) => {
          if (!open) setResetRow(null);
        }}
      />
    </SidebarProvider>
  );
}

const dialogFieldLabel = "text-[13px] font-semibold text-foreground";
const dialogHint = "text-xs leading-[1.6] text-muted-foreground";
const revealButton =
  "inline-flex min-h-9 shrink-0 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring transition-colors hover:bg-secondary/80";

/** 新建账号 dialog (admin create; design `#new-account-dialog`). */
function NewAccountDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (account: {
    email: string;
    name: string;
    role: AccountRole;
    initialMethod: "password" | "otp";
    password: string;
  }) => void;
}) {
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<AccountRole>("member");
  const [initialMethod, setInitialMethod] = React.useState<"password" | "otp">(
    "password",
  );
  const [tempPw, setTempPw] = React.useState("");
  const [reveal, setReveal] = React.useState(false);

  // Reset the draft each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setRole("member");
      setInitialMethod("password");
      setTempPw("");
      setReveal(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>新建私有账号</DialogTitle>
          <DialogDescription>
            仅管理员可创建。新账号默认启用，可用密码或邮箱验证码登录；平台不开放公开注册。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3.5">
          <div className="grid gap-2">
            <label htmlFor="na-email" className={dialogFieldLabel}>
              邮箱
            </label>
            <Input
              id="na-email"
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <label htmlFor="na-name" className={dialogFieldLabel}>
              显示名称
            </label>
            <Input
              id="na-name"
              placeholder="用于审计与界面展示"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <label htmlFor="na-role" className={dialogFieldLabel}>
              角色
            </label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as AccountRole)}
            >
              <SelectTrigger id="na-role" className="min-h-10 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">成员</SelectItem>
                <SelectItem value="admin">管理员</SelectItem>
              </SelectContent>
            </Select>
            <small className={dialogHint}>
              管理员可进入「账号管理」；角色不改变执行权限，启用账号均为 host-root。
            </small>
          </div>
          <div className="grid gap-2">
            <span className={dialogFieldLabel}>初始登录方式</span>
            <label className="flex items-start gap-2.5 rounded-md bg-[#fafafa] p-3 shadow-ring">
              <input
                type="radio"
                name="na-init"
                className="mt-0.5"
                checked={initialMethod === "password"}
                onChange={() => setInitialMethod("password")}
              />
              <span>
                <strong className="text-[13px] font-semibold text-foreground">
                  设置初始密码
                </strong>
                <br />
                <span className={dialogHint}>
                  管理员设定临时密码，用户首次登录强制改密。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5 rounded-md bg-[#fafafa] p-3 shadow-ring">
              <input
                type="radio"
                name="na-init"
                className="mt-0.5"
                checked={initialMethod === "otp"}
                onChange={() => setInitialMethod("otp")}
              />
              <span>
                <strong className="text-[13px] font-semibold text-foreground">
                  仅邮箱验证码
                </strong>
                <br />
                <span className={dialogHint}>
                  不设密码，用户用邮件验证码登录（需已配置 SMTP），可日后自行设置密码。
                </span>
              </span>
            </label>
          </div>
          {initialMethod === "password" ? (
            <div className="grid gap-2">
              <label htmlFor="na-pw" className={dialogFieldLabel}>
                临时密码
              </label>
              <div className="flex flex-nowrap items-center gap-2">
                <Input
                  id="na-pw"
                  type={reveal ? "text" : "password"}
                  placeholder="至少 12 位，含大小写与数字"
                  value={tempPw}
                  onChange={(e) => setTempPw(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  className={revealButton}
                >
                  {reveal ? "隐藏" : "显示"}
                </button>
              </div>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
          >
            取消
          </button>
          <button
            type="button"
            disabled={
              !email.trim() || (initialMethod === "password" && !tempPw)
            }
            onClick={() =>
              onCreate({ email, name, role, initialMethod, password: tempPw })
            }
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            创建账号
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 重置密码 dialog (local accounts; design `#reset-pw-dialog`). */
function ResetPasswordDialog({
  row,
  onReset,
  onOpenChange,
}: {
  row: AccountRow | null;
  onReset: (password: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [newPw, setNewPw] = React.useState("");
  const [reveal, setReveal] = React.useState(false);

  React.useEffect(() => {
    if (row) {
      setNewPw("");
      setReveal(false);
    }
  }, [row]);

  return (
    <Dialog open={row != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>
            为该账号设置新的临时密码，用户下次登录需改密。
            {row ? `（${row.identity}）` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3.5">
          <div className="grid gap-2">
            <label htmlFor="rp-pw" className={dialogFieldLabel}>
              新临时密码
            </label>
            <div className="flex flex-nowrap items-center gap-2">
              <Input
                id="rp-pw"
                type={reveal ? "text" : "password"}
                placeholder="至少 12 位，含大小写与数字"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                className={revealButton}
              >
                {reveal ? "隐藏" : "显示"}
              </button>
            </div>
          </div>
          <p className={cn(dialogHint, "m-0")}>
            重置后旧密码立即失效；该账号现有会话将在下次请求时被要求重新登录。
          </p>
        </DialogBody>
        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!newPw}
            onClick={() => onReset(newPw)}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            重置密码
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
