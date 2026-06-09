/**
 * `/` — 营销落地 Landing (standalone, SSR; Track 12 fe-page-landing-login 12.1;
 * session-awareness + polish per auth-redirects-and-landing).
 *
 * The public marketing page. It is a top-level route (NOT under `_app`), so the
 * auth gate never runs here and it ships its OWN chrome via the configurable
 * `LandingNav`.
 *
 * SESSION-AWARE (auth-redirects-and-landing): the page reads the auth session and
 * adapts its entries WITHOUT a hydration mismatch — the SSR/first paint renders
 * the UNAUTHENTICATED state (login CTA), and after client mount it reconciles to
 * the authenticated affordance ("进入控制台" → `/dashboard`). The console entries
 * (nav "控制台", hero primary) therefore never silently dead-bounce through the
 * gate: anonymous → `/login`; authenticated → `/dashboard`.
 *
 * SSR-safe: no window/clock/random in render; the authed swap is gated behind a
 * post-mount flag so server and first client paint agree (mirrors the `_app`
 * gate's client-deferred pattern).
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
} from "@/components/shell/landing-nav";
import { LandingFooter } from "@/components/landing/landing-footer";
import { HeroPreview } from "@/components/landing/hero-preview";
import { ProofGrid, ProofTile } from "@/components/landing/proof-tile";
import { TrustStrip } from "@/components/landing/trust-strip";
import { FeatureCard, FeatureGrid } from "@/components/landing/feature-card";
import { WorkflowRow, WorkflowStep } from "@/components/landing/workflow-step";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

/** Access-mode trust pills (verbatim prototype copy). */
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

  return (
    <>
      <LandingNav links={navLinks} cta={navCta} />

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-[1200px] px-[clamp(16px,4vw,40px)] pt-[clamp(54px,7vw,92px)] pb-[clamp(42px,6vw,72px)]">
          <div className="grid items-center gap-[clamp(32px,6vw,72px)] min-[1181px]:grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)]">
            {/* Left column */}
            <div>
              <div className="font-mono text-xs font-semibold text-muted-foreground">
                Private remote agent control
              </div>
              {/* `keep-all` + `<wbr>` give controlled CJK line breaks so words like
                  "操作者" never split mid-token (the prior text-balance break). */}
              <h1 className="mt-[14px] mb-[18px] max-w-[900px] text-[clamp(42px,5.4vw,72px)] leading-none font-semibold tracking-[clamp(-2.88px,-0.03em,-1.8px)] text-ink [word-break:keep-all]">
                一个面向<wbr />操作者的<wbr />远端 Agent <wbr />运行池。
              </h1>
              <p className="max-w-[680px] text-[clamp(18px,2.1vw,22px)] leading-[1.68] text-pretty text-ink-soft">
                GitHub OAuth 只负责确认身份；仓库导入决定 Agent
                能碰什么；任务队列负责调度；实时终端把最后的控制权留给你。整个产品围绕“可派发、可暂停、可审计”设计。
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
                    {/* Secondary is a non-bouncing in-page jump to the preview, not
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

              {/* Subtle scroll cue into the workflow section. */}
              <a
                href="#workflow"
                className="mt-7 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-ink"
              >
                <span aria-hidden="true">↓</span> 向下了解操作者流程
              </a>
            </div>

            {/* Right column — the preview is the anchor target for "查看演示". */}
            <div id="preview" className="scroll-mt-20">
              <HeroPreview />
            </div>
          </div>
        </section>

        {/* Workflow section */}
        <section
          id="workflow"
          className="mx-auto max-w-[1200px] scroll-mt-20 px-[clamp(16px,4vw,40px)] py-[clamp(40px,5vw,72px)]"
        >
          <div className="mb-7 flex items-end justify-between gap-6">
            <div>
              <div className="font-mono text-xs font-semibold text-muted-foreground">
                操作者流程
              </div>
              <h2 className="mt-2 max-w-[720px] text-[clamp(32px,4vw,48px)] leading-[1.08] font-semibold tracking-[clamp(-2.4px,-0.03em,-1.28px)] text-ink [word-break:keep-all]">
                从首次授权、<wbr />仓库导入到<wbr />远端 CLI，<wbr />每一步都有明确的控制边界。
              </h2>
            </div>
          </div>
          <WorkflowRow>
            <WorkflowStep step="develop" eyebrow="01 连接" title="GitHub 授权登录">
              首次进入时完成 OAuth 登录和账号绑定；只有白名单账号能进入控制台。
            </WorkflowStep>
            <WorkflowStep step="preview" eyebrow="02 导入" title="导入仓库">
              进入控制台后先查看已导入仓库；需要新增时直接拉取当前账号下的仓库并导入。
            </WorkflowStep>
            <WorkflowStep step="ship" eyebrow="03 控制" title="创建任务并进入会话">
              选择仓库和分支后创建 task；xterm.js 会话归属于单个
              task，支持暂停、输入 CLI 命令和回看历史日志。
            </WorkflowStep>
          </WorkflowRow>
        </section>

        {/* Security section */}
        <section
          id="security"
          className="mx-auto max-w-[1200px] scroll-mt-20 px-[clamp(16px,4vw,40px)] py-[clamp(40px,5vw,72px)]"
        >
          <div className="mb-7 flex items-end justify-between gap-6">
            <div>
              <div className="font-mono text-xs font-semibold text-muted-foreground">
                默认私有
              </div>
              <h2 className="mt-2 max-w-[720px] text-[clamp(32px,4vw,48px)] leading-[1.08] font-semibold tracking-[clamp(-2.4px,-0.03em,-1.28px)] text-ink [word-break:keep-all]">
                产品结构围绕<wbr />“单用户私有后台”<wbr />和可审计操作设计。
              </h2>
            </div>
            <Button
              asChild
              className="bg-card text-foreground shadow-ring hover:bg-secondary"
            >
              <Link to="/login">检查登录流程</Link>
            </Button>
          </div>
          <FeatureGrid>
            <FeatureCard title="白名单登录">
              GitHub OAuth 是进入产品的第一步；非白名单账号会停在拒绝访问状态，不进入控制台。
            </FeatureCard>
            <FeatureCard title="仓库级授权">
              GitHub 绑定发生在首次登录阶段；控制台内只管理已导入仓库和新增导入。
            </FeatureCard>
            <FeatureCard title="CLI 可审计">
              每次远端命令、Agent 输出和 GitHub 事件都进入历史，可按信息、警告、错误过滤。
            </FeatureCard>
          </FeatureGrid>
        </section>

        <LandingFooter />
      </main>
    </>
  );
}
