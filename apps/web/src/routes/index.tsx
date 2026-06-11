/**
 * `/` — 营销落地 Landing (standalone, SSR; console-design-pixel-merge Track 5;
 * session-awareness + polish per auth-redirects-and-landing).
 *
 * The public marketing page. It is a top-level route (NOT under `_app`), so the
 * auth gate never runs here and it ships its OWN chrome via the configurable
 * `LandingNav`.
 *
 * Design-revision merge (Track 5): the hero's right column is the LIVE
 * `RunnerCapsule` demo (the React port of the design's `runner-capsule.js`
 * Web Component — SSR-safe, reduced-motion-first), replacing the former static
 * `HeroPreview`; the `#workflow` section is the design's two-column
 * operator-layout — the `process-rail` (4 numbered steps) in the main card and
 * the `boundary-ledger` aside carrying the `#security` anchor (the nav 权限 and
 * footer 安全模型 links keep resolving there).
 *
 * SESSION-AWARE (auth-redirects-and-landing): the page reads the auth session
 * and adapts its entries WITHOUT a hydration mismatch — the SSR/first paint
 * renders the UNAUTHENTICATED state (login CTA), and after client mount it
 * reconciles to the authenticated affordances: the "进入控制台" CTA →
 * `/dashboard` AND the nav account chip (avatar/initials + GitHub login,
 * verify-reopened V1). The console entries (nav "控制台", hero primary)
 * therefore never silently dead-bounce through the gate: anonymous → `/login`;
 * authenticated → `/dashboard`.
 *
 * Anchors: in-page links stay real `<a href="#…">` targets with `scroll-mt-20`
 * clearing the fixed 64px nav; a mount-scoped effect sets
 * `scroll-behavior: smooth` on the document root (cleaned up on unmount) so
 * the anchor jumps are smooth without leaking the behavior to console routes.
 *
 * CJK line breaks: the display heading uses `word-break: keep-all` plus
 * explicit `<br>` breakpoints (the design's pattern), so words like 操作者
 * never split mid-token.
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
  type LandingNavCta,
  type LandingNavAccount,
} from "@/components/shell/landing-nav";
import { LandingFooter } from "@/components/landing/landing-footer";
import { RunnerCapsule } from "@/components/landing/runner-capsule";
import { ProofGrid, ProofTile } from "@/components/landing/proof-tile";
import { TrustStrip } from "@/components/landing/trust-strip";
import { BoundaryLedger, LedgerRow } from "@/components/landing/feature-card";
import { ProcessRail, WorkflowStep } from "@/components/landing/workflow-step";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

/** Access-mode trust pills (verbatim design copy). */
const TRUST_PILLS = [
  "GitHub OAuth 白名单",
  "GitHub 账号仓库导入",
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
  // document root (the page scroller) and restored on unmount.
  React.useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "smooth";
    return () => {
      root.style.scrollBehavior = previous;
    };
  }, []);

  // The console entry routes to the dashboard when authed, else to login — so an
  // anonymous click never silently bounces through the `_app` gate.
  const consoleTarget = authed ? "/dashboard" : "/login";

  const navLinks: readonly LandingNavLink[] = [
    { label: "流程", href: "#workflow" },
    { label: "权限", href: "#security" },
    { label: "控制台", to: consoleTarget },
  ];
  const navCta: LandingNavCta = authed
    ? { label: "进入控制台", to: "/dashboard" }
    : { label: "GitHub 登录", to: "/login" };
  // Account affordance (verify-reopened V1): identity chip beside the CTA once
  // the session is known. Client-only by construction (`authed` is mount-gated),
  // so the SSR/first-paint nav stays anonymous — same invariant as the CTA swap.
  const navAccount: LandingNavAccount | undefined =
    authed && session
      ? { login: session.login, avatarUrl: session.avatarUrl || undefined }
      : undefined;

  return (
    <>
      <LandingNav links={navLinks} cta={navCta} account={navAccount} />

      <main>
        {/* Hero */}
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
                GitHub OAuth 只负责确认身份；仓库导入决定 Agent
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
                      <Link to="/login">使用 GitHub 登录</Link>
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

              {/* Subtle scroll cue into the workflow section. */}
              <a
                href="#workflow"
                className="mt-7 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-ink"
              >
                <span aria-hidden="true">↓</span> 向下了解操作者流程
              </a>
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

          {/* Proof tiles — full-width band under the hero pair. */}
          <div className="mt-3">
            <ProofGrid>
              <ProofTile label="ACCESS" title="单用户白名单">
                没有公开注册入口，所有控制台行为都归属于一个 GitHub 身份。
              </ProofTile>
              <ProofTile label="CONTROL" title="任务级终端">
                CLI 不全局暴露，只能从具体 task 进入、暂停和复制。
              </ProofTile>
              <ProofTile label="SAFETY" title="写入前停顿">
                commit、push、secret 和 PR 创建前必须由操作者确认。
              </ProofTile>
            </ProofGrid>
          </div>
        </section>

        {/* Operator layout: process-rail (#workflow) + boundary-ledger (#security) */}
        <section
          id="workflow"
          className="mx-auto max-w-[1240px] scroll-mt-20 px-[clamp(16px,4vw,40px)] py-[clamp(42px,6vw,72px)]"
        >
          <div className="grid items-start gap-3 min-[1181px]:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
            {/* Main card — the operator model + process rail. */}
            <div className="min-w-0 rounded-md bg-card p-[clamp(24px,3vw,36px)] shadow-ring">
              <div className="font-mono text-xs font-semibold text-muted-foreground">
                操作者模型
              </div>
              <h2 className="mt-2 max-w-[720px] text-[clamp(24px,3vw,32px)] leading-[1.18] font-semibold tracking-[-0.8px] text-foreground [text-wrap:balance]">
                不是“放任 Agent 跑”，而是把每一次远端执行收进可控路径。
              </h2>
              <p className="mt-3.5 max-w-[680px] text-base leading-[1.7] text-muted-foreground">
                流程只保留四个动作：确认身份、限定仓库、分配
                runner、接管会话。右侧账本同步说明每一步的控制边界。
              </p>

              <ProcessRail>
                <WorkflowStep
                  index="01"
                  title="GitHub 身份进入控制台"
                  meta={["OAuth", "Allowlist"]}
                >
                  首次进入完成 OAuth
                  登录；非白名单账号停在拒绝访问状态，不进入任何控制台资源。
                </WorkflowStep>
                <WorkflowStep
                  index="02"
                  title="导入仓库形成可触达范围"
                  meta={["Repo scope", "Branch aware"]}
                >
                  控制台只展示已导入仓库；新增仓库从当前 GitHub
                  账号拉取，Agent 不直接扫描全部账号资产。
                </WorkflowStep>
                <WorkflowStep
                  index="03"
                  title="任务分配到空闲 runner"
                  current
                  meta={["Queue", "Runner lease", "xterm.js"]}
                >
                  任务进入队列后由控制面分配到可用远端 runner；runner
                  再挂载仓库、注入身份并启动 CLI 会话。
                </WorkflowStep>
                <WorkflowStep
                  index="04"
                  title="操作者接管关键动作"
                  meta={["Take over", "Audit trail"]}
                >
                  commit、push、secret、PR
                  创建等写入动作前停顿确认；历史页保留任务、命令和 GitHub 事件。
                </WorkflowStep>
              </ProcessRail>

              <div className="mt-7 flex flex-wrap items-center justify-between gap-3.5 border-t border-line pt-[18px] text-[13px] text-muted-foreground">
                <span>当前设计重点：控制面先分配，runner 内再执行。</span>
                <code className="rounded bg-[#fafafa] px-1.5 py-[3px] font-mono text-xs text-foreground">
                  task → runner lease → operator takeover
                </code>
              </div>
            </div>

            {/* Boundary ledger — carries the #security anchor. */}
            <BoundaryLedger
              id="security"
              eyebrow="控制边界"
              title="入口对应限制面。"
              action={
                <Button
                  asChild
                  className="bg-card text-foreground shadow-ring hover:bg-secondary"
                >
                  <Link to="/login">检查登录</Link>
                </Button>
              }
            >
              <LedgerRow
                tone="active"
                ledgerKey="Access"
                title="白名单 GitHub 身份"
                state="required"
              >
                登录是权限边界，不是营销入口。
              </LedgerRow>
              <LedgerRow ledgerKey="Scope" title="已导入仓库" state="bounded">
                Agent 只能从仓库范围和分支上下文开始执行。
              </LedgerRow>
              <LedgerRow
                ledgerKey="Runtime"
                title="远端 runner 租约"
                state="leased"
              >
                任务分配到空闲 runner，完成后回收到运行池。
              </LedgerRow>
              <LedgerRow
                tone="critical"
                ledgerKey="Write gate"
                title="写入前确认"
                state="manual"
              >
                高风险 Git 和 Secret 动作必须先停住，等待操作者接管。
              </LedgerRow>
              <LedgerRow
                ledgerKey="Audit"
                title="任务与事件回放"
                state="recorded"
              >
                命令、Agent 输出和 GitHub 事件进入历史日志。
              </LedgerRow>
            </BoundaryLedger>
          </div>
        </section>

        <LandingFooter />
      </main>
    </>
  );
}
