# Epic：对外 API 化 + 远程 MCP 服务

> 母文档（explore 阶段产出，对标 `docs/oss-self-update-epic.md`）。锁定本 epic 的决策、架构、Track 分解与已收敛的风险，作为后续每个 OpenSpec change 的既定约束。
>
> 状态：规划中（explore 完成；T3 已深化定稿；未开 change）。日期基线 2026-06-19。

## 1. 目标

把现在「人用浏览器 console 驱动」的服务，扩展出两种**程序化入口**：

1. **对外 API 调用模式** —— 让脚本 / CI / 第三方用稳定凭证（API Key）通过 REST 创建并观察任务。
2. **远程 MCP 服务** —— 让用户在 Claude Desktop / Claude.ai 自定义连接器 / Cursor 里通过 OAuth 连接 `https://cap-api.douglasdong.com/mcp`，用 MCP 工具启动沙箱、跑任务。

## 2. 锁定决策

### Epic 级（2026-06-19 拍板）
- **D1 MCP 拓扑**：远程托管 MCP，端点内嵌进 cap-api（`/mcp`，streamable-HTTP），授权复用现有 GitHub OAuth + 硬 allowlist。**不**做本地 stdio 版。
- **D2 任务归属**：**保持共享池**（所有 allowlist 用户 + 凭证看同一任务池，与现 console 一致）。per-user 作用域留作后续独立 change。
  - ⚠️ 已接受后果：任何 MCP/API 调用方能 `list` 看到全部任务、能 `stop` 别人的任务。与今天 console 行为一致。
- **D3 范围**：完整三层 epic 一次规划（机器身份 + 公开 API + MCP），覆盖异步观测全套。
- **D4 token 模型（MCP）**：**不透明 token + 本地 DB 内省**（非 JWT）。复用现有 `Session` 的「只存 SHA-256 哈希 + 每请求 allowlist 重确认」肌理。已对抗验证确认合规（见 §7、§8）。

### T3 级（2026-06-19 拍板，spike 后）
- **D5 实现路径**：**手搓薄 AS**（OAuth proxy 模式包 GitHub）+ **官方 SDK 的 RS 侧助手**（`requireBearerAuth` / `mcpAuthMetadataRouter`，来自 `@modelcontextprotocol/express`）。**不**采用 mcp-nest 内建 AS（理由见 §6）。
- **D6 DCR 范围**：**首版即含 RFC 7591 `/register`**（带去重 / 防 spam），客户端零手填 client_id。

## 3. 架构：统一凭证解析核心

现有系统所有认证汇聚到一个传输无关的决策点 `resolveOperatorPrincipal()`（REST guard + WS handshake guard 共用），principal kind 现为 `'session' | 'legacy-token'`。本 epic 的杠杆点 = **给这个核心加两种 kind**，下游 guard / audit / allowlist 机器全复用：

```
                    ┌─────────── 统一凭证解析核心（共用 allowlist 重确认）───────────┐
 curl / CI / 脚本 ──Bearer cap_sk_…(长命,带scope)──► [T1 API Key 校验] ─┐            │
                    │                                                  ├─► resolveOperatorPrincipal()
 MCP 客户端 ──OAuth─► [T3 薄AS 包GitHub] ─► Bearer mcp_…(短命,可吊销) ──┤   +'api-key' / +'mcp'
   (Claude/Cursor)   ↑ 发不透明token,存哈希;用户认证=转发现有GitHub      │      ↓ 每请求重确认 allowlist
                       OAuth+allowlist闸门                              │   业务逻辑（共享任务池 D2）
                                                                       │
 浏览器 console ──cookie cap_session(现状)────────────────────────────┘
```

三种凭证（session / api-key / mcp）都是「不透明凭证 → 解析成带 allowlist 重确认的 principal」，共用一个解析核心。

## 4. Track 分解

```
T0 ─ 公开面划界（前提）
 │   /v1 公开子集 vs console 内部端点；稳定契约 + OpenAPI 生成基线
 │
 ├──► T1 ─ API Key 身份         ┐ 两条机器身份线
 │     ApiKey 模型(哈希/userId/  │ 互相独立、可并行
 │     scope/吊销) + 'api-key'   │
 │     principal + audit 归属    │
 │                              │
 ├──► T3 ─ MCP OAuth 薄AS ───────┘  ← 本文档已深化定稿（§5–§8）
 │     手搓薄AS包GitHub + DCR + PKCE + 不透明token；官方SDK RS助手；+'mcp' principal
 │
 ├──► T2 ─ 公开 REST + 异步观测  （依赖 T0；underpins T4）
 │     /v1 namespace · 分页 · 创建幂等键 · 限流(新建,零基建) · 异步观测(见下)
 │
 └──► T4 ─ MCP 端点 + 工具       （依赖 T3 授权 + T2 service）
       官方 @modelcontextprotocol/sdk(v1.x) StreamableHTTPServerTransport 直挂 /mcp（不引入 @rekog/mcp-nest，见 §15）
       工具: start_sandbox/create_task · get_task · list_tasks · stop_task · get_transcript · list_repos
```

**关键路径**：`T0 → T2 → T4`（工具要有 API 可调）+ `T3 → T4`（MCP 要有授权）。T1 与 T3 是两条独立身份线，可并行。

**建议起手轨**：T1（API Key）—— 最独立、能立刻让 curl 跑通验证 `resolveOperatorPrincipal` 扩展点，且它建的凭证解析核心正是 T3 复用的地基。

## 5. 异步观测设计（T2 的硬骨头）

外部调用方拿 Bearer key，走不了现在 console 的 cookie WS。三档，优先级递减：

| 方案 | 体验 | 工作量 | 决策 |
|------|------|--------|------|
| 轮询 `GET /v1/tasks/:id` | 够用 | 最小 | 首版必有 |
| SSE（Bearer 鉴权）实时日志 | 流式 | 中（复用 transcript 基建） | 首版宜有 |
| Webhook 回调订阅 | 真异步可编排 | 大（存订阅+重试+签名） | 后置子轨 |

MCP 工具典型用法 = 「创建 → 轮询直到终态 → 取 transcript」，SSE/poll 优先，webhook 后置。

---

## 6. T3 深化设计：MCP OAuth 薄 AS（已定稿）

### 6.1 为什么手搓而非采用 mcp-nest（D5 依据）

spike + 对抗验证（裁决见 §7）后两路差距被拉大：

- **官方 SDK 的 AS 侧助手是死路**：`ProxyOAuthServerProvider` / `mcpAuthRouter` 已弃用（`@modelcontextprotocol/server-legacy`），且它把 DCR 转发给**上游** AS——而 GitHub 没有 DCR 端点、没有 AS metadata，所以 GitHub 无法坐在它上游。
- **mcp-nest 内建 AS 不是「纯配置」**：它确实原生做 GitHub 上游跳转 + DCR + PKCE + discovery（塌缩 ~80% 管道），但 ① 发 **HS256 JWT 不是不透明 token**（偏离 D4）；② 其 `validateToken` **不校验 audience**——这是 spec MUST，要手写补；③ allowlist 闸门、confused-deputy 同意页都要自己加；④ 内建 AS 是 **Beta**。
- **手搓路因两点变得划算**：(a) DCR 被证明非连接必需（§7），削掉手搓最重的一块的紧迫性；(b) 本仓库已有几乎为 D4 量身的机制可复用（下）。

**RS 侧用官方 SDK（v1.x 单包路径）**：`requireBearerAuth` + `mcpAuthMetadataRouter`（来自 `@modelcontextprotocol/sdk/server/auth/*`，**不是** v2-alpha 的 `@modelcontextprotocol/express`）的 `verifyAccessToken(token)` 接口正好插我们的 DB 内省。⚠️ 该接口要求返回**完整 `AuthInfo`（含 `expiresAt`）**，否则每个有效 token 都 401——见 §6.5 / G1。

### 6.2 可直接复用的现有机制

| 复用点 | 现有实现 | T3 用途 |
|--------|---------|---------|
| HMAC 签名 state + cookie pin | `auth/session-token.ts` `signState`/`verifyStateSignature`/`statesMatch` | leg-2(→GitHub) 的 state，编码 `pending_authz.id` |
| GitHub code 交换 + 取 /user | `auth/github-oauth.service.ts` | `/callback` 里换 GitHub token |
| allowlist 闸门 | `auth/allowlist.ts` `isAllowlistedRaw` | `/callback` 签发前 + 每 `/mcp` 请求重查 |
| 不透明 token 存哈希 / 过期判定 | `session-token.ts` `hashSessionToken`/`isSessionExpired`/`mintSessionToken` | mcp token 的存储与校验 |
| 凭证解析核心 | `auth/operator-principal.ts` `resolveOperatorPrincipal` | 加 kind `'mcp'` |

### 6.3 嵌套 OAuth 时序（correctness 面）

两条 OAuth 腿：leg-1 = MCP客户端↔我们的AS（客户端自己的 PKCE/redirect_uri/state/resource）；leg-2 = 我们的AS↔GitHub（我们自己的 state/secret）。靠服务端 `pending_authz` 行关联，其随机 PK 作为 leg-2 的 state 穿过 GitHub 跳转。

```
 ① 发现:  client POST /mcp 无token → 401 + WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"
          → client 抓 PRM → 抓 AS metadata(/.well-known/oauth-authorization-server, 路径插入到 /mcp) → code_challenge_methods=[S256]
 ② 注册:  POST /register (DCR, D6) → 存 oauth_client 行，返回 public client_id（token_endpoint_auth_method=none）
 ③ /authorize: 校验 client_id 已知 / redirect_uri 精确匹配(loopback端口豁免 RFC8252) / code_challenge 存在且 method===S256 / resource===规范URI
 ④ 同意页★: 我们自己的、按 client_id 的 consent 页(CSRF, frame-ancestors none) ← confused-deputy 必须;leg-2 state cookie 仅同意后才设
 ⑤ leg-2→GitHub: state=signState(SESSION_SECRET) 编码 pending_authz.id → 302 github authorize (我们的静态 GitHub App client_id)
 ⑥ /callback: verifyStateSignature + statesMatch(cookie) → 用 GitHub code 换 token(此腿无需 PKCE) → GET /user
 ⑦ allowlist 闸门★: isAllowlistedRaw(githubId)  拒→AS自有403页,删pending_authz,签发空(绝不带code 302出去)  准→upsert user(GitHub token留服务端)
 ⑧ 签我们的码: oauth_authcode{code_hash, redirect_uri, code_challenge, resource→audience, githubUserId, +60s, 单用}; 删 pending_authz
 ⑨ 302回client: redirect_uri?code=OURCODE&state=<client原state>(回显,非leg-2 state)
 ⑩ /token: 校验 redirect_uri 一致 + PKCE: base64url(sha256(verifier))===存储challenge(常数时间) → 签不透明 access+refresh
 ⑪ /mcp 带 Bearer: RS守卫 hash 查 mcp_access_token → 未过期 ∧ audience===规范URI ∧ isAllowlistedRaw 重查 → principal{kind:'mcp',scopes}
 ⑫ refresh 轮换: 公开client必须轮换;已消费的refresh被重放=盗用信号→吊销整条 grant family
```

### 6.4 端点清单

| 端点 | 侧 | 说明 |
|------|----|------|
| `GET /.well-known/oauth-protected-resource[/mcp]` | RS | PRM（RFC 9728）。`resource` 必填；`authorization_servers` MUST |
| `GET /.well-known/oauth-authorization-server[/mcp]` | AS | AS metadata（RFC 8414，**路径插入**非追加） |
| `POST /register` | AS | DCR（RFC 7591），去重防 spam |
| `GET /authorize` | AS | 校验 + 同意页 + 跳 GitHub |
| `GET /callback` | AS | GitHub 返；allowlist 闸门；签我们的码 |
| `POST /token` | AS | PKCE 校验；签不透明 access+refresh；audience 绑定 |
| `POST /revoke` | AS | 吊销 |
| `POST\|GET\|DELETE /mcp` | RS | 工具端点（T4）；每请求过 RS 守卫 |

### 6.5 数据模型（Prisma，只存哈希，镜像 `Session`）

```
oauth_client      : client_id | client_name | redirect_uris[](精确,loopback端口放宽) | token_endpoint_auth_method | created_at
pending_authz     : id(随机=leg-2 state载荷) | client_id | redirect_uri | client_state | code_challenge | ccm('S256')
                    | resource(audience) | scope | github_user_id(null至callback) | created_at | expires_at(+10m) | consumed
oauth_authcode    : code_hash | client_id | redirect_uri | code_challenge | ccm | resource | github_user_id | scope | expires_at(+60s) | consumed
mcp_access_token  : token_hash | user_id | audience | scopes[] | client_id | expires_at(+~10m)
mcp_refresh_token : token_hash | user_id | audience | scopes[] | client_id | rotated_from | consumed_at | expires_at(+~30d)
```

RS 校验 `resolveMcpToken(rawToken, expectedAudience)` = `resolveSession` 近克隆：`hashSessionToken` → 查 `mcp_access_token` → `isSessionExpired` → `audience===规范URI` → `isAllowlistedRaw(user.githubId)` 重查 → 返回**完整 `AuthInfo`** `{token, clientId, scopes, expiresAt(epoch 秒，取自 mcp_access_token.expires_at), resource(规范 /mcp URI)}`。

> ⚠️ **G1（blocker，对抗验证查出）**：官方 `requireBearerAuth` 会**拒绝 `expiresAt` 未设的 token**（抛 "Token has no expiration time" → 401）。绝不能只回 `{user, scopes}`，否则每个有效 MCP token 都连不上。`scopes` 必须落到 `AuthInfo.scopes`（SDK 据此做 scope 校验）。

principal 侧：解析出的 user/scopes 接进 `resolveOperatorPrincipal` 的新 kind `'mcp'`（mcp bearer 走 `mcp_` 前缀分派，独立信任域，见 §13）。

### 6.6 Scopes

`tasks:read | tasks:write | repos:read`（后续可加 `tasks:execute`）。在 tool 边界强制：缺 scope → **403**（区别于无效/缺 token 的 401）。授予 scope = 客户端请求 ∩ 用户被许可。

### 6.7 规范 audience / канonical URI

`PRM.resource`、存储的 `audience`、客户端的 `resource` 参数三者必须**逐字节相同**。一次性定死规范形（建议无尾斜杠、路径限定 `https://cap-api.douglasdong.com/mcp`），在签发与校验两端断言。

## 7. 对抗验证裁决（3 个承重判断）

| 判断 | 裁决 | 要点 |
|------|------|------|
| mcp-nest 把 T3 塌缩成「配置」| ⚠️ **部分** | 内建 AS 真做 GitHub 跳转+DCR+PKCE+discovery，但发 JWT、不校验 audience(spec MUST 漏洞)、allowlist/consent 要手写、Beta。`ProxyOAuthServerProvider` 是死路（弃用 + 需上游 DCR，GitHub 没有）→ 不采用，改手搓（D5） |
| 没 DCR 端点就连不上 | ❌ **被推翻** | DCR 是 SHOULD 非 MUST。Cursor(`mcp.json` auth 块)/Claude(Advanced settings 填 Client ID)/VS Code(`oauth.clientId` 1.123+) 都有静态路径。真正卡连接的 MUST = PRM(9728)+401、AS metadata(8414 路径插入)、PKCE S256、RFC 8707 audience。→ 我们仍首版含 DCR(D6) 为体验，但它非阻塞项 |
| 不透明 token + 本地内省合规(D4) | ✅ **确认** | 合规依据走 **OAuth 2.1 §5.2**（"token 串可被 RS 用来取回授权信息"），**不是** RFC 7662(它对同进程内省沉默)。audience MUST 由 spec "or otherwise verify that they are the intended recipient" 满足=比对存储 audience 列。单节点 JWT 一无所得（照样每请求查库做 allowlist 重确认） |

## 8. 安全 MUST 清单（逐条带规范出处）

- **confused-deputy**：静态 GitHub client_id + DCR 下，转发 GitHub 前必须取得**我们自己的**按 client 同意（别靠 GitHub 的 consent cookie）；leg-2 state cookie 仅同意后才设。
- **PKCE 降级**（GHSA-qgp8-v765-qxx9）：`/authorize` 强制 `code_challenge` 存在且 `method===S256`；`/token` verifier 缺失/不符即 fail-closed；**绝不静默降级 plain/none**。
- **token passthrough 禁止**：GitHub token 留服务端，客户端只见我们自签的不透明 token；RS 拒绝非我方 token（audience 校验）。
- **exact redirect_uri**：精确串匹配，仅 loopback 放宽端口（RFC 8252）；allowlist 拒绝时绝不 302 任何 code。
- **refresh 轮换 + 重放检测**：公开 client 必须轮换；已消费 refresh 重放 → 吊销整条 grant family。
- **token 只存 SHA-256 哈希**（镜像 `mintSessionToken`），原始 token 绝不落库。
- **限流**：公开 API/MCP 开放算力，零限流基建，T1/T2 必须新建 per-key/per-user 限流；并发 slot 信号量只兜底总量。
- **措辞修正**：合规论证引用 OAuth 2.1 §5.2，**不要**写「RFC 7662 允许同进程内省」（7662 对此沉默）。

## 9. 工作量估算（T3，路径2）

约 **4–6 人日**（DCR 含在内但因复用抵消）：
PRM+401+AS metadata(0.5d) → DCR `/register`(0.5d) → `/authorize`+consent(1d) → `/callback`+allowlist 闸门(0.5d，大量复用) → `/token`+PKCE+不透明签发(1d) → refresh 轮换+重放检测(0.5–1d) → `resolveMcpToken`+principal kind `'mcp'`+RS 守卫(0.5d) → 客户端实测 Claude/Cursor 各跑通(0.5–1d)。

## 10. 前向兼容 / 待决

- **CIMD/XAA（2025-11 草案）**：客户端用 URL 托管的 client metadata 文档替代 DCR。设计对齐稳定的 **2025-06-18** 修订；在 `oauth_client` 留 `client_id_metadata_document_uri` 种子位，后续升级免 schema 迁移。
- **Claude.ai web（非 Desktop）静态 client 路径**：是否需邮件申请 `oauth_anthropic_creds`，待对当前 Anthropic 连接器文档核实——若是，则 DCR 对 web 客户端更有价值（已含，无碍）。
- **AS issuer URL vs RS URL**：同源 `cap-api.douglasdong.com`，确认 RFC 8414 metadata 路径派生与当前 Claude/Cursor 探测一致。
- **GitHub OAuth App 回调**：在同一个 App 上加第二个回调 `…/mcp-oauth/github/callback`（GitHub 允许多回调；App 仍是单一静态 client_id——与 confused-deputy 分析相关）。
- **MCP SDK 版本/包路径**：T4 **不引入 @rekog/mcp-nest**（D5 已否决其唯一差异化价值=内建 AS，剩 @Tool 装饰器引入二级框架净零收益），直接用官方 `@modelcontextprotocol/sdk` v1.x 的 `StreamableHTTPServerTransport`。v1.x 是**单包**：RS 助手在 `@modelcontextprotocol/sdk/server/auth/*`、传输类是 `StreamableHTTPServerTransport`——**别照搬 GitHub main 的 v2-alpha**（`@modelcontextprotocol/express` / `NodeStreamableHTTPServerTransport`）。装包后先 `node -e "require(...)"` 钉死真实子路径再写代码（G2）。

## 11. 关键来源

- MCP Authorization 2025-06-18：https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- MCP Security Best Practices：https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices
- Anthropic 连接器鉴权：https://claude.com/docs/connectors/building/authentication
- Cursor MCP（静态 client）：https://cursor.com/docs/mcp
- 官方 SDK RS 助手教程：https://modelcontextprotocol.io/docs/tutorials/security/authorization
- FastMCP OAuthProxy（包非 DCR 上游的范式）：https://gofastmcp.com/servers/auth/oauth-proxy
- @rekog/mcp-nest（T4 RS/tool 层候选）：https://github.com/rekog-labs/MCP-Nest
- RFC 9728(PRM) / 8414(AS metadata) / 7591(DCR) / 8707(resource) / 8252(loopback) / OAuth 2.1 §5.2
- PKCE 降级 CVE：GHSA-qgp8-v765-qxx9
- Cloudflare 524 / SSE 缓冲：error-524 文档、cloudflared #1449（GET-SSE 缓冲到关闭）、#199

---

## 12. T0 深化：公开面划界 + /v1 + OpenAPI

**公开子集（仅这 ~7 个，其余全 console 内部）**。分类依据：是否安全（无密钥/无部署态）+ 是否需要 GitHub-identity 操作员（legacy/api-key principal 的 `user===null` 会被现有 `requireOperator`/`requireGithubId` 拒）。

| 端点 | 桶 | /v1 改造 |
|------|----|---------|
| `POST /v1/tasks` | 公开（需改造） | repoId 从 path 移入 body + 接 `Idempotency-Key` 头 |
| `GET /v1/tasks` | 公开（需改造） | cursor 分页 + `{items,nextCursor}` 信封；共享池=返回全部 |
| `GET /v1/tasks/:id` | 公开 | 原样（TaskSchema 已无密钥） |
| `POST /v1/tasks/:id/stop` | 公开 | 原样；共享池=可停任何人的（D2 接受） |
| `GET /v1/repos` · `GET /v1/repos/:id` | 公开（列表需分页） | RepoSchema 无 OAuth token |
| `GET /v1/tasks/:id/transcript` | 公开 | = session-history 别名，容器无关只读 |
| `GET /v1/openapi.json` + `/v1/docs` | 公开-免鉴权 | 建议加入豁免（像 /version） |

console 内部（**绝不上外部面**）：oauth/* · settings(+codex 凭证) · audit · metrics · /tasks/:id/metrics · runtimes 就绪 · github-import(需 githubAccessToken) · self-update · update-status · /v1/approvals(沙箱回调,已豁免) · WS /terminal。

**版本化 = 加新 `@Controller('v1/...')` 委托同一 service**（`TasksService`/`ReposService`/`TRANSCRIPT_STORE`），console 控制器与 apps/web 契约**零改动**。**不调 `app.enableVersioning()`**（会把版本号强加全表、风险 console 契约）；纯路径前缀控制器与已在产的 `/v1/approvals` 一致。**这正是端点版本演进的基础**：将来对外端点要做不兼容修改时，新增 `@Controller('v2/...')` 控制器，`/v1` 消费者不受影响、可并存、按弃用周期下线——对外端点天然版本化（用户 2026-06-19 确认为优先项，故对外 API 一律走 `/v1` 而非未版本化的 console 内部路径）。AuthGuard **零改动即自动保护**（新 /v1 路径不在任何豁免表）。

**新 /v1-only 契约**（`CreateTaskRequestSchema.extend({repoId})`、分页信封、Idempotency-Key）**绝不改** console 的 `CreateTaskRequestSchema/ListTasks/ListRepos`——apps/web `real.ts` 直接 import 它们。task-create/分页/幂等是**净新契约工作，非纯委托**。

**OpenAPI = `@asteasolutions/zod-to-openapi` 钉 v7（zod-3 线）**：实测 zod 解析到 **3.25.76**（非 3.23.8），树里另有 zod 4.4.3（仅 TanStack 前端工具链拉，api/contracts 不碰）→ v8 是 zod-4 线会错。`extendZodWithOpenApi(z)` 是对**共享 z 的一次性全局副作用**，放 contracts 外、同一 z 实例。契约只用 `z.object/enum/literal/array/discriminatedUnion/nullable/optional`（无 `.transform/.lazy/.brand/.pipe/superRefine`），逐 schema 映射干净。

**风险**：豁免必须 **exact-match**——若有人改成 `startsWith('/v1/')` 整个外部 API 静默裸奔（`/v1/approvals` 是 exempt）。加测试钉 `/v1/tasks` 非豁免。

## 13. T1 深化：API Key + 四凭证消歧

**承重：四 Bearer 消歧（前缀分派必须在最顶）**。`resolveOperatorPrincipal` 扩展：

```
b = bearerToken
if b?.startsWith('cap_sk_') → resolveApiKey(b)   → kind 'api-key' | null   ← 最先, fail-closed
if b?.startsWith('mcp_')    → resolveMcpToken(b)  → kind 'mcp' | null       ← 最先, fail-closed
if sessionToken             → resolveSession      → kind 'session'          ← 之后
if b && legacyEnabled && constantTimeEqual(b, AUTH_TOKEN) → 'legacy-token'  ← 仅未打前缀的 bearer
else null
```

- ⚠️ **G4**：前缀分派必须是函数**第一条语句**。WS 单信道把同一 presentedToken 同时塞 `sessionToken`+`legacyBearerToken`（terminal.gateway.ts:696-697），且 resolve 是 session-first——分派放后面会让 `cap_sk_`/`mcp_` token 先撞 Session 库查询。加测试：`cap_sk_`/`mcp_` 在 REST 头 + WS 各一例，绝不命中 Session 库。
- ⚠️ **G10**：`AUTH_TOKEN` 是运营者自选自由文本（仅 trim，可碰撞；session token 是 randomBytes32 不会）→ 加 boot 断言：`AUTH_TOKEN` 不得以保留前缀开头，否则拒启。
- 常数时间属性保留（每域各自 SHA-256 哈希查库或 `constantTimeEqual`；前缀是公开非密路由决策）。

**ApiKey Prisma**（镜像 Session，只存哈希）：`userId / tokenHash(SHA-256) / prefix / last4 / name / scopes[] / lastUsedAt? / expiresAt? / revokedAt?`。`resolveApiKey` = `resolveSession` 近克隆 + owner allowlist 重查。`lastUsedAt` best-effort 异步，不阻塞热路径。key 体用 `randomBytes(32).base64url`（plain-SHA256 才成立）。

**CRUD（session-only 铸造，防提权链）**：`POST /api-keys`（原始 key 只回一次）/ `GET`（只回 prefix+last4）/ `DELETE`（置 revokedAt）。apps/web settings 加 API Keys 卡。

**scopes**（与 MCP T3 §6.6 共享）：`ScopeSchema=enum('tasks:read','tasks:write','repos:read')`。⚠️ **G9**：session/legacy 的 `scopes===undefined` 语义=**全放行**（否则现有 console 全 403）；`hasScope(p,req)`：undefined→true。缺 scope→**403**（非 401）。

**audit 归属（G11，静默 no-op 陷阱）**：`TasksController` **现在根本没读 `operatorPrincipal`**，create/stop 不传 githubId → 今天连人类 session 创建的任务都是 system 归属。T1 必须显式让 controller 读 `principal.user.githubId` 传给 service（两方法已收可选 githubId 形参，只是没传）。加测试钉 api-key 创建的任务 `userId=owner`。

**限流**：`@nestjs/throttler` 作为**第 2 个 APP_GUARD，注册在 AuthGuard 之后**（全局 guard 顺序=provider 注册顺序），`getTracker` 读 `req.operatorPrincipal`（per-key/per-owner，**非** raw header）。单实例进程内存 store 够 v1。

## 14. T2 深化：异步观测 + 加固

**关键发现：外部调用方不需要 WS/PTY 原始流**（它与 gateway 的内存 session map / write-lease / 背压强耦合，且容器终止即 unregister）。需要的是生命周期状态 + 最终 transcript，二者都已与活容器解耦：

- **轮询 `GET /v1/tasks/:id` = v1 地板**：`transition()` 是唯一状态写入点，findById 直读 row，状态完全可观测。
- **SSE 干净 seam = `AuditEvent` 表尾**（`transition()` 已 fan-out 到 append-only `AuditEvent`，`@@index[taskId,timestamp]`，天然游标序），**不是** PTY 流。`GET /v1/tasks/:id/events` 尾随 AuditEvent（~1.5s 轮询 `timestamp>lastSeen`，`id:`=event id 支持 Last-Event-ID，`:ka` 心跳，终态自关）。可选在 transition 加 rxjs Subject 推送（免轮询），DB 尾作多副本/audit-未绑兜底。
- `get_transcript` 复用 session-history（durable-first `readDurable`，容器无关，已 Bearer-ready）。

⚠️ **G7 CF 流式只验证了文档、未验证线**：CF 命名隧道有 **~100–120s idle 超时**（非企业不可调，本隧道历史上 524 过无心跳的 WS）→ **<90s 心跳是硬要求，非"缓解"**；cloudflared #1449 让 **GET-SSE 一直缓冲到关闭**（headers 救不了）→ **server-push 走 POST，别把 GET /events 作主路**；`text/event-stream` + `Cache-Control:no-cache,no-transform` + `X-Accel-Buffering:no` + `Content-Encoding:identity` 让 cloudflared 切 flush。**上线前用 `curl -N` 跑一次 2 分钟心跳流实测 cap-api.douglasdong.com**（唯一真未知；之前隧道流式成功全是 WS 非 HTTP SSE）。

**幂等**：POST create 可选 `Idempotency-Key`；`IdempotencyKey{key, scopeUserId, requestHash, taskId, expiresAt(+24h), @@unique[scopeUserId,key]}`，与 `task.create` **同事务**插入防竞态双 admit；同 key 同 body→同 task，同 key 异 body→409。
**分页**：keyset cursor=`base64(createdAt|id)`（createdAt 单列不唯一会丢/重），default 50 max 200，console 不动。
**webhook**：**推迟**；先建 transition Subject seam，未来 dispatcher 订阅同源。
⚠️ **G6**：semaphore 只 cap 运行中、不 cap 已创建 → 单 key 可灌爆 queued 积压（DB+内存）；per-key **create-rate cap** 是真兜底，与限流一起做。

## 15. T4 深化：MCP 挂载 + 工具

**挂载抉择 = 官方 SDK transport 直挂（非 mcp-nest）**。mcp-nest 解耦 auth 技术上支持（`guards:[]`+`transport:[]`），但 D5 否决其唯一价值（内建 AS）后只剩 @Tool 装饰器，引入整个二级框架净零收益。

```ts
@Controller() class McpController {
  @Post('mcp') @Get('mcp') @Delete('mcp')
  async handle(@Req() req, @Res() res) {
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => t.close());
    await this.mcpServer.connect(t);              // 一个 McpServer(工具注册一次), transport per request
    await t.handleRequest(req, res, req.body);    // req.body = Nest 默认 json() 已解析
  }
}
```

stateless 模式（无 session 亲和，友好 CF/横扩）。`requireBearerAuth({verifier:{verifyAccessToken: resolveMcpToken}})` 作 Express 中间件挂 /mcp 前，401 带 `WWW-Authenticate: Bearer resource_metadata=...`（发现握手 §6.3 ①）。

**全局 guard 短路**（mirror /v1/approvals + /auth/*）：⚠️ **G8** 豁免 `/mcp` + 全部发现/AS 路径（含 RFC 路径插入变体 `/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server/mcp` + `/register /authorize /callback /token /revoke`），**但 `/mcp` 仍受 requireBearerAuth 保护非裸奔**。exact-match 枚举；加测试钉 `/mcp` 无 bearer 仍 401、各发现路径豁免。

- **WS 共存**：WsAdapter 只截 /terminal upgrade，/mcp 是 HTTP，无冲突。
- **DNS-rebinding**：SDK transport 校验 Host/Origin，CF→nginx→:8080 上游 Host 可能不匹配 → 配 `allowedHosts=cap-api.douglasdong.com` 或 disable（靠 bearer+audience 兜）。
- **body limit**：Nest json() 默认 100kb，大 prompt 可能 413，按需抬高 /mcp。
- ⚠️ **G13 CORS**：/mcp + .well-known 要 route-scoped **bearer-only 非凭证** CORS（别把 claude.ai 加进 console 的 `credentials:true` origin 列，否则该浏览器源会带 cap_session）。

**工具表**（name | input | service | scope）：
- `create_task` `{repoId,prompt,branch?,strategy?,runtime?,skills?,deadlineMs?,idleTimeoutMs?}` → `TasksService.create(repoId,body)` | tasks:write
- `get_task` `{taskId}` → `findById` | tasks:read
- `list_tasks` `{}`（共享池）→ `list` | tasks:read
- `stop_task` `{taskId}` → `stop` | tasks:write
- `get_transcript` `{taskId}` → session-history 逻辑 | tasks:read
- `list_repos` `{}` → `ReposService.list` | repos:read
- **`start_sandbox` 不作独立工具**：无独立 provision 路径（provision 由 guardrails admit 驱动）→ 是 `create_task` 别名，或不出（独立暴露会开一条绕过 FIFO 信号量的未管控 provision 路径）。

**异步**：`create_task` 立即返回 `{taskId,status}`（create 从不 await 完成），client 轮询 `get_task` 到终态再 `get_transcript` → 无工具阻塞，不撞 MCP 调用超时。
**scope 在工具边界查**（requireBearerAuth 只验 token、不查 scope-vs-tool）：缺 scope → `McpError` → 403 语义。

## 16. 跨轨硬约束 + 必落测试/探针（万无一失闸门）

对抗验证 + 完整性批判查出 **1 blocker + 7 major + 5 minor，全部 spec 修订/小探针，无需重设计**。上文各节已修订；汇总闸门：

| # | 级 | 轨 | 问题 | 关闭动作 |
|---|----|----|------|---------|
| G1 | **blocker** | T3 | resolveMcpToken 只回 {user,scopes}；requireBearerAuth 拒绝 expiresAt 未设 token → 全 401，无客户端能连 | §6.5 已改回完整 AuthInfo；加测试：有效 token 被放行 |
| G2 | major | T4 | 引用 v2-alpha 包 @modelcontextprotocol/express | §10 已改 v1.x 单包；装包后 `node -e require` 钉死子路径 |
| G3 | major | T4 | §4/§10 与 D5 矛盾（还提 mcp-nest） | 已改官方 SDK transport 直挂 |
| G4 | major | T1 | 前缀分派不在最顶 → WS 单信道 token 跨域误试 | §13 分派为第一语句 + REST/WS 双测试 |
| G5 | major | CI | DI 顺序崩溃前科（persist-transcripts 致生产 6h 宕，build+单测没抓）；本 epic 加 ~3 模块+第2 guard | **落新模块前 CI 加 boot smoke（起 app 打 /health），设 required** |
| G6 | major | T2 | throttler 须排 AuthGuard 后否则退化 IP 限流；semaphore 不 cap 创建 → 积压灌爆 | §14 第2 APP_GUARD 在后 + per-key create-rate cap + 双 key 同 IP 独立桶测试 |
| G7 | major | T2/T4 | CF 流式从未实测；~100s 超时；GET-SSE 缓冲 bug | 上线前 curl -N 2min 心跳实测；<90s 心跳硬要求；server-push 走 POST；轮询作地板 |
| G8 | major | T3 | 发现豁免须 exact-match 枚举全变体，/mcp 必须仍受护 | §15 枚举 + 测试钉 /mcp 无 bearer 仍 401 |
| G9 | minor | T1 | scopes===undefined 须=全放行 | hasScope undefined→true + 测试 |
| G10 | minor | T1 | AUTH_TOKEN 前缀碰撞 | boot 断言不得以保留前缀起头 |
| G11 | minor | T1 | audit 归属是静默 no-op（controller 没读 principal） | controller 显式传 githubId + 测试 |
| G12 | minor | T0 | zod 实测 3.25.76 非 3.23.8，树里有 zod4 | zod-to-openapi 钉 v7 + console schema 字节不变测试 |
| G13 | minor | T4 | CORS 全局凭证，MCP 需 route-scoped bearer-only | /mcp+.well-known 单独非凭证 CORS |

事实更正：**zod=3.25.76**（非 3.23.8）；api 内部端口=**:8080**（nginx upstream，非 main.ts 默认 3000）。

## 17. propose 就绪度

完整性批判裁决：**整体尚未"万无一失"，但很近，缺口外科级非结构级，一轮定向修订即闭合。架构（单 `resolveOperatorPrincipal` 漏斗 / 加层 /v1 委托同一 service / 容器无关 transcript / 官方 SDK RS 助手）经验证为真。**

- **T0、T1 现在就能 propose**（前缀分派顺序 / AUTH_TOKEN 断言 / scope-undefined / audit 穿线 / v1 加层 schema + zod-to-openapi v7 都已明确且有测试）。
- **T2、T3、T4 propose 前先关**：G1(resolveMcpToken AuthInfo)、G2(v1.x 导入路径，装包验证)、G7(CF 心跳实测)、G8(发现豁免枚举)、G5(CI boot smoke)、G6(throttler 顺序+create-rate)。
- 建议起手 **T1**（最独立，建的消歧核心 T3 复用；G4/G5/G9/G10/G11 都在其内一次性钉死），**CI boot smoke(G5) 作为它的前置守卫先落**。

## 18. UI 跟进 change（OD「OpenSpec Agent System」设计稿，2026-06-19）

参考 OD 项目 `680d21c4`（linkedDir=本仓库）的 `index.html`（简化首页）+ `screens/api.html`（API 调试页）设计稿，拆两个独立前端 change，其中 API 页与 epic 的 T0 强相关：

- **change `simplify-landing-homepage`（独立，已 propose 完成 4/4 valid）**：把营销落地页 `/` 简化为 nav→hero→footer，砍掉 proof-tiles / `#workflow` process-rail / `#security` boundary-ledger，保留 session-aware + SSR-safe + runner-capsule 预览；MODIFY `frontend-console` 的 Landing-family 需求 + 刷 `/` 像素基线。不碰后端/console。
- **API Playground（`add-api-playground`，B，待规划）**：控制台内 Postman 式 API 测试页（`routes/_app/api.tsx`），左接口集合 + 右请求/响应，**真实执行**，auth 用**当前会话自动签名**（OAuth 注入，登录用户无需填 token）。新能力 `api-playground` + MODIFY `frontend-console`（路由树 +1 页、侧栏加「API 调试」入口、像素基线）。
  - **关键决策（2026-06-19，因版本化成优先项而从"调现有端点"翻转）**：**Playground 调版本化的 `/v1`，故依赖 T0；先完整建 T0（公开 /v1 面 + OpenAPI/分页/幂等）再做 B**。理由：Playground 是「对外版本化 API 的 UI」，让它测未版本化、即将被 /v1 取代的 console 内部端点会误导用户且 T0 后整目录要改路径。
  - 故 B 的目录直接用设计稿的 `/v1/*`（tasks/repos/sessions transcript/version 等）；session-cookie transport 已具备（web `request()` 的 `credentials:include`）。
  - B **未开 change**（空脚手架已删），待 T0 的 /v1 契约定稿后再 propose。

**排序**：`simplify-landing-homepage`（独立，可随时 apply） ‖ 〔T0 公开 /v1 面〕→ `add-api-playground`。
