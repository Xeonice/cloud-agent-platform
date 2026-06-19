/**
 * `LandingFooter` — minimal footer for the marketing landing
 * (auth-redirects-and-landing; pixel pass in console-design-pixel-merge
 * Track 5; trimmed in simplify-landing-homepage). A quiet closing band with the
 * repo link, a login link, and a copyright line. The former `#security`
 * "安全模型" jump is removed with the boundary-ledger section (no dead anchor).
 * SSR-safe: static copy, no window/clock/random.
 *
 * Fidelity (design index.html `.landing-footer` / `.landing-links`):
 *   max-w 1200, hairline top, py 32; links = gap 24, 13px/500 muted.
 */
import { Link } from "@tanstack/react-router";

const REPO_URL = "https://github.com/Xeonice/cloud-agent-platform";

export function LandingFooter() {
  return (
    <footer className="mx-auto max-w-[1200px] border-t border-line px-[clamp(16px,4vw,40px)] py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 font-semibold tracking-tight text-ink">
          <span className="grid size-[26px] place-items-center rounded-md bg-dark-pill font-mono text-xs text-background">
            AC
          </span>
          <span>Agent 控制台</span>
        </div>
        <nav
          aria-label="页脚导航"
          className="flex flex-wrap items-center gap-6 text-[13px] font-medium text-muted-foreground"
        >
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="transition-colors hover:text-ink"
          >
            GitHub 仓库
          </a>
          <Link to="/login" className="transition-colors hover:text-ink">
            登录
          </Link>
        </nav>
      </div>
      <p className="mt-5 font-mono text-xs text-muted-foreground">
        © Agent 控制台 · 单用户私有后台 · 控制台访问即 host-root 权限
      </p>
    </footer>
  );
}
