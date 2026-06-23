/**
 * `SmtpConfigCard` — the admin-only "邮件发送（Resend）" settings section
 * (add-smtp-config-ui, frontend-console spec "Settings page has an admin-only
 * Resend SMTP section"; track frontend, task 5.2).
 *
 * Pixel-faithful to the OpenDesign source (`screens/settings.html` `#smtp` panel,
 * project 680d21c4): a `.panel` with a head (title + 仅管理员 pill + the lead
 * copy), a `.provider-meta` masked status row (发件人 + API Key 后缀, plus a
 * 已配置/未配置 pill and the 配置 button), a 「如何配置 Resend」 help link, and a
 * `.panel-foot` hint.
 *
 * ADMIN GATE (UX only — the backend independently enforces admin-only on every
 * SMTP endpoint): the management controls (the 配置 button → the dialog) are shown
 * only for an admin session (`isAdminSession`, the same env-allowlist gate the
 * MCP card / self-update banner use). A non-admin sees the masked status but no
 * configure affordance. Per the spec the whole section is mounted admin-only by
 * the settings page, so a non-admin never reaches this card; the in-card gate is
 * defense in depth.
 *
 * The card owns the dialog open state + the save/test mutations through the
 * real/mock api seam (`lib/api/queries` + `lib/api/mutations`, gated by the
 * `settings` capability). The masked read NEVER carries the plaintext password —
 * only `发件人` + an `API Key ••••<last4>` suffix.
 *
 * SSR-safe: deterministic render off query data; the dialog-open flag is plain
 * `useState`; no window/clock/random access during render.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { authSessionQuery, smtpConfigQuery } from "@/lib/api/queries";
import {
  saveSmtpConfigMutation,
  testSmtpConfigMutation,
} from "@/lib/api/mutations";
import { isAdminSession } from "@/components/shell/update-banner";
import { StatusPill } from "@/components/status-pill";
import { Panel, PanelHead } from "@/components/settings/panel";
import { SmtpConfigDialog } from "@/components/settings/smtp-config-dialog";

/** The admin-only Resend SMTP settings section (masked status + config dialog). */
export function SmtpConfigCard() {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(authSessionQuery());
  const { data: config } = useQuery(smtpConfigQuery());

  const saveConfig = useMutation(saveSmtpConfigMutation(queryClient));
  const testConfig = useMutation(testSmtpConfigMutation());

  const [dialogOpen, setDialogOpen] = React.useState<boolean>(false);

  const isAdmin = isAdminSession(session ?? undefined);
  const configured = config?.hasPassword === true;
  // The masked status line: 发件人 + an API Key suffix (never the plaintext key).
  const fromLabel = config?.from || "未设置";
  const keyLabel =
    configured && config?.passLast4 ? `••••${config.passLast4}` : "未设置";

  return (
    <Panel className="grid gap-4">
      <PanelHead
        right={
          <StatusPill variant={configured ? "green" : "neutral"}>
            {configured ? "已配置" : "未配置"}
          </StatusPill>
        }
      >
        <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
          邮件发送（Resend）
          <StatusPill variant="neutral">仅管理员</StatusPill>
        </h3>
        <p className="mt-0.5 text-[13px] leading-[1.55] text-muted-foreground">
          用 Resend 发送登录邮箱验证码（OTP），仅管理员可配置。只需填 API Key 与发件人地址（固定走{" "}
          <span className="font-mono">smtp.resend.com:465</span>）。密钥加密存储、保存后仅展示后缀；改动即时生效，无需重启。未配置时回退到环境变量{" "}
          <span className="font-mono">SMTP_*</span>。
        </p>
      </PanelHead>

      {/* .provider-meta masked status row — 发件人 + API Key 后缀 + 配置 button. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[#fafafa] p-3.5 shadow-ring">
        <div className="min-w-0">
          <strong className="block text-[13px] font-semibold text-foreground">
            Resend SMTP
          </strong>
          <p className="mt-1 text-xs leading-[1.45] text-muted-foreground">
            发件人 <span className="font-mono">{fromLabel}</span> · API Key{" "}
            <span className="font-mono">{keyLabel}</span>
          </p>
        </div>
        {/* The configure control is admin-gated (UX); the api re-enforces it. */}
        {isAdmin ? (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex min-h-9 flex-none items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
          >
            配置
          </button>
        ) : (
          <span className="flex-none text-xs text-muted-foreground">
            仅管理员可配置
          </span>
        )}
      </div>

      {/* 「如何配置 Resend」 help link. */}
      <Link
        to="/help/resend-smtp"
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
      >
        如何配置 Resend（获取 API Key、验证域名）？
        <span aria-hidden="true" className="text-muted-foreground">
          ↗
        </span>
      </Link>

      {/* .panel-foot hint. */}
      <p className="m-0 border-t border-border pt-3 text-xs leading-[1.5] text-muted-foreground">
        API Key 即 SMTP 密码，按部署密钥加密存储，仅发信时解密；未配置则使用环境变量{" "}
        <span className="font-mono">SMTP_*</span>。
      </p>

      <SmtpConfigDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        config={config ?? null}
        saving={saveConfig.isPending}
        onSave={(body) =>
          saveConfig.mutate(body, { onSuccess: () => setDialogOpen(false) })
        }
        onTest={(body) => testConfig.mutateAsync(body)}
      />
    </Panel>
  );
}
