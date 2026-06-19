# 后端服务架构审查报告

> 审查日期：2026-06-19（第二版，针对 main 当前状态重写）
> 锚定：`main @ e611ab9`（#20，`Release-As: 0.7.0`）。范围：`apps/api`（NestJS 编排器）+ `packages/contracts` + 部署拓扑。
> 方法：分子系统探查 → 两轮对抗式代码核验（共 66 条断言，绝大多数 confirmed/good；分歧处以代码为准修正）。
> 标注：**✅ 已核验** = 已对照源码逐条确认（附 `file:line`）；**🔴** = 重大发现；**⚠️** = 待处理。

> **本版相对第一版的变化**：第一版（2026-06-18）误把"工作树 + 在飞重构"当成 main 来审，已作废若干结论。本版锚定 main 真实提交链：multi-runtime 抽象已经历一次 policy/mechanism 重构（#19）并即将随 v0.7.0 发布；并新增一条第一版没看到的重大发现——**claude-code 在 v0.6.0 是"上线即死"**。

---

## 0. 一句话结论

核心架构**不需要重构**，且比上一版更健康：第一版建议的 P1（把 codex 半内联/双接口收敛成单一 policy 端口）团队已在 #19 主动、漂亮地完成，机制层实测零 agent-identity 分支、codex 字节级不变有 golden 测试兜底。

唯一的真要务是**补一条回归测试**：claude-code 的 runtime 选择路径曾让该功能在 v0.6.0 100% 失效（DOA），修复（#19）即将随 v0.7.0 发布，但守护那个 seam 的快速/CI 测试至今缺失——同一个 bug 已经修过两次，正是这个测试盲区让它反复。

---

## 1. 整体形态：单进程编排器 + 一任务一沙箱

单进程 NestJS 编排器：它本身不跑 agent，而是为每个任务拉起独立的 AIO 沙箱容器，agent（`codex` / `claude-code`）在容器内的 detached tmux 会话中运行。

```
┌──────────────────────────────────────────────────────────────────┐
│  浏览器 (TanStack Start, Vercel)                                    │
│   GitHub OAuth 登录 · 硬 allowlist (按不可变 githubId)              │
└───────────────┬───────────────────────────┬──────────────────────┘
        REST /v1/* (cookie/bearer)     WS /terminal (connect-auth)
                │                           │
┌───────────────▼───────────────────────────▼──────────────────────┐
│  api 单进程 (NestJS · cap-api 镜像 · restart: unless-stopped)       │
│                                                                    │
│  控制面          实时面             安全/并发(全内存)    可观测       │
│  TasksService    TerminalGateway   Guardrails(信号量)   Metrics    │
│  Repos/Import    AioPtyClient      WriteLock(写租约)     Audit(DB)  │
│  Settings        Snapshot/Cast     Creds(临时凭据)       SelfUpdate │
│  Auth            Approvals         RetentionCleaner               │
│                                                                    │
│  ── AgentRuntime 抽象层 (#19 后: 单一 policy/mechanism 端口) ──      │
│     port(policy) → CodexRuntime / ClaudeCodeRuntime                 │
│     Registry → 机制层(provider/pty)读 policy, 零 id 分支            │
│                                                                    │
│  ── 端口 (DI token) ──                                              │
│     SandboxProvider · CodexAuthSource · ClaudeAuthSource           │
│     ProvisionLookup · RuntimeRegistry · AuditRecorder              │
└──────┬─────────────────────────────────────────────┬─────────────┘
       │ dockerode (docker.sock)                       │ Prisma
       │                                               ▼
┌──────▼────────────────────────────┐          ┌──────────────┐
│ 每任务沙箱 cap-aio-<taskId>         │          │ PostgreSQL    │
│  cap-net 私网 · 不暴露宿主端口       │          │ (单实例)      │
│  /v1/shell/exec  /v1/shell/ws      │          └──────────────┘
│  detached tmux: task<taskId>       │
│   └─ codex / claude TUI            │   持久卷 workspaces/<taskId>/
└────────────────────────────────────┘     session.log / .cast / transcript.gz
```

**版本状态（重要运维含义）**：当前最高 tag 是 **v0.6.0**；`#20` 触发的 **v0.7.0 尚未切出**。**v0.6.0 上 claude-code 是坏的**（见 §4.2），要等 v0.7.0 发布并升级后才修复。常驻 prod 栈若在 v0.6.0，claude-code 不可用。

---

## 2. 任务生命周期（控制面核心，✅ 已核验）

```
create(repoId, body)                                    [tasks.service.ts:434]
  ① repo 存在性校验 (404)
  ② runtime 解析 registry.resolve(runtime)   ── 未知 id → 503 fail-closed
  ③ claude-code readiness 门: 未配置 token → 503        [:471]
       (codex 不门控,缺凭据时降级为未认证运行)
  ④ prisma.task.create (status=pending; 持久化 runtime/branch/skills/guardrail 参数)
  ⑤ audit: task.created
  ⑥ guardrails.admit(taskId, {deadlineMs, idleTimeoutMs})
  ▼
guardrails.admit → semaphore.offer
  ├─ 有空位 → startRunning: transition→running, 武装 deadline/idle watcher,
  │            sandbox.provision(), 打开 TerminalGateway 会话
  └─ 无空位 → transition→queued (不开沙箱), 参数挂起
  ▼
sandbox.provision (AioSandboxProvider)                  [provision():~225]
  ① 幂等检查 ② 镜像/seccomp 校验 ③ createContainer(cap-aio-<id>, cap-net, 无宿主端口)
  ④ start ⑤ 轮询 /v1/docs 就绪
  ⑥ resolveProvisionMaterial(runtime) → 集中解析凭据 (official/compatible+SSRF/claude token)
  ⑦ runtime.sandboxSetupCommands(ctx, material) → provider 跑返回的命令 (两 runtime 统一)
  ⑧ git clone(token 走 http.extraHeader 不进 URL) ⑨ 预装 skills(allowlist)
  失败 → teardownSandbox 再抛 (绝不泄漏容器)
  ▼
运行中: AioPtyClient 连 /v1/shell/ws → launch-or-attach detached tmux
        pty 读 runtime.terminalStartup (声明式) 决定 DSR/CR
        Gateway 把 PTY 输出 fan-out + 写 session.log + 录 .cast + 喂 snapshot
        liveness poller 调 runtime.detectExit (codex: tmux has-session; claude: transcript end_turn)
  ▼
终态 (completed / failed / cancelled / agent_failed_to_start)
  transition() 单一写入口 → audit + isTerminal → guardrails.onTerminal:
   清 timer → captureTranscript(持久化) → runtime.preStopTrimCommands()(fail-open) →
   teardownSandbox(停但保留) → teardownSession(销毁临时凭据) → semaphore.release → admitNext(FIFO)
```

**崩溃恢复（`onApplicationBootstrap` 三阶段）**仍是后端最扎实的部分之一：Phase 0 重认领存活的 detached 会话（不误判 failed）→ Phase 1 回收真死任务 → Phase 2 按 FIFO 重发 queued。

---

## 3. 符合预期 / 做得好的部分 ✅

| 维度 | 评价 | 核验 |
|---|---|---|
| **policy/mechanism 重构（#19）** | 见 §4.1，机制层全绿，是这次复审的最大亮点 | ✅ |
| **端口化设计** | `SandboxProvider`/`*AuthSource`/`ProvisionLookup`/`RuntimeRegistry`/`AuditRecorder` 全 DI token 绑定 | ✅ |
| **模块环消解** | `Tasks↔Guardrails↔Terminal↔Audit` 的环用「窄接口 + token + `@Optional()` + 重新 provide」打破 | ✅ |
| **Fail-closed 安全** | allowlist 按不可变 `githubId`(`allowlist.ts:61`)；session token 存 SHA-256 哈希；legacy token 常量时间比较；redirect 白名单 | ✅ |
| **凭据加密静存** | AES-256-GCM + 随机 12B IV + GCM authTag；key 缺失 fail-closed 抛错；读路径只暴露末 4 位掩码(`settings-crypto.ts:31/85/185`) | ✅ |
| **密钥处理（重构后）** | `sandboxSetupCommands` 返回含 base64 密钥的命令串，但 provider 从不记录命令串本身（只 scrub 输出）→ 相比旧 `injectAuth(exec)` **无新增暴露面** | ✅ |
| **沙箱隔离** | 不暴露宿主端口；GitHub token 走 header；clone 失败信息脱敏；停机前 trim `~/.codex`/`~/.claude` 保留 transcript | ✅ |
| **崩溃恢复** | detached tmux + 三阶段 boot recovery，重部署不杀在跑任务 | ✅ |
| **可观测诚实性** | metrics 采样失败返回 `stale`/`unavailable` 不伪造 0；update-status 失败诚实降级 | ✅ |
| **self-update 收敛** | 四层门禁(env 默认 OFF + admin allowlist + 必须匹配最新 release 的合法 semver + plan 全服务端生成) | ✅ |
| **兼容 provider 已接通** | 见 §3.1（第一版误判为死配置，本版纠正） | ✅ |

整体代码纪律好：**全 `apps/api/src` 里 `grep TODO/FIXME/HACK/XXX` 零命中**（✅ 已核验）。

### 3.1 兼容/自定义模型 provider：已闭环（非死配置）

`codex-auth-source.port.ts` 是 `official | compatible` 判别联合；`prisma-codex-auth-source.ts:109` 在 compatible 分支解密凭据；`aio-sandbox.provider.ts` 按 `kind==='compatible'` 写 `~/.codex/config.toml` 的 `[model_providers.cap]`（`wire_api="responses"` + `experimental_bearer_token`）；baseUrl 写入前过 `assertSafeProviderUrl()`（DNS 解析拦内网，**SSRF 已补**）；凭据按**任务 owner** 解析（走 `task.created` 审计归属，**越权已修**）。来源：归档 change `2026-06-17-wire-compatible-provider-execution`。#19 后该路径仍在，且 SSRF 校验作为 **mechanism** 留在 provider、不污染纯 runtime policy。

---

## 4. 多 runtime 抽象：现状与一段重要历史

### 4.1 policy/mechanism 重构（#19）——教科书级，机制层全绿 ✅

`add-claude-code-runtime`（v0.6.0）当初为了不动 codex 字节脆弱的终端握手，用 adapter-bridge 仓促集成，导致 codex 逻辑散落 4 处 + 两个并行 `AgentRuntime` 接口 + `RuntimeAdapter`（即第一版 §4 我标注的顾虑）。`#19` 做了一次纯重构（codex/claude 行为不变），把端口重塑为 **POLICY，机制层为 MECHANISM**。审计逐条确认：

- **runtime = 纯 POLICY**：单一接口 5 个接缝——`buildLaunchLine` + 声明式 `terminalStartup` + 纯命令发射器 `sandboxSetupCommands`/`preStopTrimCommands` + 单 `detectExit`，**不持有任何 I/O**（`agent-runtime.port.ts:191-242`）。
- **机制层零 agent-identity 分支**（grep + 语义双查）：provider 用数据驱动 dispatch 表 `resolveProvisionMaterial`（`provider:971-982`）；pty client 读 `runtime.terminalStartup.replyToStartupDSR`/`promptSubmit`（`aio-pty-client.ts:405-407,647`），无 `id==='codex'`、无伪装身份判断的兜底布尔。
- **双接口合一、`RuntimeAdapter` 已删**（`integration.ts:23-27,82`：re-export 端口类型，registry 直接交付叶子 runtime）。
- **codex 字节级不变有 golden 测试**：`agent-runtime.test.mjs:479-593` 对 config.toml/auth.json/compatible TOML/prompt/trim 命令逐字节断言（含"无 prompt 时省略写入"陷阱用例）。
- **provider 集中解析全部 material**（official auth / compatible+SSRF / claude token），统一传给 `runtime.sandboxSetupCommands`，统一跑命令；`plan.ok===false`（claude 无 token）→ provision 前 throw + teardown（fail-closed）；codex 无凭据 → 降级（fail-open）；trim 全程 fail-open（10s 超时、warn-only）。
- **退出码语义保留**：`SandboxSetupCommand.tolerateUnresolvedExit` 精确复刻 codex（NaN 也 fail-closed）vs claude auth 写（NaN 容忍）的旧行为。

净 -139 LOC，已在真实 x86 沙箱端到端验证（codex + claude）。spec 侧 `refresh-agent-runtime-spec`（commit 9b175eb）已把 live spec 的 5 条过时需求 + 1 处硬枚举矛盾改成 policy/mechanism 语言，**spec 与代码一致**。

### 4.2 🔴 重大历史发现：claude-code 在 v0.6.0 是"上线即死"（DOA）

直接回答"是否符合预期"。`#18` 把 claude-code 作为可选 runtime 发布进 **v0.6.0**，但 `ProvisionLookup` 端口**从没声明 `getTaskRuntime`**，而 `IntegrationRuntimeRegistry.readTaskRuntime` 里有句防御性 `if (typeof reader?.getTaskRuntime !== 'function') return null`——于是：

```
创建路径  ✅ 持久化 runtime='claude-code', 201 返回, readiness 门生效
读取路径  ✅ 列表/详情如实回显 claude-code
派发路径  🔴 resolveForTask → getTaskRuntime 不存在 → 返回 null → 默认 codex
执行      🔴 provision 出来的是 codex(launch/auth/prompt 全是 codex)
```

用户选 claude-code、看到任务持久化为 claude-code、然后在终端里看着它**跑起 codex**——无报错、无告警、零提示的静默错位。**派发/执行层 100% 失效**。

- **修复**：`#19` 给 `ProvisionLookup` 端口加 `getTaskRuntime`（`provision-lookup.port.ts:69`）+ prisma 实现（`prisma-provision-lookup.ts:74-80` 返回 `task?.runtime ?? null`），并在 x86 实测 claude 任务真正鉴权应答。
- **发布**：`#20`（空提交，`Release-As: 0.7.0`）把该修复浮成 **v0.7.0**。即用户升到 v0.7.0 才真正能用 claude-code。
- **教训**：同一个 bug 修了两次（#19 标题 + #20 重提），根因是下面 §5 的测试盲区。这也坐实了第一版把"runtime 解析失败静默回落 codex"列为隐患的判断——那个静默回落正是掩盖此 bug 的元凶。

---

## 5. 待处理的问题（按优先级）

### 🔴 P0 — 选择路径缺真链路回归测试（这次唯一的真要务）

DOA 之所以能上线、又反复，正因为没有任何**快速/CI** 测试跑"真实 `IntegrationRuntimeRegistry` + `PrismaProvisionLookup`"组合。现有测试都绕开了出事的 seam（✅ 已核验逐一查证）：

- `agent-runtime.test.mjs:177` 测的是**叶子** `registry.resolve('claude-code')`——单元级，不走真实查找；
- `tasks.service.test.mjs:344` "dispatches to claude" 用 **fake registry**，且测的是 **create 期** `resolve()`，**不是** DOA 所在的 **provision 期** `resolveForTask()→getTaskRuntime()`；
- **无** `prisma-provision-lookup` 专门单测（确认无该文件）；
- 唯一覆盖真实链路的 `aio-e2e.mjs` claude-code e2e **没 token 就自跳过**，且自托管 amd64-only、不进 CI。

> 后果：谁再把 `getTaskRuntime` 从 prisma 实现删掉，所有单测照样全绿。这个曾让 claude-code 100% 失效的 seam，正随 v0.7.0 发版却无快速测试守护。

**建议**：加一个真链路回归测试——真 `IntegrationRuntimeRegistry` + 真形状 `ProvisionLookup`（或真 `PrismaProvisionLookup` 配 mock prisma），建 `runtime='claude-code'` 任务 → 断言 `resolveForTask(taskId)` 返回 `ClaudeCodeRuntime` 而非 `CodexRuntime`，把这个 seam 钉进 CI。

### ⚠️ P1 — 静默回落仍不够吵

`agent-runtime.integration.ts:163-179`：`readTaskRuntime` 在「`getTaskRuntime` 方法缺失 / lookup 抛错 / DB 值越界」时都返回 null → 默认 codex，但 `logger.warn` **只在 throw 时**触发。Prisma 抖一下，操作员选的 claude-code 会静默变 codex、无任何可见信号。**建议**：方法缺失（现在是设计错误而非优雅降级）、值越界都应 warn。

### ⚠️ P1 — 单实例硬约束仍只在代码注释（第一版遗留，未变）

并发信号量、写锁租约、临时凭据、runner-minutes 账本、retention cleaner 全是进程内内存态（✅ 已核验：`semaphore.ts:39`、`write-lock.service.ts:42`、`session-credentials.service.ts:37`、`runner-minutes.ts:79`、`retention-cleaner.ts:40`）。约束**仅写在** `retention-cleaner.ts:30-34` 注释，`docker-compose*.yml` 既未 `replicas:1` 也无说明。**建议**：提升到 compose 注释 + 部署文档 + 钉 `replicas:1`。若产品定位就是单 VPS/单运营者，这是正确取舍——勿为不存在的横向扩展引入分布式锁。

### ⚠️ P2 — `agent-runtime` 三处 docstring 漂移

代码与 spec 已对齐，但**源码内 docstring**仍提已删方法名（✅ 已核验，纯文案）：
- `agent-runtime.port.ts:1-21` 文件头仍描述旧"六接缝方法袋"（injectAuth/autosubmit/transcript capture）；
- `codex-runtime.ts:20-40`、`claude-code-runtime.ts:23-30` 类注释仍提 "no-op autosubmit"、"injectAuth writes"。

### ⚠️ P2 — 上帝对象（机会性拆分）

实测行数：`terminal.gateway.ts` **1590**、`aio-sandbox.provider.ts` **1203**（重构后从 1329 回落）、`aio-pty-client.ts` **1061**、`agent-runtime.integration.ts` 180。gateway 仍是最大上帝对象，纠缠连接鉴权/写租约/背压/输出 fan-out/session.log/cast/审批/快照重连——`AuthHandler`、`OutputBroadcaster`、`SessionLogWriter`+`CastRecorder` 是干净接缝。不阻塞功能。

---

## 6. 未改子系统：逐一确认仍成立 ✅

`git log --since='2026-06-19 02:33'` 实测：#19 之后只有 agent-runtime 自身变动（#20 空提交）。auth / guardrails / creds / write-lock / audit / metrics / self-update / settings 的最近提交全部早于 agent-runtime 工作，故第一版对这些子系统的结论在 main 上**逐字仍然有效**：单实例内存态（guardrails/creds/write-lock/metrics）、fail-closed auth、AES-256-GCM settings、self-update 四层门禁、兼容 provider 已接通。

---

## 7. 建议分档汇总

| 档 | 行动 | 状态 |
|---|---|---|
| **P0** | 补 claude-code 选择路径**真链路回归测试**（create→persist→read→dispatch，codex+claude 各一），钉进 CI | 🔴 唯一真要务 |
| **P1** | `readTaskRuntime` 静默回落加响亮日志（方法缺失/值越界/抛错都 warn） | ⚠️ |
| **P1** | 单实例约束提升到 compose 注释 + 部署文档 + `replicas:1` | ⚠️ 第一版遗留 |
| **P2** | 清 `agent-runtime` 三处 docstring 漂移 | ⚠️ 纯文案 |
| **P2** | 机会性拆 `terminal.gateway.ts`(1590) | ⚠️ |

> 运维提醒：当前 prod 若在 **v0.6.0，claude-code 不可用**；升级到 **v0.7.0**（#20 触发）后修复。

---

## 附录：核验记录

两轮对抗式核验（workflow `verify-arch-review-claims` 4 agent + `rereview-main-agent-runtime-refactor` 4 agent，共 66 条断言）：

- **第一轮**（pre-#19 工作树）：纠正两条初稿错误——"兼容 provider 死配置"被推翻（实已闭环，见 §3.1）；"单实例未文档化"修正为"仅在代码注释、未进部署配置"。
- **第二轮**（main @ #19/#20）：44 条审计 = 37 good / 2 minor / 3 concern / 2 bug。两条 "bug" 是同一 DOA 缺陷的两个切面，**已在 #19 修复**（见 §4.2）；3 concern = 测试盲区(P0)、静默回落日志(P1)、port.ts 文件头漂移(P2)；机制层完整性 10 项全绿；未改子系统 8 项全部确认稳定。
