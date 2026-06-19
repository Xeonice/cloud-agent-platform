/**
 * `MobileNav` — the fixed bottom navigation bar shown only at ≤820px (task 11.2
 * / 11.5).
 *
 * Replaces the desktop sidebar on small screens (the sidebar is
 * `max-[821px]:hidden`; this bar is `hidden max-[821px]:grid`). Four equal
 * cells: 控制台 / 仓库 / 历史 as `Link`s, plus 账户 which reuses `AccountMenu`
 * in its compact `mobile` variant (its DropdownMenu opens upward).
 *
 * Active highlighting reuses the same pure `activeNavKey` helper as the sidebar
 * so a session/create route still lights 控制台.
 *
 * SSR-safe: derives state from the router pathname; no client-only access.
 *
 * Fidelity (prototype `.mobile-nav` FINAL values): fixed inset 12px, z-30, grid
 * of 4, gap 4px, p-1.5, rounded-[18px] (the ≤820px breakpoint override — the
 * only width at which this bar is visible), white@92% + blur, 1px ring + soft
 * drop shadow; active cell = dark pill + white text.
 */
import { Link } from "@tanstack/react-router";

import { cn } from "@/utils";
import { AccountMenu } from "@/components/shell/account-menu";
import { activeNavKey, type NavKey } from "@/components/shell/app-sidebar";

interface MobileNavEntry {
  key: NavKey;
  to: "/dashboard" | "/repositories" | "/history" | "/api";
  label: string;
}

const MOBILE_ENTRIES: readonly MobileNavEntry[] = [
  { key: "dashboard", to: "/dashboard", label: "控制台" },
  { key: "repositories", to: "/repositories", label: "仓库" },
  { key: "history", to: "/history", label: "历史" },
  { key: "api", to: "/api", label: "API" },
];

export interface MobileNavProps {
  /** The current pathname, used to compute the active nav cell. */
  pathname: string;
}

export function MobileNav({ pathname }: MobileNavProps) {
  const active = activeNavKey(pathname);

  return (
    <nav
      aria-label="移动端导航"
      className={cn(
        "fixed inset-x-3 bottom-3 z-30 hidden grid-cols-4 gap-1 p-1.5 max-[821px]:grid",
        "rounded-[18px] bg-[rgba(255,255,255,0.92)] backdrop-blur-md",
        "shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_18px_48px_-28px_rgba(0,0,0,0.14)]",
      )}
    >
      {MOBILE_ENTRIES.map((entry) => {
        const isActive = active === entry.key;
        return (
          <Link
            key={entry.key}
            to={entry.to}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "grid min-h-11 place-items-center rounded-lg text-[11px] font-semibold",
              isActive
                ? "bg-dark-pill text-background"
                : "text-muted-foreground",
            )}
          >
            {entry.label}
          </Link>
        );
      })}
      <AccountMenu variant="mobile" />
    </nav>
  );
}
