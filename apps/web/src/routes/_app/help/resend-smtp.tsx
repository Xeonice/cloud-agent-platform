/**
 * `/help/resend-smtp` — the in-console "如何配置 Resend 发信" help page
 * (add-smtp-config-ui, frontend-console spec "Resend SMTP help page"; track
 * frontend, task 5.3). Renders trusted, app-authored markdown
 * (`content/resend-smtp.md`, imported at build time via Vite `?raw`) through the
 * SAME shared `Markdown` component (react-markdown + remark-gfm, no raw HTML
 * execution) the forge-token help page uses — documenting, in order: verifying a
 * sending domain, creating an API Key, filling the console (API Key + sender),
 * the fixed parameters, and the mainland-email caveat.
 *
 * Reached contextually from the settings SMTP section + the config dialog
 * (`<Link to="/help/resend-smtp">`), NOT from a global nav slot. It does NOT
 * rebuild the shell — it renders inside the `_app` `<Outlet/>` (sidebar / topbar /
 * mobile-nav already exist) and so inherits the auth gate, exactly like the
 * forge-token help page.
 *
 * SSR-safe: content is a build-time string (no fetch); pure render, no
 * window/clock/random access.
 */
import { createFileRoute } from "@tanstack/react-router";

import resendSmtpMd from "@/content/resend-smtp.md?raw";
import { Markdown } from "@/components/markdown/markdown";

export const Route = createFileRoute("/_app/help/resend-smtp")({
  component: ResendSmtpHelpPage,
});

function ResendSmtpHelpPage() {
  return (
    <>
      <section className="mb-[18px] grid items-end gap-4">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-muted-foreground">
            帮助
          </div>
          <h1 className="max-w-[880px] text-[clamp(24px,3vw,32px)] leading-[1.18] font-semibold tracking-[-0.8px] text-foreground">
            如何配置 Resend 发信
          </h1>
          <p className="mt-[7px] max-w-[820px] text-sm leading-[1.58] text-muted-foreground">
            验证发信域名、创建 API Key，再回控制台填「API Key + 发件人地址」即可发送登录验证码（OTP）邮件。
          </p>
        </div>
      </section>

      <section className="rounded-xl bg-card p-6 shadow-ring">
        <Markdown source={resendSmtpMd} />
      </section>
    </>
  );
}
