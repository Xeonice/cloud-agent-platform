/**
 * `/` — 营销落地 Landing (standalone, SSR; simplify-landing-homepage).
 *
 * The public marketing page, simplified per the OpenDesign "OpenSpec Agent
 * System" revision (`index.html`) to **nav → hero → footer**. It is a top-level
 * route (NOT under `_app`), so the auth gate never runs here and it ships its own
 * chrome via the configurable `LandingNav`.
 *
 * Sections: the landing-nav (brand + the authenticated account affordance), a
 * hero (eyebrow, the CJK display title + subline, lead copy, a session-aware dual
 * CTA, trust-pill chips, and the live `RunnerCapsule` demo — the SSR-safe React
 * port of the design's `runner-capsule.js` Web Component, the `#preview` anchor
 * target for "查看演示"), and the minimal `LandingFooter`. The former proof-tile
 * grid, `#workflow` `process-rail`, and `#security` `boundary-ledger` sections are
 * dropped in this revision, along with every nav/footer anchor that targeted them
 * (no dead anchors).
 *
 * SESSION-AWARE (auth-redirects-and-landing): the page reads the auth session and
 * adapts WITHOUT a hydration mismatch — the SSR/first paint renders the
 * UNAUTHENTICATED state (login CTA), and after client mount it reconciles to the
 * authenticated affordances: the hero primary becomes "进入控制台" → `/dashboard`
 * and the nav shows the account chip. The anonymous primary never silently
 * dead-bounces through the gate (it routes to `/login`); the secondary "查看演示"
 * is an in-page jump to the `#preview` demo.
 *
 * SSR-safe: no window/clock/random in render; the authed swap and the
 * runner-capsule animation upgrade are both gated behind post-mount effects so
 * server and first client paint agree (hydration-warning-free).
 */
import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { authSessionQuery } from "@/lib/api/queries";
import { Button } from "@/components/ui/button";
import {
  LandingNav,
  type LandingNavLink,
  type LandingNavAccount,
} from "@/components/shell/landing-nav";
import { LandingFooter } from "@/components/landing/landing-footer";
import { RunnerCapsule } from "@/components/landing/runner-capsule";
import { TrustStrip } from "@/components/landing/trust-strip";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

/** Access-mode trust pills (verbatim design copy). */
const TRUST_PILLS = [
  "本地账号访问",
  "GitHub PAT 仓库导入",
  "远端 Agent CLI",
] as const;

function LandingPage() {
  // SSR-safe session awareness: render the anonymous state on the server + first
  // client paint, then reconcile to the authenticated affordance after mount.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const { data: session } = useQuery(authSessionQuery());
  const authed = mounted && session != null;

  // Smooth anchor scrolling, scoped to the landing: applied post-mount on the
  // document root (the page scroller) and restored on unmount. The only in-page
  // anchor is the `#preview` runner-capsule demo ("查看演示").
  React.useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "smooth";
    return () => {
      root.style.scrollBehavior = previous;
    };
  }, []);

  // Brand-only nav (the OD revision): no in-page anchor links and NO nav CTA —
  // the login affordance is the hero CTA. The account chip is the only right-side
  // element, and only once the session is known (mount-gated), so the SSR/first
  // paint nav stays anonymous (brand only).
  const navLinks: readonly LandingNavLink[] = [];
  const navAccount: LandingNavAccount | undefined =
    authed && session
      ? {
          // `login` is nullable on the session (a local password/OTP account has
          // no GitHub handle); fall back to the always-present display name.
          login: session.login ?? session.name,
          avatarUrl: session.avatarUrl || undefined,
        }
      : undefined;

  return (
    <>
      <LandingNav links={navLinks} cta={null} account={navAccount} />

      <main>
        {/* Hero — the page's single content section (nav → hero → footer). */}
        <section className="mx-auto max-w-[1240px] px-[clamp(16px,4vw,40px)] pt-[clamp(54px,7vw,92px)] pb-[clamp(42px,6vw,72px)]">
          <div className="grid items-center gap-y-9 min-[1181px]:grid-cols-[minmax(430px,0.92fr)_minmax(520px,1.08fr)] min-[1181px]:gap-x-[clamp(56px,7vw,96px)]">
            {/* Left column — hero copy */}
            <div className="min-w-0 max-w-[540px] max-[1180px]:max-w-[760px]">
              <div className="font-mono text-xs font-semibold text-muted-foreground">
                Private remote agent control
              </div>
              {/* `keep-all` + explicit <br> give controlled CJK line breaks so
                  words like "操作者" never split mid-token (the design pattern). */}
              <h1 className="mt-3.5 mb-[18px] max-w-[540px] text-[clamp(42px,4.4vw,62px)] leading-none font-semibold tracking-[clamp(-2.88px,-0.03em,-1.8px)] text-foreground [word-break:keep-all]">
                一个面向
                <br />
                操作者的远端
                <br />
                Agent 运行池。
                <span className="mt-2 block text-[clamp(27px,3vw,40px)] leading-[1.08] tracking-[clamp(-1.8px,-0.03em,-1px)] text-muted-foreground">
                  把每一次 CLI 会话变成可接管的工作流。
                </span>
              </h1>
              <p className="max-w-[520px] text-[clamp(18px,2.1vw,22px)] leading-[1.68] text-muted-foreground">
                本地账号确认谁能进入控制台；PAT 仓库导入决定 Agent
                能碰什么；任务队列负责调度；实时终端把最后的控制权留给你。
              </p>

              <div className="mt-7 flex flex-wrap items-center gap-3">
                {authed ? (
                  // Authenticated: a single clear primary into the console.
                  <Button asChild>
                    <Link to="/dashboard">进入控制台</Link>
                  </Button>
                ) : (
                  <>
                    <Button asChild>
                      <Link to="/login">登录控制台</Link>
                    </Button>
                    {/* Secondary is a non-bouncing in-page jump to the demo, not
                        a console route that the gate would silently reject. */}
                    <Button
                      asChild
                      className="bg-card text-foreground shadow-ring hover:bg-secondary"
                    >
                      <a href="#preview">查看演示</a>
                    </Button>
                  </>
                )}
              </div>

              <TrustStrip items={TRUST_PILLS} />
            </div>

            {/* Right column — the live runner-capsule demo, anchor target for
                "查看演示". */}
            <div
              id="preview"
              className="w-full min-w-0 scroll-mt-20 max-[1180px]:max-w-[720px] min-[1181px]:w-[min(100%,600px)] min-[1181px]:justify-self-end"
            >
              <RunnerCapsule />
            </div>
          </div>
        </section>

        <LandingFooter />
      </main>
    </>
  );
}
