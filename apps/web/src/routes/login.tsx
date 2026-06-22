/**
 * `/login` — centered login modal with a 3-method switch (add-private-account-identity,
 * track frontend, tasks 9.1 + 9.2; design `login.html`).
 *
 * A top-level route (NOT under `_app`), so NO auth gate runs on it — this is the
 * page the gate redirects an unauthenticated visitor TO. Rebuilt from the prior
 * two-column GitHub-only gate into the simplified design: a centered
 * `.dialog.dialog-sm` login card offering a method switch among
 *   - email + password  → `passwordLogin`
 *   - email OTP         → `requestOtp` then `verifyOtp`
 *   - GitHub authorize  → `login()` (the existing OAuth redirect / mock gate)
 * rendering ONLY the methods whose backend capability flag is enabled
 * (`loginCapabilities()`, D11). On success the page routes into the CONSOLE
 * (`/dashboard` by default, or the carried `redirect` deep-link).
 *
 * Forced first-login change (9.2 / D9): when the freshly-authenticated account
 * has `mustChangePassword` set, a no-cancel password-change dialog is shown
 * BEFORE console access; only after `changePassword` succeeds does the page
 * navigate into the console. The login/app-shell gate (the `_app` `beforeLoad`)
 * owns the same enforcement on a direct console load; this route owns it on the
 * just-completed-login path.
 *
 * Auth flow (capability seam via `@/lib/mock-session` + `isAuthCapable()`):
 *   - MOCK (today, `auth` off): the credential calls establish the local gate
 *     and resolve immediately; GitHub `login()` flips the gate too. The page
 *     then either shows the forced-change dialog (if the mock must-change flag is
 *     set) or navigates into the console.
 *   - REAL (`auth` on): password/OTP POST to the backend and set the session
 *     cookie; GitHub `login()` redirects to `GET /auth/github/login`. A
 *     non-allowlisted / denied GitHub callback comes back with `?error`/`?denied`
 *     and we render the rejection copy under the GitHub method.
 *
 * SSR-safe: the server renders the default-method card deterministically; method
 * switching, credential submission, the gate read, and `login()` all run only on
 * the client (user handlers / `useEffect` after mount). No bare
 * window/document/clock/random during render or at module top-level.
 */
import * as React from "react";
import {
  createFileRoute,
  Link,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { toast } from "sonner";

import {
  changePassword,
  fetchLoginCapabilities,
  isAuthCapable,
  isAuthenticated,
  login,
  loginCapabilities,
  passwordLogin,
  requestOtp,
  verifyOtp,
  type LoginMethod,
  type LoginResult,
} from "@/lib/mock-session";
import { safeRelativePath } from "@/lib/safe-redirect";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import { Input } from "@/components/ui/input";

/**
 * `?error`/`?denied` carry a rejected/non-allowlisted GitHub OAuth callback
 * (real mode). `?redirect` is the app path the auth gate bounced the operator
 * from, threaded so the post-login flow can return them there (open-redirect-
 * guarded server-side).
 */
export interface LoginSearch {
  error?: string;
  denied?: boolean;
  redirect?: string;
  /**
   * Set by the `_app` auth gate when an authenticated session has a pending
   * forced password change: it bounces the operator here with `change=true` so the
   * forced-change dialog opens on a direct console load / refresh (D9).
   */
  change?: boolean;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    error: typeof search.error === "string" ? search.error : undefined,
    denied: search.denied === true || search.denied === "true",
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
    change: search.change === true || search.change === "true",
  }),
  component: LoginPage,
});

/** A same-origin relative path is safe to navigate to; else fall back to the console. */
function safeClientRedirect(redirect: string | undefined): string {
  return safeRelativePath(redirect) ?? "/dashboard";
}

/**
 * Enter the authenticated console with a FULL DOCUMENT LOAD (NOT a soft navigate).
 * A fresh page discards the react-query cache so the `_app` gate re-resolves the
 * session from the existing cookie instead of bouncing on a landing-prewarmed stale
 * `authSession` (or a cached `mustChangePassword`). Mirrors the GitHub OAuth full-page
 * path. Exported as the single seam the post-auth test spies. Destination is the
 * open-redirect-guarded relative `redirect`, else `/dashboard`.
 */
export function enterConsole(redirect: string | undefined): void {
  window.location.assign(safeClientRedirect(redirect));
}

/** Verbatim method labels (design `login.html` `.login-methods`). */
const METHOD_LABEL: Record<LoginMethod, string> = {
  password: "密码",
  otp: "邮箱验证码",
  github: "GitHub",
};

/** The fixed display order of the method switch (design order). */
const METHOD_ORDER: readonly LoginMethod[] = ["password", "otp", "github"];

const primaryButton =
  "inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60";
const secondaryButton =
  "inline-flex min-h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring transition-colors hover:bg-secondary/80 disabled:opacity-60";
const fieldLabel = "text-[13px] font-semibold text-foreground";
const fieldHint = "m-0 text-xs leading-[1.6] text-muted-foreground";

function LoginPage() {
  const navigate = useNavigate();
  const { error, denied, redirect, change } = useSearch({ from: "/login" });

  // Which methods to render. The SSR render + first client paint use the safe
  // synchronous default (`loginCapabilities`); after mount we read the LIVE
  // backend flags (`fetchLoginCapabilities`) so OTP appears only when SMTP is
  // configured and any disabled method is hidden — without a hydration mismatch.
  const [caps, setCaps] = React.useState<Record<LoginMethod, boolean>>(
    loginCapabilities,
  );
  React.useEffect(() => {
    let alive = true;
    void fetchLoginCapabilities().then((live) => {
      if (alive) setCaps(live);
    });
    return () => {
      alive = false;
    };
  }, []);
  const enabledMethods = METHOD_ORDER.filter((m) => caps[m]);
  const defaultMethod: LoginMethod = enabledMethods[0] ?? "github";

  const [method, setMethod] = React.useState<LoginMethod>(defaultMethod);

  // The forced first-login change dialog (9.2 / D9). Opened after a credential
  // login whose response reports a pending change, OR immediately when the `_app`
  // gate bounced an authenticated must-change session here (`change=true`).
  // Closing it requires a successful `changePassword`.
  const [forceChangeOpen, setForceChangeOpen] = React.useState(
    change === true,
  );

  // In real mode, an `?error`/`?denied` callback means the GitHub account is not
  // on the allowlist (or the user cancelled) — show the rejection copy on the
  // GitHub method.
  const githubRejected = isAuthCapable() && (denied === true || Boolean(error));

  // An already-authenticated MOCK-gate visitor is bounced to `/workspace`
  // (CLIENT-only; the server can't read the sessionStorage gate). In real mode
  // the OAuth callback owns redirects — real authenticated sessions that land
  // here are intentionally not bounced.
  React.useEffect(() => {
    if (githubRejected) return;
    if (forceChangeOpen) return;
    if (isAuthCapable()) return; // real-mode redirect is the OAuth callback's job
    if (isAuthenticated()) {
      void navigate({ to: "/workspace" });
    }
  }, [navigate, githubRejected, forceChangeOpen]);

  /**
   * Shared post-credential-success path: if the just-authenticated account must
   * change its password (reported by the login response / mock flag), open the
   * forced-change dialog; otherwise enter the console.
   */
  function afterLoginSuccess(result: LoginResult) {
    if (result.mustChangePassword) {
      setForceChangeOpen(true);
      return;
    }
    toast.success("已登录");
    // Full document load (see `enterConsole`): re-resolves a clean session from the
    // existing cookie instead of a soft navigate the stale-cache gate could bounce.
    enterConsole(redirect);
  }

  /**
   * Forced-change completion: the password is now changed server-side. Enter the
   * console with a FULL DOCUMENT LOAD so the fresh page re-resolves a clean session
   * from the existing cookie — the prior soft navigate read the stale cached
   * must-change session and bounced back here in a loop. The full load discards the
   * cache, so no `invalidateQueries` is needed (it was a no-op on `/login` anyway,
   * where `authSession` has no active observer to refetch).
   */
  function afterForcedChange() {
    toast.success("密码已更新");
    enterConsole(redirect);
  }

  return (
    <main
      className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_18%_18%,rgba(10,114,239,0.09),transparent_30%),radial-gradient(circle_at_82%_10%,rgba(26,127,55,0.08),transparent_26%),var(--background)] p-[clamp(18px,4vw,48px)]"
      aria-label="登录 Agent 控制台"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
        className="grid w-[min(440px,100%)] gap-4 rounded-2xl bg-background p-[clamp(22px,4vw,30px)] shadow-card"
      >
        {/* Head — brand → /, title + access copy. */}
        <header className="grid gap-1.5">
          <Link
            to="/"
            aria-label="Agent 控制台"
            className="mb-2 inline-flex w-fit items-center gap-2.5 text-sm font-semibold tracking-[-0.32px] text-ink"
          >
            <span className="grid size-[26px] place-items-center rounded-md bg-dark-pill font-mono text-xs font-bold text-background">
              AC
            </span>
            <span>Agent 控制台</span>
          </Link>
          <h2 id="login-title" className="m-0 text-2xl font-semibold tracking-[-0.6px] text-ink">
            登录控制台
          </h2>
          <p className="m-0 text-[13px] leading-[1.6] text-muted-foreground">
            私有访问边界，登录即获得 host-root 执行权限。平台不开放注册，账号由管理员开通。
          </p>
        </header>

        <div className="grid gap-3.5">
          {/* Method switch — only the enabled methods, three-equal-column. */}
          {enabledMethods.length > 1 ? (
            <div
              role="tablist"
              aria-label="登录方式"
              className="grid gap-[3px] rounded-md bg-[#f4f4f5] p-[3px] shadow-[inset_0_0_0_1px_var(--border)]"
              style={{
                gridTemplateColumns: `repeat(${enabledMethods.length}, minmax(0,1fr))`,
              }}
            >
              {enabledMethods.map((m) => {
                const active = m === method;
                return (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setMethod(m)}
                    className={cn(
                      "inline-flex min-h-[30px] items-center justify-center rounded-sm px-[11px] text-[13px] font-medium transition-colors",
                      active
                        ? "bg-foreground text-background shadow-[rgba(0,0,0,0.08)_0_1px_2px]"
                        : "bg-transparent text-ink-soft hover:bg-background",
                    )}
                  >
                    {METHOD_LABEL[m]}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* The active method panel. */}
          {method === "password" && caps.password ? (
            <PasswordPanel onSuccess={afterLoginSuccess} />
          ) : null}
          {method === "otp" && caps.otp ? (
            <OtpPanel onSuccess={afterLoginSuccess} />
          ) : null}
          {method === "github" && caps.github ? (
            <GithubPanel redirect={redirect} rejected={githubRejected} />
          ) : null}

          <p className="m-0 border-t border-border pt-3.5 text-xs leading-[1.6] text-muted-foreground">
            没有账号？平台不开放公开注册——请联系管理员在「账号管理」中为你开通私有账号。
          </p>
        </div>
      </section>

      {/* Forced first-login password change (9.2 / D9): no cancel — must set a
          password before the console is reached. */}
      {forceChangeOpen ? (
        <ForcedChangeDialog
          onChanged={() => {
            setForceChangeOpen(false);
            afterForcedChange();
          }}
        />
      ) : null}
    </main>
  );
}

/** 方式一：邮箱 + 密码. */
function PasswordPanel({
  onSuccess,
}: {
  onSuccess: (result: LoginResult) => void;
}) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await passwordLogin(email, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "登录失败。");
      return;
    }
    onSuccess(result);
  }

  return (
    <form className="grid gap-3.5" onSubmit={handleSubmit} autoComplete="on">
      <div className="grid gap-2">
        <label htmlFor="pw-email" className={fieldLabel}>
          邮箱
        </label>
        <Input
          id="pw-email"
          type="email"
          placeholder="you@example.com"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <label htmlFor="pw-pass" className={fieldLabel}>
          密码
        </label>
        <div className="flex flex-nowrap items-center gap-2">
          <Input
            id="pw-pass"
            type={reveal ? "text" : "password"}
            placeholder="输入账号密码"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className={cn(secondaryButton, "shrink-0")}
          >
            {reveal ? "隐藏" : "显示"}
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? "登录中…" : "登录"}
      </button>
      <p className={fieldHint}>
        忘记密码？切换到「邮箱验证码」登录，或联系管理员重置。
      </p>
    </form>
  );
}

/** 方式二：邮箱 + 邮件验证码（仅 SMTP 已配置时显示）. */
function OtpPanel({
  onSuccess,
}: {
  onSuccess: (result: LoginResult) => void;
}) {
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);

  async function handleSend() {
    setError(null);
    setSending(true);
    const result = await requestOtp(email);
    setSending(false);
    if (!result.ok) {
      setError(result.error ?? "发送失败。");
      return;
    }
    setSent(true);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setVerifying(true);
    const result = await verifyOtp(email, code);
    setVerifying(false);
    if (!result.ok) {
      setError(result.error ?? "登录失败。");
      return;
    }
    onSuccess(result);
  }

  return (
    <form className="grid gap-3.5" onSubmit={handleSubmit} autoComplete="off">
      <div className="grid gap-2">
        <label htmlFor="otp-email" className={fieldLabel}>
          邮箱
        </label>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <Input
            id="otp-email"
            type="email"
            placeholder="you@example.com"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending}
            className={cn(secondaryButton, "shrink-0")}
          >
            {sending ? "发送中…" : sent ? "重新发送" : "发送验证码"}
          </button>
        </div>
      </div>
      <div className="grid gap-2">
        <label htmlFor="otp-code" className={fieldLabel}>
          验证码
        </label>
        <Input
          id="otp-code"
          inputMode="numeric"
          maxLength={6}
          placeholder="6 位数字"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={verifying} className={primaryButton}>
        {verifying ? "登录中…" : "登录"}
      </button>
      <p className={fieldHint}>
        验证码 10 分钟内有效，60 秒内可重发一次；仅向已开通的邮箱发送。
      </p>
    </form>
  );
}

/** 方式三：GitHub 授权（白名单 gate 不变）. */
function GithubPanel({
  redirect,
  rejected,
}: {
  redirect: string | undefined;
  rejected: boolean;
}) {
  function handleLogin() {
    // Real mode: `login(redirect)` redirects to `GET /auth/github/login?redirect=…`
    // (the backend owns the post-login redirect, open-redirect-guarded). Mock
    // mode: the gate is flipped; the page-level `useEffect` / success path then
    // routes into the console.
    login(redirect);
  }

  return (
    <div className="grid gap-3.5">
      {rejected ? (
        <div className="grid justify-items-start gap-2">
          <StatusPill variant="danger">无法进入</StatusPill>
          <p className="m-0 text-[13px] text-ink">
            该 GitHub 账号不在白名单内，无法进入控制台。
          </p>
        </div>
      ) : null}
      <button type="button" onClick={handleLogin} className={primaryButton}>
        <span
          className="grid size-[26px] place-items-center rounded-full bg-background font-mono text-[10px] font-bold text-ink"
          aria-hidden="true"
        >
          GH
        </span>
        <span>使用 GitHub 授权登录</span>
      </button>
      <p className={fieldHint}>
        仅 <span className="font-mono">AUTH_ALLOWLIST</span>{" "}
        白名单内的 GitHub 账号可进入；从任务会话被拦截登录会回到原页面。
      </p>
    </div>
  );
}

/**
 * The forced first-login password-change dialog (9.2 / D9). No cancel action:
 * the operator must set a new password (≥12 chars, matching confirmation)
 * before the console is reached.
 */
function ForcedChangeDialog({ onChanged }: { onChanged: () => void }) {
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [reveal, setReveal] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (next.length < 12) {
      setError("新密码至少 12 位。");
      return;
    }
    if (next !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    setError(null);
    setBusy(true);
    const result = await changePassword(next);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "密码修改失败。");
      return;
    }
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="fl-title"
        className="grid w-[min(440px,100%)] gap-4 rounded-2xl bg-background p-[clamp(22px,4vw,30px)] shadow-card"
      >
        <header className="grid gap-1.5">
          <StatusPill variant="blue" className="w-fit">
            首次登录
          </StatusPill>
          <h2 id="fl-title" className="m-0 mt-1 text-xl font-semibold tracking-[-0.4px] text-ink">
            设置你的新密码
          </h2>
          <p className="m-0 text-[13px] leading-[1.6] text-muted-foreground">
            检测到这是部署时注入的默认管理员账号。出于「登录即 host-root」的安全要求，请先设置专属密码后再进入控制台。
          </p>
        </header>
        <form className="grid gap-3.5" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <label htmlFor="fl-new" className={fieldLabel}>
              新密码
            </label>
            <div className="flex flex-nowrap items-center gap-2">
              <Input
                id="fl-new"
                type={reveal ? "text" : "password"}
                placeholder="至少 12 位，含大小写与数字"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                className={cn(secondaryButton, "shrink-0")}
              >
                {reveal ? "隐藏" : "显示"}
              </button>
            </div>
          </div>
          <div className="grid gap-2">
            <label htmlFor="fl-confirm" className={fieldLabel}>
              确认新密码
            </label>
            <Input
              id="fl-confirm"
              type="password"
              placeholder="再次输入新密码"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="m-0 text-[13px] text-danger">
              {error}
            </p>
          ) : null}
          <p className={fieldHint}>
            保存后默认密码立即失效，下次登录请使用新密码或邮箱验证码。
          </p>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? "保存中…" : "保存并进入控制台"}
          </button>
        </form>
      </section>
    </div>
  );
}
