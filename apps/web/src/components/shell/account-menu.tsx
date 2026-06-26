/**
 * `AccountMenu` — the operator identity control (task 11.2).
 *
 * Shared by BOTH the desktop sidebar footer (the prototype "private card") and
 * the mobile bottom-nav "账户" cell, selected via the `variant` prop. Identity
 * is read from `authSessionQuery` so the same render path serves the mock gate
 * and the real backend session; it NEVER renders empty — login + initials fall
 * back to `ALLOWED_ACCOUNT` ("tanghehui") when the session has
 * not yet resolved.
 *
 * Built on shadcn `DropdownMenu` (Radix), which supplies Esc-to-close,
 * outside-click dismissal, `aria-haspopup="menu"`, `aria-expanded`, and
 * focus-return for free — so this component adds no manual keyboard/focus
 * wiring. The menu opens UPWARD (`side="top"`), matching the prototype's
 * `bottom: calc(100% + 8px)` popover anchor.
 *
 * SSR-safe: the trigger renders deterministically on the server (it shows the
 * fallback identity until the client query resolves); `logout()` and
 * `navigate()` only fire from the user-driven `onSelect` handler.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import { authSessionQuery } from "@/lib/api/queries";
import { ALLOWED_ACCOUNT, logout } from "@/lib/mock-session";
import { useIsAdmin } from "@/hooks/use-account-menu";
import { cn } from "@/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Which trigger surface to render: the sidebar private card or the mobile cell. */
export type AccountMenuVariant = "sidebar" | "mobile";

export interface AccountMenuProps {
  /** Trigger surface. `sidebar` = the full private card; `mobile` = a compact bottom-nav cell. */
  variant?: AccountMenuVariant;
}

/**
 * Derive a 2-letter avatar fallback from a display name's words (e.g.
 * "Tang Hehui" -> "TH"). Falls back to the first two letters of the login, and
 * finally to the static "TH" so the avatar is never blank.
 */
function deriveInitials(name: string | null | undefined, login: string): string {
  const fromName = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  if (fromName.length >= 1) return fromName;
  const fromLogin = login.trim().slice(0, 2).toUpperCase();
  return fromLogin.length >= 1 ? fromLogin : "TH";
}

export function AccountMenu({ variant = "sidebar" }: AccountMenuProps) {
  const navigate = useNavigate();
  const { data: session } = useQuery(authSessionQuery());
  // The 账号管理 entry is admin-only (the administration page is restricted to
  // admins; a non-admin is 403'd server-side regardless). UX-gate it here.
  const isAdmin = useIsAdmin();

  // Never render empty: fall back to the mock account identity until the
  // session query resolves (and on the server, where the client gate is unread).
  const login = session?.login ?? ALLOWED_ACCOUNT;
  const initials = deriveInitials(session?.name, login);
  const avatarUrl = session?.avatarUrl ?? undefined;

  async function handleLogout() {
    await logout();
    // The public landing is the logged-out home (it is session-aware and shows the
    // login CTA there), so sign-out returns to `/` rather than `/login`.
    navigate({ to: "/" });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "sidebar" ? (
          <button
            type="button"
            className={cn(
              "grid w-full min-h-[46px] grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md p-2 text-left",
              "transition-[background,box-shadow] hover:bg-[#f4f4f4] hover:shadow-ring focus-visible:bg-[#f4f4f4] focus-visible:shadow-ring focus-visible:outline-none",
            )}
          >
            <Avatar size="sm" className="size-7">
              <AvatarImage src={avatarUrl} alt={login} />
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className="grid min-w-0 gap-[3px]">
              <strong className="overflow-hidden text-[13px] font-semibold leading-tight text-ellipsis whitespace-nowrap text-foreground">
                {login}
              </strong>
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs leading-tight whitespace-nowrap text-muted-foreground">
                <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                会话已验证
              </span>
            </span>
            <span className="font-mono text-[11px] text-muted-foreground" aria-hidden="true">
              ⌄
            </span>
          </button>
        ) : (
          <button
            type="button"
            className={cn(
              "grid min-h-11 place-items-center rounded-lg text-[11px] font-semibold text-muted-foreground",
              "data-[state=open]:bg-dark-pill data-[state=open]:text-background",
            )}
          >
            账户
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-(--radix-dropdown-menu-trigger-width)">
        <DropdownMenuItem asChild>
          <Link to="/settings">打开设置</Link>
        </DropdownMenuItem>
        {isAdmin ? (
          <DropdownMenuItem asChild>
            <Link to="/accounts">账号管理</Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void handleLogout()}>
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
