/**
 * `_app` — pathless app-shell layout + auth gate (tasks 11.1 / 11.3 / 11.5).
 *
 * Wraps every authenticated console page (dashboard / repositories / history /
 * settings / tasks) in the cohesive shell: a fixed left `AppSidebar`, a sticky
 * `Topbar`, the routed `<Outlet />`, and a `MobileNav` that takes over ≤820px.
 * The pathless segment contributes no URL path.
 *
 * Layout: a shadcn `SidebarProvider` with `--sidebar-width` pinned to 228px and
 * a `Sidebar collapsible="none"` (no collapse — the design ships its own mobile
 * bottom-nav, not the off-canvas sheet). `SidebarInset` is the main content
 * area (the `.console-body .main` canvas: the console bg comes from the
 * body-level `var(--console)` rule in app.css — no wrapper bg class; padding
 * `18px clamp(18px,3vw,40px) 68px`, tightened to `18px 14px 94px` ≤820px to
 * clear the fixed mobile nav). Nav highlighting derives from the live pathname.
 *
 * Auth gate (`beforeLoad`, D1): an unauthenticated visitor to ANY `_app` route
 * is redirected to `/login` BEFORE the shell renders.
 *
 *   - REAL auth (`auth` capable): the gate resolves the session on BOTH the
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

import { cn } from "@/utils";
import { authSessionQuery } from "@/lib/api/queries";
import { isAuthCapable, isAuthenticated } from "@/lib/mock-session";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { Topbar } from "@/components/shell/topbar";
import { MobileNav } from "@/components/shell/mobile-nav";
import { UpdateBanner } from "@/components/shell/update-banner";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    let authed: boolean;
    if (isAuthCapable()) {
      // Real auth: resolve the session on BOTH server and client so a DIRECT
      // load / refresh / deep-link is gated (beforeLoad does not re-run on the
      // client during hydration). On SSR the session cookie is forwarded
      // (lib/server-cookie.ts) and `getAuthSession` maps a 401 to `null`, so an
      // unauthenticated visitor redirects cleanly instead of throwing.
      const session = await context.queryClient.ensureQueryData(
        authSessionQuery(),
      );
      // A pending forced password change (D9) blocks the app shell: bounce the
      // operator to the login route's forced-change dialog (carrying the attempted
      // path) instead of rendering the console. The backend independently 403s
      // every protected route for such an account; this turns that into the
      // prescribed forced-change UX on a direct load / refresh / deep-link.
      if (session?.mustChangePassword) {
        throw redirect({
          to: "/login",
          search: { redirect: location.href, change: true },
        });
      }
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

  // The LIVE session page (`/tasks/:id`, NOT `/tasks/new`) is a fixed-height
  // cockpit: it has no topbar AND it pins the content area to the viewport so the
  // terminal fills the space and scrolls INSIDE. Every other page keeps the
  // topbar + the default grow-with-content, document-scroll model.
  const isSession =
    pathname.startsWith("/tasks/") && pathname !== "/tasks/new";

  return (
    <SidebarProvider
      // Pin the sidebar to the cockpit design's fixed 228px column; no collapse.
      style={{ "--sidebar-width": "228px" } as React.CSSProperties}
      // The shell wrapper's min-height MUST use the SAME viewport unit as the
      // session inset's `h-dvh` (below). `min-h-screen` (100vh) is right for the
      // grow-with-content pages, but on the session route the inset is pinned to
      // `h-dvh` (100dvh) — and on MOBILE 100vh (URL-bar-retracted) > 100dvh
      // (current). With the sidebar hidden ≤821px the inset is the wrapper's only
      // in-flow child, so a `min-h-screen` wrapper would stand ~one URL-bar taller
      // than the visible viewport → a spurious OUTER document scroll + a reflow
      // jump as the URL bar collapses. `min-h-dvh` on the session route keeps the
      // wrapper exactly the visible viewport, matching the inset.
      className={cn("min-h-screen", isSession && "min-h-dvh")}
    >
      <AppSidebar pathname={pathname} />
      <SidebarInset
        className={cn(
          "min-w-0 bg-transparent pt-[18px]",
          isSession
            ? "px-[18px] pb-[18px] max-[821px]:px-[14px] max-[821px]:pb-[94px]"
            : "px-[clamp(18px,3vw,40px)] pb-[68px] max-[821px]:px-[14px] max-[821px]:pb-[94px]",
          // Session route: pin the inset to the viewport height so the terminal
          // section (`flex-1 min-h-0`, see `$taskId.tsx`) flexes to fill exactly
          // the space below the page header — no fixed `100dvh − Npx` magic number
          // (which mis-estimated the variable-height header and overflowed the
          // page). The live session owns its scroll inside xterm/replay panes, so
          // the app shell itself stays fixed-height and non-scrolling.
          isSession && "h-dvh overflow-hidden",
        )}
      >
        {/* The cockpit session page (`/tasks/:id`) has NO topbar — its `← 任务控制台`
            crumb is the top chrome (session-cockpit-redesign). `/tasks/new` keeps
            the topbar. Dashboard ≤820px hides the topbar (its mobile-workbench-meta
            strip carries the Runner readout); other pages keep the mobile topbar. */}
        {isSession ? null : (
          <Topbar
            className={
              pathname === "/dashboard" ? "max-[821px]:hidden" : undefined
            }
          />
        )}
        {/* The dismissible "update available" strip (update-availability-check).
            Shown only when the check honestly reports a newer version; absent
            otherwise (it renders nothing on its own). Kept off the fixed-height
            cockpit session route, whose top chrome is its own crumb. */}
        {isSession ? null : <UpdateBanner />}
        <Outlet />
      </SidebarInset>
      <MobileNav pathname={pathname} />
    </SidebarProvider>
  );
}
