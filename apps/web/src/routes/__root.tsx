/**
 * Root route (rebuild-console-tanstack-start D3 / D4).
 *
 * Emits the HTML document shell: `<HeadContent />` (head tags), `<Outlet />`
 * (matched routes), and `<Scripts />` (hydration). It also:
 *   - links the app's Tailwind v4 stylesheet (`src/styles/app.css`);
 *   - renders a Sonner `<Toaster />` placeholder (toasts wired in later tracks);
 *   - injects an inline, pre-hydration theme script (FOUC guard, D4.7) — kept
 *     light-only for now (chrome is light; only the terminal is dark), but the
 *     hook is in place so the synthesized `.dark` set can be activated later.
 *
 * The route context carries the per-request `QueryClient` (see `router.tsx`),
 * so loaders and components can reach Query without a module singleton.
 */
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Toaster } from "sonner";

import { AppErrorComponent, AppNotFound } from "@/components/app-error";
import { runtimeEndpointConfigScript } from "@/lib/config";
import appCss from "../styles/app.css?url";

export interface RootRouteContext {
  queryClient: QueryClient;
}

/**
 * Pre-hydration theme script (D4.7). Runs before React hydrates to set the
 * theme class on <html>, preventing a flash of the wrong theme. App chrome is
 * light-only this round; the terminal scope handles its own dark palette. The
 * `.dark` set exists but is not toggled until a later track ships a switch.
 */
const themeScript = `(() => {
  try {
    document.documentElement.classList.remove('dark');
  } catch (_) {}
})();`;

export const Route = createRootRouteWithContext<RootRouteContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Agent Control Plane" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  errorComponent: AppErrorComponent,
  notFoundComponent: AppNotFound,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script
          dangerouslySetInnerHTML={{ __html: runtimeEndpointConfigScript() }}
        />
      </head>
      <body>
        {children}
        <Toaster richColors position="top-right" />
        <Scripts />
      </body>
    </html>
  );
}
