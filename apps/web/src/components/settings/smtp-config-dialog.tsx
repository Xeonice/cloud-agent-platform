/**
 * `SmtpConfigDialog` — the Resend-shaped SMTP config dialog (add-smtp-config-ui,
 * frontend-console spec "Settings page has an admin-only Resend SMTP section";
 * track frontend, task 5.2).
 *
 * Pixel-faithful to the OpenDesign source (`screens/settings.html` `#smtp-dialog`,
 * project 680d21c4 — `.dialog.dialog-sm` with `.dialog-head` / `.dialog-body` /
 * `.dialog-foot`). It collects ONLY what Resend needs:
 *
 *   1. The **API Key** (= the SMTP password) — a password field with a 显示/隐藏
 *      reveal toggle, NEVER pre-filled (the server returns only a masked suffix;
 *      留空沿用现有 = an empty submit keeps the stored key).
 *   2. The **sender (from) address** — pre-fillable from the masked read, with
 *      the "@ 后域名需在 Resend 验证过；@ 前可自定" hint.
 *
 * The fixed `smtp.resend.com` / `465` / `resend` tuple is shown as COPY in the
 * description, NOT as inputs (the backend still stores the full tuple — the card
 * always submits it). A 发送测试 conn-test row sends a test email to the admin's
 * own session email via the test mutation and reflects the `{ ok, message }`
 * outcome inline (未测试 → 测试中… → 已发送/失败). A 「如何获取 API Key 与验证域名」
 * help link routes to `/help/resend-smtp`.
 *
 * SSR-safe: deterministic render off props; the reveal flag, draft key, and test
 * status are plain `useState`; no window/clock/random access during render.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";

import type {
  SmtpConfigRead,
  SaveSmtpConfigRequest,
  TestSmtpConfigRequest,
  TestSmtpConfigResponse,
} from "@/lib/api/real";
import { StatusPill, type StatusPillVariant } from "@/components/status-pill";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// The fixed Resend tuple — shown as copy, NOT as inputs (the card submits it).
// ---------------------------------------------------------------------------

/** The fixed Resend SMTP tuple (host/port/username are copy, never editable). */
export const RESEND_SMTP_FIXED = {
  host: "smtp.resend.com",
  port: 465,
  user: "resend",
} as const;

// ---------------------------------------------------------------------------
// The dialog's transient conn-test status
// ---------------------------------------------------------------------------

type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "done"; ok: boolean; message: string };

/** The conn-test pill variant + label for a given test status. */
function testPill(status: TestStatus): { variant: StatusPillVariant; label: string } {
  switch (status.kind) {
    case "testing":
      return { variant: "blue", label: "测试中…" };
    case "done":
      return status.ok
        ? { variant: "green", label: "已发送" }
        : { variant: "danger", label: "失败" };
    default:
      return { variant: "neutral", label: "未测试" };
  }
}

export interface SmtpConfigDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Open/close the dialog. */
  onOpenChange: (open: boolean) => void;
  /** The current masked config (sender pre-fill + has-key state), or null. */
  config: SmtpConfigRead | null;
  /** Whether a save is in flight (disables the 保存配置 button). */
  saving: boolean;
  /** Persist the config; the parent owns the server call + closing the dialog. */
  onSave: (body: SaveSmtpConfigRequest) => void;
  /** Send a test email through the candidate config; resolves the outcome. */
  onTest: (body: TestSmtpConfigRequest) => Promise<TestSmtpConfigResponse>;
}

/** The Resend-shaped SMTP config dialog (API Key + sender + 发送测试). */
export function SmtpConfigDialog({
  open,
  onOpenChange,
  config,
  saving,
  onSave,
  onTest,
}: SmtpConfigDialogProps) {
  // The API Key draft — NEVER pre-filled (the read carries only a masked
  // suffix); an empty submit keeps the stored key (留空沿用现有).
  const [apiKey, setApiKey] = React.useState<string>("");
  const [revealKey, setRevealKey] = React.useState<boolean>(false);
  // The sender address — pre-fillable from the masked read.
  const [from, setFrom] = React.useState<string>("");
  const [testStatus, setTestStatus] = React.useState<TestStatus>({ kind: "idle" });

  // Reset transient state to the current config each time the dialog opens. The
  // API Key is ALWAYS reset empty (never pre-filled from a masked read).
  React.useEffect(() => {
    if (open) {
      setApiKey("");
      setRevealKey(false);
      setFrom(config?.from ?? "");
      setTestStatus({ kind: "idle" });
    }
  }, [open, config?.from]);

  /** Build the candidate config to save/test from the draft + the fixed tuple. */
  function candidate(): SaveSmtpConfigRequest {
    const trimmedKey = apiKey.trim();
    return {
      host: RESEND_SMTP_FIXED.host,
      port: RESEND_SMTP_FIXED.port,
      user: RESEND_SMTP_FIXED.user,
      from: from.trim(),
      // Omit an empty key so the server keeps the stored ciphertext (留空沿用).
      ...(trimmedKey ? { pass: trimmedKey } : {}),
    };
  }

  async function handleTest() {
    setTestStatus({ kind: "testing" });
    try {
      const result = await onTest(candidate());
      setTestStatus({ kind: "done", ok: result.ok, message: result.message });
    } catch (err) {
      setTestStatus({
        kind: "done",
        ok: false,
        message: err instanceof Error ? err.message : "测试发送失败。",
      });
    }
  }

  function handleSave() {
    onSave(candidate());
  }

  // Saving requires either a new key OR an already-stored key (留空沿用), plus a
  // sender address — never let a save strand the config without a key.
  const canSave =
    from.trim().length > 0 &&
    (apiKey.trim().length > 0 || config?.hasPassword === true) &&
    !saving;

  const pill = testPill(testStatus);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-labelledby="smtp-title"
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-modal sm:max-w-[480px]"
      >
        {/* .dialog-head */}
        <header className="flex shrink-0 items-start justify-between gap-4 p-[22px_22px_14px]">
          <div className="min-w-0">
            <DialogTitle
              id="smtp-title"
              className="mb-1.5 text-[22px] font-semibold tracking-[-0.8px] text-ink"
            >
              配置 Resend 发信
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-[1.55] text-muted-foreground">
              用 Resend 发送登录验证码邮件，固定走{" "}
              <span className="font-mono">smtp.resend.com:465</span>、用户名固定{" "}
              <span className="font-mono">resend</span>。只需填 API Key 与发件人地址。
            </DialogDescription>
          </div>
          <DialogClose
            aria-label="关闭"
            className="grid size-8 flex-none place-items-center rounded-md bg-transparent text-2xl leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            ×
          </DialogClose>
        </header>

        {/* .dialog-body */}
        <DialogBody>
          <div className="grid gap-4 p-[0_22px_18px]">
            {/* API Key field — reveal toggle; never pre-filled (留空沿用). */}
            <div className="grid gap-2">
              <label
                htmlFor="smtp-key"
                className="text-[13px] font-semibold text-foreground"
              >
                API Key
              </label>
              <div className="flex flex-nowrap gap-2">
                <input
                  id="smtp-key"
                  name="smtp-key"
                  type={revealKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="re_… （留空沿用现有）"
                  autoComplete="off"
                  className="min-h-10 w-full min-w-0 flex-1 rounded-md bg-card px-3 text-[13px] text-foreground shadow-[0_0_0_1px_var(--border)] focus:shadow-[0_0_0_1px_var(--ring),0_0_0_3px_rgba(10,114,239,0.16)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setRevealKey((v) => !v)}
                  className="inline-flex min-h-10 flex-none items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
                >
                  {revealKey ? "隐藏" : "显示"}
                </button>
              </div>
              <small className="text-xs leading-[1.5] text-muted-foreground">
                Resend 控制台创建的 API Key，即 SMTP 密码。加密存储，保存后仅展示后缀；留空则保留现有
                {config?.hasPassword && config.passLast4 ? (
                  <>
                    （当前 ••••
                    <span className="font-mono">{config.passLast4}</span>）
                  </>
                ) : null}
                。
              </small>
            </div>

            {/* Sender address — pre-fillable; the verified-domain hint. */}
            <div className="grid gap-2">
              <label
                htmlFor="smtp-from"
                className="text-[13px] font-semibold text-foreground"
              >
                发件人地址
              </label>
              <input
                id="smtp-from"
                name="smtp-from"
                type="text"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="no-reply@yourdomain.com"
                autoComplete="off"
                className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-[13px] text-foreground shadow-[0_0_0_1px_var(--border)] focus:shadow-[0_0_0_1px_var(--ring),0_0_0_3px_rgba(10,114,239,0.16)] focus:outline-none"
              />
              <small className="text-xs leading-[1.5] text-muted-foreground">
                @ 后域名需在 Resend 验证过；@ 前可自定（no-reply 等），无需真实邮箱。
              </small>
            </div>

            {/* Help link — routes to the Resend help page. */}
            <Link
              to="/help/resend-smtp"
              className="inline-flex w-fit items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
            >
              如何获取 API Key 与验证域名？
              <span aria-hidden="true" className="text-muted-foreground">
                ↗
              </span>
            </Link>

            {/* 发送测试 conn-test row — sends to the admin's own email. */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-[#fafafa] p-3.5 shadow-ring">
              <div className="min-w-0">
                <strong className="block text-[13px] font-semibold text-foreground">
                  发送测试
                </strong>
                <p
                  className={
                    testStatus.kind === "done" && !testStatus.ok
                      ? "mt-1 text-xs leading-[1.45] text-danger"
                      : "mt-1 text-xs leading-[1.45] text-muted-foreground"
                  }
                >
                  {testStatus.kind === "done" && testStatus.message
                    ? testStatus.message
                    : "向你的账号邮箱发送一封测试邮件验证配置。"}
                </p>
              </div>
              <div className="flex flex-nowrap items-center gap-2">
                <StatusPill variant={pill.variant}>{pill.label}</StatusPill>
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testStatus.kind === "testing" || from.trim().length === 0}
                  className="inline-flex min-h-9 flex-none items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80 disabled:opacity-60"
                >
                  {testStatus.kind === "testing" ? "发送中…" : "发送测试"}
                </button>
              </div>
            </div>
          </div>
        </DialogBody>

        {/* .dialog-foot */}
        <div className="flex shrink-0 flex-wrap justify-end gap-2.5 border-t border-border p-[14px_22px_18px] max-[480px]:grid max-[480px]:grid-cols-1">
          <DialogClose className="inline-flex min-h-9 items-center justify-center rounded-md bg-secondary px-3.5 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80">
            取消
          </DialogClose>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="inline-flex min-h-9 items-center justify-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
