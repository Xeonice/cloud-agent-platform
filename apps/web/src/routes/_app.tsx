/**
 * `_app` — pathless app-shell layout + auth gate (tasks 11.1 / 11.3 / 11.5).
 *
 * Wraps every authenticated console page (dashboard / repositories / history /
 * settings / tasks) in the cohesive shell: a fixed left `AppSidebar`, a sticky
 * `Topbar`, the routed `<Outlet />`, and a `MobileNav` that takes over ≤820px.
 * The pathless segment contributes no URL path.
 *
 * Layout: a shadcn `SidebarProvider` with `--sidebar-width` pinned to 244px and
 * a `Sidebar collapsible="none"` (no collapse — the design ships its own mobile
 * bottom-nav, not the off-canvas sheet). `SidebarInset` is the main content
 * area (the `.console-body .main` canvas: bg `#f8f9fb`, padding
 * `18px clamp(18px,3vw,40px) 68px`, tightened to `18px 14px 94px` ≤820px to
 * clear the fixed mobile nav). Nav highlighting derives from the live pathname.
 *
 * Auth gate (`beforeLoad`, D1): an unauthenticated visitor to ANY `_app` route
 * is redirected to `/login` BEFORE the shell renders.
 *
 *   - REAL OAuth (`auth` capable): the gate resolves the session on BOTH the
 *     server and the client. This is load-bearing: `beforeLoad` does NOT re-run
 *     on the client during hydration of a DIRECT load / refresh / deep-link, so
 *     a client-only check would silently let an unauthenticated visitor land on
 *     a console URL typed/opened directly. The server-side check closes that:
 *     `lib/server-cookie.ts` forwards the browser's session cookie on SSR, and
 *     `getAuthSession` maps the backend's 401 (logged out) to `null`, so the
 *     gate cleanly redirects server-side (a 302) instead of throwing into the
 *     error boundary. Soft (in-app) navigation runs the same check on the client.
 *   - MOCK gate (`auth` NOT capable, local dev): the signal is `sessionStorage`,
 *     which the server cannot read, so the decision is deferred to the client to
 *     avoid a false SSR redirect for a mock-authenticated session.
 */
import {
  createFileRoute,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";

import { authSessionQuery } from "@/lib/api/queries";
import { isAuthCapable, isAuthenticated } from "@/lib/mock-session";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { Topbar } from "@/components/shell/topbar";
import { MobileNav } from "@/components/shell/mobile-nav";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    let authed: boolean;
    if (isAuthCapable()) {
      // Real OAuth: resolve the session on BOTH server and client so a DIRECT
      // load / refresh / deep-link is gated (beforeLoad does not re-run on the
      // client during hydration). On SSR the session cookie is forwarded
      // (lib/server-cookie.ts) and `getAuthSession` maps a 401 to `null`, so an
      // unauthenticated visitor redirects cleanly instead of throwing.
      const session = await context.queryClient.ensureQueryData(
        authSessionQuery(),
      );
      authed = session != null;
    } else {
      // Mock gate: the signal lives in `sessionStorage`, unreadable on the
      // server, so defer to the client to avoid a false SSR redirect.
      if (typeof document === "undefined") return;
      authed = isAuthenticated();
    }
    if (!authed) {
      // Carry the attempted app path so the post-login flow can return the
      // operator here (deep-link). The backend re-validates it via its
      // open-redirect guard. `location.href` is the in-app path (pathname +
      // search), which is exactly what we want to return to.
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <SidebarProvider
      // Pin the sidebar to the prototype's fixed 244px column; no collapse.
      style={{ "--sidebar-width": "244px" } as React.CSSProperties}
      className="min-h-screen bg-[#f8f9fb]"
    >
      <AppSidebar pathname={pathname} />
      <SidebarInset className="min-w-0 bg-transparent px-[clamp(18px,3vw,40px)] pt-[18px] pb-[68px] max-[820px]:px-[14px] max-[820px]:pb-[94px]">
        <Topbar />
        <Outlet />
      </SidebarInset>
      <MobileNav pathname={pathname} />
    </SidebarProvider>
  );
}
