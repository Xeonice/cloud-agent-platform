import * as React from "react";

import { Container } from "@/components/container";
import type { FooterContent } from "../content";
import { resolveTokens } from "../lib/site-config";

/**
 * Site footer (task 4.5) — tagline, the link group (in-page anchors + the
 * external GitHub link, token-resolved), and the legal/disclosure line that
 * keeps the host-root posture visible even at the bottom of the page. External
 * links open in a new tab with `rel="noreferrer noopener"`.
 */
function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function SiteFooter({ footer }: { footer: FooterContent }) {
  return (
    <footer className="border-t border-hairline py-12">
      <Container className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-sm">
          <p className="font-mono text-sm font-semibold tracking-tight text-fg">
            cloud-agent-platform
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {footer.tagline}
          </p>
        </div>

        <nav className="flex flex-wrap gap-x-6 gap-y-3" aria-label="Footer">
          {footer.links.map((link) => {
            const href = resolveTokens(link.href);
            const external = isExternal(href);
            return (
              <a
                key={href}
                href={href}
                {...(external
                  ? { target: "_blank", rel: "noreferrer noopener" }
                  : {})}
                className="cursor-pointer text-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                {link.label}
              </a>
            );
          })}
        </nav>
      </Container>

      <Container className="mt-10">
        <p className="border-t border-hairline pt-8 text-xs leading-relaxed text-muted">
          {footer.legal}
        </p>
      </Container>
    </footer>
  );
}
