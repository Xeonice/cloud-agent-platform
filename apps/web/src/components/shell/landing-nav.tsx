/**
 * `LandingNav` — standalone marketing/launcher navigation.
 *
 * Reused by the standalone (no-app-shell) routes `/`, `/workspace`, `/resume`.
 * Mirrors the prototype `.landing-nav` markup verbatim (Chinese copy kept
 * full-width), but routes through TanStack `<Link>` instead of `<a href>` so the
 * launcher is a client-side SPA shell.
 *
 * Configurable (task 12.4 reuse): each standalone page passes its OWN nav links
 * + CTA via props, so the same chrome serves both the `/workspace` launcher
 * (产品介绍 / 仓库 / 历史 → 进入工作台) and the `/` marketing landing
 * (流程 / 权限 / 控制台 → GitHub 登录). The props DEFAULT to the workspace
 * (index.html) link-set already in place, so `/workspace` + `/resume` keep
 * working unchanged when they drop in a bare `<LandingNav />`.
 *
 * Link kinds:
 *   - product/CTA targets (a TanStack route `to`) render as SPA `<Link>`.
 *   - same-page anchor targets (`href="#…"`) stay real `<a href>` so the browser
 *     performs native smooth-scroll to the section (paired with `scroll-mt-*` on
 *     the target section to clear this fixed 64px nav).
 *
 * Account affordance (verify-reopened V1): the optional `account` prop renders
 * the authenticated operator's identity (avatar-or-initials + GitHub login)
 * alongside the CTA, per the "Landing is session-aware" scenario. Pages pass it
 * only once the session is known on the client, so the SSR/first-paint markup
 * stays the anonymous state (no hydration mismatch).
 *
 * SSR-safe: pure, deterministic render — no window/document/clock/random access.
 *
 * Fidelity (prototype assets/styles.css `.landing-nav`):
 *   sticky top-0, flex justify-between, min-h 64px, px clamp(16px,4vw,40px),
 *   surface @ 88% + blur(18px), ring (1px shadow border).
 * brand-mark: 26x26 grid, rounded-md, dark-pill bg, white mono 12px text.
 * nav-links: gap 24px, 14px medium ink-soft, hover ink.
 */
import { Link, type LinkProps } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

/** A type-checked TanStack route target (validated against the route tree). */
type RouteTarget = LinkProps["to"];

/**
 * One nav link. Exactly one of `to` (SPA route) or `href` (same-page anchor) is
 * provided; `to` renders a `<Link>`, `href` (a `#…` target) renders an `<a>`.
 */
export type LandingNavLink =
  | { label: string; to: RouteTarget; href?: never }
  | { label: string; href: string; to?: never };

/** The primary CTA button — always an SPA route target. */
export interface LandingNavCta {
  label: string;
  to: RouteTarget;
}

/** The authenticated operator identity shown alongside the CTA. */
export interface LandingNavAccount {
  /** GitHub login (the allowlist identity). */
  login: string;
  /** GitHub avatar URL; falls back to login-derived initials when absent. */
  avatarUrl?: string;
}

export interface LandingNavProps {
  /** Plain text links shown before the CTA. Defaults to the workspace set. */
  links?: readonly LandingNavLink[];
  /** The trailing primary button. Defaults to 进入工作台 → /dashboard. */
  cta?: LandingNavCta;
  /** Authenticated operator identity chip; omitted = anonymous nav. */
  account?: LandingNavAccount;
}

/**
 * Default link-set = the existing `/workspace` (index.html) launcher nav, so
 * pages that render `<LandingNav />` with no props keep their current chrome.
 */
const DEFAULT_LINKS: readonly LandingNavLink[] = [
  { label: "产品介绍", to: "/" },
  { label: "仓库", to: "/repositories" },
  { label: "历史", to: "/history" },
];

const DEFAULT_CTA: LandingNavCta = { label: "进入工作台", to: "/dashboard" };

export function LandingNav({
  links = DEFAULT_LINKS,
  cta = DEFAULT_CTA,
  account,
}: LandingNavProps = {}) {
  return (
    <nav
      data-slot="landing-nav"
      className="sticky top-0 z-20 flex min-h-16 items-center justify-between bg-background/88 px-[clamp(16px,4vw,40px)] shadow-ring backdrop-blur-[18px]"
    >
      <Link
        to="/"
        aria-label="Agent 控制台"
        className="inline-flex items-center gap-2.5 font-semibold tracking-tight text-ink"
      >
        <span className="grid size-[26px] place-items-center rounded-md bg-dark-pill font-mono text-xs text-background">
          AC
        </span>
        <span>Agent 控制台</span>
      </Link>

      <div
        aria-label="产品导航"
        className="flex items-center gap-6 text-sm font-medium text-ink-soft"
      >
        {links.map((link) =>
          link.to !== undefined ? (
            <Link
              key={`${link.label}:${link.to}`}
              to={link.to}
              className="transition-colors hover:text-ink"
            >
              {link.label}
            </Link>
          ) : (
            <a
              key={`${link.label}:${link.href}`}
              href={link.href}
              className="transition-colors hover:text-ink"
            >
              {link.label}
            </a>
          ),
        )}
        {account ? (
          <span
            data-slot="landing-nav-account"
            aria-label={`当前账户 ${account.login}`}
            className="inline-flex items-center gap-2 rounded-full bg-card py-1 pr-2.5 pl-1 shadow-ring"
          >
            {account.avatarUrl ? (
              <img
                src={account.avatarUrl}
                alt=""
                aria-hidden="true"
                className="size-[22px] rounded-full"
              />
            ) : (
              <span
                aria-hidden="true"
                className="grid size-[22px] place-items-center rounded-full bg-dark-pill font-mono text-[10px] text-background"
              >
                {account.login.slice(0, 2).toUpperCase()}
              </span>
            )}
            <span className="font-mono text-xs text-muted-foreground">
              {account.login}
            </span>
          </span>
        ) : null}
        <Button asChild size="sm" className="min-h-[30px] px-2.5 text-xs">
          <Link to={cta.to}>{cta.label}</Link>
        </Button>
      </div>
    </nav>
  );
}
