/**
 * `/` — 营销落地 Landing (standalone, SSR; Track 12 fe-page-landing-login 12.1).
 *
 * The public marketing page, faithful to the prototype `landing.html`. It is a
 * top-level route (NOT under `_app`), so the auth gate never runs here and it
 * ships its OWN chrome via the configurable `LandingNav` (the landing link-set:
 * 流程 / 权限 / 控制台 + the「GitHub 登录」CTA).
 *
 * Composition:
 *   - `LandingNav` (landing links + CTA).
 *   - Hero (`.hero-grid` 2-col): LEFT = eyebrow / h1 / lead / hero-actions /
 *     `TrustStrip` / `ProofGrid` of 3 `ProofTile`; RIGHT = `HeroPreview`.
 *   - `#workflow` section: header + `WorkflowRow` of 3 `WorkflowStep`.
 *   - `#security` section: header (+ 检查登录流程 button) + `FeatureGrid` of 3
 *     `FeatureCard`.
 *
 * Behavior: fully STATIC — no queries, no client data, no effects. Same-page
 * anchor links (流程 → #workflow, 权限 → #security) smooth-scroll; the section
 * ids carry `scroll-mt-20` so they clear the fixed 64px nav. Route CTAs go
 * through `<Link>`. SSR-safe: all copy is literal; no window/clock/random in
 * render.
 *
 * Fidelity (NON-console-body cascade — base styles.css + the non-.console-body
 * audit-refinement overrides win):
 *   .hero = max-w 1200 centered, py clamp; .hero-grid = `0.9fr 1.1fr`, gap
 *     clamp(32,6vw,72) (1-col ≤820px). h1 = display 42→72 clamp, 600, tight
 *     tracking, line-height 1. lead = ink-soft 18→22 clamp / 1.68.
 *   .section = max-w 1200 centered, py clamp(56,8vw,96); .section-header = flex
 *     end-aligned between; h2 = 32→48 clamp / 600 ink / tight.
 */
import { createFileRoute, Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import {
  LandingNav,
  type LandingNavLink,
  type LandingNavCta,
} from "@/components/shell/landing-nav";
import { HeroPreview } from "@/components/landing/hero-preview";
import { ProofGrid, ProofTile } from "@/components/landing/proof-tile";
import { TrustStrip } from "@/components/landing/trust-strip";
import { FeatureCard, FeatureGrid } from "@/components/landing/feature-card";
import { WorkflowRow, WorkflowStep } from "@/components/landing/workflow-step";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

/** The landing-specific nav links (流程 / 权限 anchors + 控制台 route). */
const LANDING_NAV_LINKS: readonly LandingNavLink[] = [
  { label: "流程", href: "#workflow" },
  { label: "权限", href: "#security" },
  { label: "控制台", to: "/dashboard" },
];

/** The landing CTA →「GitHub 登录」. */
const LANDING_NAV_CTA: LandingNavCta = { label: "GitHub 登录", to: "/login" };

/** Access-mode trust pills (verbatim prototype copy). */
const TRUST_PILLS = [
  "GitHub OAuth 白名单",
  "GitHub 账号仓库导入",
  "远端 Agent CLI",
] as const;

function LandingPage() {
  return (
    <>
      <LandingNav links={LANDING_NAV_LINKS} cta={LANDING_NAV_CTA} />

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-[1200px] px-[clamp(16px,4vw,40px)] pt-[clamp(54px,7vw,92px)] pb-[clamp(42px,6vw,72px)]">
          <div className="grid items-center gap-[clamp(32px,6vw,72px)] min-[1181px]:grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)]">
            {/* Left column */}
            <div>
              <div className="font-mono text-xs font-semibold text-muted-foreground">
                Private remote agent control
              </div>
              <h1 className="mt-[14px] mb-[18px] max-w-[900px] text-[clamp(42px,5.4vw,72px)] leading-none font-semibold tracking-[clamp(-2.88px,-0.03em,-1.8px)] text-balance text-ink">
                一个面向操作者的远端 Agent 运行池。
              </h1>
              <p className="max-w-[680px] text-[clamp(18px,2.1vw,22px)] leading-[1.68] text-pretty text-ink-soft">
                GitHub OAuth 只负责确认身份；仓库导入决定 Agent
                能碰什么；任务队列负责调度；实时终端把最后的控制权留给你。整个产品围绕“可派发、可暂停、可审计”设计。
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <Button asChild>
                  <Link to="/login">使用 GitHub 登录</Link>
                </Button>
                <Button
                  asChild
                  className="bg-card text-foreground shadow-ring hover:bg-secondary"
                >
                  <Link to="/dashboard">查看控制台</Link>
                </Button>
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
            </div>

            {/* Right column */}
            <HeroPreview />
          </div>
        </section>

        {/* Workflow section */}
        <section
          id="workflow"
          className="mx-auto max-w-[1200px] scroll-mt-20 px-[clamp(16px,4vw,40px)] py-[clamp(56px,8vw,96px)]"
        >
          <div className="mb-7 flex items-end justify-between gap-6">
            <div>
              <div className="font-mono text-xs font-semibold text-muted-foreground">
                操作者流程
              </div>
              <h2 className="mt-2 max-w-[720px] text-[clamp(32px,4vw,48px)] leading-[1.08] font-semibold tracking-[clamp(-2.4px,-0.03em,-1.28px)] text-ink">
                从首次授权、仓库导入到远端 CLI，每一步都有明确的控制边界。
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
          className="mx-auto max-w-[1200px] scroll-mt-20 px-[clamp(16px,4vw,40px)] py-[clamp(56px,8vw,96px)]"
        >
          <div className="mb-7 flex items-end justify-between gap-6">
            <div>
              <div className="font-mono text-xs font-semibold text-muted-foreground">
                默认私有
              </div>
              <h2 className="mt-2 max-w-[720px] text-[clamp(32px,4vw,48px)] leading-[1.08] font-semibold tracking-[clamp(-2.4px,-0.03em,-1.28px)] text-ink">
                产品结构围绕“单用户私有后台”和可审计操作设计。
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
      </main>
    </>
  );
}
