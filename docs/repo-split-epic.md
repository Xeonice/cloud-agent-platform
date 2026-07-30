# Repo split epic — 上游总仓 + 下游分仓

母文档。记录动机、实测证据、已锁定的决策，以及分阶段的执行顺序。
每个阶段落地为一个独立的 OpenSpec change；本文档只承载**跨 change 的约束**，
不重复各 change 内部的细节。

状态：**规划中，尚未开工。** 决策已锁定，见 §3。

---

## 1. 为什么拆

三条动机，来自使用者本人，按实测后的成色排列：

**① 智能体上下文交叉（真问题，且完全没处理过）**

在同一个仓里工作时，智能体的认知与上下文互相污染。希望用物理隔离硬性切开。

实测：仓库里**没有任何 `CLAUDE.md` / `AGENTS.md`**，一个都没有。智能体面对
16 个包、908 个源文件、270,676 行，作用域约束为零。搜一次 `runtime` 命中
api 228 文件 + web 58 + contracts 36 + sandbox 22。

**② 开源与部署边界说不清（文档缺口）**

`docs/repo-layout.md` 存在，但它讲的是 `.claude/` 和 `openspec/` 这套工具链，
**关于 `apps/` 和 `packages/` 一个字没有**。自托管者无从判断该 clone 什么、
部署需要哪些。

**③ 只部署 api 不要前端（已经成立，是文档问题）**

`docker-compose.prod.yml` 里 `web` 已经是 `profiles: ["web"]`，注释写着
「CORE 运行单元 = api + Postgres，**可选** web 控制台」。不启用该 profile
即可。这条不需要拆仓，需要 ② 把它说出来。

---

## 2. 拆之前必须知道的事实

全部为实测，不是推断。

### 2.1 前后端从来没有互相引用

```
apps/web  ──> @cap-console/contracts, @cap-console/ui
apps/api  ──> @cap-console/contracts, @cap-console/sandbox
              ↑ 唯一交汇，且是「被两边依赖」，不是「互相依赖」
```

双向 grep 结果均为零。**「前后端不该互相引用」这条原则本来就成立**，
拆分不需要解耦任何引用。

### 2.2 但它们 45% 的时间一起改动

近 6 个月 179 个提交中，81 个同时改 `apps/api` 和 `apps/web`：

```
feat 48   fix 29   refactor 3   test 1
```

样本：`add model selection with API and MCP parity`、`add sub-day recurrence
controls`、`surface runtime credential failures`。

**全是纵向功能切片** —— 一个功能天然需要「契约形状 + api 端点 + UI」。
这不是抽象泄漏，是全栈功能的定义。

触及 `packages/contracts` 的 57 个提交里，**91% 同时改 api 和 web，
独立改 contracts 的是 0%**。

> **这次拆分买的是「智能体上下文的物理隔离」和「部署/开源边界的清晰」，
> 卖的是「45% 纵向功能切片的原子性」。两者都是这个选择本身的属性，
> 不会因为拆得好不好而改变。**

### 2.3 契约不只是类型，也不只是 REST

web 从 `@cap-console/contracts` 导入 213 个符号：

```
136  纯类型            (64%)   ← OpenAPI 能生成
 77  运行时值/函数      (36%)   ← 生成不了
     ├ 52  zod schema  web 用它做客户端校验平价
     └ 25  常量/函数    FRAME_CHANNEL、MAX_TERMINAL_INPUT_BYTES、
                       SCHEDULE_MINUTE_INTERVALS、PUBLIC_V1_OPERATIONS…
```

其中 1,010 行是 **WebSocket 帧协议**（`terminal-attachment-frames` 531 /
`ws-frames` 90 / `write-lock-frames` 96 / `control-frame` 62 /
`terminal-bytes` 91 / `approvals` 140）。浏览器和服务端跑同一份帧词表、
流控和字节上限。**OpenAPI 描述不了它** —— 这是「用代码生成替代共享包」
方案被否决的原因。

### 2.4 15% 的需求单条同时约束两端

687 条 capability 需求中，104 条（15%）在**一条需求内**同时约束两个运行时。
例如 `realtime-terminal` 的 `Dual-channel WebSocket stream`：服务端背压 +
浏览器 `requestAnimationFrame` 写合并 + 线上 ACK 控制帧。

这类需求**拆开写就失效** —— 一份验收标准撕成两半，两边都无法自证。
它们决定了治理层的归属（见 §3）。

集中处：`frontend-console` 26、`realtime-terminal` 7、`mcp-server` 6、
`session-history-replay` 6、`agent-runtime` 5。

### 2.4b 契约重声明审计（24 个符号 · 23 个裁定）

传递可达把「谁在共享」量清楚了，但它量不到另一件事：**契约里有定义、消费者却
另起炉灶自己声明了一份。** 机械扫描出 24 个同名候选，逐个派 agent 读两处真实
声明后分类，并对 DIVERGENT / COLLISION / DERIVED 三类做双镜头对抗性驳斥——
判错这三类，真重复就溜过去了。驳斥推翻了 2 个判决。

```
DUPLICATE   13   ← 真缺陷：同概念、同意图、本地副本无理由存在
DERIVED      5   ← 别名/收窄，不是独立重述
DIVERGENT    4   ← 同概念但刻意不同
COLLISION    1   ← 撞名，概念无关
```

（1 个符号因 agent 报 403 未裁定：`SandboxEnvironmentCompatibility`。）

**今天造成运行时故障的 DUPLICATE：0 个。** 已经漂移但没人执行的：2 处。其余
全是**丢失的编译期信号**。严重性不在「现在有错」，而在「即将建的版本闸门会
建在没人执行的声明之上」。两处已漂移的，逐行核实过：

```
契约 SmtpConfigReadSchema   host/user/from .min(1) · port .min(1)
api  实发                    { host:'', port:0, user:'', from:'', … }   ← smtp.controller.ts:259
                             没人发现，因为该 schema 全仓零调用点

契约 RuntimeReadinessResponseSchema = z.array(…)
api  实发                    { runtimes: [...] }                        ← runtimes.service.ts:83
                             web 为此长了防御代码（real.ts:776）
```

#### 「被重复致死」是模式，不是孤例

零消费者的 contracts 导出**至少 6 处**：`sandbox.ts`(整模块) · `runtime.ts`(整模块) ·
`auth-account` 的 `AdminRevealResponse` · `runtime-model` 的 `RuntimeModelPreflightError` ·
`settings` 的 `SmtpConfigReadSchema` · `sandbox-environment` 的
`SandboxEnvironmentProviderFamily`(类型)。

后三例发生在**看起来很活跃**的模块内部，逐模块可达性分析看不见它们。

**一张没人执行的 schema，会静默地变成假的。**

#### 数字的诚实边界

- **上限**：机械扫描按同名匹配，`import { type X }` 被误判为声明。已证实的误报有
  `SandboxEnvironmentProviderFamily`(5 处中 4 处)、`ForgeKind`、`Scope`、
  `TaskFailure`、`sandboxProviderLabel`。
- **下限**：改了名的本地副本不在视野内——`AdminRevealCredentials`、`McpTokenScope`、
  `SandboxPreflightProbeResult` 等。所以「6 处死声明」是保守数。

### 2.5 仓级闸门耦合很轻

`scripts/` 下只有 **3 个**同时推理两端，且全是驱动真实浏览器/终端打活 api
的 canary：`boxlite-real-cli-terminal`、`terminal-fresh-attach`、`yolo-agent`。
其余闸门都是单侧的。

### 2.6 真正的单仓税在 CI，不在拓扑

`.github/workflows/ci.yml` **7 个 job，零 `paths` 过滤**。改一行 CSS 也会跑
`task-model N-1 兼容`、`task-admission 迁移兼容`（起 Postgres）、`boot-smoke`
（起整个 api）。

构建侧已经隔离良好（turbo dry-run：web 5 个任务，api 11 个）。
**这一条加 `paths` 过滤就能解，不需要动仓库结构** —— 列在 Phase 0。

---

## 3. 已锁定的决策

| # | 决策 | 备选与否决理由 |
|---|---|---|
| D1 | **拓扑：上游总仓 `cap` + 下游子仓，submodule 钉版** | 2 仓（contracts 归 api）被否：api 仓仍然过大，智能体隔离不彻底 |
| D2 | **契约独立成仓 `cap-contracts`，发布到 npmjs 公开** | GitHub Packages 私有被否（外部贡献者多一道门槛，与开源定位冲突）；submodule 分发被否（无版本语义 + 智能体常忽略子模块状态） |
| D3 | **版本偏移用 capability attestation 防护** | 锁步发版被否（等于用流程换回今天的耦合）；启动期握手被否（只提示不阻断，偏移仍变成运行时怪 bug）；不做被否 |
| D4 | **治理层（`openspec/` + `.claude/`）与 e2e 同住总仓** | 按端拆 spec 被否 —— §2.4 那 104 条跨端需求无处可去；治理层再独立一仓被否：它与 e2e 性质相同（都是「站在所有仓之上做跨端判断」），分开只是多一个仓 |
| D5 | **版本号 = 总仓 tag = submodule 指针组合** | 语义最准：「我验证过这个组合，它是 v1.5.0」 |
| D6 | **12 个 api-only 契约模块（1,472 行）并回 `cap-api`** | 留在契约仓被否：api 改自己的内部 DTO 也要走「契约仓 PR → 发版 → api bump」，纯摩擦。并回后 `cap-contracts` 名副其实：里面每一行都是两端共享的 |
| D7 | **总仓只读铁律**（见下） | 这是 submodule 方案能成立的前提 |
| D12 | **npm scope 统一为 `@cap-console`，792 个文件的改名放在 Phase 0** | scope 已注册并验证归属（`npm org ls cap-console douglasdong` → owner，对照组 `cap`/`angular` 均为空）。混用 scope（发布包一个名、内部包另一个名）被否——源码里没有任何标记区分两者，读代码的人和智能体都要额外记忆。改名放 Phase 0 是因为**现在是最便宜的时刻**：1 个仓、1 份 lockfile、一次机械替换（实测 1,116 处 / 597 文件）+ 一次全量验证；拆分后是 6 仓 6 lockfile + 跨仓协调 |
| D13 | **`@cap-console/eslint-config`（77 行）与 `@cap-console/tsconfig`（81 行）复制到各子仓，不发版** | 它们是跨仓需要的三个包中的两个，但体量近乎为零。为 158 行建两条发布流水线、并让每个子仓的构建等它们发版，代价远大于复制。契约是唯一值得发版的跨仓包 |
| D11 | **规划全部在总仓，子仓只写代码** | 子仓不安装 `openspec/` 或 `.claude/`。这不是省事，而是 D7 得以执行的原因：实现发生在子仓的独立 clone 里，智能体因此从不需要在总仓的 submodule 目录内编辑 |
| D8 | **`cap-www` 与 `cap-release-cache-worker` 各自独立成仓** | 合并为 `cap-edge` 被否；留在总仓被否（破坏 D7）。理由是**受众边界**而非维护面：宣传站只由维护者本人负责，贡献 api 或 web 的人世界里不该有它。这与动机 ①② 同源 |
| D9 | **历史提取用 `git filter-repo`** | 实测跨未来仓边界的文件移动为 **0**，三个子仓都是干净的子目录提取，`subtree split` 亦可；选 filter-repo 因其对目录内重命名的跟随更好、大历史上更快，且它是 git 官方文档在 `filter-branch` 处推荐的替代工具。注意：非 git 自带，Phase 3 需先安装 |
| D10 | **总仓 CI 拉源码跑 e2e，不拉发布镜像** | 拉镜像与 D5 因果颠倒——总仓 tag 是「已验证的组合」，用镜像则必须先发布才能验证。且今天 `scripts/aio-e2e.sh` 本就从检出源码构建 compose 栈，拉源码是原样平移，不新增凭据 |

| D14 | **sandbox 词汇表统一到 contracts：类型层用 `import type` 收敛，运行时层保留副本 + 加对账闸门** | 见下 D14 详述 |

### D14 — sandbox 词汇表的归属

`SandboxProviderFamily` / `SandboxEnvironmentSourceKind` 这类词汇表，要同时被
**线协议层**（api↔web，需 zod 校验、必须封闭）和 **provider port**
（第三方实现的扩展点，必须开放、零依赖）使用。审计把这对判为 DIVERGENT，
理由是「一张 zod schema 表达不了封闭和开放」。**git 证据不支持这个判断。**

#### 证据

```
source-kind      contracts 与 sandbox-core 两份同一提交诞生（08972b6）
                 同一提交同步删掉同样两个成员（5a5a618）
                 从未单独变动过

provider family  sandbox-core/provider.ts 的开放联合      08972b6
                 contracts/provider-family.ts 的规范源    203436a
                 203436a 改了 sandbox-core 的 capabilities.ts + 测试，
                 唯独 provider.ts 一行没碰
```

203436a 是**专门为消灭这种重复而做的收敛**，提交信息点名「四个内容互不一致的
枚举，两个漏了 cloud-http，两个连成员顺序都不同」——它数的四个全在 contracts 侧。
sandbox-core 那份不是没看见，是**够不着**。

一处修正：驳斥者称「从开放联合删成员是语义 no-op，唯一动机就是手工同步镜像」，
前半句对（`(string & {})` 让任何字符串都可赋值，删成员只影响自动补全），
**后半句是过度推断**——保持补全准确本身就是正当动机。但结论不变：两份从未
独立演化，一致性完全靠作者当时记得，**没有任何机制保证**。

#### 约束比预想的软

```
packages/sandbox-core                     没有任何 package-boundary 测试
sandbox-environment/package-boundary:28   只断言 dependencies，不看 devDependencies
                                          禁止列表里也没有 @cap-console/contracts
```

**纯类型依赖两道闸门都过得去。**

#### 决定：分两层处理

**类型层——收敛。** `sandbox-core/provider.ts` 改为

```ts
import type { SandboxProviderFamily } from '@cap-console/contracts';
export type SandboxEnvironmentProviderFamily = SandboxProviderFamily | (string & {});
```

`import type` 编译期抹掉，不产生运行时依赖。`SandboxEnvironmentSourceKind` 同理。

**运行时层——不收敛，加闸门。** `sandbox-core/provisioning-diagnostics.ts:23` 的
`SANDBOX_PROVISIONING_DIAGNOSTIC_PROVIDER_FAMILIES` 在 line 436 被 `validateEnum`
**运行时**使用，`import type` 给不了值。取真值就要真依赖，而 contracts 依赖 zod
——sandbox-core 的零运行时依赖当场失效。**零依赖是第三方能实现 provider 的前提，
为一个四成员数组放弃它，代价不对等。**

改为保留副本 + 一道断言「它 == contracts 成员集 + `'unknown'`」的闸门，模板是
现成的 `provider-contract-parity-check.mjs`。多出的 `'unknown'` 本就该是显式扩展
（contracts 侧 `z.enum([...SANDBOX_PROVIDER_FAMILIES, 'unknown'])` 已经这么写），
闸门正好把它钉住。

**不并入的**：`host-harness/config.ts` 的 `'auto' | 'aio' | 'boxlite' | 'control-plane'`
和 `provider-terminal-story.ts` 的 `'auto' | 'aio' | 'boxlite'` 是**操作员配置取值**，
不是 provider family 本身（前者有 `control-plane`、没 `cloud-http`）。它们是别的东西。

### D7 — 总仓只读铁律

submodule 检出在 detached HEAD，智能体在其中编辑会：提交漂空、认错仓库、
忘记 bump 指针。这与本次拆分要买的隔离**方向相反**。唯一能让方案成立的规矩：

```
写 spec / 做规划   →  开总仓 cap
写代码            →  开对应子仓（独立 clone，硬隔离）
验证组合           →  总仓 CI 拉指针跑 e2e
更新指针           →  CI 自动 bump，绝不手工
```

**总仓里的 submodule 目录永远只读，任何情况下不在其中编辑。**
违反这条，②（智能体友好性）就会持续咬人。

### 目标拓扑

```
cap  （上游总仓 —— 治理 + 验证 + 钉版，不含可编辑代码）
├── contracts/              → submodule cap-contracts
├── api/                    → submodule cap-api
├── web/                    → submodule cap-web
├── www/                    → submodule cap-www
├── release-cache-worker/   → submodule cap-release-cache-worker
├── openspec/               ← 69 个 spec，含 104 条跨端需求
├── .claude/                ← skills / commands / workflows
└── e2e/                    ← e2e.yml + 3 个跨端 canary
```

两层依赖，互不冲突：

```
代码依赖层：  cap-web  --npm-->  @cap-console/contracts@1.5.0
组合钉版层：  cap      --submodule-->  各子仓具体 SHA
```

---

## 4. 阶段与顺序

依赖是硬的，不可重排。每阶段一个 OpenSpec change。

### Phase 0 — 前置（不拆也该做，且能立刻见效）

不依赖任何拆分决策，收益立即兑现，同时验证「痛点不全在拓扑」。

- **分区 `CLAUDE.md`**：`apps/api/`、`apps/web/`、`packages/contracts/`、
  `packages/sandbox/` 各一份。现在一份都没有。拆分后每个子仓要自带一份，
  这里先写好就是直接迁移。
- **`docs/product-layout.md`**：谁是谁、自托管要哪些、web 是可选的（动机 ②③）。
- **CI `paths` 过滤**：7 job 全量跑 → 按受影响范围收敛（§2.6）。
- **⚠ 未完成的验证**：`scope-agent-context-and-document-layout` 给三个 CI job 加了
  路径条件，但**条件的两个方向尚未在真实 PR 上观察**（`ci.yml` 只在
  `pull_request` / `push to main` 触发，推分支不触发）。见该 change 的 task 3.4。
  在此之前，「CI 只跑受影响的 job」这条是接好了、未经证实。
- **scope 改名 `@cap/*` → `@cap-console/*`**（D12）：实测 1,116 处 / 597 个文件的机械替换，
  含 `pnpm-lock.yaml`、`.github/workflows/{ci,release}.yml`、`apps/web/Dockerfile`、
  `scripts/{boot-smoke,scheduled-tasks-live-e2e}.sh`。一次跑完全量验证确认。

### Phase 1 — 契约仓化（不动仓库结构）

> **D6 的前提已被实测推翻。** 那个「12 个模块 / 1,472 行」是按**直接 import**
> 统计的。改按**传递可达**重算（从 web / sandbox / hooks 的导入符号出发，
> 沿契约包内部依赖闭包）：
>
> ```
> web/sandbox/hooks 可达   36 模块 / 10,104 行   ← 真共享（92%）
> 仅 api 可达               3 模块 /    648 行   ← 真可搬
> 谁都不可达                4 模块 /    138 行   ← 死代码
> ```
>
> 差异来自传递共享。典型是 `v1`：web 不 import 它，但 web 消费的
> `public-v1-operations`（API playground 的操作目录）用 `v1` 的 schema 构造
> `SchemaPair`。同理 `provider-family` ← `sandbox-environment`、
> `artifact-checksum` ← `runtime-model`。**「api 独占」量的是直接 import，
> 不是可分离性。**
>
> 真正可搬的三个：`task-model-capability`(265) · `task-admission-capability`(243)
> · `mcp-token`(140)。

> **范围也随之变了。** Phase 1 原本写的是「搬 12 个模块」，实测后是「搬 3 个」；
> 但 §2.4b 的审计说明真正的工作根本不在搬运，而在**折叠 13 处重复**——那才是
> 让「contracts 里的一切都真正共享」这句话成立的东西。

#### 1a. 折叠重复（主体工作）

- **13 个 DUPLICATE 收敛到契约。其中 8 个是一行 import 的事**，且所在文件或其
  同目录兄弟本来就在 import contracts：`ExecutionMode`、`RuntimeReadiness`(api 侧)、
  `ApiKeyListItem`、`SmtpConfigRead`、`SaveSmtpConfigRequest`、
  `TestSmtpConfigRequest`、`TestSmtpConfigResponse`、`ModelDiscoveryErrorCode`。
- **5 个不是**：`SandboxMode`、`SandboxEnvironmentStatus`、
  `SandboxEnvironmentParameter`、`SandboxEnvironmentValidationProbe`，加两个
  DIVERGENT 的 sandbox 词汇表。它们卡在硬边界上，见 D14。
- **顺序铁律：先折叠，再重跑可达性测量，最后才删死模块。** `runtime.ts` 和
  `sandbox.ts` 之所以死，正是因为消费者重声明了它；先删等于把重复合法化，
  同一形状会以第三个名字重新长出来（`AdminRevealCredentials`、`McpTokenScope`
  已是先例）。折叠后的死模块名单大概率不是现在这 4 个。
- **5 个 DERIVED 不是缺陷**，但其中 3 个是过期脚手架（`CreateTaskBody` 的交集
  已被证明是 no-op、`Scope` 私有别名旁边的兄弟文件就是直接 import、
  `sandboxProviderLabel` 只是同名遮蔽），清掉零成本且能降低下次扫描的噪声。
  `RuntimeModelPreflightError`（COLLISION）契约侧那对别名是纯死代码，直接删。

#### 1b. 搬运与清理

- **搬 3 个模块 / 648 行回 `apps/api`**：`task-model-capability`、
  `task-admission-capability`、`mcp-token`。
- 在 1a 之后重跑传递可达测量，按新结果决定删哪些死模块。

#### 1c. 发布链路

- `packages/contracts` 具备独立发布能力：release-please + `npm publish` 到
  npmjs 公开，scope `@cap-console`（D12，已注册）。
- 翻 `private: true`、给出第一个版本号。
- **`zod` 改为 `peerDependency`**：契约是 ESM、api 是 CJS，`require('zod')` 解析到
  的是**另一个 class realm**（`zod-instance.ts` 已为此存在）。今天两边指向同一份
  物理 zod 靠的是 pnpm workspace；发布后 `dependencies` 会让消费者装独立副本，
  **版本错配叠加在 realm 错配之上**。工作区里现已有三份 zod（3.22.3 / 3.25.76 / 4.4.3）。
- release-please 现在只管根包一个（`packages: {".": …}`）。contracts 要独立版本线
  就要改多包 manifest，而这**直接冲击 D5「版本号 = 总仓 tag」**——contracts 的版本
  与平台版本是什么关系，必须在这里定。
- 消费方暂时仍走 `workspace:*`，但**发布流程先跑通并发出第一个版本**。

#### 1d. 新增一条机械闸门

- **`packages/contracts` 中零 importer 的导出应当使构建失败。** 这条规则字面上
  就是「contracts 里的一切都真正共享」。审计证明现有闸门（`turbo typecheck lint`、
  contracts 单测、package-boundary 测试、`provider-contract-parity-check.mjs`）
  在至少一对重复上全部漏检。

> 关键：这一阶段结束时，`@cap-console/contracts` 已是一个真实的公开 npm 包，
> 但仓库结构一行未动。可独立回滚。

### Phase 2 — 一次发版协调所有已部署面（原「版本偏移闸门」，已改写）

**原文说：拆分瞬间，「线上 api 与线上 web 契约一致」这个结构保证就消失了。测量之后
这句话不成立。** 那个保证不来自单仓，来自**协调发布**——一个 tag、一个 commit、四个
镜像，`docker-compose.prod.yml` 用同一个 `${CAP_VERSION}` 钉住 api 与 web。拆仓不会
拿走它：D5 的总仓 tag 继续协调，同栈自托管依然无法偏移。

**真正拿走它的是第二条部署通道。** Vercel 的 git 集成让 `cap-console.douglasdong.com`
在每次合并 `main` 时上线，绕过 release.yml、绕过 tag、绕过 `CAP_VERSION`。实测（`83bb319`）：
最新 tag `v0.46.1`，`main` 领先 19 个提交，其中 10 个动过 `apps/web` 或 `packages/contracts`，
包含一次线上形状变更。**所以偏移不是拆分带来的未来风险，是当时就在跑的现状。**

于是这一阶段做的不是"建一个兼容性协商闸门"，而是两件更小的事，见 change
`couple-console-deploy-to-the-release`：

1. **关掉旁路**（`apps/web/vercel.json` 的 `git.deploymentEnabled.main = false`），
   由 `release.yml` 的 `deploy-console` job 在镜像集验证之后发布 console。
   顺序是 build → verify → console → 移 `latest`，所以 console 发布失败时 `latest`
   停在上一个发版，那里两边仍然匹配。
2. **断言不变量**：console 把它的构建版本带在 REST 头与 WS 握手参数上，api 与自己的
   `CAP_VERSION` 比较，不等即拒。默认开启，`CAP_CONSOLE_BUILD_ENFORCED=0` 是恢复用的
   逃生口而不是开关。

#### 「何为 COMPATIBLE」那五条输入 —— 已被取代，不是被实现

审计当年给的五条，是为"两侧可能不兼容、需要判定"这个框架服务的。既然不变量是
**两侧是同一次构建**，这个判定就不存在了——比的是身份，一个值，没有谱系。

各自的下落：

- **② 「缺席」必须可表达**（`AdminRevealResponse` 只有成功臂）—— **是缺陷，已修**
  （`83bb319`：契约补 union + strict 空臂，并加了出站 parse）。
- **④ 比信封不只比条目**（`z.array` vs `{ runtimes: [...] }`）—— **是缺陷，已修**
  （`81a115d` 收敛 `/runtimes`；`83bb319` 收敛 mcp-token 列表信封）。
- **① 封闭度分方向和位置** —— 规则本身随判定一起取消，但它点出的**代码问题仍在**：
  `apps/web/src/lib/api/real.ts:1322` 对响应跑 `ListSandboxEnvironmentsResponseSchema.parse`
  这个封闭 parse。`/runtimes` 那一侧已经是派生式加宽并写进了 `monorepo-foundation` 规格。
- **③ 闸门只管过线的类型**（`PendingApproval` 的活闭包）—— 不再需要，闸门不看类型。
- **⑤ 静态类型闸门在 cast 处失明** —— 规则不再需要，**代码问题仍在**：生产文件里约 11 处
  `as never`，集中在 `task-response.ts` 与 `sandbox-environments.service.ts`。

①⑤ 剩下的部分是**代码质量**，不再是闸门输入。

### Phase 3 — 物理拆分

- 用 `git filter-repo`（D9，需先安装）建 `cap-contracts`（58 commits）、
  `cap-api`（140）、`cap-web`（113，含 `packages/ui` 9）、`cap-www`（16）、
  `cap-release-cache-worker`。**保留历史是硬要求**，不接受 squash 到单个
  初始提交。
- 建总仓 `cap`，加 submodule。
- 治理层 `openspec/` + `.claude/` 迁入总仓。
- e2e + 3 个跨端 canary 迁入总仓。
- 每个子仓补上 Phase 0 写的分区 `CLAUDE.md`。

### Phase 4 — 发布与部署接线

风险最高 —— 触及已上线功能。

- 版本号改为总仓 tag 驱动（D5）。
- `self-update`（应用内一键升级，**已上线且使用者实际用过**）、
  `/update-status`、releases CF Worker 全部重新指向。相关实现：
  `apps/api/src/self-update/`、`apps/api/src/update-status/`。
- `release.yml` 现在从单仓构建 `ghcr.io/xeonice/cap-api` 与 `cap-web`，
  需改为总仓编排。
- 部署源切换：web 的 Vercel 项目、api 的常驻 compose 栈。

---

## 5. 已知风险

| 风险 | 缓解 |
|---|---|
| **指针舞**：跨端功能变成 5 步（contracts PR → 发版 → api PR → web PR → 总仓 bump） | 最后一步由 CI 自动化（D7）。前四步是拆分的既定成本，不可消除，见 §2.2 |
| **submodule 咬智能体**：detached HEAD、认错仓库、漏 bump | D7 铁律 + CI 自动 bump。这是方案成立的**前提**而非缓解措施 |
| **Phase 4 打到已上线的 self-update** | 单独成 change，活环境验证后再切；保留回滚路径 |
| **仓外配置也引用包名** | **已发生。** `@cap-console` 改名后 Vercel 的 cap-web 构建挂了：`No package found with name '@cap/web'` —— 构建命令配在 Vercel 面板里，不在仓库中，所以仓内的全量替换够不着它。修法不是改面板，而是把配置搬进仓（`apps/web/vercel.json`）并改用**路径过滤器** `--filter=./apps/web`，它天然免疫改名。Phase 3 拆仓会产生更多仓外配置（每个子仓一套 CI、Vercel、部署接线），**清点仓外引用必须是拆分前的一项任务，而不是拆完再发现** |
| **git 历史丢失** | Phase 3 用 filter-repo，历史保留列为验收条件 |
| **仓数量为 6** | 已接受（D8）。合并 `cap-edge` 已被否——受众边界是拆分的目的本身，不是可以为省一个仓而让步的东西 |
| **Phase 0 的改名波及构建/部署配置** | 不只是 import：lockfile、两个 workflow、web 的 Dockerfile、两个 shell 脚本都含旧 scope。验收必须包含一次完整的 build + boot-smoke，不能只看 typecheck 通过 |
| **Phase 0 做完可能发现痛点已大幅缓解** | 这是好结果，不是坏结果。届时重新评估 Phase 1–4 是否仍值得 |

---

## 6. 执行方式

### 工作流（D11 的直接后果）

```
总仓 cap
  ├ propose：写 spec / design / tasks
  ├ 读代码做规划（submodule 只读，D7）
  │
  ├──> 拉子 agent，带任务简报 ──> 子仓独立 clone
  │                                 实现 + 本地 typecheck/lint/test
  │    <── 回传结果 ──────────────┘
  │
  ├ 勾 tasks、跑 e2e、bump submodule 指针
  └ 打 tag（= 已验证的组合，D5）
```

各子仓边界清晰、互不引用（§2.1），适合并行；但**涉及契约的改动必须由主控收口**，
避免各 agent 对共享类型给出不一致的实现。

### 三条必须写进子仓 `CLAUDE.md` 的禁令

子仓不含 `openspec/`，智能体在里面会本能地做错三件事：

1. **不要在子仓创建 openspec change。** 规划只在总仓做（D11）。子仓里跑
   `/opsx:propose` 会生出一个孤儿 `openspec/` 目录。
2. **不要在子仓改 `@cap-console/contracts`。** 它是 npm 依赖，不是工作区包。契约改动
   走 `cap-contracts` 仓 → 发版 → 这里 bump 版本。
3. **不要试图跑跨端验证。** e2e 与 3 个跨端 canary 住总仓（D4/D10），
   子仓只跑自己的单测/类型检查。

### 简报必须携带的东西

实现 agent 在子仓里**看不到 spec**。因此主控下发的简报必须逐字带上：

- 对应需求的**原文**（不是转述——转述就是二次解释，会漂）
- 该 change 的相关 design 决策
- 验收方式（哪些命令、期望什么结果）

回传后由主控在总仓对着 spec 核验，而不是相信 agent 自述完成。

---

## 7. 凭据面（已确认，原未决项）

现有 workflow 只用 5 个 secret，且 Vercel 走 git 集成、Cloudflare Worker 靠本地
wrangler，**都不经过 CI**。主仓 `visibility: PUBLIC`，所以总仓递归检出子仓用
自带的 `GITHUB_TOKEN` 即可，无需 PAT 或 GitHub App。

| 仓 | secret | 来源 |
|---|---|---|
| `cap`（总仓） | `CLAUDE_CODE_OAUTH_TOKEN`、`GITHUB_TOKEN` | 前者从今天的 `e2e.yml` 平移；后者自动注入 |
| `cap-contracts` | **`NPM_TOKEN`**、`RELEASE_PLEASE_APP_ID` / `_PRIVATE_KEY` / `_TOKEN` | release-please 三件套平移 |
| `cap-api` | `GITHUB_TOKEN` | GHCR push，自动注入 |
| `cap-web` | `GITHUB_TOKEN` | GHCR push，自动注入 |
| `cap-www` | 无 | Vercel git 集成 |
| `cap-release-cache-worker` | 无 | 本地 wrangler |

**唯一新增的是 `NPM_TOKEN`。** 其余全为平移或自动注入。

---

## 8. 未决

无。所有规划期决策已锁定；剩余不确定性属于执行期（各 Phase 内部的实现选择），
由对应 change 的 design 承载。
