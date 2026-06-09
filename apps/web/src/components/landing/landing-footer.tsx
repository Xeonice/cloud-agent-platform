/**
 * `LandingFooter` — minimal footer for the marketing landing
 * (auth-redirects-and-landing). The prototype landing ended abruptly after the
 * `#security` section with no footer; this adds a quiet closing band with the
 * repo link, a security-model jump, and a copyright line, in the existing design
 * language (ink-soft mono labels, hairline top border). SSR-safe: static copy,
 * no window/clock/random.
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
          className="flex flex-wrap items-center gap-5 text-[13px] text-ink-soft"
        >
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="transition-colors hover:text-ink"
          >
            GitHub 仓库
          </a>
          <a href="#security" className="transition-colors hover:text-ink">
            安全模型
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
