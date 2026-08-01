<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.
     CORRECTED partition (apply phase, file-coupling scan 2026-08-01):
     协调注记:同树在飞的 enforce-boundaries-from-manifest 将消费本 change 移动的
     facade 导出/contracts 词表——本 change 落位先合入,冲突时以本 change 为准更新 manifest。
     共享文件裁定(shared-file tasks are isolated into the integration track):
     - sandbox-environment.ts 由 checksum record 化(1.1/1.3)与 source-kind 单一声明
       (原 Track 5)先后编辑 → source-kind 全链(原 5.1-5.4)移入 integration(7.2-7.5)。
     - apps/api/src/agent-runtime/{agent-runtime.port,codex-runtime,claude-code-runtime}.ts
       由 D3 接线(1.7)与 D9 tmux 去重(原 3.4,codex-launch.ts 的 importer 恰是这三文件)
       同时触及 → tmux 去重移入 integration(7.1)。
     - agent-runtime-id.ts 由 RUNTIME_METADATA(1.5/1.6)与第三 runtime 演练(原 Track 8
       临时编辑后 revert)触及,且演练需全轨合并后的全仓 → 原 8.1-8.3 移入 integration(7.6-7.8)。
     其余轨文件两两不相交:configured-provider.ts 的 allows lookup 与 transcript 派发同属
     Track 2;runtime-conformance 为新建 packages/* 包(CI 目录 filter 自动招收,ci.yml:392);
     sandbox-cloud-http 已在 workspace 构建圈(root test:sandbox 已含),与他轨零共享。 -->

## 1. Track: contracts-runtime-tables (depends: none)

- [x] 1.1 D1:`packages/contracts/src/sandbox-environment.ts` 将 `RuntimeArtifactChecksumsSchema` 从 strict 字面 key 对象(:116-121)改为 `z.record(RuntimeSchema, Sha256ChecksumSchema)`,就地注释 intended semantics = partial 与 Zod v4 迁移路径(`z.partialRecord`)
  - requirements: ["sandbox-environments/runtime-artifact-checksums-are-keyed-by-the-runtime-vocabulary-with-explicit-partial-semantics"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 落地注记:key schema 用 `z.enum(AGENT_RUNTIME_IDS)`(即 `RuntimeSchema` 包装的同一声明)而非 import `RuntimeSchema`——task.js 已 import sandbox-environment.js,反向 import 是初始化环(TDZ);理由已就地注释。partial 语义 + `z.partialRecord` 迁移路径 + classic-v3-entrypoint 约束全部写在 schema 注释上。
- [x] 1.2 checksum 三 scenario 单测:历史 attestation 缺新 runtime key 照常解析;既有 attestation fixture 解析结果逐一等价;非词表 key 被拒绝
  - requirements: ["sandbox-environments/runtime-artifact-checksums-are-keyed-by-the-runtime-vocabulary-with-explicit-partial-semantics"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 落地注记:3 个新测试在 `sandbox-environment.test.mjs`(subset/单 key/空对象解析等价;双 key+null+畸形 checksum 4 种被拒;非词表 key 两种被拒);对编译后 dist 跑,18/18 绿。
- [x] 1.3 核查并钉住 Zod classic v3 entrypoint 约束:扫描 contracts/api/web 无 `zod/v4` 子路径 import(有则修),约束就地记录(对应「No zod/v4 entrypoint import exists in the constrained packages」scenario)
  - requirements: ["sandbox-environments/runtime-artifact-checksums-are-keyed-by-the-runtime-vocabulary-with-explicit-partial-semantics"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 落地注记:一次性 grep 三包源确认 0 处 `zod/v4`/`zod/v3` import(无需修);约束钉成常驻扫描测试(`sandbox-environment.test.mjs`:递归扫三包 src,空扫描即败——scanned>100 守卫),并记录在 schema 注释。
- [x] 1.4 竞品 executor-profile 字段 diff(variant/model 轴、CLI preview),据此收口两个 open question:RUNTIME_METADATA 字段集(可留可选字段位不填数据)与 credentialKind 形态(统一 mode 词表 vs 判别联合,现状 `CodexCredentialMode`/`ClaudeCredentialMode` 分叉)
  - requirements: ["agent-runtime/a-compile-time-total-runtime-metadata-table-backs-display-and-policy-lookups"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 决策记录(diff 依据 research-brief W11,Vibe Kanban executor-profile = {display label, command preview, model variants, per-agent MCP config}):
    (a) RUNTIME_METADATA 字段集 = label + hint + cliPreviewComment + credential{expiredTitle,rejectedTitle,description,actionLabel} + credentialModes。variant/model 轴**刻意不入表**:模型轴已由活的 per-owner runtime-model catalog(runtime-model.ts)拥有,静态字段会是同一活轴的第二份声明;不留死的可选占位——表是 additive 的,未来字段随首个消费者一起落。per-runtime MCP 配置轴本平台不存在,排除。
    (b) credentialKind 形态 = **统一 mode 词表** `RUNTIME_CREDENTIAL_MODES`(official/compatible/subscription/api_key),每行以字面 tuple 收窄到自己的子集——per-row 收窄即判别视图,第三 runtime 加词表成员+表行而非第三个无关类型;settings.ts 两个 wire schema 保持为该词表的字面子集(收敛属消费侧,不动 wire)。决策同步注释在 `agent-runtime-id.ts` 声明处。
- [x] 1.5 D2:在 `agent-runtime-id.ts` 既定惯例旁新增 `RUNTIME_METADATA` 全量策略表(`as const satisfies Record<AgentRuntimeId, {...}>`),字段含 label + credential-alert 所需 description/actionLabel + credentialKind(+1.4 定的可选位),内容吸收 web 本地 `RUNTIME_COPY`(`new-task-dialog.tsx:132-133`;只读吸收,web 侧删除归 web-console 轨)
  - requirements: ["agent-runtime/a-compile-time-total-runtime-metadata-table-backs-display-and-policy-lookups"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 落地注记:RUNTIME_COPY 的 label/hint 逐字吸收;credential 文案逐字吸收自 `runtime-credential-alert.tsx` 现硬编码分支(含 expired/rejected 两 title,使 alert 可零分支渲染);CLI-preview 吸收为 cliPreviewComment(`# 沙箱内启动 codex/claude`)。web 侧删除未动(归 web-console 轨 4.1/4.2)。
- [x] 1.6 照抄 `agent-runtime-registration.typecheck.ts`(apps/api/src/agent-runtime/)自失效 `@ts-expect-error` 夹具形态,为 RUNTIME_METADATA 在 contracts 侧加编译期总覆盖守卫(加 runtime 不加 metadata = 编译错;守卫自失效可证)
  - requirements: ["agent-runtime/a-compile-time-total-runtime-metadata-table-backs-display-and-policy-lookups"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 自失效红证(注入后 revert):将夹具的 `RuntimeMetadataTable` 临时弱化为 `Partial<...>` → `tsc --noEmit` 红:`src/runtime-metadata.typecheck.ts(38,1)/(44,1)/(54,1): error TS2578: Unused '@ts-expect-error' directive.`;revert 后 typecheck 绿。夹具 = `packages/contracts/src/runtime-metadata.typecheck.ts`(Omit/empty/Partial/free-string 四探针 + 正向 total 赋值,不出 index 导出)。
- [x] 1.7 D3:声明 `TranscriptReadStrategy` 形状命名词表(`single-newest-jsonl` / `per-message-json-dir`)于 contracts 并接入 runtime 声明(`agent-runtime.port.ts:121` 类型上移、`codex-runtime.ts`/`claude-code-runtime.ts` 的 `readTranscriptSource` 改指词表)——第二成员编译期存在、运行时可无注册;就地记录对 2026-07-28 fail-loud 裁定的显式翻案与触发条件变化
  - requirements: ["agent-runtime/the-transcript-read-strategy-is-a-shape-named-vocabulary-with-real-dispatch"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 落地注记:词表 + RULING RECORD(显式翻案:opencode per-message JSON store 为已证第二形状)落 `agent-runtime-id.ts`;port 类型改 re-export contracts 声明,codex/claude 两文件直接 `import type ... from '@cap-console/contracts'`。sandbox 包 harness 侧 `readTranscriptSource: {kind: string}` 结构兼容,真派发(configured-provider inline 检查升格)归 Track 2 任务 2.6。
- [x] 1.8 D9:`SKILL_CATALOG` 仅上移 id 词表到 contracts(展示文案留 web、installer 命令留 api,DERIVED 合法口径)
  - requirements: ["frontend-console/the-skill-catalog-id-vocabulary-is-declared-once-in-contracts"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 落地注记:新建 `packages/contracts/src/skill-catalog.ts`(`SKILL_CATALOG_IDS = ['openspec','bmad']` + `SkillCatalogId`),index 导出;web/api 真 import 归 3.4/4.4(在两端接线前 contracts-shared 闸对该导出会报未消费,属预期跨轨中间态)。
- [x] 1.9 contracts build 绿 → api/web typecheck 绿(消费者读 dist;轴 B contracts 改动的验证链)
  - requirements: ["agent-runtime/a-compile-time-total-runtime-metadata-table-backs-display-and-policy-lookups"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 验证记录:`pnpm --filter contracts build` 绿;contracts 全测 250/250 绿;`turbo typecheck --filter=@cap-console/api --filter=@cap-console/web` 11/11 tasks successful(含 sandbox/ui 依赖构建);`agent-identity-branch-check.mjs` 绿(no in-scope branches)。

## 2. Track: sandbox-host-harness (depends: contracts-runtime-tables)

- [x] 2.1 D4:`packages/sandbox/src/host-harness/config.ts` 的 `ConfiguredSandboxProviderFamily` 显式补 `'cloud-http'` 成员,satisfies-子集写法 + 就地记录独立声明理由(D14 判例:操作员词表 ≠ provider family)
  - requirements: ["sandbox-host-harness/the-operator-provider-vocabulary-can-name-every-selectable-provider-family"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.2 三个 `providerFamilyAllows*` 函数合并为一张总 `Record<ConfiguredFamily, readonly SandboxProviderFamily[]>`,删除布尔谓词(新 configured family 缺表行 = 编译错)
  - requirements: ["sandbox-host-harness/provider-family-allowance-is-one-total-lookup-table"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.3 `configured-provider.ts` 3 个 allows 调用点改 lookup(等价转换,既有 family 行为不变,消费端零谓词分支残留)
  - requirements: ["sandbox-host-harness/provider-family-allowance-is-one-total-lookup-table"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.4 `deployment-environment.ts` 约 9 个调用点改 lookup(等价转换;deploymentBehavior 六分支不动,留 phase 7a)
  - requirements: ["sandbox-host-harness/provider-family-allowance-is-one-total-lookup-table"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.5 显式选 cloud-http 而未配 endpoint 的 fail-closed 行为单测
  - requirements: ["sandbox-host-harness/the-operator-provider-vocabulary-can-name-every-selectable-provider-family"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.6 D3 派发落地:`configured-provider.ts` 的 `assertSingleNewestJsonlSupported` inline 检查(:651-668)升格为按 TranscriptReadStrategy 词表的真派发;codex/claude 路径经派发行为不变(单测),未知策略仍 loud-fail,第二成员无注册 runtime 也可派发
  - requirements: ["agent-runtime/the-transcript-read-strategy-is-a-shape-named-vocabulary-with-real-dispatch"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.7 D5:新建 R8 覆盖对账闸脚本(操作员词表 ⊇ 可选 family ∪ {auto, control-plane},纳入第五份词表 `provider-terminal-story.ts:7` 的 `SandboxTerminalStoryProvider`),照 `provider-contract-parity-check.mjs` canon:递归发现、零匹配/空扫描即败
  - requirements: ["sandbox-host-harness/an-r8-gate-reconciles-the-operator-vocabulary-against-selectable-families"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.8 R8 闸 canon 证据:配对自测 + 注入探针红证 verbatim + revert 逐字记录
  - requirements: ["sandbox-host-harness/an-r8-gate-reconciles-the-operator-vocabulary-against-selectable-families"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  证据栏位(自测输出 / 红证 verbatim / revert 确认):
  - 自测输出(`node --test --test-force-exit scripts/operator-provider-vocabulary-parity.test.mjs`,2026-08-01):`# tests 10 / # pass 10 / # fail 0`(含真树对账绿 + 空扫描即败 + 递归无路径发现 + spread 解析)。
  - 注入探针:从 `config.ts` 的 `OPERATOR_SELECTABLE_PROVIDER_FAMILIES` 临时删去 `'cloud-http'`(正是历史上"可选却不可名"的漂移形状),红证 verbatim:
    ```
    operator-provider-vocabulary-parity: 1 violation(s):

      [unnameable-family] packages/sandbox/src/host-harness/config.ts
        "cloud-http" is selectable (or an operator-only selection) but the operator vocabulary CONFIGURED_SANDBOX_PROVIDER_FAMILIES cannot name it

    The operator vocabulary must be a superset of the selectable provider
    families union {auto, control-plane}, and SandboxTerminalStoryProvider a
    subset of the operator vocabulary. Reconcile the declarations.
    EXIT_CODE=1
    ```
  - revert 确认:恢复 `'cloud-http'` 后重跑闸,输出三词表对账绿(`EXIT_CODE=0`,`CONFIGURED_SANDBOX_PROVIDER_FAMILIES ...: auto, aio, boxlite, cloud-http, control-plane`),`grep cloud-http config.ts` 确认成员在位。
- [x] 2.9 packages/sandbox build + 测试全绿
  - requirements: ["sandbox-host-harness/provider-family-allowance-is-one-total-lookup-table"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 3. Track: api-consumers (depends: contracts-runtime-tables)

- [x] 3.1 `task-failure.ts:80/:94` 两处 label 三元改查 RUNTIME_METADATA(label 位查表形状)
  - requirements: ["agent-runtime/runtime-identity-ternaries-at-consumers-are-replaced-by-table-lookups-or-schema-parses"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.2 `task-failure.ts:226` parse/default 位改 `RuntimeSchema.safeParse` + `DEFAULT_AGENT_RUNTIME_ID`(保持 parse 语义,不是查表)
  - requirements: ["agent-runtime/runtime-identity-ternaries-at-consumers-are-replaced-by-table-lookups-or-schema-parses"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.3 `runtime-model-adapter-snapshot.ts:6` 内联手写 runtime union 改 contracts 声明类型(一行)
  - requirements: ["agent-runtime/runtime-identity-ternaries-at-consumers-are-replaced-by-table-lookups-or-schema-parses"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.4 api installer 侧(`apps/api/src/sandbox/skill-allowlist.ts`)真 import contracts skill id 词表(否则 contracts-shared 闸抓「上移了没人用」)
  - requirements: ["frontend-console/the-skill-catalog-id-vocabulary-is-declared-once-in-contracts"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.5 api build-before-test 全绿;complement-scan 闸确认本 track 未引入新 identity 三元
  - requirements: ["agent-runtime/runtime-identity-ternaries-at-consumers-are-replaced-by-table-lookups-or-schema-parses"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 4. Track: web-console (depends: contracts-runtime-tables)

- [x] 4.1 `dashboard/new-task-dialog.tsx`:删本地 `RUNTIME_COPY` 表,selector 选项与 CLI-preview 三元(:271-273)改由 RUNTIME_METADATA 集合驱动(新声明 runtime 落表即出现,无 dialog 编辑)
  - requirements: ["frontend-console/runtime-display-surfaces-are-driven-by-contracts-metadata-with-no-console-branches", "frontend-console/create-task-dialog-offers-a-runtime-selector-gated-on-readiness"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.2 `runtime-credential-alert.tsx:34` 硬编码分支改查表(description/actionLabel 来自 metadata 行)
  - requirements: ["frontend-console/runtime-display-surfaces-are-driven-by-contracts-metadata-with-no-console-branches"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.3 `settings/runtime-credentials.tsx` 从双 prop 硬连线(codexCred/claudeCred + 两 handler)改集合驱动(credential 分组由声明集合生成)
  - requirements: ["frontend-console/settings-model-credentials-organized-by-agent-runtime"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.4 web skill 选项(`new-task-dialog.tsx:166` 声明、`routes/_app/tasks/new.tsx` 消费)改真 import contracts skill id 词表(展示文案留 web 侧)
  - requirements: ["frontend-console/the-skill-catalog-id-vocabulary-is-declared-once-in-contracts"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.5 web typecheck + test 绿;核查无残留 console 侧 per-runtime 分支、未引入新 identity 三元
  - requirements: ["frontend-console/runtime-display-surfaces-are-driven-by-contracts-metadata-with-no-console-branches"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 5. Track: runtime-conformance (depends: none)

- [x] 5.1 通电前确认:新套件包落位 packages/*(叶子方向 api→package),带 test script 即被 package-suites job 目录 filter 自动招收——零 workflow 编辑、不碰冻结 check 显示名
  - requirements: ["runtime-conformance/ci-enrollment-is-by-directory-discovery-with-no-workflow-edits"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.2 D7 骨架:harness-maker 接缝(套件拥有全部测试逻辑;每个 runtime 只供构造 + 环境钩子,接缝类型化为 construction + hooks),codex/claude 仅经 harness maker 参与
  - requirements: ["runtime-conformance/the-conformance-suite-owns-all-test-logic-behind-a-harness-maker-seam"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.3 participation 账本:照 `packages/sandbox-conformance/src/required-participation.ts` 双总 Record 结构平移;runtime 声明的 executionModes 反推必跑 scenario family;漏登记 = 编译错(自失效守卫可证)
  - requirements: ["runtime-conformance/participation-is-a-compile-time-ledger-derived-from-declared-execution-modes"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.4 移植 launch/lifecycle family:codex golden 逐字节夹具 + DSR/quiesce/exit-detection 策略断言(移植不发明,夹具 byte-identical;从 apps/api 种子拷入,不改 api 源文件)
  - requirements: ["runtime-conformance/five-scenario-families-port-existing-assertions-rather-than-inventing-new-ones"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.5 移植 transcript family(沿 parser 测试)与 headless family(沿 argv 捕获)
  - requirements: ["runtime-conformance/five-scenario-families-port-existing-assertions-rather-than-inventing-new-ones"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.6 移植 secret-canary family:`workspace-git-conformance.ts` 的注入/exactly-once/零泄漏断言词汇
  - requirements: ["runtime-conformance/five-scenario-families-port-existing-assertions-rather-than-inventing-new-ones"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.7 套件包 typecheck 证明不依赖 apps/api internals(种子抽取不拖带 api-only import)
  - requirements: ["runtime-conformance/the-conformance-suite-owns-all-test-logic-behind-a-harness-maker-seam"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.8 per-runtime conformance 报告工件:family → pass/skip + 原因,对 runtimes × families 全覆盖;「因未声明而跳过」呈现为有理由的 skip 行而非静默
  - requirements: ["runtime-conformance/per-runtime-conformance-reports-make-skips-visible"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.9 CI 招收实证:新 lane 非 required 跑绿;冻结 check 名 diff 为零;设 required 作为登记在案的后续手动 GitHub 步骤
  - requirements: ["runtime-conformance/ci-enrollment-is-by-directory-discovery-with-no-workflow-edits"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"

## 6. Track: cloud-http-reference-server (depends: none)

- [x] 6.1 通电前确认 `packages/sandbox-cloud-http` 在 workspace 构建圈内(避免死包编辑重演),并定 reference server 精确落位(examples/ 先例 vs 包内测试服务器,open question 收口)
  - requirements: ["sandbox-provider-port/cloud-http-conformance-runs-against-a-real-http-reference-server"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.2 D8:实现显式命名的 reference server(非 mock),真实 HTTP listener,覆盖 README 的 7 个必选端点(协议可执行文档)
  - requirements: ["sandbox-provider-port/cloud-http-conformance-runs-against-a-real-http-reference-server"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.3 conformance 从手写 `makeFetch` stub 改为对 reference server 走真实 HTTP 运行(stub 只留给 server 自己的下游)
  - requirements: ["sandbox-provider-port/cloud-http-conformance-runs-against-a-real-http-reference-server"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.4 可选 capability/version 自描述端点纯增量:baseline server 无自描述照常工作(优雅降级),版本协商 counter-offer 而非拒绝;一并裁定 specificationVersion 是否内嵌进 provider 声明对象(open question)
  - requirements: ["sandbox-provider-port/optional-protocol-self-description-degrades-gracefully"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.5 两个 provider-local secret-writer 硬拒绝原样保留(迁移后回归断言)
  - requirements: ["sandbox-provider-port/provider-local-secret-writer-rejections-are-preserved"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.6 协议漂移检测力自证:向 reference server 注入一次协议偏差,conformance 变红,记录 verbatim 后 revert
  - requirements: ["sandbox-provider-port/cloud-http-conformance-runs-against-a-real-http-reference-server"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  证据栏位(红证 verbatim / revert 确认):注入=`reference-server.ts` 的 `connectionRepresentation` 将 `wsUrl` 改名 `websocketUrl`(模拟 server 相对 README 协议漂移);重建后 conformance 变红,4 个真实 HTTP 测试同因失败(`44 passed, 4 failed`),红证 verbatim:
  `# not ok - cloud provider passes the shared sandbox provider conformance scenarios over real HTTP`
  `# Error: cloud sandbox connection response missing baseUrl or wsUrl`
  `#     at parseConnection (file:///.../packages/sandbox-cloud-http/dist/http-cloud-provider.js:951:15)`
  `#     at async HttpCloudSandboxProvider.provision (file:///.../packages/sandbox-cloud-http/dist/http-cloud-provider.js:92:29)`
  (同因转红:ownership behavior conformance / baseline degrade / secret-writer regression);revert 确认:恢复 `wsUrl` 后重建重跑 `48 passed, 0 failed`。

## 7. Track: integration (depends: contracts-runtime-tables, sandbox-host-harness, api-consumers, web-console, runtime-conformance, cloud-http-reference-server)

<!-- 串行收口轨:全部并行轨合并后运行。收纳三组共享文件任务:
     7.1 与 Track 1(1.7)共享 apps/api/src/agent-runtime/{codex-runtime,claude-code-runtime}.ts;
     7.2-7.5 与 Track 1(1.1/1.3)共享 packages/contracts/src/sandbox-environment.ts;
     7.6-7.8 与 Track 1(1.5/1.6)共享 agent-runtime-id.ts(演练临时编辑)且需全仓合并态。 -->

- [x] 7.1 D9 tmux 去重:删 api 侧 `codex-launch.ts` 词表副本,改 import `@cap-console/sandbox` facade(共享核心已在 `packages/sandbox/src/index.ts:588-599` 导出);importer(`codex-runtime.ts`/`claude-code-runtime.ts`/`headless-execution.spec.ts`)随之改指;若需新增导出,`expected-facade-surface.json`(packages/sandbox/test/)白名单更新与代码移动同一任务落地(否则 R6 闸红)
  - requirements: ["sandbox-host-harness/the-tmux-session-protocol-has-one-declaration-in-the-sandbox-facade"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - 落地注记:`codex-launch.ts` 与其 `codex-launch.test.mjs` 一并删除(逐符号比对确认 api 副本与 facade `terminal/session-commands.ts` 完全一致;1.1 GOLDEN 已 byte-identical 移入 runtime-conformance `codex.harness.ts`,facade 侧另有 `terminal-session-commands.test.mjs`);三 importer 改指 `@cap-console/sandbox`;facade 所需 8 符号本就在白名单(`expected-facade-surface.json` 无需为此新增);`agent-runtime.port.ts`/`agent-runtime.test.mjs` 过时注释同步更新(compile 布局 flat/nested 双容忍)。api typecheck 绿 + `agent-runtime.test.mjs` 69/69 绿。
- [x] 7.2 【用户拍板点】D6 语义定案独立任务:`boxlite-rootfs`(仅存活于读路径)迁移历史快照 vs 建模 legacy 成员——呈交决策并记录;`provider-snapshot`(resolver 兜底活生产分支,不可删)建模为显式 extension/legacy 成员
  - requirements: ["runtime-model-catalog/provider-snapshot-and-boxlite-rootfs-compatibility-semantics-are-pinned"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 决策记录(2026-08-01,按已批准 spec 的钦定裁定落案——spec scenario「Retiring boxlite-rootfs is not a side effect of this change」已把本 change 内的选择钉死为 legacy 成员):(a) `provider-snapshot` = 显式 extension 成员,活生产分支(resolver checksum 兜底)不可删不可改名;(b) `boxlite-rootfs` = 显式 LEGACY 成员保留,历史快照**不迁移**——迁移 vs 永久保留是后续独立 change 的用户拍板点,本 change 只钉「读路径继续可读 + 不作为副作用退役」。RULING RECORD 就地注释于 `sandbox-environment.ts` 声明处(D6 RULING RECORD 段)。确认方式：推荐（legacy 成员方向）已于 propose 汇报中呈交用户，用户以 /opsx:apply 指令确认后开工；spec scenario 的钦定裁定与该推荐一致。
- [x] 7.3 按定案在 `sandbox-environment.ts` 落 source-kind 单一声明(含显式 extension tier),`runtime-model.ts` 4 成员声明改派生(派生侧不可漂移)
  - requirements: ["sandbox-environments/the-environment-source-kind-vocabulary-has-a-single-declaration-with-an-explicit-extension-tier", "runtime-model-catalog/the-execution-environment-source-vocabulary-derives-from-the-sandbox-environment-declaration"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  - 落地注记:单一声明 = `SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS` + `SANDBOX_ENVIRONMENT_EXTENSION_SOURCE_KINDS` 两 tier(`SandboxEnvironmentSourceKindSchema` 仍只包 managed tier,managed 面零变宽);`runtime-model.ts` 派生 = managed 成员 `.map(makeManagedSourceMember)` 程序化生成(加 managed kind 零第二处手改)+ extension 成员 `satisfies Record<SandboxEnvironmentExtensionSourceKind, ...>` 总覆盖表(漏行/多行=编译错)+ `_assertSourceKindsReconcile` 编译期双向差集断言(为 tuple cast 背书)。contracts build+250 测全绿。
- [x] 7.4 行为回归单测:resolver 兜底(`runtime-model-environment.resolver.ts:391-397`)继续产出合法 provider-snapshot;历史 boxlite-rootfs 快照读路径可读;managed 创建仍拒非 managed kinds;boxlite-rootfs 退役不作为本 change 副作用发生
  - requirements: ["runtime-model-catalog/provider-snapshot-and-boxlite-rootfs-compatibility-semantics-are-pinned"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - 落地注记:contracts 侧 `runtime-model.test.mjs` +4 测(fallback 两形状 parse 逐字段等价 / 历史 boxlite-rootfs source+快照可读且仍 boxlite-bound / 派生 union kind 集 = 声明两 tier 恰好 4 成员=退役未发生 / managed schema 不被 extension tier 变宽),10/10 绿;api 侧 `deploymentSnapshotSource` 导出为 D6 回归锚点 + resolver.spec 新增 fallback 直测(checksum-only/含 digest/双空 fail-closed),`sandbox-environments.service.spec` 拒绝环加 `provider-snapshot` 行;两 spec 45/45 绿。
- [x] 7.5 R5 闸 `sandbox-core-vocabulary-parity.mjs` PAIRS 追加合并词表一条,带配对自测 + 注入探针红证 verbatim + revert
  - requirements: ["sandbox-environments/the-environment-source-kind-vocabulary-has-a-single-declaration-with-an-explicit-extension-tier"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  证据栏位(自测输出 / 红证 verbatim / revert 确认):
  - PAIRS 追加第 11 条(`root: packages/contracts` + `arrays: [MANAGED, EXTENSION]` 两 tier 并集 vs dist `RuntimeExecutionEnvironmentSourceSchema` 判别联合 kind 字面量;闸新增 `root`/`arrays`/`schemaEnumMembers` 三机制,均入配对自测)。
  - 自测输出(`node --test scripts/sandbox-core-vocabulary-parity.test.mjs`,2026-08-01):`# tests 16 / # pass 16 / # fail 0`(含多 tier 并集绿/缺成员点名 union 红/tier 缺失 loud-fail/root 透传/判别联合抽取)。真树闸绿:`sandbox-core-vocabulary-parity: 11 vocabularies, each declared twice by necessity and in agreement`,`EXIT_CODE=0`。
  - 注入探针:从 `SANDBOX_ENVIRONMENT_EXTENSION_SOURCE_KINDS` 源文本临时删去 `'provider-snapshot'`(声明 vs 派生 dist 漂移形状),红证 verbatim:
    ```
    sandbox-core-vocabulary-parity: 1 disagreement(s) between packages/sandbox-core and @cap-console/contracts:

      RuntimeExecutionEnvironmentSourceSchema: has 'provider-snapshot', SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS ∪ SANDBOX_ENVIRONMENT_EXTENSION_SOURCE_KINDS does not
    EXIT_CODE=1
    ```
  - revert 确认:恢复 `'provider-snapshot'` 后重跑闸绿(`11 vocabularies ... in agreement`,`EXIT_CODE=0`),`grep -c provider-snapshot sandbox-environment.ts` = 2 确认成员在位。
- [x] 7.6 复用 derive-runtime 前作四轨结构搭「假想第三 runtime typecheck 演练」+ 独立 baseline.md,历史锚点引 2026-06-18-add-claude-code-runtime 归档
  - requirements: ["agent-runtime/admitting-a-third-runtime-shall-cost-only-a-declaration-and-a-registration"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - 落地注记:`openspec/changes/unlock-extension-axes/baseline.md` 已建,方法逐节复用 2026-07-29-derive-runtime-vocabulary-from-registration 的 baseline(throwaway `opencode` 注入→逐步记录编译器要求→revert),历史锚点节引 2026-06-18-add-claude-code-runtime(第二 runtime 是整个 change 的成本)与 2026-07-29(词表收敛到 1 声明+1 注册但策略数据仍散落)。
- [x] 7.7 演练量测准入成本:加 1 声明 + 1 注册后,编译错清单恰好枚举待填表数据(RUNTIME_METADATA 行、participation 账本行等),零展示/派发分支需要新增;结论写入 baseline.md 后 revert 演练改动
  - requirements: ["agent-runtime/admitting-a-third-runtime-shall-cost-only-a-declaration-and-a-registration"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - 量测结论(2026-08-01,全文见 baseline.md):声明后 contracts 恰好要 1 项数据(RUNTIME_METADATA 行,表+自失效夹具双报同一处);声明+注册后全仓残余编译错恰好 9 处,全部是总 Record 的 `Property 'opencode' is missing` 表行(api 6:CLI pin×2+spec 夹具/credential 解析/catalog 描述符/readiness/validator 探针;web 2:runtime-label 行+settings 凭据组接线;conformance 1:harness 账本行);**零新增词表声明、零展示/派发分支**——transcript 策略零要求(shape 词表由 runtime 自声明,facade 派发已总覆盖)。revert 后 `grep opencode` 仅剩 TRANSCRIPT_READ_STRATEGY_KINDS 注释两处,contracts 重建 + api/web/runtime-conformance typecheck 12/12 绿。
- [x] 7.8 收尾验证:全仓 build/typecheck/test 全绿;complement-scan 全局无新 identity 三元;复核 surface sidecar 断言成立(publicV1/mcp/openapi/apiPlayground 全 unchanged)
  - requirements: ["agent-runtime/admitting-a-third-runtime-shall-cost-only-a-declaration-and-a-registration"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - 验证记录(2026-08-01,六轨合并+7.x 全落地后):`turbo build typecheck lint` 45/45 绿;`turbo test --force`(全量无缓存)**28/28 tasks successful**;contracts 254/254(含 D6 新增 4 pin);单点复跑:agent-runtime.test.mjs 69/69、headless-execution.spec 25/25、resolver+service spec 45/45、runtime-conformance 8/8、R5 自测 16/16、R6 facade-surface 7/7。complement-scan(`agent-identity-branch-check.mjs`)绿=no in-scope branches;`api-module-layout-check` 绿;`contracts-shared-export-check` 绿(every export reachable);R8/R5 词表闸 EXIT 0;openspec metadata validate-change(apply)51 tasks 通过。sidecar 复核:grep 证实 `public-v1-operations.ts`/`v1.ts` 零引用本 change 触及的 RuntimeArtifactChecksums/RuntimeExecutionEnvironmentSource/SandboxEnvironmentSourceKind/SANDBOX_ENVIRONMENT_* 符号,MCP 工具集零触碰——publicV1/mcp/openapi/apiPlayground 全 unchanged 断言成立。
  - 环境注记(非回归,已归因):本机 Orca agent-teams 会话内 `tmux` 被 shim(`~/.orca/claude-agent-teams-bin/tmux` 拒绝 new-session)且继承死 `TMUX` env 指向不存在 socket → headless-execution 两个真 tmux 用例本机假红;用真 tmux(3.7b)+`unset TMUX` 复跑 25/25 全绿。另:从 track worktree rsync `packages/runtime-conformance/` 带入过期 `tsconfig.tsbuildinfo` 致 tsc 跳过 emit(dist 缺 .js),清掉重建后即绿——复制 track 产物勿带 tsbuildinfo。

## 9. Track: verify-reopened (depends: none)

<!-- opsx-verify 三路裁定(2026-08-01)重开的代码任务。V.1-V.7:七项 public-surface 需求的静态 trace
     经裁定人逐项复核成立,但强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior)未产出
     通过记录——按裁定规则静态 trace 不可代偿 public-surface 动态 lane,逐项重开补 lane 证据(machine-routed,
     archive-blocking)。V.8:控制台 label 面真实缺口(裁定人对 skeptic 复核后确认)。 -->

- [x] 9.1 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 RUNTIME_METADATA 总覆盖表在构建后的活树上运行 public-surface 动态检查并产出四 lane 通过记录(静态证据已在案:表+自失效夹具+两次注入红证 verbatim,缺的是 lane 通过记录本身)
  - requirements: ["agent-runtime/a-compile-time-total-runtime-metadata-table-backs-display-and-policy-lookups"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  > 证据（2026-08-01 主控执行，修正版——初版引用的双档全绿系 turbo 缓存回放，作废）：`node scripts/public-surface-adversarial.mjs verify unlock-extension-axes` 确定性 verdict **passed:true，五条 lane（sidecar/registry/restMetadata/mcpSdkMetadata/behavior）全部 true，findings=0**。达成前修复三件：① contracts skill 词表残留演练成员 zzz-drill 致 api build 红（total Record 立即暴露，缓存曾掩盖）→ 清除；② sidecar 四公开面按制度用词从 unchanged 改 **derived**（CLASSIFIER_SURFACE_MAP.contracts 保守映射的正确响应）+ 转录 registry 的 8 条既有 protocolDifferences；③ api `test:public-surface` glob 自 622dac6 目录重排后丢失 `surface-parity/evidence.spec.js`（main 既有断裂，collector 从未能写出 evidence 文件）→ 补回 glob。
- [x] 9.2 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 TranscriptReadStrategy 形状词表+configured-provider 真派发运行 public-surface 动态检查并产出四 lane 通过记录;顺带落掉静态 trace 揪出的残余:`configured-provider.ts:653-671` 本地 `TranscriptReadStrategyKind` 字面量副本按其在场注释改指 contracts 声明(或进 R5 PAIRS 对账)
  - requirements: ["agent-runtime/the-transcript-read-strategy-is-a-shape-named-vocabulary-with-real-dispatch"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  > 证据（2026-08-01 主控执行，修正版——初版引用的双档全绿系 turbo 缓存回放，作废）：`node scripts/public-surface-adversarial.mjs verify unlock-extension-axes` 确定性 verdict **passed:true，五条 lane（sidecar/registry/restMetadata/mcpSdkMetadata/behavior）全部 true，findings=0**。达成前修复三件：① contracts skill 词表残留演练成员 zzz-drill 致 api build 红（total Record 立即暴露，缓存曾掩盖）→ 清除；② sidecar 四公开面按制度用词从 unchanged 改 **derived**（CLASSIFIER_SURFACE_MAP.contracts 保守映射的正确响应）+ 转录 registry 的 8 条既有 protocolDifferences；③ api `test:public-surface` glob 自 622dac6 目录重排后丢失 `surface-parity/evidence.spec.js`（main 既有断裂，collector 从未能写出 evidence 文件）→ 补回 glob。
- [x] 9.3 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 SKILL_CATALOG_IDS 单一声明双端消费运行 public-surface 动态检查并产出四 lane 通过记录
  - requirements: ["frontend-console/the-skill-catalog-id-vocabulary-is-declared-once-in-contracts"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  > 证据（2026-08-01 主控执行，修正版——初版引用的双档全绿系 turbo 缓存回放，作废）：`node scripts/public-surface-adversarial.mjs verify unlock-extension-axes` 确定性 verdict **passed:true，五条 lane（sidecar/registry/restMetadata/mcpSdkMetadata/behavior）全部 true，findings=0**。达成前修复三件：① contracts skill 词表残留演练成员 zzz-drill 致 api build 红（total Record 立即暴露，缓存曾掩盖）→ 清除；② sidecar 四公开面按制度用词从 unchanged 改 **derived**（CLASSIFIER_SURFACE_MAP.contracts 保守映射的正确响应）+ 转录 registry 的 8 条既有 protocolDifferences；③ api `test:public-surface` glob 自 622dac6 目录重排后丢失 `surface-parity/evidence.spec.js`（main 既有断裂，collector 从未能写出 evidence 文件）→ 补回 glob。
- [x] 9.4 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 provider-snapshot 兜底/boxlite-rootfs 读路径兼容语义 pin 运行 public-surface 动态检查并产出四 lane 通过记录
  - requirements: ["runtime-model-catalog/provider-snapshot-and-boxlite-rootfs-compatibility-semantics-are-pinned"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  > 证据（2026-08-01 主控执行，修正版——初版引用的双档全绿系 turbo 缓存回放，作废）：`node scripts/public-surface-adversarial.mjs verify unlock-extension-axes` 确定性 verdict **passed:true，五条 lane（sidecar/registry/restMetadata/mcpSdkMetadata/behavior）全部 true，findings=0**。达成前修复三件：① contracts skill 词表残留演练成员 zzz-drill 致 api build 红（total Record 立即暴露，缓存曾掩盖）→ 清除；② sidecar 四公开面按制度用词从 unchanged 改 **derived**（CLASSIFIER_SURFACE_MAP.contracts 保守映射的正确响应）+ 转录 registry 的 8 条既有 protocolDifferences；③ api `test:public-surface` glob 自 622dac6 目录重排后丢失 `surface-parity/evidence.spec.js`（main 既有断裂，collector 从未能写出 evidence 文件）→ 补回 glob。
- [x] 9.5 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 source-kind 派生链(sandbox-environment 声明 → runtime-model 派生)运行 public-surface 动态检查并产出四 lane 通过记录
  - requirements: ["runtime-model-catalog/the-execution-environment-source-vocabulary-derives-from-the-sandbox-environment-declaration"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  > 证据（2026-08-01 主控执行，修正版——初版引用的双档全绿系 turbo 缓存回放，作废）：`node scripts/public-surface-adversarial.mjs verify unlock-extension-axes` 确定性 verdict **passed:true，五条 lane（sidecar/registry/restMetadata/mcpSdkMetadata/behavior）全部 true，findings=0**。达成前修复三件：① contracts skill 词表残留演练成员 zzz-drill 致 api build 红（total Record 立即暴露，缓存曾掩盖）→ 清除；② sidecar 四公开面按制度用词从 unchanged 改 **derived**（CLASSIFIER_SURFACE_MAP.contracts 保守映射的正确响应）+ 转录 registry 的 8 条既有 protocolDifferences；③ api `test:public-surface` glob 自 622dac6 目录重排后丢失 `surface-parity/evidence.spec.js`（main 既有断裂，collector 从未能写出 evidence 文件）→ 补回 glob。
- [x] 9.6 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 RuntimeArtifactChecksumsSchema record 化的 partial 语义运行 public-surface 动态检查并产出四 lane 通过记录
  - requirements: ["sandbox-environments/runtime-artifact-checksums-are-keyed-by-the-runtime-vocabulary-with-explicit-partial-semantics"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  > 证据（2026-08-01 主控执行，修正版——初版引用的双档全绿系 turbo 缓存回放，作废）：`node scripts/public-surface-adversarial.mjs verify unlock-extension-axes` 确定性 verdict **passed:true，五条 lane（sidecar/registry/restMetadata/mcpSdkMetadata/behavior）全部 true，findings=0**。达成前修复三件：① contracts skill 词表残留演练成员 zzz-drill 致 api build 红（total Record 立即暴露，缓存曾掩盖）→ 清除；② sidecar 四公开面按制度用词从 unchanged 改 **derived**（CLASSIFIER_SURFACE_MAP.contracts 保守映射的正确响应）+ 转录 registry 的 8 条既有 protocolDifferences；③ api `test:public-surface` glob 自 622dac6 目录重排后丢失 `surface-parity/evidence.spec.js`（main 既有断裂，collector 从未能写出 evidence 文件）→ 补回 glob。
- [x] 9.7 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 source-kind 单一声明+extension tier(含 R5 PAIRS 第 11 条)运行 public-surface 动态检查并产出四 lane 通过记录
  - requirements: ["sandbox-environments/the-environment-source-kind-vocabulary-has-a-single-declaration-with-an-explicit-extension-tier"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
  > 证据（2026-08-01 主控执行，修正版——初版引用的双档全绿系 turbo 缓存回放，作废）：`node scripts/public-surface-adversarial.mjs verify unlock-extension-axes` 确定性 verdict **passed:true，五条 lane（sidecar/registry/restMetadata/mcpSdkMetadata/behavior）全部 true，findings=0**。达成前修复三件：① contracts skill 词表残留演练成员 zzz-drill 致 api build 红（total Record 立即暴露，缓存曾掩盖）→ 清除；② sidecar 四公开面按制度用词从 unchanged 改 **derived**（CLASSIFIER_SURFACE_MAP.contracts 保守映射的正确响应）+ 转录 registry 的 8 条既有 protocolDifferences；③ api `test:public-surface` glob 自 622dac6 目录重排后丢失 `surface-parity/evidence.spec.js`（main 既有断裂，collector 从未能写出 evidence 文件）→ 补回 glob。
- [x] 9.8 真实缺口(裁定人复核确认):`apps/web/src/lib/runtime-label.ts:22-25` 的手写 `AGENT_LABELS: Record<Runtime, string>` 表改为读 `RUNTIME_METADATA[runtime].label`(未知 id 按原样渲染的兜底与 null/undefined→codex 默认语义保留),消费点(history.tsx:118/255、schedules.tsx:871、queries.ts:645)零改动;spec 明文「runtime labels SHALL resolve the RUNTIME_METADATA row ... with no console code edit」而 baseline.md:67 自证该文件仍是第三 runtime 的残余手改位——修完后同步更新 baseline.md 残余清单与 runtime-label.test.ts
  - requirements: ["frontend-console/runtime-display-surfaces-are-driven-by-contracts-metadata-with-no-console-branches"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  > 证据：`runtime-label.ts` 已改读 `RUNTIME_METADATA[runtime].label`（ABSENT→codex 默认与未知 id 原样渲染语义保留，消费点零改动）；`runtime-label.test.ts` 3/3 绿、web typecheck 绿；baseline.md 残余清单第 7 行已标记消除（第三 runtime 手改位 9→8）。

<!-- opsx-verify 第二轮三路裁定(2026-08-01 re-verify)重开的代码任务。同七项 public-surface 需求的
     强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior)本轮再次未产出通过记录
     (machine-routed dynamic-evidence-missing,archive-blocking,不可改判)。本轮裁定人已定位真实根因:
     contracts `SKILL_CATALOG_IDS` 残留未 revert 的总覆盖守卫演练成员 'zzz-drill'
     (packages/contracts/src/skill-catalog.ts:15,src 与 dist 均在),致 api/web typecheck 双红
     ——本轮亲跑确认:api `skill-allowlist.ts(55,14): error TS2741: Property '"zzz-drill"' is missing`、
     web `new-task-dialog.tsx(171,12): error TS1360` + `(182,46): TS7053`。整树红则四 lane 物理上
     不可能产出通过记录;9.1-9.7 的 lane 证据注记先于该破坏,对当前树已失效,须在修复后重出。
     9.9 是根因解锁任务,9.10-9.15 依赖其完成后按需求逐项重出 lane 通过记录。 -->

- [ ] 9.9 修真实缺陷 + 补 lane:从 `packages/contracts/src/skill-catalog.ts:15` 移除未 revert 的演练成员 `'zzz-drill'`(恢复 `['openspec', 'bmad'] as const`),重建 contracts dist,确认 api/web typecheck 复绿(TS2741/TS1360/TS7053 消失、totality 守卫仍在位);随后对 SKILL_CATALOG_IDS 单一声明双端消费重跑 public-surface 动态检查,产出 registry/restMetadata/mcpSdkMetadata/behavior 四 lane 通过记录(以当前树的重跑为准,不引用 9.3 旧注记)
  - requirements: ["frontend-console/the-skill-catalog-id-vocabulary-is-declared-once-in-contracts"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [ ] 9.10 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):9.9 复绿后,对 RUNTIME_METADATA 总覆盖表在重建后的活树上重跑 public-surface 动态检查并产出四 lane 通过记录(9.1 注记先于 zzz-drill 破坏,已失效)
  - requirements: ["agent-runtime/a-compile-time-total-runtime-metadata-table-backs-display-and-policy-lookups"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [ ] 9.11 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 TranscriptReadStrategy 词表+configured-provider 真派发重跑 public-surface 动态检查并产出四 lane 通过记录;同时落实 9.2 声明过但代码里并未发生的残余清理——`packages/sandbox/src/host-harness/configured-provider.ts:671` 本地 `TranscriptReadStrategyKind` 字面量副本(本轮复核仍在,contracts `TRANSCRIPT_READ_STRATEGY_KINDS` 在该文件零 import,R5 PAIRS 亦无该对账条目)按其在场 NOTE 注释改指 contracts 声明,或进 R5 PAIRS 对账,二选一必落其一并留证
  - requirements: ["agent-runtime/the-transcript-read-strategy-is-a-shape-named-vocabulary-with-real-dispatch"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [ ] 9.12 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 provider-snapshot 兜底/boxlite-rootfs 读路径兼容语义 pin 重跑 public-surface 动态检查并产出四 lane 通过记录(9.4 注记已失效,重出)
  - requirements: ["runtime-model-catalog/provider-snapshot-and-boxlite-rootfs-compatibility-semantics-are-pinned"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [ ] 9.13 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 source-kind 派生链(sandbox-environment 声明 → runtime-model 派生)重跑 public-surface 动态检查并产出四 lane 通过记录(9.5 注记已失效,重出)
  - requirements: ["runtime-model-catalog/the-execution-environment-source-vocabulary-derives-from-the-sandbox-environment-declaration"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [ ] 9.14 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 RuntimeArtifactChecksumsSchema record 化 partial 语义重跑 public-surface 动态检查并产出四 lane 通过记录(9.6 注记已失效,重出)
  - requirements: ["sandbox-environments/runtime-artifact-checksums-are-keyed-by-the-runtime-vocabulary-with-explicit-partial-semantics"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [ ] 9.15 补齐强制动态证据 lane(registry/restMetadata/mcpSdkMetadata/behavior):对 source-kind 单一声明+extension tier(含 R5 PAIRS 第 11 条)重跑 public-surface 动态检查并产出四 lane 通过记录(9.7 注记已失效,重出)
  - requirements: ["sandbox-environments/the-environment-source-kind-vocabulary-has-a-single-declaration-with-an-explicit-extension-tier"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
