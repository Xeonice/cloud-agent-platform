# Proposal: unlock-extension-axes

## Why

三条扩展轴各剩最后一处物理拒绝:轴 B(runtime)的 `RuntimeArtifactChecksumsSchema` 是 strict 字面 key 对象(`packages/contracts/src/sandbox-environment.ts:116-121`),新 runtime 的 attestation 在解析期被拒;轴 A(provider)的 `ConfiguredSandboxProviderFamily` 缺 `'cloud-http'` 成员(`packages/sandbox/src/host-harness/config.ts:11-15`),操作员物理上无法显式选择 cloud-http;轴 C 的 source-kind 词表双份声明(2 成员 vs 4 成员)且无对账闸。opencode 的会话存储形状(per-message JSON 目录,非 single-newest-jsonl)证明第三 runtime 是真实将至的需求,而 contracts 词表新增必须赶在 repo-split Phase 1c 首发冻结之前落地(master plan 总则 3)——这是「why now」。本 change 是 2026-07-29 derive-runtime-vocabulary-from-registration 的直接续集:该前作收敛了 runtime id 词表并显式把「per-runtime 策略表」与 `ConfiguredSandboxProviderFamily` 留作后续,本 change 接续之,统一验收标准为**新增一个 runtime/provider = 1 声明 + 1 注册 + 查表数据,零 dispatch 分支**。

## What Changes

### 轴 B — runtime 扩展轴(contracts 词表 + 消费点)

- `RuntimeArtifactChecksumsSchema` 从 strict 字面 key 对象改为 `z.record(RuntimeSchema, Sha256ChecksumSchema)`,**意图语义显式定为 partial**(历史 attestation 缺新 runtime 的 checksum 必须继续可解析);record 两半均已在 contracts 声明,drop-in 可行。附带约束:contracts/api/web 仅使用 Zod classic v3 entrypoint(v4 的 record 语义翻转为 exhaustive,`zod/v4` 子路径在 web 钉的 3.25.x 今天已可误 import;未来 v4 迁移路径是 `z.partialRecord`)。
- 新增 `RUNTIME_METADATA` 全量策略表(`as const satisfies Record<AgentRuntimeId, {...}>`),落在 `agent-runtime-id.ts` 既定惯例旁,编译期总覆盖照抄既有 `agent-runtime-registration.typecheck.ts` 的自失效 `@ts-expect-error` 夹具形态。字段集不只 label:credential-alert 需要 description/actionLabel,credentialKind 须统一或判别 mode 词表(现状 `CodexCredentialMode` vs `ClaudeCredentialMode`),并在冻结 contracts 形状前对竞品 executor-profile 字段(variant/model 轴、CLI preview)做一次 diff。
- 消费点替换(lift-don't-invent):`task-failure.ts` 的两处 label 三元(:80/:94)改查表,第三处(:226)是 parse/default 位、改 `RuntimeSchema.safeParse` + `DEFAULT_AGENT_RUNTIME_ID` 而非查表;web 侧吸收 `new-task-dialog.tsx` 既有的本地 `RUNTIME_COPY` 表、替换 CLI-preview 三元与 `runtime-credential-alert.tsx` 的硬编码分支;`runtime-credentials.tsx` 从双 prop 硬连线(codexCred/claudeCred + 两个 handler)改集合驱动。新消费点不得引入新 identity 三元(受 complement-scan 闸约束)。
- `TranscriptReadStrategy` 从单成员 loud-throw 升格为真派发架子——这是对 2026-07-28 fail-loud-on-unknown-runtime「false seam 二选一」裁定的**显式翻案,触发条件已变**(opencode 的 per-message-JSON 存储证明第二成员真实存在)。策略词表按形状命名(`single-newest-jsonl` / `per-message-json-dir`)而非按 runtime;派发落点在 `packages/sandbox/src/host-harness/configured-provider.ts:653-664` 的 inline 检查(任务提示中的 `assertSingleNewestJsonlSupported` 符号在树中不存在)。
- 残余词表收敛三处:`runtime-model-adapter-snapshot.ts:6` 的内联手写 union 改 contracts 类型;tmux 会话协议双份声明去重(api 侧删 `codex-launch.ts` 副本,改 import `@cap-console/sandbox` facade,新增导出须进 `expected-facade-surface.json` 否则 R6 闸红);`SKILL_CATALOG` 仅上移 id 词表到 contracts、web 留展示文案、api 留 installer 命令,上移后两端必须真 import(否则 contracts-shared 闸抓「上移了没人用」)。

### 轴 A — provider/操作员词表

- `ConfiguredSandboxProviderFamily` 保留独立声明(D14 判例:操作员词表 ≠ provider family 是刻意分叉),显式补 `'cloud-http'` 成员,写法复用 satisfies-子集 + 就地记录理由。
- `providerFamilyAllows*` 三个函数合并为一个总 `Record<ConfiguredFamily, readonly SandboxProviderFamily[]>`,消费面覆盖 `configured-provider.ts`(3 调用点)与 `deployment-environment.ts`(约 9 调用点)——本期只做 lookup 转换,`deploymentBehavior` 六分支留给 phase 7a。
- 新建 R8 覆盖对账闸(操作员词表 ⊇ 可选 family ∪ {auto, control-plane}),含第五份词表 `SandboxTerminalStoryProvider`——其位置在 **sandbox 包内** `packages/sandbox/src/host-harness/provider-terminal-story.ts:7`(任务提示的 api 路径已过期)。闸门照抄 `provider-contract-parity-check.mjs` canon:递归发现、零匹配即败、配对自测、注入探针红证 + revert 逐字记录;不引入 dependency-cruiser 等新工具。

### 轴 C — source-kind 词表合并

- source-kind 合并为 `sandbox-environment.ts` 单一声明,`runtime-model.ts` 侧派生。语义定案是真开放决策且属行为变更:`provider-snapshot` 有活的生产分支(resolver 兜底)**不可删**,须建模为显式 extension/legacy 成员;`boxlite-rootfs` 仅存活于读路径(历史快照),迁移 vs legacy 成员按 converge-contracts 警戒线做成**独立任务 + 用户拍板点**,不埋在派生改写里。
- 合并完成后向 R5 词表对账闸(`sandbox-core-vocabulary-parity.mjs`)的 PAIRS 追加一条。

### runtime-conformance 套件(新)

- 新建 runtime-conformance 套件骨架:harness-maker 接缝(套件拥有全部测试逻辑,每个 runtime 只供构造 + 环境钩子)+ participation 账本(双总 Record,runtime 声明的 executionModes 反推必跑 scenario family,漏登记 = 编译错,spec 措辞一开始就写账本形态)。
- 五个 scenario family 全部**移植既有断言而非发明**:launch/lifecycle 沿 codex golden 逐字节夹具与 DSR/quiesce/exit-detection 策略断言,transcript 沿 parser 测试,headless 沿 argv 捕获,secret-canary 移植 `workspace-git-conformance.ts` 的注入/exactly-once/零泄漏断言词汇。种子在 apps/api(叶子包),抽进 packages/* 跨 api→package 方向,不得拖带 api-only import。
- 输出 per-runtime conformance 报告工件(family → pass/skip + 原因),让「因未声明而跳过」可见而非静默。
- CI:带 test script 即被 package-suites job 目录 filter 自动招收,零 workflow 编辑、不碰冻结的 check 显示名;新 lane 先非 required。

### cloud-http 参考服务端

- 把 sandbox-cloud-http conformance 的手写 `makeFetch` stub 换成真实 HTTP listener,对一个显式命名的 **reference server**(非 mock)运行——对真实对端跑协议 conformance 是行业共识,stub 只留给 server 自己的下游;现 stub 会与 README 协议静默漂移。reference server 兼作协议的可执行文档,覆盖 README 的 7 个必选端点。
- 可选 capability/version 自描述端点作纯增量:capability 缺失 = 优雅降级而非报错,版本协商 counter-offer 而非拒绝,并考虑把 specificationVersion 内嵌进声明对象;两个 provider-local secret-writer 硬拒绝原样保留。
- 通电前确认 sandbox-cloud-http 在 workspace 构建圈内(避免死包编辑重演)。

## Capabilities

### New Capabilities

- `runtime-conformance`: runtime 级 conformance 套件——五 scenario family(launch/lifecycle/transcript/headless/secret-canary)、harness-maker 接缝、以 executionModes 声明反推必跑 family 的 participation 账本(漏登记 = 编译错)、per-runtime 报告工件、经目录发现机制自动进 package-suites CI。

### Modified Capabilities

- `agent-runtime`: 「新增第三 runtime 仅需 1 声明 + 1 注册」的既有需求扩展为**还包括查表数据、零展示/派发分支**——新增 `RUNTIME_METADATA` 全量策略表(编译期总覆盖,加 runtime 不加 metadata = 编译错);`TranscriptReadStrategy` 从单成员 loud-throw 改为按形状命名的真派发(显式翻案 fail-loud 裁定);adapter 边界残余手写 runtime union 改用 contracts 单一声明。
- `sandbox-environments`: attestation checksum 表从 strict 字面 key 改为 keyed-by-runtime 的 record,**partial 语义成为需求**(缺新 runtime key 的历史 attestation 必须继续可解析,非 enum key 必须拒绝);source-kind 词表成为单一声明(runtime-model 侧派生)。
- `sandbox-host-harness`: 操作员 provider 词表补 `'cloud-http'` 成员;三个 allows 函数收敛为一个全量 Record lookup;新增 R8 覆盖对账闸(操作员词表 ⊇ 可选 family ∪ {auto, control-plane},含 provider-terminal-story 第五份词表);tmux 会话协议单一声明在 sandbox facade,api 侧只 import。
- `sandbox-provider-port`: cloud-http conformance 从 stub-fetch 改为对真实 HTTP reference server 运行;reference server 成为协议的一等交付物/可执行文档;可选 capability/version 自描述端点(优雅降级语义);secret-writer 信任边界拒绝保持不变。
- `runtime-model-catalog`: 环境 source 词表从独立 4 成员声明改为派生自 sandbox-environment 单一声明 + 显式 extension 成员;`provider-snapshot`(活生产分支)与 `boxlite-rootfs`(历史快照读路径)的兼容语义作为需求钉死。
- `frontend-console`: 控制台 runtime 展示(新任务对话框 CLI preview、credential alert、credentials 设置页)与 skill 目录 id 从 per-runtime 硬编码分支/双 prop 改为由 contracts 声明数据集合驱动——新 runtime 落表即出现在控制台,无 console 代码分支。

## Impact

**代码面**:`packages/contracts/src`(sandbox-environment.ts、agent-runtime-id.ts 旁新表、task.ts 消费、skill id 词表;路径是 packages/contracts/src 非 contracts/src)、`apps/api/src`(task-failure.ts、runtime-model-adapter-snapshot.ts、codex-launch.ts 删除、agent-runtime.port.ts)、`apps/web/src/components`(dashboard/new-task-dialog.tsx、runtime-credential-alert.tsx、settings/runtime-credentials.tsx——真实路径以树为准,任务文本两处过期)、`packages/sandbox`(config.ts、configured-provider.ts、deployment-environment.ts、provider-terminal-story.ts、facade 导出面)、`packages/sandbox-cloud-http`(conformance + reference server)、新 conformance 包、`scripts/`(R8 新闸 + R5 PAIRS 追加,均带配对自测)。

**外部面(surface sidecar 断言已复核成立)**:publicV1/mcp/openapi/apiPlayground 全部 unchanged。传递引用证明:`public-v1-operations.ts` 只从 runtime-model.js 引 `RuntimeModelCatalog*`/`RuntimeModelNotAvailable*`;`RuntimeModelCatalogSchema.effectiveEnvironment` 走 `RuntimeModelEffectiveEnvironmentSchema` 判别联合,从不引用 `RuntimeExecutionEnvironmentSourceSchema`;`public-v1-operations.ts` 与 `v1.ts` 均不 import `sandbox-environment.js`——故 record 化与 source-kind 合并全部落在 /v1 之外,sidecar 无需升级。

**验证链与闸门**:每个轴 B contracts 改动走 contracts build → api/web typecheck(消费者读 dist);api 侧 build-before-test;tmux 去重受 sandbox boundary 闸约束走 facade-import;每个新闸门带全套 gate canon(配对自测 + 红证 verbatim + revert + 空扫描即败),tasks.md 按 parity 范本预留证据栏位;「假想第三 runtime typecheck 演练」复用 derive-runtime 前作的四轨结构与独立 baseline.md,历史锚点引 2026-06-18-add-claude-code-runtime 归档。

**依赖与协调**:同树在飞的 enforce-boundaries-from-manifest(phase 3)将消费本 change 移动的同批文件(facade 导出、contracts 词表)——本 change 的 facade/词表移动应先于其 manifest 定稿合入,冲突时以本 change 的落位为准更新 manifest。contracts 形状(RUNTIME_METADATA、skill id、source-kind)必须在 repo-split Phase 1c 首发冻结前定稿。

**Non-Goals(带理由)**:
- 不改变「runtime 是什么」(policy 对象边界、执行语义)——接续 derive-runtime 前作同名 Non-Goal,本 change 只动词表、表数据与派发。
- 不引入 opencode/pi 等具体新 runtime,也不引入第三方 provider——只拆除其接入的物理障碍;真派发架子的第二成员可以是编译期存在、运行时未注册。
- `deployment-environment.ts` 的 deploymentBehavior 六分支不在本期(已划给 phase 7a),本期只做 allows lookup 的等价转换。
- 不引入 dependency-cruiser/ArchUnit 等新工具——仓库已有自研 parity-gate canon,延用一致性优先。
- 不动 /v1、MCP、OpenAPI 任何外部面(见上证明);webhooks 等推迟项不在范围。
