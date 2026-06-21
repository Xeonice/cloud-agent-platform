/**
 * `/help/forge-tokens` — the in-console "如何申请代码托管令牌" help page
 * (add-forge-token-help-docs). Renders trusted, app-authored markdown
 * (`content/forge-tokens.md`, imported at build time via Vite `?raw`) documenting,
 * per forge (GitHub / GitLab / Gitee), a human web-link path and an agent terminal
 * path to mint a token with the scopes the forge-credentials connect flow needs.
 *
 * Reached contextually from the settings forge-credentials card (per-row + in-dialog
 * links), NOT from a global nav slot. It does NOT rebuild the shell — it renders
 * inside the `_app` `<Outlet/>` (sidebar / topbar / mobile-nav already exist) and so
 * inherits the auth gate, exactly like dashboard / settings / api.
 *
 * The markdown headings carry slugified ids (`#github` / `#gitlab` / `#gitee` — the
 * canonical forge kinds), so a `#<kind>` deep link from the card lands on the
 * matching section; a client-only effect scrolls the targeted section into view.
 *
 * SSR-safe: content is a build-time string (no fetch); the only browser access is
 * the hash-scroll effect, which runs client-side in `useEffect`.
 */
import * as React from "react";
import { createFileRoute, useLocation } from "@tanstack/react-router";

import forgeTokensMd from "@/content/forge-tokens.md?raw";
import { Markdown } from "@/components/markdown/markdown";

export const Route = createFileRoute("/_app/help/forge-tokens")({
  component: ForgeTokensHelpPage,
});

function ForgeTokensHelpPage() {
  const { hash } = useLocation();

  // Scroll the targeted forge section into view on a `#<kind>` deep link (client
  // only — the headings get their slug ids from the markdown renderer).
  React.useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.replace(/^#/, ""));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash]);

  return (
    <>
      <section className="mb-[18px] grid items-end gap-4">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            帮助
          </div>
          <h1 className="max-w-[880px] text-[clamp(24px,3vw,32px)] leading-[1.18] font-semibold tracking-[-0.8px] text-foreground">
            如何申请代码托管令牌
          </h1>
          <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
            连接 GitHub / GitLab / Gitee 所需访问令牌的申请步骤 —— 每个平台都给网页一键创建与终端（Agent）两种方式。
          </p>
        </div>
      </section>

      <section className="rounded-xl bg-card p-6 shadow-ring">
        <Markdown source={forgeTokensMd} />
      </section>
    </>
  );
}
