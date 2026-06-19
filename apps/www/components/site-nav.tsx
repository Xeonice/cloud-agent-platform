import * as React from "react";

import { Button } from "@/components/button";
import { Container } from "@/components/container";
import { LanguageToggle } from "@/components/language-toggle";
import type { Locale, NavContent } from "../content";
import { resolveTokens } from "../lib/site-config";

/**
 * Site nav (task 4.5) — a sticky, hairline-bottomed top bar: brand wordmark,
 * in-page anchor links, the language toggle, and the primary CTA. Anchor hrefs
 * are in-page (`#features`, …); the CTA / any external hrefs are token-resolved.
 * The language toggle is the only icon-light control and carries an accessible
 * group label (a11y bar, task 4.6).
 */
export function SiteNav({
  nav,
  locale,
  languageToggleLabel,
}: {
  nav: NavContent;
  locale: Locale;
  languageToggleLabel: string;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-bg/80 backdrop-blur">
      <Container as="nav" className="flex h-16 items-center justify-between gap-4">
        <a
          href={`/${locale}`}
          className="cursor-pointer font-mono text-sm font-semibold tracking-tight text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          cloud-agent-platform
        </a>

        <div className="hidden items-center gap-6 md:flex">
          {nav.links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="cursor-pointer text-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <LanguageToggle locale={locale} label={languageToggleLabel} />
          <Button asChild size="sm" className="hidden sm:inline-flex">
            <a href={resolveTokens(nav.cta.href)} className="cursor-pointer">
              {nav.cta.label}
            </a>
          </Button>
        </div>
      </Container>
    </header>
  );
}
