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
 * is redirected to `/login` BEFORE the shell renders. The decision is deferred
 * to the client — the server can neither read the client gate (sessionStorage)
 * nor forward a cross-origin session cookie, so a server-side check would false-
 * redirect during SSR. On the client it reads the real session query when `auth`
 * is capable, else the mock gate.
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
    // Server can't read the client gate (sessionStorage) nor forward a cross-
    // origin session cookie, so defer the decision to the client to avoid a
    // false redirect during SSR.
    if (typeof document === "undefined") return;
    let authed: boolean;
    if (isAuthCapable()) {
      const session = await context.queryClient.ensureQueryData(
        authSessionQuery(),
      );
      authed = session != null;
    } else {
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
