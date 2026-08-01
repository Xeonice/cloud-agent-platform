# Design — unlock-extension-axes

## Context

三条扩展轴(A=provider、B=runtime、C=source-kind)各剩最后一处物理拒绝:

- **轴 B**:`RuntimeArtifactChecksumsSchema` 是 strict 字面 key 对象(`packages/contracts/src/sandbox-environment.ts:116-121`,字面 key `codex` + `claude-code`),新 runtime 的 attestation 在解析期被拒。record 化的两半(`RuntimeSchema = z.enum(AGENT_RUNTIME_IDS)`、`Sha256ChecksumSchema`)均已在 contracts 声明,drop-in 可行。
- **轴 A**:`ConfiguredSandboxProviderFamily = 'auto'|'aio'|'boxlite'|'control-plane'`(`packages/sandbox/src/host-harness/config.ts:11-15`)缺 `'cloud-http'`,`providerFamilyAllowsCloudHttp` 仅对 `'auto'` 返回 true——操作员物理上无法显式选择 cloud-http。
- **轴 C**:source-kind 双份声明(`sandbox-environment.ts:25-28` 2 成员 vs `runtime-model.ts:58-94` 4 成员)且无对账闸;其中 `provider-snapshot` 有活的生产分支(`runtime-model-environment.resolver.ts:391-397` 兜底),`boxlite-rootfs` 仅存活于读路径。

本 change 是 2026-07-29 derive-runtime-vocabulary-from-registration 的直接续集:该前作收敛了 runtime id 词表并显式把「per-runtime 策略表」与 `ConfiguredSandboxProviderFamily` 留作后续。统一验收标准:**新增一个 runtime/provider = 1 声明 + 1 注册 + 查表数据,零 dispatch 分支**。

Why now:opencode 的会话存储形状(per-message JSON 目录,非 single-newest-jsonl)证明第三 runtime 是真实将至的需求;contracts 词表新增必须赶在 repo-split Phase 1c 首发冻结之前定稿(master plan 总则 3)。

外部面已复核:publicV1/mcp/openapi/apiPlayground 全 unchanged,传递引用证明见 proposal Impact 段(`public-v1-operations.ts` 与 `v1.ts` 均不 import `sandbox-environment.js`),sidecar 无需升级。

## Goals / Non-Goals

**Goals:**

- 拆除三轴各自的最后一处物理拒绝,使「加第三 runtime / 显式选 cloud-http / 加 source-kind」都是声明 + 表数据级改动。
- 每个词表配机械对账(R8 新闸、R5 PAIRS 追加、编译期总覆盖表),不靠纪律。
- runtime-conformance 套件骨架 + participation 账本,让新 runtime 的行为符合性可被套件行使而非散落单测。
- cloud-http conformance 从 stub 换真实 HTTP reference server,协议获得可执行文档。

**Non-Goals**(接续 proposal,带理由):

- 不改变「runtime 是什么」(policy 对象边界、执行语义)——接续 derive-runtime 前作同名 Non-Goal。
- 不引入 opencode/pi 等具体新 runtime、不引入第三方 provider——只拆障碍;真派发架子的第二成员可以编译期存在、运行时未注册。
- `deployment-environment.ts` 的 deploymentBehavior 六分支不动(已划给 phase 7a),本期只做 allows lookup 等价转换。
- 不引入 dependency-cruiser/ArchUnit 等新工具——延用自研 parity-gate canon。
- 不动 /v1、MCP、OpenAPI 外部面;webhooks 等推迟项不在范围。

## Decisions

### D1 — checksum 表 record 化,意图语义显式定为 partial

`RuntimeArtifactChecksumsSchema` 改为 `z.record(RuntimeSchema, Sha256ChecksumSchema)`。在 Zod classic v3 下 record 是 partial 语义:新 runtime key 接受、缺 key 容忍、非 enum key 拒绝——这正是需求(历史 attestation 缺新 runtime 的 checksum 必须继续可解析)。**intended semantics = partial 必须写进 spec**,因为 Zod v4 的 record 语义翻转为 exhaustive(缺 enum key = parse 失败),未来迁移路径是 `z.partialRecord`。

附带约束:contracts/api/web 仅使用 Zod classic v3 entrypoint。web 钉的 3.25.x 今天已带 `zod/v4` 子路径,一个误写 import 就会对同一 schema 表现出 exhaustive 行为。

- 否决:保留 strict object、每加 runtime 手补字面 key——物理拒绝依旧,且历史 attestation 解析失败。
- 否决:exhaustive record——直接违反 partial 需求。

### D2 — RUNTIME_METADATA 全量策略表,lift-don't-invent

`as const satisfies Record<AgentRuntimeId, {...}>` 落在 `agent-runtime-id.ts` 既定惯例旁;编译期总覆盖照抄 `agent-runtime-registration.typecheck.ts` 的自失效 `@ts-expect-error` 夹具形态(仓库已三次使用,非新发明)。「加 runtime 不加 metadata = 编译错」与前作 D5 同一保证,只是落在数据表上。

字段集不只 label:credential-alert 需要 description/actionLabel(`runtime-credential-alert.tsx:34` 现硬编码);credentialKind 须统一或判别 mode 词表(现状 `CodexCredentialMode` vs `ClaudeCredentialMode` 分叉);冻结形状前对竞品 executor-profile 字段(variant/model 轴、CLI preview)做一次 diff,抓出第三 runtime 会要的字段。

消费点替换分两类形状(不可混):

- label 位:`task-failure.ts:80/:94` 三元、web 的 CLI-preview 三元(`dashboard/new-task-dialog.tsx:271-273`)、credential-alert 分支——改查表;web 既有本地 `RUNTIME_COPY` 表(`new-task-dialog.tsx:132-133`)被 RUNTIME_METADATA 吸收。
- parse/default 位:`task-failure.ts:226` 的 runtime 强转三元——改 `RuntimeSchema.safeParse` + `DEFAULT_AGENT_RUNTIME_ID`,**不是**查表。

`runtime-credentials.tsx` 从双 prop 硬连线(codexCred/claudeCred + 两个 handler)改集合驱动。新消费点不得引入新 identity 三元(受 fail-loud change 立的 complement-scan 闸约束)。

- 否决:per-consumer 本地表(现状)——N 份拷贝活在 contracts 边界错侧。
- 否决:label-only 表——credential-alert 字段更丰,留分支等于没解。

### D3 — TranscriptReadStrategy 升格真派发:显式翻案,策略按形状命名

2026-07-28 fail-loud-on-unknown-runtime 曾裁定 readTranscriptSource 是「false seam——要么真派发要么删承诺」,当时选单成员大声抛错。本 change **显式翻案,触发条件已变**:opencode 的 per-message-JSON 存储证明第二成员真实存在。

策略词表按形状命名(`single-newest-jsonl` / `per-message-json-dir`)而非按 runtime——reader 实现的是形状。派发落点是 `packages/sandbox/src/host-harness/configured-provider.ts:653-664` 的 inline 检查(蓝图中的 `assertSingleNewestJsonlSupported` 符号在树中不存在,已勘误)。第二成员可编译期存在、运行时无 runtime 注册。

- 否决:维持单成员 loud-throw——原裁定的前提(无第二成员证据)已不成立。
- 否决:按 runtime 命名策略——第三个 runtime 若复用 JSONL 形状会逼出假成员。

### D4 — 操作员词表保留独立声明,补 'cloud-http',allows 三件套并成一张 Record

`ConfiguredSandboxProviderFamily` 不从 provider family 派生(D14 判例:操作员词表 ≠ provider family 是刻意分叉,git 时间线已裁定),显式补 `'cloud-http'` 成员,写法复用 satisfies-子集 + 就地记录理由。

三个 `providerFamilyAllows*` 函数合并为一个总 `Record<ConfiguredFamily, readonly SandboxProviderFamily[]>`;消费面覆盖 `configured-provider.ts`(3 调用点)与 `deployment-environment.ts`(约 9 调用点),本期只做 lookup 等价转换。

- 否决:从 provider family 派生操作员词表——推翻 D14 既定裁定,且 `auto`/`control-plane` 本就不是 family。
- 否决:保留布尔函数、加第四个——第 N 个 family = 第 N 个函数,发散不收敛。

### D5 — R8 覆盖对账闸照抄自研 gate canon,不引新工具

新建 R8 闸:操作员词表 ⊇ 可选 family ∪ {auto, control-plane},纳入第五份词表 `SandboxTerminalStoryProvider`——其位置在 **sandbox 包内** `packages/sandbox/src/host-harness/provider-terminal-story.ts:7`(蓝图的 api 路径已过期,已勘误)。闸门照抄 `provider-contract-parity-check.mjs` canon:递归发现、零匹配即败、配对自测、注入探针红证 + revert 逐字记录。

- 否决:dependency-cruiser/ArchUnit——能表达同类规则,但仓库已有 canon,一致性优先且不增依赖。

### D6 — source-kind 合并为单一声明;boxlite-rootfs 语义定案独立拍板

source-kind 单一声明落 `sandbox-environment.ts`,`runtime-model.ts` 侧派生;完成后向 R5 闸(`sandbox-core-vocabulary-parity.mjs`)PAIRS 追加一条。

语义定案是行为变更,按 converge-contracts 警戒线处理:

- `provider-snapshot` 有活的生产分支(resolver 兜底)**不可删**,建模为显式 extension/legacy 成员。
- `boxlite-rootfs` 仅存活于读路径(历史快照),迁移 vs legacy 成员做成**独立任务 + 用户拍板点**,不埋在派生改写里。

- 否决:直接删 4 成员声明中的多出成员——provider-snapshot 是活生产者,删除是静默行为变更。
- 否决:把定案埋进派生改写——drift 收敛需要自己的证据(A9 判例)。

### D7 — runtime-conformance 套件:harness-maker 接缝 + participation 账本,移植不发明

- 布局照 go-cloud drivertest:套件拥有全部测试逻辑,每个 runtime 只供构造 + 环境钩子。
- 账本照 `packages/sandbox-conformance/src/required-participation.ts` 双总 Record 结构平移:runtime 声明的 executionModes 反推必跑 scenario family,漏登记 = 编译错;**spec 措辞一开始就写账本形态**(A5 教训:别写不可表达的 SHALL 再返工)。
- 五个 scenario family 全部移植既有断言:launch/lifecycle 沿 codex golden 逐字节夹具与 DSR/quiesce/exit-detection 策略断言,transcript 沿 parser 测试,headless 沿 argv 捕获,secret-canary 移植 `workspace-git-conformance.ts` 的注入/exactly-once/零泄漏断言词汇。种子在 apps/api(叶子包),抽进 packages/* 跨 api→package 方向,**不得拖带 api-only import**。
- 输出 per-runtime conformance 报告工件(family → pass/skip + 原因),「因未声明而跳过」可见而非静默(Gateway API GEP-1709 精化)。
- CI:带 test script 即被 package-suites job 目录 filter 自动招收,零 workflow 编辑、不碰冻结的 check 显示名;新 lane 先非 required,设 required 是登记在案的手动 GitHub 步骤。

- 否决:per-runtime 测试 fork——扩不到 N 个实现。
- 否决:手维护 runtime→family 映射——账本应从声明计算,手表会漂。
- 否决:发明新场景——既有 golden/parser/argv/canary 断言就是行为基线。

### D8 — cloud-http conformance 对真实 HTTP reference server 跑

手写 `makeFetch` stub 换真实 HTTP listener,对显式命名的 **reference server**(非 mock)运行——对真实对端跑协议 conformance 是行业共识(OCI distribution-spec、Pact provider verification),stub 只留给 server 自己的下游;现 stub 与 README 协议静默漂移。reference server 兼作协议可执行文档,覆盖 README 的 7 个必选端点。

可选 capability/version 自描述端点作纯增量(MCP initialize 习语):capability 缺失 = 优雅降级而非报错,版本协商 counter-offer 而非拒绝;两个 provider-local secret-writer 硬拒绝原样保留。通电前确认 sandbox-cloud-http 在 workspace 构建圈内(避免 A13 死包编辑重演)。

- 否决:保留 makeFetch stub——倒置 Pact 原则(stub 了被验证系统本身)。
- 否决:命名为 mock——reference 命名表明它是协议的活规范(MCP 'everything' 先例)。

### D9 — 残余词表收敛三处的落法

- `runtime-model-adapter-snapshot.ts:6` 内联手写 union 改 contracts 类型(一行)。
- tmux 会话协议去重:api 侧删 `codex-launch.ts` 副本,改 import `@cap-console/sandbox` facade(共享核心已在 `packages/sandbox/src/index.ts:588-599` 导出);**新增导出须进 `expected-facade-surface.json`,否则 R6 闸红**。
- `SKILL_CATALOG` 仅上移 id 词表到 contracts,web 留展示文案、api 留 installer 命令(converge-contracts 的 DERIVED 合法口径);上移后**两端必须真 import**,否则 contracts-shared 闸抓「上移了没人用」。

## Risks / Trade-offs

- [Zod v4 迁移静默翻转 record 语义,历史 attestation 被拒] → intended-partial 写进 spec 需求 + 迁移路径 `z.partialRecord` 记录在案;仅用 classic v3 entrypoint 的约束随本 change 声明。
- [web 侧今天就可误 import `zod/v4` 子路径] → 约束显式写下;动 sandbox-environment.ts 时顺带核查 import 面。
- [RUNTIME_METADATA 形状冻结过早,第三 runtime 需要的字段(variant/model 轴)缺席] → 冻结前做竞品 executor-profile diff;Phase 1c 是硬截止。
- [tmux 去重 / facade 导出变化把 R6 facade-surface 闸打红] → 白名单更新与代码移动同一任务落地,tasks 预留证据栏位。
- [conformance 种子抽取拖带 api-only import,污染 package 依赖方向] → 抽进 packages/* 时以构建图约束验证;套件包不依赖 apps/api。
- [source-kind 合并是行为变更,派生改写可能静默改语义] → provider-snapshot/boxlite-rootfs 定案独立任务 + 用户拍板点(D6)。
- [新闸门自证不了检测力] → 每个新闸带全套 canon:配对自测 + 注入探针红证 verbatim + revert + 空扫描即败。
- [新 CI lane 引入 flake 阻塞合并] → 先非 required 跑绿;预存 flake 记录在案,绝不 retry 到看不见。
- [同树兄弟 change(enforce-boundaries-from-manifest)与本 change 动同批文件] → 本 change 的 facade/词表落位先于其 manifest 定稿合入;冲突时以本 change 落位为准更新 manifest。

## Migration Plan

按轴分 track、每轴独立可回滚:

1. **轴 B contracts 先行**(D1/D2 声明与表):contracts build → api/web typecheck(消费者读 dist),再逐消费点替换(D2/D3/D9);api 侧 build-before-test。
2. **轴 A**(D4/D5):config.ts 词表 + Record 化 → 两个消费文件 lookup 转换 → R8 新闸带 canon 证据。
3. **轴 C**(D6):先独立拍板任务定案语义,再合并声明与派生,最后 R5 PAIRS append。
4. **conformance 套件**(D7)与 **cloud-http reference server**(D8)相互独立,可并行于 1-3 之后。
5. 「假想第三 runtime typecheck 演练」复用 derive-runtime 前作四轨结构与独立 baseline.md,历史锚点引 2026-06-18-add-claude-code-runtime 归档。

回滚:record 化是解析面放宽(本 change 不引入新 runtime key,回滚不弃数据);各轴改动为等价转换或纯增量,单轴 revert 不牵连他轴;新闸门/新 lane 非 required,revert 即摘除。

## Open Questions

- **boxlite-rootfs 定案**:迁移历史快照 vs 建模为 legacy 成员——独立任务中呈交用户拍板(D6 预留)。
- **credentialKind 词表形态**:统一 mode 词表 vs 判别联合(现状 `CodexCredentialMode` / `ClaudeCredentialMode` 分叉)——在 RUNTIME_METADATA 形状 diff 后定。
- **RUNTIME_METADATA 是否本期纳入 variant/model 轴字段**:取决于竞品 executor-profile diff 结论;可留可选字段位而不填数据。
- **specificationVersion 是否内嵌进 provider 声明对象**(而不只在自描述端点)——cloud-http 自描述端点落地时一并裁定。
- **reference server 精确落位**(examples/ 先例 vs 包内测试服务器)——通电时按 workspace 构建圈确认后定。
- **【verify SPEC-DEFECT,archive 阻塞】surface-impact.json 四外部面「unchanged」断言与 verify 公共面 code-evidence 判定矛盾(machine-routed undeclared-impact ×4)**:verify 的代码证据 lane 判定本 change 触及 `publicV1`/`mcp`/`openapi`/`apiPlayground`,而 sidecar 四面全部声明 unchanged;任务 7.8 的 grep 复核结论(`public-v1-operations.ts`/`v1.ts` 零引用被触符号、MCP 工具集零触碰)与该判定相反。两者必居其一是错的:要么 sidecar 是 false claim(须升级为 changed 并列出操作 id),要么 code-evidence 判定是误报(须以可复核证据在 verify 记录中驳回并留档)。归档在该矛盾解决前被 blockingSpecDefects 门禁——archive 不能接受 false sidecar claim。涉及全部 7 项 public-surface 需求:`agent-runtime/a-compile-time-total-runtime-metadata-table-backs-display-and-policy-lookups`、`agent-runtime/the-transcript-read-strategy-is-a-shape-named-vocabulary-with-real-dispatch`、`frontend-console/the-skill-catalog-id-vocabulary-is-declared-once-in-contracts`、`runtime-model-catalog/provider-snapshot-and-boxlite-rootfs-compatibility-semantics-are-pinned`、`runtime-model-catalog/the-execution-environment-source-vocabulary-derives-from-the-sandbox-environment-declaration`、`sandbox-environments/runtime-artifact-checksums-are-keyed-by-the-runtime-vocabulary-with-explicit-partial-semantics`、`sandbox-environments/the-environment-source-kind-vocabulary-has-a-single-declaration-with-an-explicit-extension-tier`。(注:此为 spec/sidecar 缺陷路由,不开实现任务。)

  **裁定结案（2026-08-01 修订版；初版裁定引用的"双档全绿"系 turbo 缓存回放，其"误报"结论一并修正）**：
  undeclared-impact 判定不是误报——`CLASSIFIER_SURFACE_MAP.contracts → 四公开面` 是刻意的保守
  制度映射，改 contracts 的 change 必须在 sidecar 以 **derived** 声明四面（"传递可达但投影不变"
  正是 derived 状态的语义），unchanged 是用词错误。已改 derived + 转录 registry 的 8 条既有
  protocolDifferences。lane 证据以确定性命令产出：`public-surface-adversarial.mjs verify` →
  **passed:true、五 lane 全 true、findings=0**（此前 collector 无法产出证据的根因是 main 既有
  断裂：622dac6 目录重排后 api test:public-surface glob 丢失 surface-parity/evidence.spec.js，
  已补回；另修 zzz-drill 演练残留——详见 tasks.md 9.1–9.7 修正版证据注记）。

  **【verify SPEC-DEFECT 再提起，第二轮 2026-08-01，archive 阻塞】**：第二轮 opsx-verify 的
  machine-routed undeclared-impact ×4 对同四面（`publicV1`/`mcp`/`openapi`/`apiPlayground`）
  再次判定 code-evidence changed vs sidecar unchanged 矛盾（route=spec-defect，blocking）。
  上一段「裁定结案」在本轮**不能维持**：其依据（`pnpm test:public-surface` /
  `pnpm verify:public-surface` 双档 14/14）对当前树不可复现——contracts
  `SKILL_CATALOG_IDS` 残留未 revert 的演练成员 `'zzz-drill'`（`skill-catalog.ts:15`，
  已烤进 dist），api/web typecheck 双红（TS2741 / TS1360+TS7053，本轮裁定人亲跑确认），
  四 lane 在整树红的前提下产不出任何通过记录，故「投影逐字节不变」的行为反证当前无效。
  矛盾重新打开，两解取一：要么 sidecar 是 false claim（升级四面为 changed 并列出操作 id），
  要么在 zzz-drill 修复、树复绿后以**新一轮**四 lane 通过记录再次驳回并留档（旧记录不得引用）。
  在此之前归档被 blockingSpecDefects 门禁——archive 不能接受 false sidecar claim。
  涉及全部 7 项 public-surface 需求（id 清单同上一条）。（注：此为 spec/sidecar 缺陷路由，
  不开实现任务；lane 重出与 zzz-drill 修复本身已按 UNMET 路由独立重开于 tasks.md 9.9-9.15。）
