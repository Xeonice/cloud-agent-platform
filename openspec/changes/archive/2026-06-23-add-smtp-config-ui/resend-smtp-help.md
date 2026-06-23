<!-- Side-car draft of the help-page content. On apply this lands at
     apps/web/src/content/resend-smtp.md and is rendered by the
     /help/resend-smtp page (reusing the forge-tokens.md / Markdown pattern). -->

# 配置 Resend 发信

控制台用 SMTP 发送登录验证码（OTP）邮件，推荐用 **Resend**——标准 SMTP、有免费额度、无需企业实名或备案、Cloudflare 可一键写 DNS。整套只要两件事：**① 验证一个发信域名 ② 创建一个 API Key**，然后回控制台填「API Key + 发件人地址」即可。

## 1. 验证发信域名

1. 注册 [resend.com](https://resend.com)，打开 **Domains → Add Domain**
2. 填一个发信子域，例如 `auth.yourdomain.com`（用子域隔离主域信誉）
3. Resend 会列出一组 DNS 记录（MX + SPF TXT + DKIM TXT）。把它们加到你的 DNS：
   - 域名在 Cloudflare 的话，可点 Resend 的 **Auto configure** 一键写入；或手动添加（**DKIM 那条 TXT 在 Cloudflare 必须设 DNS-Only / 灰云**，否则验证失败）
4. 回 Resend 点 **Verify**，状态变 **Verified** 即完成

> 发件人地址的 **@ 后域名必须是这里验证过的域名**；@ 前（`no-reply` 等）随意，不需要真实邮箱、不需要收件箱。

## 2. 创建 API Key

1. Resend → **API Keys → Create API Key**
2. 名字随意（如 `cap-otp`），权限选 **Sending access**
3. 复制 `re_…` 开头的 key（**只显示一次**，关掉就看不到了）

> Resend 的 SMTP **用户名固定是 `resend`**，**密码就是这个 API Key**——所以控制台只让你填 API Key，不用单独设用户名和密码。

## 3. 在控制台填写

打开 **设置 → 邮件发送（Resend）→ 配置**，填两项：

- **API Key**：粘贴 `re_…`
- **发件人地址**：`no-reply@auth.yourdomain.com`（用你验证过的域名）

点 **发送测试** 给自己账号邮箱发一封验证，成功后再 **保存配置**。保存后密钥加密存储、仅展示后缀，邮箱验证码登录方式即刻可用，无需重启。

## 固定参数（无需填写）

| 参数 | 值 | 说明 |
|---|---|---|
| SMTP 服务器 | `smtp.resend.com` | Resend 固定 |
| 端口 | `465` | 隐式 TLS |
| 用户名 | `resend` | Resend 固定字面量 |
| 密码 | 你的 API Key（`re_…`） | API Key 即 SMTP 密码 |

## 大陆邮箱提示

Resend（及所有国际发信商）对 QQ / 163 / 126 等大陆邮箱送达不稳定。若操作者主要用大陆邮箱，建议他们用密码或 GitHub 登录；OTP 优先服务 Gmail 等国际邮箱。

## 不配置会怎样

不在控制台配置时，后端回退到部署环境变量 `SMTP_*`（若设过）。两者都没有，则邮箱验证码登录方式自动隐藏，登录仍可用密码 / GitHub。
