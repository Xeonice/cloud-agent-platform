"use client";

/**
 * Language toggle — a Vercel-style dropdown that switches locale by rewriting
 * the URL's locale segment.
 *
 * The site is locale-segmented (`/[locale]/...`, i18n 3.1): the active locale is
 * the first path segment. Switching languages swaps that segment and navigates,
 * which (a) reflects the selected locale in the URL and (b) lands on the
 * statically-exported page for the new locale — satisfying the spec scenario
 * "Language toggle switches locale" with no runtime translation fetch.
 *
 * Shape (Vercel pattern): a hairline trigger button (globe + current language +
 * chevron) opens a small surface popover listing each locale, the active one
 * marked with a check. Each option is a real `next/link` anchor, so the
 * inter-locale links stay in the crawled static HTML and the menu works as a
 * progressive enhancement over them.
 *
 * Motion: the popover fades + scales in from its top-right origin (~150ms) and
 * fades back out — implemented with a persistent element toggled via
 * `visibility`/opacity/transform so BOTH directions animate. `transition-all`
 * carries `visibility` so the fade-out completes before the menu is hidden;
 * `globals.css` zeroes all of this out under `prefers-reduced-motion`.
 *
 * A11y (CRITICAL bar): the trigger is a real `<button>` with
 * `aria-haspopup="menu"` / `aria-expanded`; the menu is `role="menu"` with
 * `role="menuitem"` links; Escape closes and restores focus to the trigger;
 * Arrow/Home/End move between items; outside pointerdown and focus-leave close
 * it. `visibility:hidden` removes the closed menu from the tab order and the
 * accessibility tree, so it is never reachable while closed.
 */
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import {
  LOCALES,
  LOCALE_LABEL,
  LOCALE_HREFLANG,
  isLocale,
  type Locale,
} from "../content";

export interface LanguageToggleProps {
  /** The currently-active locale (resolved from the route segment). */
  readonly locale: Locale;
  /** Accessible label for the control (localized, e.g. "Switch language"). */
  readonly label: string;
  /** Optional extra class names for the wrapping element. */
  readonly className?: string;
}

/**
 * Replace the locale segment of a pathname with `next`, preserving the rest of
 * the path. Falls back to the locale root when the current path has no
 * recognizable locale segment.
 */
export function swapLocaleInPath(pathname: string, next: Locale): string {
  const [, first, ...rest] = pathname.split("/");
  if (first && isLocale(first)) {
    const tail = rest.length ? `/${rest.join("/")}` : "";
    return `/${next}${tail}`;
  }
  // No locale segment yet: prefix the whole path under the new locale.
  const tail = pathname === "/" || pathname === "" ? "" : pathname;
  return `/${next}${tail}`;
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function LanguageToggle({
  locale,
  label,
  className,
}: LanguageToggleProps): React.JSX.Element {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const itemRefs = React.useRef<Array<HTMLAnchorElement | null>>([]);
  const menuId = React.useId();

  // Close on a pointerdown outside the control.
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // On open, move focus into the menu (ARIA menu pattern) — onto the active
  // locale. Programmatic focus after a click does not trigger :focus-visible,
  // so mouse users don't see a stray ring.
  React.useEffect(() => {
    if (!open) return;
    const activeIndex = Math.max(0, LOCALES.indexOf(locale));
    const frame = window.requestAnimationFrame(() => {
      itemRefs.current[activeIndex]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, locale]);

  function onRootKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const items = itemRefs.current;
      const count = LOCALES.length;
      const current = items.findIndex((el) => el === document.activeElement);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next =
        current === -1
          ? event.key === "ArrowDown"
            ? 0
            : count - 1
          : (current + delta + count) % count;
      items[next]?.focus();
      return;
    }
    if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      itemRefs.current[event.key === "Home" ? 0 : LOCALES.length - 1]?.focus();
    }
  }

  // Close when focus leaves the control entirely (e.g. Tab past it).
  function onRootBlur(event: React.FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    if (open) setOpen(false);
  }

  return (
    <div
      ref={rootRef}
      className={cn("relative", className)}
      onKeyDown={onRootKeyDown}
      onBlur={onRootBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-transparent px-2.5 text-xs transition-colors hover:bg-fg/5 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          open ? "bg-fg/5 text-fg" : "text-muted",
        )}
      >
        <GlobeIcon className="h-3.5 w-3.5" />
        <span>{LOCALE_LABEL[locale]}</span>
        <ChevronIcon
          className={cn(
            "h-3.5 w-3.5 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      <div
        id={menuId}
        role="menu"
        aria-label={label}
        className={cn(
          "absolute right-0 top-full z-50 mt-2 min-w-[10rem] origin-top-right rounded-lg border border-hairline bg-surface p-1 shadow-xl shadow-black/50 transition-all duration-150 ease-out",
          open
            ? "visible translate-y-0 scale-100 opacity-100"
            : "invisible -translate-y-1 scale-95 opacity-0",
        )}
      >
        {LOCALES.map((target: Locale, index: number) => {
          const active = target === locale;
          const href = swapLocaleInPath(pathname, target);
          return (
            <Link
              key={target}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              href={href}
              hrefLang={LOCALE_HREFLANG[target]}
              lang={LOCALE_HREFLANG[target]}
              role="menuitem"
              tabIndex={open ? 0 : -1}
              aria-current={active ? "true" : undefined}
              onClick={() => setOpen(false)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-4 rounded-md px-2.5 py-1.5 text-sm transition-colors focus:outline-none focus-visible:bg-fg/5 focus-visible:text-fg",
                active ? "text-fg" : "text-muted hover:bg-fg/5 hover:text-fg",
              )}
            >
              <span>{LOCALE_LABEL[target]}</span>
              {active ? (
                <CheckIcon className="h-4 w-4 shrink-0" />
              ) : (
                <span className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default LanguageToggle;
