/**
 * Shared global error + 404 surfaces (rebuild-console-tanstack-start Track 19 /
 * task 19.1). Wired into the root route's `errorComponent` / `notFoundComponent`
 * (see `routes/__root.tsx`) so EVERY unhandled throw and every unmatched URL
 * lands on one on-brand surface instead of a raw stack trace.
 *
 * These render on the server too (TanStack Start SSR), so they are strictly
 * SSR-safe: pure render, design-token classes only, no window/document/clock/
 * random access at module top-level or during render.
 *
 * LOGIN-GATE DETECTION (D1, the load-bearing security boundary): the real REST
 * client throws an {@link ApiError} carrying the HTTP status. A `401` means the
 * request was unauthenticated — session expired, never signed in, or the account
 * is disabled (the backend returns 401 in all three).
 * Because login == host root, a 401 must NOT look like a generic crash: it
 * routes to a dedicated re-login prompt with a link to `/login`, never an
 * actionable stack the operator would try to "retry" against.
 */
import { Link } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/real";

/**
 * Whether `error` is an authentication/authorization failure (HTTP 401) raised
 * by the real REST client. Covers session-expired, unauthenticated, and
 * disabled accounts alike — the backend returns 401 for all.
 */
function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** Shared page frame: centered, on-brand card on the app background. */
function ErrorShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-[clamp(18px,4vw,48px)] text-foreground">
      <section className="grid w-[min(440px,100%)] gap-4 rounded-2xl bg-background p-[clamp(24px,4vw,40px)] text-center shadow-card">
        {children}
      </section>
    </main>
  );
}

/**
 * Root `errorComponent`. On a 401 it renders the login gate (re-authenticate);
 * otherwise a generic recoverable error surface with a `重试` (reset) action and
 * a `返回控制台` link. `reset` is supplied by TanStack Router and re-renders the
 * boundary's subtree to retry the failed render/loader.
 */
export function AppErrorComponent({ error, reset }: ErrorComponentProps) {
  if (isUnauthorized(error)) {
    return (
      <ErrorShell>
        <div className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            需要重新登录
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            会话已失效或未授权，请重新登录。
          </p>
        </div>
        <div className="grid gap-2">
          <Button asChild>
            <Link to="/login">前往登录</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link to="/">返回首页</Link>
          </Button>
        </div>
      </ErrorShell>
    );
  }

  const message =
    error instanceof Error && error.message
      ? error.message
      : "发生了未知错误，请稍后再试。";

  return (
    <ErrorShell>
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          出错了
        </h1>
        <p className="break-words text-sm leading-relaxed text-muted-foreground">
          {message}
        </p>
      </div>
      <div className="grid gap-2">
        <Button type="button" onClick={reset}>
          重试
        </Button>
        <Button asChild variant="ghost">
          <Link to="/dashboard">返回控制台</Link>
        </Button>
      </div>
    </ErrorShell>
  );
}

/**
 * Root `notFoundComponent`. Renders on any unmatched URL (and on explicit
 * `notFound()` throws). Offers a way back into the app shell and to the landing
 * page.
 */
export function AppNotFound() {
  return (
    <ErrorShell>
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          页面不存在
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          你访问的页面不存在或已被移动。
        </p>
      </div>
      <div className="grid gap-2">
        <Button asChild>
          <Link to="/dashboard">返回控制台</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link to="/">返回首页</Link>
        </Button>
      </div>
    </ErrorShell>
  );
}
