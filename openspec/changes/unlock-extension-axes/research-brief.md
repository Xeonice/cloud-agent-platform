# Research Brief — unlock-extension-axes

三路并行调研(Web 外部证据 / Codebase 代码实证 / Archive 归档判例)的综合简报。每条 finding 标注来源路线与证据锚点;末节给出对 proposal/design/tasks 的直接结论。

---

## Route: Web(外部证据)

**W1 — Zod v3/v4 的 record 语义相反。** `z.record(z.enum(...), value)` 在 v3 推断 partial key 且解析时不要求全 key;v4 推断全 key 必填并在解析期强制穷尽(缺 enum key = parse 失败),v4 另加 `z.partialRecord()` 还原 v3 行为。(证据: zod.dev/v4/changelog; zod#4571)
→ 工作项 1 把字面 key `.strict()` 的 `RuntimeArtifactChecksumsSchema` 换成 `z.record(RuntimeSchema, Sha256ChecksumSchema)` 后,在当前 v3 下得到的是宽松/partial 语义(新 runtime key 接受、缺 key 容忍、非 enum key 拒绝)——这正是解除轴 B×C 物理拒绝的行为。但**意图语义(partial vs exhaustive)必须现在写下**:未来 v4 迁移会静默翻转为「全 runtime 必填」,导致历史 attestation(缺新 runtime 的 checksum)被拒。若意图是 partial,迁移路径是 `z.partialRecord`。

**W2 — 仓库 zod 版本分叉,`zod/v4` 子路径今天已可装。** contracts/api 钉 `^3.23.8`,web 钉 `^3.25.76`;3.25.x 已带 `zod/v4` 子路径(翻转后的 record 语义)。web 侧一个误写的 `zod/v4` import 就会对同一 schema 形状表现出 exhaustive-record 行为。(证据: packages/contracts/package.json:31; apps/api/package.json:66; apps/web/package.json:47)
→ W1 的语义危害不是假想的未来——change 应声明「仅用 classic v3 entrypoint」或在动 sandbox-environment.ts 时顺带对齐版本。

**W3 — 编译期全覆盖元数据表的标准写法是 `as const satisfies Record<UnionType, Shape>`。** 编译器同时拒绝缺失和多余的 union 成员,且保留字面值类型,彻底消除 dispatch 分支。(证据: dev.to compile-time-exhaustiveness; refine.dev satisfies)
→ 工作项 2 的 `RUNTIME_METADATA: Record<AgentRuntimeId,{label,cliPreview,credentialKind,...}>` 和工作项 8 的 `Record<ConfiguredFamily, readonly SandboxProviderFamily[]>` 的直接模板。用 `satisfies`(而非类型标注)保持 web 侧字面值窄类型,同时「加 runtime 不加 metadata」是编译错——与现有 agent-runtime-registration.typecheck.ts 的 @ts-expect-error 夹具同一保证,只是落在数据表上。

**W4 — Kubernetes Gateway API conformance(GEP-1709/GEP-2162)是 participation ledger 的典范设计。** 每个 conformance 测试声明所需 features,实现声明 SupportedFeatures,测试在实现声明齐全时才跑;profile 是 feature 的命名捆绑,报告按 profile 列 supported/unsupported。(证据: gateway-api.sigs.k8s.io GEP-1709/GEP-2162)
→ 验证工作项 12 的 required-participation 设计(runtime 声明 executionModes 反推必跑 scenario family),并给出两个已被证明的精化:(a) 测试声明需求、实现声明能力、交集计算得出——而非手维护映射;(b) 输出 per-runtime conformance 报告工件(family → pass/skip+原因),让「因未声明而跳过」可见而非静默。

**W5 — Kubernetes CSI 的 csi-sanity 是 spec 级 driver conformance kit 的先例。** 独立于 orchestrator、走 driver 的真实 socket(driver 可为任意语言)、按 driver 自报的 GetPluginCapabilities 门控测试组、以负向断言为核心(如 NodePublishVolume 无 volume id 必须失败)。(证据: kubernetes-csi/csi-test pkg/sanity)
→ runtime-conformance 套件(工作项 12)的形状模板:scenario family 按声明能力键控、通过生产同款接口(AgentRuntime port)行使、重「畸形输入必须大声拒绝」——对应 launch/lifecycle/transcript/headless family。也是「conformance 与单测是职责不同的两个套件」的先例。

**W6 — Go Cloud CDK 每个 portable API 配一个 drivertest 包。** 套件拥有全部测试逻辑,每个 driver 只实现小的 Harness/HarnessMaker 接口(构造 driver、提供 checker、关闭),`RunConformanceTests(harness)` 从各 driver 自己的测试文件调用。(证据: google/go-cloud blob/drivertest)
→ 与 packages/sandbox-conformance 及拟建 runtime-conformance 骨架结构最贴近的匹配:harness-maker 接缝让 golden/launch 夹具(codex-launch.test.mjs 逐字节形状)作为套件所有的数据,各 runtime 只供构造+环境钩子。确认「套件贴着 port,driver 注册进来」的布局能扩到 N 个实现而不产生 per-implementation fork。

**W7 — OCI distribution-spec 对真实 registry(非 stub)跑 HTTP 协议 conformance。** 按 workflow 分类(Pull 必选,Push/Content Discovery/Content Management 可选),自认证报告集中发布;其 2026 重设计改为生成式数据 permutation(digest 算法、空列表、嵌套 index),覆盖手写夹具漏掉的边角。(证据: distribution-spec/conformance/README; opencontainers.org 2026-04-04 博客)
→ 工作项 13 的先例:对参考实现跑 real-HTTP conformance 是 provider 协议的既定规范(其必选/可选分类对应 cloud-http 的 7 个必选端点 vs 可选 capability/version 端点)。2026 重设计的教训——生成式 permutation 胜过手写 stub 夹具——正是用真实 HTTP 往返替换手写 stub 的论据。

**W8 — MCP initialize 握手是协议自描述的紧凑成熟设计。** 日期字符串 protocolVersion 协商(服务端 counter-offer 自己最佳支持版本),capabilities 是对象、key 缺失意味优雅降级而非硬失败。(证据: modelcontextprotocol.io architecture 文档)
→ 工作项 13 可选 capability/version 自描述端点(工件03 B.3/B.4)的模板:capability 缺失=「不支持,降级」而非报错;版本协商 counter-offer 而非拒绝——保持 7 个必选端点是兼容性地板,自描述端点纯增量。仓库已跑 MCP 服务端,这套习语是自家在用的。

**W9 — MCP 'everything' server 是官方参考服务器,自陈目的不是「有用」而是行使协议全部特性。** 维护在仓库内、作为一等交付物服务客户端开发者。(证据: modelcontextprotocol/servers src/everything)
→ 直接回答工作项 13 的落位问题(examples/ vs 包内测试服务器):先例支持一个显式命名的 reference server,兼作 conformance 套件的 real-HTTP 对端与可执行文档(替代 README 散文)。命名用 "reference"(而非 "mock"),表明它是协议的活规范。

**W10 — opencode 会话持久化为多个小 JSON 文件,不是单个 newest JSONL。** `storage/session/{projectHash}/{sessionID}.json` + `message/{sessionID}/msg_{messageID}.json`(OPENCODE_DATA_DIR 下);结构化编程访问走 `opencode serve` HTTP 或 `opencode run --format json`,`opencode session export` 出 markdown/json。(证据: ccusage.com/guide/opencode; opencode.ai/docs/cli)
→ 工作项 4 的硬外部事实:TranscriptReadStrategy 的 opencode 第二成员是货真价实的不同读取策略(per-message-JSON 目录或 HTTP attach),现在就把 loud-throw 升级为真派发架子是有据的——且策略词表应**按形状命名**(如 `single-newest-jsonl` vs `per-message-json-dir`)而非按 runtime 命名,因为 reader 实现的是形状。

**W11 — Vibe Kanban(最近竞品)以 executor-profiles 架构支持 10+ coding agent。** 每个 agent 是一条 profile(command、variant/model 配置、MCP 配置),per task 可选;加 agent 是 registry/config 级而非 branch 级。(证据: BloopAI/vibe-kanban; vibekanban.com/docs/agents)
→ 对本 change 验收标准(「新 runtime = 1 声明 + 1 注册 + 表数据,零分支」)的市场验证,以及 RUNTIME_METADATA 字段的 checklist 来源:他们的 per-executor profile 含 display label、launch command preview、model variants、per-agent MCP 配置——值得与计划的 `{label, cliPreview, credentialKind, ...}` 做 diff,在 repo-split Phase 1c 前冻结 contracts 形状之前抓出第三 runtime 会要的字段(如 variant/model 轴)。

**W12 — gate canon 是 mutation testing 的手工实例;架构规则做 CI 测试已是主流。** 播种缺陷并要求检查杀掉它,是衡量闸门真实检测力的既定方法;ArchUnit(TS)/dependency-cruiser 把模块边界、allowed-import 矩阵做成 CI 测试(含 Nx-graph-aware monorepo 规则)。(证据: circleci mutation-testing; ArchUnitTS; TNG/ArchUnit)
→ 给 R8/R5 需求以命名先例(design doc 可用的语言),并为工作项 6 的 facade 规则提供现货替代:dependency-cruiser 可声明「apps/api 必须从 @cap-console/sandbox import tmux session protocol,绝不用本地副本」。但鉴于仓库已有自研 parity-gate canon(provider-contract-parity-check.mjs、sandbox-core-vocabulary-parity.mjs),**延用既有 canon + 配对自测纪律比引入新工具更一致**。

**W13 — Vercel AI SDK 组合了 string-id provider registry 与版本化实现规范。** `createProviderRegistry`('providerId:modelId')+ 每个 provider 对象携带 specificationVersion('v2'/'v3')、provider、modelId、supportedUrls,宿主纯靠声明数据派发与特性门控。(证据: ai-sdk.dev provider-management / provider-registry)
→ 一次覆盖两轴的 TypeScript 原生先例:runtimes/providers 的 registry-of-declarations(轴 B)+ 内嵌 specificationVersion 字段作为协议自描述机制(cloud-http B.4)——**把 spec 版本带在声明对象里**(而不只在端点上)才让消费者能在编译/解析期特性门控。

**W14 — 契约测试实践(Pact provider verification)对真实 provider 服务跑录制交互。** stub 只留给 provider 自己的下游依赖,绝不 stub 被验证系统本身。(证据: docs.pact.io provider)
→ 强化工作项 13 方向:sandbox-cloud-http conformance 套件对真实 HTTP reference server(reference server 内部可自由 stub 自己的下游)符合行业共识;当前手写 stub 正好倒置了这一点,会与 README 协议静默漂移。

---

## Route: Codebase(代码实证)

**C1 — change 脚手架已存在,仅有 surface-impact sidecar。** publicV1/mcp/openapi/apiPlayground 全 'unchanged' 并带 research-stage 复核条款;internalOnly 'changed' 载全量 phase-2 scope 文本。(证据: openspec/changes/unlock-extension-axes/surface-impact.json,目录唯一文件)
→ propose 进行中;sidecar 的 publicV1 unchanged 断言是任务要求通过 PUBLIC_V1_OPERATIONS 传递引用复核的那一条。

**C2 — publicV1 'unchanged' 断言经传递检查成立。** public-v1-operations.ts 只从 runtime-model.js 引 RuntimeModelCatalog*/RuntimeModelNotAvailable*;RuntimeModelCatalogSchema.effectiveEnvironment 是 RuntimeModelEffectiveEnvironmentSchema(name/provider/fingerprint 判别联合),从不引用 RuntimeExecutionEnvironmentSourceSchema;public-v1-operations.ts 与 v1.ts 均不 import sandbox-environment.js,故 RuntimeArtifactChecksumsSchema 与 source-kind 合并都在 /v1 之外。(证据: packages/contracts/src/public-v1-operations.ts:21-26; packages/contracts/src/runtime-model.ts:24-49, :99-122, :265-277)
→ 无需升级 sidecar——传递引用审计通过;**该证明记入 proposal**。

**C3 — 工作项 1 目标确认。** RuntimeArtifactChecksumsSchema 是 strict object,字面 key codex + 'claude-code'——唯一的轴 B×C 物理拒绝;record key schema 已存在(RuntimeSchema = z.enum(AGENT_RUNTIME_IDS))。(证据: packages/contracts/src/sandbox-environment.ts:116-121; packages/contracts/src/task.ts:67-68; 消费点 sandbox-environment.ts:136)
→ `z.record(RuntimeSchema, Sha256ChecksumSchema)` 是 drop-in——record 两半都已在 contracts 声明;注意路径是 **packages/contracts/src**,不是任务文本写的 contracts/src。

**C4 — runtime 词表已是单声明,且模式正是 RUNTIME_METADATA 应镜像的。** AGENT_RUNTIME_IDS as const + 派生类型,从 contracts index 导出,CLAUDE.md 强制「总 Record over 它」。(证据: packages/contracts/src/agent-runtime-id.ts:24-26,37; packages/contracts/src/index.ts:63; packages/contracts/CLAUDE.md)
→ RUNTIME_METADATA 落在既定惯例旁——不需要新机制,只需要一张新表。

**C5 — 任务点名的 compile-fail 模板存在且覆盖所需习语。** @ts-expect-error 夹具证明 Omit/Partial/empty-record/free-string 全都编译失败,外加双向可赋值性钉死 api RuntimeId === contract AgentRuntimeId。(证据: apps/api/src/agent-runtime/agent-runtime-registration.typecheck.ts:20-63)
→ RUNTIME_METADATA 全覆盖与「假想第三 runtime typecheck 演练」验收都照抄此夹具形状。

**C6 — task-failure.ts 恰有三处 runtime 分支,但形状分两类。** 两处 label 三元('claude-code' ? 'Claude Code' : 'Codex')在 :80/:94;一处 runtime 强转三元(row.runtime === 'claude-code' ? 'claude-code' : DEFAULT_TASK_RUNTIME)约 :226,在 taskFailureFromRecord 内——第三处是 parse/default 位,不是 label 位。(证据: apps/api/src/task-failure/task-failure.ts:80,94,226)
→ RUNTIME_METADATA.label 替换 :80/:94;:226 要的是 RuntimeSchema.safeParse + DEFAULT_AGENT_RUNTIME_ID 而非 label 查表——**proposal 须区分两种形状**。

**C7 — web 三元位确认,但路径与任务文本不同。** CLI-preview 三元在 apps/web/src/components/**dashboard**/new-task-dialog.tsx:271-273('# 沙箱内启动 claude' vs codex);credential-alert 分支在 apps/web/src/components/**runtime-credential-alert.tsx**:34(if failure.runtime === 'claude-code',硬编码 Claude Code 文案);另有第四处 label 三元在 runtime-credentials.tsx 约 :79(issueRuntimeLabel)。(证据: 上列三文件)
→ tasks.md 用正确路径(dashboard/ 非 tasks/;components 根目录非 settings/);credential-alert 分支还硬编码 per-runtime description/actionLabel——比 label 更丰,**RUNTIME_METADATA 要么带这些字段,要么 alert 保留按 id 键控的本地文案**。

**C8 — new-task-dialog 已有本地 per-runtime 元数据表 RUNTIME_COPY。** {label,hint} 按 AGENT_RUNTIME_IDS 键控,options 用 .map() 派生——一个活在 contracts 边界错侧的 RUNTIME_METADATA 前身。(证据: new-task-dialog.tsx:132-133, :150-158)
→ **Lift-don't-invent**:RUNTIME_METADATA 可吸收 RUNTIME_COPY;双端同源 import 路径已被证明(web 已从 contracts import AGENT_RUNTIME_IDS)。

**C9 — runtime-credentials.tsx 完全双 prop 硬连线。** RuntimeCredentialTabsProps 声明 codexCred/claudeCred + onConfigureCodex/onConfigureClaude,组件按名解构全部四个。(证据: apps/web/src/components/settings/runtime-credentials.tsx:52-67)
→ 工作项 3 的集合驱动重写目标;注意 handler 收 runtime 专属 mode 类型(CodexCredentialMode vs ClaudeCredentialMode),**RUNTIME_METADATA 的 credentialKind 必须统一或判别 mode 词表**。

**C10 — TranscriptReadStrategy 是单成员联合 { kind: 'single-newest-jsonl' } 带 NOT-YET-AN-EXTENSION-POINT 注释块;loud refusal 不是名为 assertSingleNewestJsonlSupported 的函数**——是 sandbox facade configured-provider 内的 inline 检查('no provider implements a strategy other than single-newest-jsonl')。(证据: apps/api/src/agent-runtime/agent-runtime.port.ts:121,418-428; packages/sandbox/src/host-harness/configured-provider.ts:653-664; 声明点 codex-runtime.ts:309 / claude-code-runtime.ts:346)
→ 工作项 4 的真派发必须落在 **configured-provider.ts(sandbox 包)**,不只在 api port;任务提示里的符号名在树中不存在。

**C11 — adapter 边界残余手写 runtime union。** assertRuntimeModelAdapterSnapshot 参数位内联 `runtime: 'codex' | 'claude-code'`。(证据: apps/api/src/runtime-models/runtime-model-adapter-snapshot.ts:6)
→ 工作项 5:一行改为 contracts 的 AgentRuntimeId/Runtime。

**C12 — tmux session protocol 双份声明、内容一致,且 sandbox facade 已导出共享核心。** buildCodexLaunchLine/detachedSessionName/TMUX_UTF8/wrapInDetachedSession/headless wrapper/buildHasSessionCommand 在 apps/api/src/agent-runtime/codex-launch.ts 与 packages/sandbox/src/terminal/session-commands.ts 各一份;facade 导出在 packages/sandbox/src/index.ts:588-599;导出白名单闸 facade-surface.gate.mjs + expected-facade-surface.json(R6 已落地)。(证据: 上列文件行号)
→ 工作项 6 方向(api 删除、import @cap-console/sandbox)今天可行;**任何未白名单的导出须加进 expected-facade-surface.json,否则 R6 闸变红**。

**C13 — SKILL_CATALOG 镜像确认。** web catalog 带 MUST-match 注释(new-task-dialog.tsx:161-169,id openspec/bmad + 展示文案)对 api SKILL_ALLOWLIST 同 id 键控(skill-allowlist.ts:44-57)。
→ 工作项 7:只上移 id 词表到 contracts;web 留 hint/label 文案,api 留 SkillInstaller 命令——任务开的拆分方式与代码形状吻合。

**C14 — ConfiguredSandboxProviderFamily = 'auto'|'aio'|'boxlite'|'control-plane'(无 'cloud-http'),providerFamilyAllowsCloudHttp 仅对 'auto' 返回 true**——「物理上不可能显式选 cloud-http」缺陷与描述一致。(证据: packages/sandbox/src/host-harness/config.ts:11-15, :113-129)
→ 工作项 8:加 'cloud-http' 成员 + 三个 allows 函数合并为一个总 `Record<ConfiguredFamily, readonly SandboxProviderFamily[]>`。

**C15 — allows 三件套有两个消费文件要在工作项 10 收敛。** configured-provider.ts(provider 选择处 3 个调用点)与 deployment-environment.ts(约 9 个调用点)。(证据: configured-provider.ts:65-67,104,109,134; deployment-environment.ts:30-32,114,134,186,217,245,331,339,372)
→ Record 化不是 config.ts 局部;deployment-environment.ts 是更大消费者,其 6 分支 deploymentBehavior 已另行划给 phase 7a(工件03 B.1)——**phase-2 scope 只做 lookup 转换**。

**C16 — 「第五词表」在 sandbox 包,不在 api。** SandboxTerminalStoryProvider = 'auto'|'aio'|'boxlite' 在 packages/sandbox/src/host-harness/provider-terminal-story.ts:7;api 仅重 alias(apps/api/src/terminal/provider-terminal-story.service.ts:30),apps/api/src/terminal/provider-terminal-story.ts 不存在。
→ R8 覆盖闸必须指向 **sandbox 包内文件**;任务提示路径过期,会把闸指到不存在的文件。

**C17 — R8 的点名模板真实存在且载全套 gate canon。** provider-contract-parity-check.mjs 做递归 DISCOVERY(无硬编码包清单)、零参与者即败、自测、保留可审阅数据清单,配对 .test.mjs;R5/R8 已在 docs/refactor/04-rules-registry.md:58,61 为 phase 2 预注册。
→ 新 R8 闸(操作员词表 ⊇ 可选 family ∪ {auto,control-plane})照抄此 canon:配对自测 + 注入探针红证 + 空扫描即败。

**C18 — R5 落点存在。** sandbox-core-vocabulary-parity.mjs 的 PAIRS 是可扩 {file, array, schema} 条目数组,带显式 declared-widening 机制,当前**无** source-kind 对;配对 .test.mjs 在。(证据: scripts/sandbox-core-vocabulary-parity.mjs:48-70, :173-180)
→ 工作项 11 的「合并后加进 PAIRS」是单条 append——前提是 SandboxEnvironmentSourceKindSchema 成为单一声明。

**C19 — 轴 C 预决策事实核实。** SandboxEnvironmentSourceKindSchema 2 成员(aio-docker-image, boxlite-image),RuntimeExecutionEnvironmentSourceSchema 4 成员(加 boxlite-rootfs, provider-snapshot);provider-snapshot 有**活的生产分支**(resolver 在存在 checksum 但无匹配 configured kind 时落到 kind:'provider-snapshot'),boxlite-rootfs 存活于 validation superRefine + taskless probe。(证据: sandbox-environment.ts:25-28 vs runtime-model.ts:58-94; runtime-model-environment.resolver.ts:391-397; runtime-model.ts:205-213; configured-runtime-model-taskless-probe.ts:245-248)
→ 确认任务钦定的裁定:**provider-snapshot 不能删**(活生产者)——派生必须将其建模为显式 extension/legacy 成员;boxlite-rootfs 只在读路径(历史快照),迁移 vs legacy 成员是 design.md 真正的开放决策。

**C20 — 五个 runtime-conformance scenario 种子全部在位。** 逐字节 launch golden(codex-launch.test.mjs:121-131)、DSR/quiesce/exit-detection 策略断言(agent-runtime.test.mjs:251-262)、transcript parser(parse-transcript.ts + claude-transcript-parser.test.mjs)、headless/resume argv 捕获含 mode 联合 'interactive-pty'|'headless-exec'|'resume'(headless-execution.spec.ts:123-126)。
→ 工作项 12 骨架可**移植真实断言而非发明场景**;注意种子在 apps/api(叶子包),抽进 packages/* 套件跨越 api→package 方向,**不得拖带 api-only import**。

**C21 — secret-canary 捐赠模式贯穿 workspace-git-conformance.ts。** options.secretCanary(:73-74)、注入 Authorization header(:83)、provider-private 配置内 exactly-once 断言(:158-160)、执行边界零泄漏 :181/:206,再断言 :303-306/:539-542——比任务引用的 73-207 范围更宽。
→ runtime secret-canary family(凭据一次性注入 / ps-log-transcript 零泄漏 / destroy 后不可读)**移植这套断言词汇**。

**C22 — participation ledger 模板是一对总 Record。** `Record<SandboxProviderCapability, SandboxCapabilityCoverage>` + `Record<SandboxConformanceFamily, () => scenarios[]>`——family 或 capability 漏登记在 provider 套件已是编译错。(证据: packages/sandbox-conformance/src/required-participation.ts:63,205)
→ 工作项 12 的「executionModes 反推必跑 family,漏登记=编译错误」是以 AgentRuntimeId/execution-mode 为 key 词表的直接结构拷贝。

**C23 — package-suites CI job 自动招收新包。** `pnpm turbo test --filter='./packages/*' --continue`,目录 filter 明确选择使「声明 test script 的新包自动加入」;CI 显示名是 attestation 消费者接口,总则2 冻结。(证据: .github/workflows/ci.yml:389-414; docs/refactor-master-plan.md:44-52)
→ packages/runtime-conformance(或类似)带 test script 即零 workflow 编辑进 CI——满足「进 package-suites job」且不碰 check 显示名。

**C24 — cloud-http reference server 输入核实。** README 枚举恰 7 端点(POST /v1/sandboxes、DELETE /:taskId、GET /:taskId、GET /:taskId/transcript、POST /:taskId/deliver、GET /readoptable、POST /:taskId/reattach);当前 conformance 对手写 makeFetch stub 跑;要保留的两个信任边界硬拒绝是 provider-local secret-writer 要求;examples/ 已在仓库根(examples/sandbox-images)作位置先例。(证据: packages/sandbox-cloud-http/README.md:14-29; test/http-cloud-provider.test.mjs:69-83; src/http-cloud-provider.ts:173,734)
→ 工作项 13:makeFetch 换真实 HTTP listener;工件03 B.3 要求保留两个 secret 拒绝,B.4 使 capability/version 自描述为可选附带。

**C25 — 任务称为 blueprint 的设计文档与代码库吻合。** 03-extension-interfaces.md 载 B.2(操作员词表修复含 4 步计划)、B.3/B.4(信任边界+参考服务端)、C.1(RUNTIME_METADATA 同 file:line 目标)、C.2(收敛清单)、C.3(五 family 表同种子)、D(轴 C 同预决策);05-reconciliation B 表 D14 记录派生方案被推翻、改独立声明+覆盖闸。(证据: docs/refactor/03-extension-interfaces.md; docs/refactor/05-repo-split-reconciliation.md:40; docs/refactor-master-plan.md:91-113)
→ spec/design 工件可逐字引用 blueprint;**blueprint 与树之间除两处过期路径(provider-terminal-story 位置、assertSingleNewestJsonlSupported 名字)外无矛盾**。

**C26 — 同树有两个兄弟 change 在飞。** enforce-boundaries-from-manifest(phase 3)与 session-approval-flow 与 unlock-extension-axes 并列于 openspec/changes/。
→ 共享工作树协调:phase 3 的 ESLint/manifest 闸会消费本 change 移动的同批文件(facade 导出、contracts 词表),**顺序/冲突注记应写进 proposal**。

**C27 — 验证命令与闸门语境。** contracts 编辑须先 rebuild 再动消费者(消费者读 dist),api 测试对 dist 跑故 build-before-test;api layout 闸 + sandbox package-boundary 闸约束移动代码的落位(api 必须 import @cap-console/sandbox facade,绝不 import sandbox-* 子包)。(证据: packages/contracts/CLAUDE.md; apps/api/CLAUDE.md)
→ tasks.md 检查点:每个轴 B contracts 改动都要 contracts build → api/web typecheck;tmux 去重(工作项 6)正是 boundary 闸强制的 facade-import 模式。

---

## Route: Archive(归档判例)

**A1 — 轴 B 的直接前作是 2026-07-29-derive-runtime-vocabulary-from-registration。** 它把 4 份 runtime 词表收敛为 contracts 单一 as const 声明 + 总 Record 注册映射,并显式把「6 张 per-runtime 策略表」留作后续——本 change 的 RUNTIME_METADATA(工作项 2)正是把三处显示三元升格为第 7 张策略表,与其 4.4 结论(策略表是必须继续被 demanded 的决策点,不是缺陷)完全一致。(证据: archive/2026-07-29-derive-runtime-vocabulary-from-registration/proposal.md Impact 段; tasks.md 4.4)
→ 本 change 是其直接续集;该前作已把 ConfiguredSandboxProviderFamily(工作项 8)和「改变 runtime 是什么」列为 Non-Goal 并写明原因,**新 proposal 应显式引用并接续这些 Non-Goal,避免重复论证**。

**A2 — 该前作的四轨结构可整体复用。** Track1 baseline-evidence(实测「今天加第三 runtime 要改几处」+ 编译器 demanded-edit 清单)→ Track2 one-declaration → Track3 registration-parity → Track4 verification(同法重测准入成本、「不许改任何现有测试」作等价性证明、grep 残余枚举并区分「第二份定义」vs「测试内字面量」)。(证据: 同上 tasks.md 1.2/4.2/4.4/4.5 与 baseline.md)
→ 「假想第三 runtime typecheck 演练自证」就是其 4.4/3.4 方法;**baseline.md 独立成档**(非散文夹在 design 里)是应复用的工件形态。

**A3 — @ts-expect-error 夹具模板是该前作 D5 产物,约定「自失效」。** 若映射被弱化为 partial/index-signature,@ts-expect-error 变 unused 使常规 typecheck 变红;同类夹具还有 admission-mode-policy.typecheck.ts 与 surface-parity/parity.typecheck.ts。(证据: agent-runtime-registration.typecheck.ts + 前作 design.md D5)
→ RUNTIME_METADATA 编译期总覆盖照抄 D5 形态;design 应像 D2 一样引用既有三次使用证明这是仓库既定 shape 而非新发明。

**A4 — R8 canon 模板 2026-07-28-enforce-provider-contract-parity 的 tasks.md 是全 archive 最佳「任务即证据记录」范本。** 每条勾选写实际发生的事:设计碰撞升级用户拍板并写码前修 spec(4.1)、注入探针红证逐字记录后 revert(5.5 加 firecracker 产生 3 处未触及文件编译错)、自测数据被自己揪出「只是看着承重」遂清空(5.1 KNOWN_DISTINCT_PAIRS)。(证据: archive/2026-07-28-enforce-provider-contract-parity/tasks.md 4.1/4.2/5.1/5.5)
→ 本 change「每个新闸门 gate canon 全套」约束的出处;**R8 新闸与 R5 PAIRS 扩充的任务应按此格式预留「红证+revert+verbatim 输出」栏位**。

**A5 — 工作项 12 的 participation 账本模板已完整存在。** enforce-provider-contract-parity 建的 required-participation.ts 用总 Record 从 provider 声明 capabilities 反推必跑 scenario family,漏登记=编译错;其 4.2 记录关键教训——spec 原文要求参与「unexpressible」,选择改写 SHALL 为账本形态而非留一条代码不满足的规则。(证据: 同上 tasks.md 4.1/4.2 + packages/sandbox-conformance/required-participation.ts)
→ runtime-conformance 的 executionModes→必跑 family 账本直接平移此结构;**spec 措辞一开始就写账本形态,别写「不可表达」级的 SHALL 再返工**。

**A6 — 工作项 8 的 D14 裁定有直接判例。** parity change 3.1 曾疑 ProviderSeamSchema 缺 cloud-http 是 drift,经 git 时间线(cloud-http 62d5ac1 早于枚举 a27356f 三周)+capability 语义裁定为 DELIBERATE 覆盖集,处理法=改成 named `as const satisfies readonly SandboxProviderFamily[]` 子集(rename 编译报错、刻意省略存活)+ 理由写在声明上。(证据: 同上 tasks.md 3.1/3.4)
→ ConfiguredSandboxProviderFamily 同是「操作员词表≠provider family」的刻意分叉;补 'cloud-http' + Record 化(工作项 8/10)应**复用 satisfies-子集+就地记录理由**写法;R8 闸补「⊇」对账正是该判例缺的机械化部分。

**A7 — 工作项 4 现状是 2026-07-28-fail-loud-on-unknown-runtime 的裁定产物。** 该 change 明言 readTranscriptSource 是「false seam——要么真派发要么删掉文档承诺,二选一并声明」,当时选了单成员大声抛错;同 change 建立 agent-identity-branch-check(runtime==='codex' 禁令可执行化)。(证据: archive/2026-07-28-fail-loud-on-unknown-runtime/proposal.md What Changes 第4条 + scripts/agent-identity-branch-check.mjs)
→ 把单成员升级为真派发是对该裁定的**显式翻案,proposal 应引用并说明触发条件变了(opencode 将至)**;新 RUNTIME_METADATA 消费点不能引入新 identity 三元,否则撞该 change 立的 complement-scan 闸。

**A8 — 工作项 7「词表上移 contracts」的模板是 2026-07-30-converge-contracts-to-genuinely-shared。** audit 用 DUPLICATE/DERIVED/DIVERGENT/COLLISION 四分裁决、type-only import 避免改运行时依赖图,并立 test:contracts-shared(contracts 里没人 import 的导出=红)与 test:vocabulary-parity(即工作项 11 要扩的 R5)两道闸。(证据: archive/2026-07-30-converge-contracts-to-genuinely-shared/proposal.md + scripts/sandbox-core-vocabulary-parity.mjs)
→ SKILL_CATALOG id 上移后**必须两端真 import**,否则 contracts-shared 闸当场抓「上移了没人用」;「展示文案留 web 只上移 id」正是该 change「DERIVED 合法、DUPLICATE 收敛」的裁决口径。

**A9 — converge-contracts 给工作项 11 立了警戒线。** 「收敛一个已 drift 的声明对是行为变更,需要自己的证据」——其两个 drift 对(SmtpConfigRead/RuntimeReadiness envelope)都单独立 track 记录决策;本 change 的 provider-snapshot(活生产分支)与 boxlite-rootfs(仅历史快照消费)语义定案属同类。(证据: 同上 proposal.md Verification 段与 Impact)
→ **定案做成独立任务并预留用户拍板点**,而不是埋在派生改写里。

**A10 — 2026-07-31-close-gate-blindspots-and-ci-hygiene 定稿闸门规范,直接约束本 change 三处。** (a) 枚举式发现是被否决形态——parity check 已改递归 glob+零匹配即败,新 runtime-conformance 应经发现机制进入而非手工名单;(b) CI check 显示名是 release.yml 消费的 attestation API,逐字节不动(总则2 出处);(c) 新 lane 先非 required 跑绿,设 required 是登记在案的手动 GitHub 步骤。(证据: archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/proposal.md + verification-report.md)
→ runtime-conformance 进 package-suites(工作项 12)与 R8 新闸按此三条落位;其 verification-report.md(三路 tally + 逐 requirement 证据 + adjudicator 复抽查)是 opsx-verify 报告现行范式。

**A11 — 工作项 12 launch family 的种子方法出自 2026-06-19-refactor-agent-runtime-policy-mechanism。** 先把 codex 4 项确定性可观测输出(launch line/DSR→CPR 序列/注入 exec 命令/trim 命令)钉成 golden/characterization 测试,再逐步重构断言逐字节不变,e2e 只是最终确认非重构闸门;policy/mechanism 词汇亦源于此。(证据: archive/2026-06-19-refactor-agent-runtime-policy-mechanism/proposal.md)
→ runtime-conformance 五 family 中 launch/lifecycle 的 scenario 就是把这些 golden 从单测搬进套件;secret-canary 移植同理——**都是既有断言改挂到 participation 账本下,不是新测法**。

**A12 — 「加一个 runtime 的历史成本」有实测参照。** 2026-06-18-add-claude-code-runtime 落地时动了 4 个 spec(agent-runtime/aio-sandbox-execution/frontend-console/repo-and-task-management)+ 后端端到端 + 前端 selector/readiness 全链。(证据: archive/2026-06-18-add-claude-code-runtime/)
→ baseline track 直接引用该归档作历史锚点,把「过去加 runtime 碰了什么」与 typecheck 演练测得的「现在还剩什么」并列,验收叙事更有力。

**A13 — 应避免的反模式在 archive 有红字记录。** (a) 2026-07-24-refactor-sandbox-provider-split 是事后补记式 proposal,此后程序性 change 全改证据先行;(b) parity 1.3 教训=别改 pnpm-workspace 排除的死包(sandbox-scheduler 改了又 revert);(c) 5.4 教训=预存 flake 记录在案、绝不 retry 到看不见;(d) converge-contracts 有 NOT-ARCHIVABLE postmortem——sidecar 声明须逐面对 diff 复核(即 publicV1 unchanged 要对 PUBLIC_V1_OPERATIONS 传递引用复核的出处)。(证据: 三个 archive change 的 proposal/tasks)
→ cloud-http 参考服务端(工作项 13)所在的 sandbox-cloud-http 由 (a) 那个 change 引入且当时只到 README 散文——**通电前先确认包在 workspace 构建圈内,别重蹈死包编辑**;sidecar 复核义务已是程序惯例(本 change 已完成,见 C2)。

**A14 — 工件形态现行完整集(2026-07-28 后成为标准)。** proposal.md(Why 带实测表格/What Changes/Capabilities/Impact 含带理由 Non-Goals)+ design.md(Context 带行号证据、D 编号决策各带被否决替代)+ research-brief.md + baseline.md(可选)+ track-annotated tasks.md + specs delta + surface-impact.json + verification-report.md;本 change 跨 12+ 工作项、三轴并行,规模最接近 close-gate-blindspots(多股收口)而非单轴的 derive-runtime。(证据: 两个 archive 目录的工件对比)
→ **track 按轴切**(B/A/C/conformance/cloud-http 各自独立 track,词表收敛项挂对应轴),依赖声明写 tasks.md 首注释;close-gate-blindspots 证明 12+ 工作项单 change 可管理,但**每股都要有自己的注入探针任务**。

---

## Implications for the proposal

### 1. 工作项 1(RuntimeArtifactChecksumsSchema record 化)——语义必须显式定案
- drop-in 可行(C3),但 design.md 必须写下 **intended semantics = partial**(历史 attestation 缺新 runtime checksum 必须继续可解析),并注明 Zod v4 迁移路径是 `z.partialRecord`(W1)。
- 加一条约束:contracts/api/web 仅用 classic v3 entrypoint,或对齐版本消除 `zod/v4` 子路径风险(W2)。
- publicV1 unchanged 的传递引用证明已完成(C2),**将证明写进 proposal**,满足 A13(d) 的 sidecar 复核惯例;sidecar 无需升级。

### 2. 工作项 2/3(RUNTIME_METADATA + 消费点)——lift-don't-invent,字段先对齐第三 runtime
- 形状:`as const satisfies Record<AgentRuntimeId, {...}>`(W3),落在 C4 既定惯例旁;编译期总覆盖照抄 D5 自失效夹具(C5/A3),design 引用既有三次使用证明非新发明。
- 字段集不能只有 label:credential-alert 需要 description/actionLabel(C7),credentialKind 须统一/判别 mode 词表(C9),并对 Vibe Kanban executor-profile 字段(variant/model 轴、MCP 配置)做 diff 后再冻结——contracts 形状在 repo-split Phase 1c 前定稿(W11)。
- web 的 RUNTIME_COPY 直接被吸收(C8);task-failure 三处分支分两类处理:label 查表替换 :80/:94,:226 用 safeParse+DEFAULT(C6)。
- 新消费点不得引入新 identity 三元,否则撞 fail-loud change 立的 complement-scan 闸(A7)。
- proposal 显式引用 derive-runtime 前作的 Non-Goal 并声明本 change 接续之(A1);复用其四轨结构与独立 baseline.md,历史锚点用 add-claude-code-runtime 归档(A2/A12)。

### 3. 工作项 4(TranscriptReadStrategy 真派发)——显式翻案 + 落点修正
- opencode 的存储形状(per-message JSON 目录 / HTTP)证明第二成员是真实需求(W10);策略词表**按形状命名**(single-newest-jsonl / per-message-json-dir)而非按 runtime。
- proposal 必须引用 fail-loud change 的「false seam 二选一」裁定并声明触发条件已变(A7)。
- 派发落点是 packages/sandbox/src/host-harness/configured-provider.ts:653-664 的 inline 检查,**不是**任务文本里的 assertSingleNewestJsonlSupported(该符号不存在)(C10)——tasks.md 用正确落点。

### 4. 工作项 8/10/R8(操作员词表)——判例齐备
- 缺陷确认(C14);修法复用 D14 判例:satisfies-子集 + 就地记录理由(A6);三个 allows 函数并成一个总 Record,消费面覆盖 configured-provider.ts + deployment-environment.ts 共约 12 个调用点,deploymentBehavior 六分支留给 phase 7a(C15)。
- R8 闸指向 sandbox 包内 provider-terminal-story.ts(任务文本路径过期,C16);照抄 provider-contract-parity-check canon:递归发现、零匹配即败、配对自测、注入探针红证+revert 逐字记录(C17/A4/A10a)。
- 不引入 dependency-cruiser 等新工具,延用自研 canon(W12)。

### 5. 工作项 11 + 轴 C(source-kind 合并)——行为变更须独立拍板
- provider-snapshot 有活生产分支不可删,boxlite-rootfs 仅读路径——迁移 vs legacy 成员是真开放决策(C19)。
- 按 converge-contracts 警戒线:定案做成**独立任务 + 用户拍板点**,不埋在派生改写里(A9)。
- 合并完成后 R5 PAIRS append 一条即可(C18);上移的任何词表两端必须真 import,否则 contracts-shared 闸抓「上移了没人用」(A8,同样约束工作项 7 SKILL_CATALOG)。

### 6. 工作项 12(runtime-conformance)——结构全部有模板,零新发明
- 布局:go-cloud drivertest 的 harness-maker 接缝(W6)+ csi-sanity 的能力门控与负向断言(W5);账本:required-participation.ts 双总 Record 直接平移,executionModes 反推必跑 family、漏登记=编译错(C22/A5);spec 措辞一开始就写账本形态(A5)。
- 场景=移植不发明:五 family 种子全在 apps/api(C20),launch/lifecycle 沿 golden-first 方法(A11),secret-canary 移植 workspace-git-conformance 断言词汇(C21);抽取跨 api→package 方向,不得拖带 api-only import(C20)。
- 采纳 Gateway API 两个精化:需求/能力交集计算 + per-runtime conformance 报告工件让 skip 可见(W4)。
- CI:带 test script 即自动进 package-suites,零 workflow 编辑、不碰冻结的 check 显示名;新 lane 先非 required(C23/A10)。

### 7. 工作项 13(cloud-http 参考服务端)——real HTTP 是行业共识
- 方向被 OCI(W7)与 Pact(W14)双重背书:conformance 对真实 HTTP reference server 跑,stub 只留给 server 自己的下游;现 makeFetch stub 会静默漂移。
- 落位与命名:照 MCP 'everything' 先例建显式命名的 **reference server**(非 mock),兼作可执行文档(W9);examples/ 位置先例已有(C24)。
- 自描述端点(B.3/B.4):capability 缺失=优雅降级、版本 counter-offer(W8),并考虑把 specificationVersion 内嵌进声明对象(W13);两个 secret-writer 硬拒绝原样保留(C24)。
- 通电前确认 sandbox-cloud-http 在 workspace 构建圈内,避免死包编辑重演(A13)。

### 8. 程序与工件形态
- 规模对标 close-gate-blindspots:track 按轴切(B / A / C / conformance / cloud-http),每股配自己的注入探针任务,依赖写 tasks.md 首注释(A14)。
- 每个新闸门带全套 canon(配对自测 + 红证 verbatim + revert + 空扫描即败),tasks.md 按 parity 范本预留证据栏位(A4)。
- 验证链:contracts build → api/web typecheck;api 侧 build-before-test;tmux 去重走 facade-import,受 boundary 闸约束,新增 facade 导出须进 expected-facade-surface.json 否则 R6 红(C12/C27)。
- 兄弟 change 协调:enforce-boundaries-from-manifest(phase 3)将消费本 change 移动的同批文件,proposal 写顺序/冲突注记(C26)。
- 任务文本三处过期须在 tasks.md 修正:`packages/contracts/src`(非 contracts/src,C3)、web 三元真实路径(C7)、provider-terminal-story 在 sandbox 包 + assertSingleNewestJsonlSupported 不存在(C10/C16);blueprint 与树其余无矛盾(C25)。
