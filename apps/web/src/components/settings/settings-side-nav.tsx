/**
 * `SettingsSideNav` — the LEFT sticky group nav of the `/settings` page
 * (rebuild-console-tanstack-start Track 14, task 14.x).
 *
 * The prototype `.settings-side-nav`: a sticky white card listing the four
 * settings groups, each an in-page anchor (`#account` / `#github` / `#codex` /
 * `#safety`) with a strong title + a muted sub-line. Clicking an anchor
 * smooth-scrolls to the matching section (the sections carry `scroll-mt` so the
 * sticky topbar never overlaps the heading).
 *
 * SSR-safe: pure render — anchors are real `<a href="#…">` so server markup is
 * navigable; the smooth-scroll is a CSS concern (`scroll-behavior` on the html /
 * `scroll-margin` on the targets), never a window read during render.
 *
 * Fidelity (audit-refinement `.settings-side-nav` FINAL): sticky top 76; white
 * card radius 10 + card shadow; 12px padding; 4px row gap; eyebrow 4/8/8 pad;
 * each link grid gap 3, padding 10/8, radius 8, hover `#fafafa`; title 13/600;
 * sub-line muted 12/1.35. Collapses to a 4-col grid <1100px, 1-col <820px.
 */
import * as React from "react";

import { cn } from "@/utils";

/** One settings group anchor: stable hash target + verbatim title/sub copy. */
export interface SettingsNavItem {
  /** The in-page hash target (e.g. "account" → href "#account"). */
  id: string;
  /** Strong group title (verbatim prototype copy). */
  title: React.ReactNode;
  /** Muted sub-line (verbatim prototype copy). */
  sub: React.ReactNode;
}

/** The four prototype settings groups, in display order (verbatim copy). */
export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  { id: "account", title: "账户身份", sub: "GitHub OAuth 与访问范围" },
  { id: "github", title: "仓库默认值", sub: "默认仓库、记录保留" },
  { id: "codex", title: "Agent 模型凭据", sub: "官方账号或兼容提供方" },
  { id: "safety", title: "安全边界", sub: "写入前确认策略" },
];

/** The sticky settings group nav (LEFT column of the settings layout). */
export function SettingsSideNav() {
  return (
    <aside
      aria-label="设置分组"
      className={cn(
        "grid gap-1 self-start rounded-lg bg-card p-3 shadow-card",
        "sticky top-[76px]",
        // <1100px: become a 4-col strip; <820px: stack to 1 col.
        "max-[1100px]:grid-cols-4 max-[820px]:grid-cols-1",
      )}
    >
      <span className="px-2 pt-1 pb-2 font-mono text-xs font-semibold text-muted-foreground max-[1100px]:col-span-full">
        Settings
      </span>
      {SETTINGS_NAV_ITEMS.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          className="grid gap-[3px] rounded-md px-2 py-2.5 text-foreground hover:bg-[#fafafa]"
        >
          <strong className="text-[13px] font-semibold">{item.title}</strong>
          <span className="text-xs leading-[1.35] text-muted-foreground">
            {item.sub}
          </span>
        </a>
      ))}
    </aside>
  );
}
