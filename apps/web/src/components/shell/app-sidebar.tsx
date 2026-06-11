/**
 * `AppSidebar` — the console's fixed left navigation column (task 11.1 / 11.5).
 *
 * Renders the prototype `.sidebar`: a sticky, full-height white/blurred column
 * with a brand link, the three-item product nav, and the `AccountMenu` private
 * card anchored at the bottom. Built on shadcn `Sidebar collapsible="none"` —
 * the design has NO collapse and ships its own mobile bottom-nav (see
 * `MobileNav`), so the shadcn off-canvas sheet is intentionally disabled. The
 * whole column is hidden at ≤820px (`max-[821px]:hidden`), where `MobileNav`
 * takes over.
 *
 * Active highlighting is computed from the current pathname via the pure
 * `activeNavKey` helper (exported for unit tests): a session/create route still
 * lights the 任务控制台 (dashboard) item.
 *
 * SSR-safe: nav state derives from the router pathname (available on the
 * server); no window/clock/random access during render.
 *
 * Fidelity (prototype audit-refinement `.console-body` FINAL values, resolved
 * across the cascading override blocks): padding 14px, white@90% + blur(18px),
 * right-edge inset hairline; nav item min-h 36px + rounded-md (from the last
 * override) with font-size 13px + padding 0 9px (from the highest-specificity
 * block that sets them); muted text; ACTIVE = solid dark pill (#171717) + white
 * text with the shortcut hint dimmed to white/60.
 */
import { Link } from "@tanstack/react-router";

import { cn } from "@/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { AccountMenu } from "@/components/shell/account-menu";

/** The product-nav keys; one of these is highlighted per route (task 11.5). */
export type NavKey = "dashboard" | "repositories" | "history";

/**
 * Map the current pathname to the nav key that should be highlighted.
 *
 * Pure + total so it is trivially unit-testable. The dashboard item owns the
 * task surfaces too: `/dashboard`, `/tasks/new`, and `/tasks/:id` all light
 * 任务控制台. `/repositories` → 仓库导入, `/history` → 历史日志. Any other path
 * (e.g. `/settings`) highlights nothing.
 */
export function activeNavKey(pathname: string): NavKey | null {
  if (
    pathname === "/dashboard" ||
    pathname === "/tasks/new" ||
    pathname.startsWith("/tasks/")
  ) {
    return "dashboard";
  }
  if (pathname === "/repositories" || pathname.startsWith("/repositories/")) {
    return "repositories";
  }
  if (pathname === "/history" || pathname.startsWith("/history/")) {
    return "history";
  }
  return null;
}

/** A single product-nav entry. */
interface NavEntry {
  key: NavKey;
  to: "/dashboard" | "/repositories" | "/history";
  label: string;
  shortcut: string;
}

const NAV_ENTRIES: readonly NavEntry[] = [
  { key: "dashboard", to: "/dashboard", label: "任务控制台", shortcut: "⌘1" },
  { key: "repositories", to: "/repositories", label: "仓库导入", shortcut: "⌘2" },
  { key: "history", to: "/history", label: "历史日志", shortcut: "⌘3" },
];

export interface AppSidebarProps {
  /** The current pathname, used to compute the active nav item. */
  pathname: string;
}

export function AppSidebar({ pathname }: AppSidebarProps) {
  const active = activeNavKey(pathname);

  return (
    <Sidebar
      collapsible="none"
      className={cn(
        "sticky top-0 h-screen justify-between p-3.5",
        "bg-[rgba(255,255,255,0.9)] backdrop-blur-md",
        "shadow-[inset_-1px_0_0_var(--border)]",
        "max-[821px]:hidden",
      )}
    >
      <SidebarHeader className="gap-[22px] p-0">
        {/* Brand */}
        <Link
          to="/"
          aria-label="Agent 控制台"
          className="inline-flex items-center gap-2.5 p-1 font-semibold tracking-tight text-foreground"
        >
          <span className="grid size-[26px] place-items-center rounded-md bg-dark-pill font-mono text-xs text-background">
            AC
          </span>
          <span>Agent 控制台</span>
        </Link>

        {/* Product nav */}
        <nav aria-label="产品导航" className="grid gap-1">
          {NAV_ENTRIES.map((entry) => {
            const isActive = active === entry.key;
            return (
              <Link
                key={entry.key}
                to={entry.to}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-9 items-center justify-between rounded-md px-[9px] text-[13px] font-medium",
                  "transition-colors",
                  isActive
                    ? "bg-dark-pill text-background"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <span>{entry.label}</span>
                <span
                  className={cn(
                    "font-mono",
                    isActive ? "text-background/60" : "text-muted-foreground",
                  )}
                >
                  {entry.shortcut}
                </span>
              </Link>
            );
          })}
        </nav>
      </SidebarHeader>

      {/* Spacer pushes the account card to the bottom (justify-between column). */}
      <SidebarContent className="overflow-visible" />

      <SidebarFooter className="p-0">
        <AccountMenu variant="sidebar" />
      </SidebarFooter>
    </Sidebar>
  );
}
