/**
 * `/login` — GitHub 授权登录 gate (Track 12 fe-page-landing-login; standalone, SSR).
 *
 * A top-level route (NOT under `_app`), so NO auth gate runs on it — this is the
 * page the gate redirects an unauthenticated visitor TO. Faithful rebuild of the
 * prototype `login.html`: a centered `.auth-shell` holding a 2-column
 * `.auth-card.auth-layout` —
 *   LEFT  `.auth-main`     : brand → `/`, the access copy, and TWO mutually-
 *                            exclusive states (empty login CTA ↔ success card).
 *   RIGHT `.auth-assurance`: the "进入控制台前会确认" 3-step flow + config summary.
 *
 * Auth flow (capability seam via `@/lib/mock-session` + `isCapable('auth')`):
 *   - MOCK (today, `auth` off): the 授权 button calls `login()` — now coherent,
 *     it sets BOTH the sessionStorage gate AND `store.githubConnected` — then
 *     swaps the card to the SUCCESS state (client `useState`), toasts success,
 *     and navigates to `/repositories`.
 *   - REAL (`auth` on): `login()` redirects the browser to
 *     `GET /auth/github/login`; an allowlisted callback establishes the session.
 *     A non-allowlisted / denied callback comes back with `?error`/`?denied`, and
 *     we render the REJECTION copy instead of the empty CTA. The mock swap stays
 *     behind the capability flag (no client state transition in real mode).
 *   - An already-authenticated MOCK-gate visitor is bounced to `/workspace`
 *     (CLIENT-only, SSR-safe). In real mode the OAuth callback owns redirects,
 *     so an authenticated real session that lands on /login is intentionally
 *     not bounced here.
 *
 * SSR-safe: the server renders the EMPTY state deterministically (terminal-free,
 * static copy). The success/rejection swap, the gate read, and `login()` all run
 * only on the client (user handler or `useEffect` after mount). No bare
 * window/document/clock/random during render or at module top-level.
 *
 * Fidelity (prototype base `styles.css` + non-`.console-body` audit-refinement;
 * `login.html` body IS `.auth-body`):
 *   shell  = min-h-screen, grid place-items-center, p clamp(18,4vw,48), radial
 *            blue+green glow over `--bg`.
 *   card   = `.auth-layout`: width min(1040,100%), grid 1fr + minmax(300,0.72fr),
 *            gap 1px on a `--line` fill (the hairline column divider), rounded-2xl
 *            (16px), overflow-hidden, card shadow; padding 0 (panels pad).
 *   panels = `.auth-main`/`.auth-assurance`: grid align-start gap 24, p
 *            clamp(24,4vw,44); main white, assurance `#fafafa`.
 */
import * as React from "react";
import {
  createFileRoute,
  Link,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { toast } from "sonner";

import { isAuthCapable, isAuthenticated, login } from "@/lib/mock-session";
import { safeRelativePath } from "@/lib/safe-redirect";
import { StatusPill } from "@/components/status-pill";
import { InstallStep } from "@/components/auth/install-step";
import { ConfigList } from "@/components/auth/config-list";

/**
 * `?error`/`?denied` carry a rejected/non-allowlisted OAuth callback (real mode).
 * `?redirect` is the app path the auth gate bounced the operator from, threaded so
 * the post-login flow can return them there (open-redirect-guarded server-side).
 */
export interface LoginSearch {
  error?: string;
  denied?: boolean;
  redirect?: string;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    error: typeof search.error === "string" ? search.error : undefined,
    denied: search.denied === true || search.denied === "true",
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: LoginPage,
});

/** A same-origin relative path is safe to navigate to; else fall back to the console. */
function safeClientRedirect(redirect: string | undefined): string {
  return safeRelativePath(redirect) ?? "/dashboard";
}

function LoginPage() {
  const navigate = useNavigate();
  const { error, denied, redirect } = useSearch({ from: "/login" });

  // The empty↔success swap is CLIENT view state (mock mode only). Starts empty so
  // the server render matches the first client paint.
  const [authed, setAuthed] = React.useState(false);

  // In real mode, an `?error`/`?denied` callback means the GitHub account is not
  // on the allowlist (or the user cancelled) — show the rejection copy.
  const rejected = isAuthCapable() && (denied === true || Boolean(error));

  // An already-authenticated MOCK-gate visitor is bounced to `/workspace`
  // (CLIENT-only; the server can't read the sessionStorage gate). In real mode
  // the OAuth callback owns redirects — real authenticated sessions that land
  // here are intentionally not bounced. Only runs when NOT mid-rejection.
  React.useEffect(() => {
    if (rejected) return;
    if (isAuthCapable()) return; // real-mode redirect is the OAuth callback's job
    if (isAuthenticated()) {
      void navigate({ to: "/workspace" });
    }
  }, [navigate, rejected]);

  function handleLogin() {
    // Real mode: `login(redirect)` redirects to `GET /auth/github/login?redirect=…`
    // and never returns to client state below (the backend owns the post-login
    // redirect, open-redirect-guarded).
    login(redirect);
    if (isAuthCapable()) return;
    // Mock mode: the gate + `githubConnected` are now set; swap to success,
    // toast, then enter the console (or the deep-link destination).
    setAuthed(true);
    toast.success("已完成授权");
    void navigate({ to: safeClientRedirect(redirect) });
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_18%_18%,rgba(10,114,239,0.09),transparent_30%),radial-gradient(circle_at_82%_10%,rgba(26,127,55,0.08),transparent_26%),var(--background)] p-[clamp(18px,4vw,48px)]">
      <section className="grid w-[min(1040px,100%)] grid-cols-1 gap-px overflow-hidden rounded-2xl bg-line shadow-card min-[821px]:grid-cols-[minmax(0,1fr)_minmax(300px,0.72fr)]">
        {/* LEFT — brand + access copy + the empty/success/rejection states */}
        <div className="grid content-start gap-6 bg-background p-[clamp(24px,4vw,44px)]">
          <Link
            to="/"
            aria-label="Agent 控制台"
            className="inline-flex min-h-[34px] w-fit items-center gap-2.5 p-1 text-[15px] font-semibold tracking-[-0.32px] text-ink"
          >
            <span className="grid size-[26px] place-items-center rounded-md bg-dark-pill font-mono text-xs font-bold text-background">
              AC
            </span>
            <span>Agent 控制台</span>
          </Link>

          <div>
            <div className="font-mono text-xs font-semibold text-muted-foreground">
              Private access
            </div>
            <h1 className="mt-3 max-w-[760px] text-[clamp(36px,6vw,64px)] font-semibold leading-none tracking-[clamp(-2.2px,-0.03em,-1.4px)] text-ink">
              用 GitHub 身份打开你的私有 Agent 运行池。
            </h1>
            <p className="m-0 max-w-[680px] text-[17px] leading-[1.7] text-muted-foreground">
              登录不是注册流程，而是访问边界：只有白名单账号能进入控制台，后续仓库范围、模型凭据、写入确认和终端会话都绑定到这个身份。
            </p>
          </div>

          {rejected ? (
            <div className="grid justify-items-start gap-3 pt-1">
              <StatusPill variant="danger">无法进入</StatusPill>
              <h2 className="m-0 text-2xl tracking-[-0.8px] text-ink">
                该 GitHub 账号不在白名单内，无法进入控制台
              </h2>
              <button
                type="button"
                onClick={handleLogin}
                className="inline-flex min-h-[46px] items-center justify-center gap-2.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors"
              >
                <span
                  className="grid size-[26px] place-items-center rounded-full bg-background font-mono text-[10px] font-bold text-ink"
                  aria-hidden="true"
                >
                  GH
                </span>
                <span>使用 GitHub 授权登录</span>
              </button>
            </div>
          ) : authed ? (
            <div className="grid justify-items-start gap-3 pt-1">
              <StatusPill variant="green">已完成授权</StatusPill>
              <h2 className="m-0 text-2xl tracking-[-0.8px] text-ink">
                GitHub 账号已绑定。
              </h2>
              <p className="m-0 text-[13px] text-muted-foreground">
                当前身份：
                <span className="font-mono tabular-nums">github.com/tanghehui</span>
              </p>
              <Link
                to="/dashboard"
                className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors"
              >
                进入控制台
              </Link>
            </div>
          ) : (
            <div className="grid justify-items-start gap-3 pt-1">
              <button
                type="button"
                onClick={handleLogin}
                className="inline-flex min-h-[46px] items-center justify-center gap-2.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors"
              >
                <span
                  className="grid size-[26px] place-items-center rounded-full bg-background font-mono text-[10px] font-bold text-ink"
                  aria-hidden="true"
                >
                  GH
                </span>
                <span>使用 GitHub 授权登录</span>
              </button>
              <p className="m-0 text-[13px] leading-[1.6] text-muted-foreground">
                登录成功后进入控制台；如果是从某个任务会话被拦截登录，会回到原页面。
              </p>
            </div>
          )}
        </div>

        {/* RIGHT — the "进入控制台前会确认" assurance panel */}
        <div className="grid content-start gap-6 bg-[#fafafa] p-[clamp(24px,4vw,44px)]">
          <div className="flex items-center justify-between gap-3">
            <h3 className="m-0 text-[17px] font-bold text-ink">
              进入控制台前会确认
            </h3>
            <StatusPill variant="blue">3 steps</StatusPill>
          </div>

          <div className="grid gap-2" aria-label="首次进入流程">
            <InstallStep index="01" title="验证 GitHub OAuth" active>
              确认账号为{" "}
              <span className="font-mono tabular-nums">github.com/tanghehui</span>，
              没有公开注册入口。
            </InstallStep>
            <InstallStep index="02" title="绑定可审计身份">
              所有任务、仓库导入、终端输入和危险写入确认都归属到当前操作者。
            </InstallStep>
            <InstallStep index="03" title="进入仓库范围选择">
              只把明确导入的仓库交给远端 Agent 工作区，不默认暴露账号下全部项目。
            </InstallStep>
          </div>

          <ConfigList
            rows={[
              { label: "访问范围", value: "单用户白名单" },
              { label: "执行边界", value: "沙箱内自治" },
              { label: "下一步", value: "任务控制台" },
            ]}
          />
        </div>
      </section>
    </main>
  );
}
