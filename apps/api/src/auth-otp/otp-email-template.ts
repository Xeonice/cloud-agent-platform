/**
 * Branded OTP email template (add-otp-email-template).
 *
 * Pure renderer: given the numeric code + validity window it returns
 * `{ subject, html, text }`. The HTML is the email-safe (table layout + inline CSS)
 * achromatic Vercel/Geist design finalized in OpenDesign (project `680d21c4`,
 * `emails/otp.html`) per `od://design-systems/vercel/DESIGN.md` — black-and-white,
 * AC brand mark, neutral code box with black Geist Mono digits, no decorative color.
 *
 * Only the typed `code` (a CSPRNG numeric string from the OTP service) and
 * `ttlMinutes` (a number) are interpolated — no free text enters the template, so
 * there is no HTML-injection surface.
 */

export interface OtpEmailInput {
  /** The verification code (a numeric string from the OTP generator). */
  readonly code: string;
  /** Validity window in minutes (derived from the OTP TTL). */
  readonly ttlMinutes: number;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Localized subject line for the verification-code email. */
const SUBJECT = '你的 Agent 控制台登录验证码';

/** Renders the OTP email's subject, HTML body, and plaintext fallback. */
export function renderOtpEmail({ code, ttlMinutes }: OtpEmailInput): RenderedEmail {
  const text =
    `你的 Agent 控制台登录验证码：${code}\n\n` +
    `验证码 ${ttlMinutes} 分钟内有效，仅可使用一次。\n` +
    `若非本人操作，忽略此邮件即可，你的账号不会受到影响。\n\n` +
    `私有访问边界 · 平台不开放注册，账号由管理员开通。这是一封系统通知邮件，请勿直接回复。`;

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>登录验证码 · Agent 控制台</title>
<style>
  /* Geist is progressive enhancement; clients that strip <style> fall back to the
     system stack declared inline on every element. */
  @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@500;600&display=swap');
  body { margin:0; padding:0; }
  /* vercel = achromatic: dark mode stays grayscale, no accent color introduced. */
  @media (prefers-color-scheme: dark) {
    .cap-bg     { background:#0a0a0a !important; }
    .cap-card   { background:#141414 !important; border-color:#262626 !important; }
    .cap-fg     { color:#ededed !important; }
    .cap-body   { color:#a1a1a1 !important; }
    .cap-faint  { color:#7d7d7d !important; }
    .cap-codebox{ background:#1c1c1c !important; border-color:#2e2e2e !important; }
    .cap-code   { color:#ededed !important; }
    .cap-foot   { border-color:#262626 !important; }
    .cap-mark   { background:#ededed !important; color:#0a0a0a !important; }
  }
</style>
</head>
<body class="cap-bg" style="margin:0;padding:0;background:#ffffff;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">你的 Agent 控制台登录验证码，${ttlMinutes} 分钟内有效。</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cap-bg" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="440" cellpadding="0" cellspacing="0" border="0" style="width:440px;max-width:100%;">
          <tr>
            <td class="cap-card" style="background:#ffffff;border:1px solid #ebebeb;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,0.04);padding:32px;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <span class="cap-mark" style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;background:#171717;color:#ffffff;border-radius:6px;font-family:'Geist Mono',ui-monospace,Menlo,Consolas,monospace;font-size:12px;font-weight:600;">AC</span>
                  </td>
                  <td style="vertical-align:middle;padding-left:10px;">
                    <span class="cap-fg" style="font-size:14px;font-weight:500;color:#171717;">Agent 控制台</span>
                  </td>
                </tr>
              </table>
              <h1 class="cap-fg" style="margin:28px 0 8px;font-size:22px;font-weight:600;color:#171717;letter-spacing:-0.6px;line-height:1.3;">登录验证码</h1>
              <p class="cap-body" style="margin:0 0 24px;font-size:14px;line-height:1.65;color:#4d4d4d;">你正在登录 Agent 控制台。请在登录页输入下面的验证码完成登录：</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="cap-codebox" align="center" style="background:#fafafa;border:1px solid #ebebeb;border-radius:8px;padding:22px 0;">
                    <span class="cap-code" style="font-family:'Geist Mono',ui-monospace,Menlo,Consolas,monospace;font-size:34px;font-weight:600;letter-spacing:10px;color:#171717;padding-left:10px;">${code}</span>
                  </td>
                </tr>
              </table>
              <p class="cap-body" style="margin:20px 0 0;font-size:13px;line-height:1.7;color:#4d4d4d;">验证码 <strong class="cap-fg" style="color:#171717;font-weight:600;">${ttlMinutes} 分钟</strong>内有效，仅可使用一次。若非本人操作，忽略此邮件即可，你的账号不会受到影响。</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="cap-foot" style="border-top:1px solid #ebebeb;padding-top:18px;padding-bottom:0;">
                    <p class="cap-faint" style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#808080;">私有访问边界 · 平台不开放注册，账号由管理员开通。这是一封系统通知邮件，请勿直接回复。</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject: SUBJECT, html, text };
}
