# Research Brief — enforce-boundaries-from-manifest

三路并行调研（Web 生态 / Codebase 现状 / Archive 先例）的综合简报。每条发现标注路由与编号（W=Web、C=Codebase、A=Archive），供 proposal/design/tasks 引用溯源。

---

## Route: Web（生态与工具调研）

### 现成的 manifest 驱动边界工具（build-vs-buy 语料）

- **W1 — eslint-plugin-boundaries 是「数据 + 通用规则」范式的最近样板**：一个 settings 块（`boundaries/elements`）把文件分类为 element 类型/层，通用规则（element-types / external / entry-point）解释这份数据——意味着 A 表 manifest 可以投影成一个 settings 对象喂给现成规则，而不是生成一堆 no-restricted-imports 片段。
  证据：https://github.com/javierbrea/eslint-plugin-boundaries 、https://www.jsboundaries.dev/docs/quick-start/
  关联：工作项 (2) 的设计备选——「数据 + 通用规则」优于「生成规则片段」（更少的生成器代码需要过 gate canon，IDE 标红免费，flat-config 兼容）；写自定义生成器前值得先评估。

- **W2 — Nx @nx/enforce-module-boundaries 证明了 per-project tag（单一声明）+ 单条 ESLint 规则读 depConstraints 的模式**（sourceTag → onlyDependOnLibsWithTags）；约束 AND 组合，且该规则同时检查 package.json deps 而非只查 TS import。
  证据：https://nx.dev/docs/technologies/eslint/eslint-plugin/guides/enforce-module-boundaries
  关联：P1–P8 包级规则的业界标准参考架构；其 tag 词表（scope:/type:）可作 boundaries-manifest 条目的命名模板；也说明完整边界故事包含 package.json 依赖检查，不止 import 语句。

- **W3 — Turborepo Boundaries（2.4.2+，2026 年仍 experimental）在 turbo.json 里做 tag 化 allow/deny（含传递依赖），但纯 CLI（`turbo boundaries`）无 IDE 集成**。
  证据：https://turborepo.dev/docs/reference/boundaries 、https://turborepo.dev/blog/turbo-2-4
  关联：仓库已用 turbo，这可以是 P1–P8 近乎免费的额外 CI 兜底；但它的 CLI-only 性质恰好验证本 change 的核心前提——IDE 即时反馈的验收判据必须靠 ESLint，别指望 turbo 取代生成器。

- **W4 — Sheriff（@softarc/sheriff-core + eslint-plugin-sheriff）是「一份规则源、两个执行器」的直接先例**：单一 sheriff.config.ts 同时驱动 ESLint 插件（IDE 反馈）和独立 CLI 校验器（CI 全量扫描），正是元规则 4 要求的生成器 vs 独立解释器分离。
  证据：https://github.com/softarc-consulting/sheriff 、http://sheriff.softarc.io/docs/module_boundaries
  关联：验证了拟议架构（manifest → ESLint 片段 + 独立 CI 解释器）是既定模式；也是候选库，但其 TS 配置格式与本 change 要求的 JSON manifest + change 留痕需要适配。

- **W5 — good-fences（微软出身）开创了 per-directory 机器可读 JSON 边界 manifest**：fence.json（tags/exports/dependencies）由独立于 ESLint 的 checker 执行。
  证据：https://github.com/smikula/good-fences/blob/master/README.md
  关联：boundaries-manifest 用 JSON 做声明源（而非代码配置）有先例；其分布式 per-directory 布局是拟议单一中心文件的反设计——分布式 fence 让架构决策在 review 里不可见，恰好论证了本 change「单一声明源 + change 留痕」的正当性。

- **W6 — dependency-cruiser 是标准的独立 CI 兜底**：与 ESLint import 插件同领域的规则，但独立解释器、对 eslint-disable 注释免疫；生态文章明确推荐两者并跑（ESLint 管编辑器即时红线、dep-cruiser 管 CI 整体校验）；且支持 'required' 规则断言某条边必须存在。
  证据：https://xebia.com/blog/taking-frontend-architecture-serious-with-dependency-cruiser/ 、https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md
  关联：精确命中工作项 (3) 的防 eslint-disable 逃逸需求；其 'required' 规则也是 R9 存在性断言（seam 文件必须存在且被 import）的先例；可作为 CI 解释器的生成目标——但手写 manifest 解释器对元规则 4（不得二次内嵌规则数据）更干净。

### Ratchet / 豁免 / 渐进收紧机制

- **W7 — ESLint v9.24.0（2025）原生 bulk suppressions**：--suppress-all/--suppress-rule 写出 eslint-suppressions.json（per-file per-rule 违规计数）；计数只允许减少（修了违规但没删条目会报 unused suppressions 而红），内建单向 ratchet（TikTok 工程贡献）。
  证据：https://eslint.org/blog/2025/04/introducing-bulk-suppressions/ 、https://eslint.org/docs/latest/use/suppressions
  关联：S2 已知旁路（api-stream-panel.tsx / session-cast-log.tsx）ratchet 的直接备选：规则开 error、suppress 两个存量文件，ESLint 自己执行 ratchet——但它只覆盖 ESLint 侧规则，layout v2 报告模式基线仍需 scripts/ratchets comparator；change 须逐规则拍板由哪套 ratchet 机制拥有，避免双重记账。

- **W8 — Betterer 与 eslint-seatbelt 是既定的 ratchet 先例**：Betterer（快照基线测试跑器：回归即败、改进自动收紧、归零后规则转入常规 lint）与 eslint-seatbelt（'starts loose, only gets tighter'），都用提交入库的基线文件在 CI 比对。
  证据：https://charpeni.com/blog/enforce-best-practices-incrementally-with-betterer 、https://github.com/justjake/eslint-seatbelt
  关联：确认 layout v2 计划的 ratchet 基线生命周期（报告模式 → 基线数字 → 阶段 6 转 required）是被证明过的迁移路径；Betterer 的「计数归零后规则并入常规 lint」正是阶段 3→6 的毕业故事，值得在 design 里引用。

### 具体规则的实现机制

- **W9 — @typescript-eslint/no-restricted-imports 有 allowTypeImports 选项**（默认 false）：允许 `import type` 而禁值 import（含 type-only re-export）。
  证据：https://typescript-eslint.io/rules/no-restricted-imports/
  关联：P6（sandbox-core 只可 type-only import contracts）的精确机制：生成器在 sandbox-core 作用域为 contracts 路径 emit 带 allowTypeImports:true 的该规则——无需自定义规则；CI 解释器必须复刻 type-only 区分（检查 import kind，不只看 specifier）。

- **W10 — import/no-restricted-paths 'zones'（target/from/except/message）是 eslint-plugin-import 的目录级分层限制标准形态**，但有文档化 caveat：zone 配置不经 resolver 设置不解析 tsconfig path alias。
  证据：https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/no-restricted-paths.md 、https://github.com/import-js/eslint-plugin-import/issues/1872
  关联：A 表规则的候选生成目标之一；alias 解析 caveat 很关键——本仓用 @cap/* 包名 import workspace 包，生成器应 emit 包名 pattern（no-restricted-imports patterns）而非文件系统 zones，绕开 resolver 脆弱性。

- **W11 — no-restricted-syntax 接受 esquery selector**（如 `CallExpression[callee.name='fetch']`、`NewExpression[callee.name='WebSocket']`），flat-config per-file 作用域可豁免两个 transport 文件；已知局限：一条 eslint-disable-next-line 会同时禁掉该规则的全部 selector（ESLint open issue #19463）。
  证据：https://eslint.org/docs/latest/rules/no-restricted-syntax 、https://github.com/eslint/eslint/issues/19463
  关联：S1（web 出网只经 real.ts/ws-client.ts）实现为发现式检测而非文件枚举；disable 粒度局限反过来强化了「无视 disable 注释的独立 CI 扫描器」的必要性；另注意 selector 抓不到 alias/window.fetch 拼法——扫描器应覆盖这些变体。

- **W12 — @eslint-community/eslint-plugin-eslint-comments 提供 no-unlimited-disable（禁裸 eslint-disable）、require-description（每条 directive 强制 '-- reason'）、no-restricted-disable（禁止 disable 特定规则，例如边界规则本身）**。
  证据：https://eslint-community.github.io/eslint-plugin-eslint-comments/rules/no-unlimited-disable.html 、https://eslint-community.github.io/eslint-plugin-eslint-comments/rules/require-description.html
  关联：补足工作项 (3)：除了 CI 侧外扫 disable 逃逸，no-restricted-disable 还能让边界规则在 IDE 里就不可 disable；require-description 是注释层面的元规则 2 式豁免登记。

### 架构测试 / 豁免治理先例

- **W13 — ArchUnitTS 默认在文件匹配 pattern 命中零文件时判失败（'empty test detection'）**；ArchUnitTS 与 ts-arch 都把层方向与循环规则写成普通测试框架用例（fitness functions）。
  证据：https://github.com/LukasNiessen/ArchUnitTS 、https://github.com/ts-arch/ts-arch
  关联：外部验证了本 change 的 gate canon 要求（空扫描即败在 ArchUnit 谱系里是一等特性，不是奇怪的要求）；layout v2 的检查（interface→application→domain/store 层方向、Prisma 只在 *.store.ts）与 ArchUnit 式「X 中的文件只能依赖 Y」断言 1:1 对应——如果偏好测试式解释器而非专用脚本。

- **W14 — Vercel Conformance 是全仓多文件检查（本地 + CI 双跑）的生产级先例**：allowlist 文件（.allowlists/<RULE>.allowlist.json）每条带 testName + reason + location 三字段，且 allowlist 文件本身由 CODEOWNERS 审批把关。
  证据：https://vercel.com/docs/workflow-collaboration/conformance/allowlist 、https://vercel.com/blog/introducing-conformance
  关联：S1 三字段豁免设计的近乎精确先例（他们的条目 schema 就是三字段），也印证把豁免编辑变成有 owner、经 review 的架构决策——与本 change「manifest 修改=架构决策须 change 留痕」同构；Google Aurora 的 severity 分级构建完成与 report-mode→required 是同一升级模型。

- **W15 — 没有专门的「Prisma 只在 repository 层」插件**；社区做法就是对 @prisma/client 上普通 no-restricted-imports、用 flat-config 文件 glob 定作用域（全域禁、豁免 *.store.ts），只有小众自定义规则（如 enum-import 限制）。
  证据：https://dev.to/kzuraw/eslint-rule-to-restrict-imports-4a4p 、https://www.npmjs.com/package/@v2nic/eslint-plugin-prisma
  关联：确认 layout v2 的 Prisma 位置检查没有库捷径——基于 contexts-manifest.json 的报告模式脚本是正确的自建路径；IDE 侧等价物（阶段 6）是可平凡生成的作用域化 no-restricted-imports 块，所以 manifest schema 现在就应编码 per-rule 的「allowed file glob」。

- **W16 — 生态里没有从外部 JSON 架构 manifest 生成 ESLint flat-config 的既定工具**；最近的先例都是插件内的 config-as-data（boundaries settings、Nx tags、Sheriff config）——flat config 是普通 JS，仓内小生成器（或 lint 启动时直读 JSON 的共享 config）是常规做法。
  证据：https://eslint.org/docs/latest/use/configure/configuration-files（flat config 是可执行 JS；多轮搜索未见 manifest-generator 标准）
  关联：给工作项 (2) 的 build-vs-buy 定案：自建有正当性，且更轻的选项——@cap-console/eslint-config 在加载时直接 import docs/refactor/boundaries-manifest.json（无 codegen 步骤、无生成片段与源之间的漂移）——以更少机械满足元规则 4。

---

## Route: Codebase（仓内现状核实）

### Change 工件与图纸文档

- **C1 — 变更工件已存在但仅有元数据**：openspec change `enforce-boundaries-from-manifest`（created 2026-08-01）只有 .openspec.yaml 与 surface-impact.json，其 internalOnly.scope 与任务陈述逐条对应（manifest JSON→ESLint 生成器→同源闸门→layout v2 报告→R9/R10），无 proposal/tasks/specs。
  证据：openspec/changes/enforce-boundaries-from-manifest/surface-impact.json（internalOnly.scope 段）；同目录 .openspec.yaml
  关联：change 已被建目录且 surface-impact 定稿为 developer-workflow/runtime unchanged；提案工作在此 change 内续写而非新建。

- **C2 — 图纸文档全部定稿在位**：工件02 的 A 表 P1–P8（14-23 行）、C 表 S1–S3（33-37 行）、D 表 4 个安全 seam（43-48 行）、E 节 CLAUDE.md 对账（53-59 行）、F 节生成物拓扑与『生成器与闸门不得各自内嵌规则数据』元规则（61-71 行）。P3/P7/S3 三行已标 ✅ 落地（close-gate-blindspots），manifest JSON 落地位置文档自述『阶段 3 第一个 change 内落地，内容以本文档的表为准』（7-8 行）。
  证据：docs/refactor/02-boundaries-manifest.md:10-71
  关联：规则内容零发明——JSON 只是这些表的机器可读化；已落地的 P3/P7/S3 应收编引用（表内已写明执行器路径）。

- **C3 — 母计划阶段3定义与验收原文**：manifest→ESLint 生成器+同源 CI 闸门（R1/R2）、S1/S2 seam 规则（存量直连组件进 ratchet）、layout-check v2 雏形报告模式建 ratchet 基线；验收=『IDE 里写 web→api import 立即标红；layout v2 报告出存量清单与数字』。阶段7b 明言 lib/api 归拢的防回流规则将来接入本阶段的 ESLint 生成器（192 行）。
  证据：docs/refactor-master-plan.md:115-125,186-193
  关联：验收判据与向后兼容点（7b 会复用生成器）直接决定生成器的可扩展设计。

- **C4 — 工件04 元规则五条与规则预登记表**：发现式/豁免默认空带 tracking/空扫描即败模板 run-suite.mjs:86-89/单一声明/fail-closed；R1（工件02 A 表→ESLint 生成器+CI 同源闸门，阶段3）、R2（C 表同上）、R7（contexts-manifest.json→layout v2，3 报告/6 拦截）、R9（D 表→seam 存在性断言）、R10（E 节→对账脚本）；D 节定义 ratchet 通用机制（基线 scripts/ratchets/<rule-id>.json 三字段、归零删文件）。新规则 change 必须同时更新 C 表登记。
  证据：docs/refactor/04-rules-registry.md:8-18,54-63,67-76,28
  关联：本 change 的准入标准与交付清单（含更新 04 的 C 表）都在这份登记制里；违反元规则4（各自内嵌规则数据）即不合格。

### Manifest 与既有执行器（收编对象）

- **C5 — contexts-manifest.json（layout v2 唯一输入）已定稿**：version 1、scope=apps/api/src、layers.order=[interface,application,domain,store]+『Prisma 只允许出现在 *.store.ts』（6-7 行）、7 上下文目录映射（10-117 行）、crossContextRules 四种合法形态+prisma/crypto/observability 共享内核豁免（119-131 行）、顶部 $comment 声明『修改本文件=架构决策，须经 change 留痕』。但 manifest 未定义文件→层判定规则（*.controller/*.service/*.store 命名映射是 v2 脚本必须拍板的设计决策）。
  证据：docs/refactor/contexts-manifest.json:2-8,119-131
  关联：v2 三类检查（跨上下文/层方向/Prisma 位置）的数据源就绪；文件→层分类是唯一缺口，需在 change 内定义并写进 manifest 或脚本注释。

- **C6 — manifest 驱动闸门的既有范本（S3/G11，收编对象）**：sandbox-package-boundary.test.mjs 从 docs/refactor/contexts-manifest.json 读 scope 做双扫描，fail-closed 三连断言（manifest 缺失/scope 空/目录不存在均红，51-67 行）；符号禁令表 69-98 行；CJK operator-copy 窄豁免+两组 fixture 自测（125-215 行）证明豁免不可扩宽——『配对自测+注入探针』canon 的活样板。
  证据：apps/api/src/sandbox/sandbox-package-boundary.test.mjs:51-67,69-98,125-215
  关联：新 boundaries JSON 的消费方式、fail-closed 姿势、豁免自测模式全部照此复制；且证明 docs/refactor/ 下 JSON 被闸门直读是既成惯例（manifest 位置候选可定 docs/refactor/）。

- **C7 — P7 执行器（收编对象）**：facade-surface.gate.mjs 用 TS AST 量测 packages/sandbox/src/index.ts 导出面，对账 committed expected-facade-surface.json，export * 即红；独立性不变量=测得侧永不再生成期望侧；随 packages/sandbox package.json 的 test script 进 CI。
  证据：packages/sandbox/test/facade-surface.gate.mjs:1-77；packages/sandbox/package.json test script
  关联：boundaries JSON 里 P7 条目应引用该 gate 为执行器，不重复实现；其 measured/expected 分离原则同样适用于 R10 对账。

- **C8 — ratchet 共享 comparator 已建成且语义定死**：scripts/ratchets/comparator.mjs 的 compareToBaseline（147-190 行）=严格 fail-on-stale（超基线红、低于基线也红须同 PR 缩基线）、count-only 比对、三字段 {count,samples,change} 强制、归零删文件；模块头明文『Later ratchets (R7/R11/S2 in subsequent phases) reuse this comparator unchanged』（52 行）；现存唯一基线 r3.json（5 文件 9 计数）是格式样例。
  证据：scripts/ratchets/comparator.mjs:50-52,147-190；scripts/ratchets/r3.json
  关联：S2 与 layout v2 的 ratchet 直接 import compareToBaseline 建 scripts/ratchets/s2.json、r7-*.json 即可，『不重复实现』有现成执行面。

### ESLint / CI 接入面

- **C9 — ESLint 接入面实测**：全仓恰 14 个 eslint.config.*（13 个 .js + apps/api 的 .mjs），除 apps/www（前置 ignores，20 行）与 release-cache-worker（8 行）外全部是三行 `import config from "@cap-console/eslint-config"; export default config;`；共享配置 packages/eslint-config/index.js 共 54 行仅一条自定义规则（no-unused-vars，46-51 行），且 ignores 含 `**/*.config.js`（21 行，配置文件自身不被 lint）。eslint ^9.27（flat config）为各包 devDependency（15 个 package.json 引用）。
  证据：packages/eslint-config/index.js:15-54；apps/web/eslint.config.js（3 行）；apps/www/eslint.config.js
  关联：单点接入=在共享包内加读 manifest JSON 的规则工厂即可覆盖 14 处；但 per-package 规则差异（P1 只约束 web、P2 只约束 api）要求工厂按消费包身份分发——flat config 的 files glob 相对消费包目录解析，共享函数需以包名/目录为参数。

- **C10 — pre-commit 回路已通**：.husky/pre-commit → lint-staged → `pnpm exec turbo run lint`（lint-staged.config.mjs 注释详述：eslint 是 per-package devDep 不 hoist、flat config cwd-scoped，故必须经 turbo 逐包跑）。生成的规则一旦进共享 config 即自动获得 IDE+pre-commit 双回路，无需新 hook。
  证据：lint-staged.config.mjs:24-37；.husky/pre-commit
  关联：验收『IDE 即时标红+pre-commit lint 生效』的接线成本≈0，前提是规则进各包自己的 flat config 链。

- **C11 — turbo 缓存陷阱**：turbo.json 的 lint task 有缓存（outputs:[] 但未 disable cache），globalDependencies 只有 packages/tsconfig/**/*.json 与 **/.env——docs/refactor/*.json 不在任何包默认 inputs 内。若生成器在 config 加载时读 docs/refactor/ 下的 manifest，改 manifest 后 turbo lint 会命中旧缓存静默不重跑。需把 manifest JSON 加进 globalDependencies 或各包 lint inputs（memory 亦记过『turbo.json 失效的 globalDependencies』前科，master-plan 阶段1 卫生项 87 行）。
  证据：turbo.json:4,15-18；docs/refactor-master-plan.md:87
  关联：不处理则『manifest 改了 lint 却绿』——正是本 change 要消灭的假安全感，属必须写进 tasks 的接线项。

- **C12 — 同源 CI 闸门的落点模式**：根 package.json 的 `test:X` 全部是 `node scripts/X.mjs && node --test scripts/X.test.mjs` 配对自测 canon；ci.yml 的 required job `typecheck + lint + test`（237-238 行 name）内逐 gate 显式 step（279-348 行），另有 test:scripts 扫描步（380 行）按 glob 发现 scripts/*.test.mjs 与 scripts/ratchets/*.test.mjs。往该 job 内加新 step 不改 job name，即满足约束『CI check 显示名不动』（required contexts 现值与消费方清单见 04-rules-registry F.1）。
  证据：.github/workflows/ci.yml:237-238,279-348,376-380；package.json test:scripts；docs/refactor/04-rules-registry.md:98-113
  关联：新增 boundaries 解释器/layout v2/R9/R10 四个脚本按此模式落 scripts/ + 根 script + job 内 step，零协调变更风险。

### 规则逐条现状核实

- **C13 — R1 现状核实：全绿起步成立**：P5=packages/contracts 依赖仅 cron-parser+zod；P6=sandbox-core dependencies 为空（contracts 仅 devDep），全包对 contracts 只有一处 import 且已是 `import type`（packages/sandbox-core/src/provider.ts:8-12，文件注释自述值 import 会拖入 zod）；P8=apps/www dependencies 无任何 @cap-console/* runtime 包；P1/P2 依赖白名单由 apps/web/CLAUDE.md:8-14（contracts·ui，『It cannot reach apps/api』）与 apps/api/CLAUDE.md 散文声明，实测无越界 import。
  证据：packages/sandbox-core/src/provider.ts:8-12；packages/contracts/package.json；apps/www/package.json；apps/web/CLAUDE.md:8-14
  关联：R1 规则落地即绿无需 ratchet；P6 的 type-only 守护可用 @typescript-eslint 版 no-restricted-imports 的 allowTypeImports 单条覆盖。

- **C14 — S1 发现式扫描的真实存量比『零』多**：除钦定 seam（real.ts 5 处 fetch:309,348,485,579,988；ws-client.ts:147 new WebSocket）外，web src 还有 7 个出网调用点——lib/mock-session.ts:184,213,240,291,315（5 处 fetch，auth mock 侧）、components/auth/admin-reveal-modal.tsx:51、components/shell/update-banner.tsx:298。G8 闸门 console-request-header-cors-check.mjs:44-47 硬编码 CONSOLE_TRANSPORTS=[real.ts, ws-client.ts] 正是 S1 要背书的枚举（工件02 C 表 S1『CORS 闸门的枚举依赖此规则』）。
  证据：grep 实测 apps/web/src；scripts/console-request-header-cors-check.mjs:44-47
  关联：S1 落地要么给这 7 处三字段豁免/ratchet，要么先归拢——proposal 必须盘这份清单，否则规则首跑即红；G8 枚举与 S1 的关系（枚举被发现式扫描背书）要写进设计。

- **C15 — S2 存量精确核实**：已知两旁路确在——api-stream-panel.tsx:28（import streamApiEvents from @/lib/api/real）与 session-cast-log.tsx:31-33（getSessionCast+错误分类器）；但组件层直接 import real.ts 的文件共 10 个，其余 8 个多为类型/错误分类器（app-error.tsx:23 的 ApiError、new-task-dialog.tsx:56 的 type CreateTaskBody、runtime-model-selector.tsx:9 的 runtimeModelErrorFromApiError 等）。规则若不区分『数据获取函数』vs『类型/错误分类器』，ratchet 基线将是 10 而非工件07 §C 预估的 ≥2。
  证据：apps/web/src/components/api/api-stream-panel.tsx:28；apps/web/src/components/session/session-cast-log.tsx:31-33；grep 全量 10 文件清单；docs/refactor/07-baselines-and-dependencies.md:49
  关联：S2 规则的谓词设计（禁函数 import、放行 type-only 与错误分类器？还是全禁进 ratchet？）是 proposal 必拍板的决策，基线数字随之变化。

- **C16 — S2 的正向 seam 锚**：apps/web/src/lib/api/capabilities.ts 文件头自述『the SINGLE real/mock switch point…queryFn is the only place real-vs-mock is chosen』（rebuild-console-tanstack-start D5），即规则的口头承诺已在代码注释里，只缺机制。
  证据：apps/web/src/lib/api/capabilities.ts:1-21
  关联：S2 规则文案可直接引用该注释为规范出处，闸门断言与文档承诺同源。

- **C17 — layout v2 报告的现实基数**：apps/api/src 现仅 1 个 *.store.ts（task-admission/prisma-task-admission.store.ts，阶段5 钦定模板）；粗测 60 个非测试文件在 store 层/prisma 目录外 import PrismaService/@prisma/client（工件07 §C 快照为 260 处/45 文件、跨上下文 .service import 112 处，07 §E 明言开工第一个 task 必须重测并回写工件07）。v1 闸门 api-module-layout-check.mjs（GOVERNED=[apps/api/src,@/]:31、ALLOWED_CYCLES=[]:40）继续跑在 ci.yml:338-339，v2 是新增独立脚本不动它。
  证据：apps/api/src/task-admission/prisma-task-admission.store.ts；scripts/api-module-layout-check.mjs:31,40；docs/refactor/07-baselines-and-dependencies.md:46-49,70-71
  关联：v2 报告模式的 ratchet 基线数字须以重测为准（并按 07 §E 回写）；v1/v2 并行关系已在任务与 G7 登记行明确。

- **C18 — R9 四个安全 seam 全部实存且有锚定测试**：request-origin.ts:1-21 注释自称 the ONE computation（配 request-origin.spec.ts，消费方 auth.guard/origin-checked-ws-adapter 同目录在位）；rest-session-validation.spec.ts（apps/api/src/auth/）与 ws-session-validation.spec.ts（apps/api/src/terminal/）以 spec 需求原文锚定统一入口；assertSafeProviderUrl 定义于 apps/api/src/settings/assert-safe-provider-url.ts、由 forge/forge-no-ssrf-gate.spec.ts 锚定、10 文件消费；凭据加密读取 helper=apps/api/src/crypto/secret-storage.ts（decryptStored:79/encryptToStored:66/storeMaybeEncrypted:102），7 个非测试消费文件。
  证据：apps/api/src/auth/request-origin.ts:1-21；apps/api/src/settings/assert-safe-provider-url.ts；apps/api/src/crypto/secret-storage.ts:66-102；apps/api/src/terminal/ws-session-validation.spec.ts:1-20
  关联：『文件存在+唯一实现 grep』断言的四个目标路径与唯一性谓词（如 decryptStored 只此一处定义）可直接落成数据条目进 boundaries JSON。

- **C19 — R10 有结构性缺口**：4 份 CLAUDE.md 中只有 apps/api（含 devDep 例外散文）与 apps/web:8 有『## What this subtree may depend on』标题段；packages/contracts 与 packages/sandbox 的 CLAUDE.md 无此段（contracts 只有反向 'Depended on by:' 散文，sandbox 标题为 invariant/Where/Verifying）。易腐数字三处：apps/api/CLAUDE.md:4『454 source files』、apps/web/CLAUDE.md:4『261 source files』、packages/contracts/CLAUDE.md:3『45 modules』。
  证据：grep '^#' packages/contracts/CLAUDE.md 与 packages/sandbox/CLAUDE.md；apps/api/CLAUDE.md:4；apps/web/CLAUDE.md:4,8
  关联：R10 对账闸门落地前必须先给两份 CLAUDE.md 补该段落（本 change 顺手做），且解析器对『段落缺失』要 fail-closed 而非跳过；数字降约数的三处清单已定位。

### Gate canon 与防逃逸机制

- **C20 — gate canon 三件套在仓内均有可复制模板**：配对自测=根 scripts 的 `node X.mjs && node --test X.test.mjs` 模式+test:scripts glob 兜底发现；注入探针=sandbox-package-boundary 的 fixture 自测（125-215 行，负向 fixture 证豁免不可扩宽）与 04-registry G2 行『注入探针红证已记 tasks.md』先例；空扫描即败=run-suite.mjs:88-91（glob 命中 0 即 exit 1，元规则 A.3 指名的模板）。
  证据：scripts/run-suite.mjs:88-91；apps/api/src/sandbox/sandbox-package-boundary.test.mjs:125-215；docs/refactor/04-rules-registry.md:13-14,37
  关联：验收『全部新闸门 gate canon』的具体形态照抄这三处即可，verify 时也会按这三件套对抗。

- **C21 — 『扫描器对 eslint-disable 不豁免』天然成立于架构**：CI 兜底解释器是独立 node 脚本做文本/AST 全量扫描（同 sandbox-package-boundary 模式），根本不经 ESLint 管线，disable 注释对它不可见；ESLint 侧 disable 逃逸只影响 IDE/pre-commit 回路，兜底闸门按同一 JSON 重扫即抓回。
  证据：apps/api/src/sandbox/sandbox-package-boundary.test.mjs（walk+正则扫描实现，220 行起）；docs/refactor/02-boundaries-manifest.md:63-71（双消费拓扑）
  关联：『防 eslint-disable 逃逸』的机制论证：独立解释器即防线，无需在 ESLint 内禁 disable 注释。

---

## Route: Archive（先例 change 复盘）

- **A1 — change 目录与 sidecar 形状已预决定**：openspec/changes/enforce-boundaries-from-manifest/ 已存在（仅 surface-impact.json，internalOnly.scope 与本提案逐字对应）。不要另起 change 名；工件填进这个目录。opsx-verify 需要该 sidecar，close-gate-blindspots task 8.14 显示 verify 时会逐面审计它。
  证据：openspec/changes/enforce-boundaries-from-manifest/surface-impact.json
  关联：proposal/design/specs/tasks 必须落在既有目录，且声明不得与最终 diff 矛盾。

- **A2 — 最近的结构模板是 2026-07-31-close-gate-blindspots-and-ci-hygiene**：proposal 以主干实测基线（commit 钉住的计数）开篇、显式 Not-in-scope 点名后续阶段；tasks.md 按 track 注解，并行 track + 一个 SERIAL integration track 持有共享文件（ci.yml、根 package.json、docs/refactor 登记表）的全部写者——这是他们三个草稿 track 在 ci.yml 上相撞后在文件头记录的分区修正。
  证据：openspec/changes/archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/proposal.md；tasks.md 1-13 行（分区修正说明）
  关联：本 change 触碰 14 个 eslint.config.*、ci.yml、docs/refactor 登记表——同样的共享文件碰撞风险；照抄并行 track+integration track 分区，把所有 eslint.config 写者与登记表翻转放进 integration track。

- **A3 — 验收引用的 'gate canon' 由 close-gate-blindspots task 8.15 完整规定**：(a) 配对自测可用 `node <script> && node --test <script>.test.mjs` 调起；(b) 可 review 的例外数据、每条三字段 {reason/owner/change}；(c) 空清单健康但空扫描即红；(d) 每个 gate 一个注入探针 task，红跑证据记进 tasks.md 后回滚（他们的 tasks 2.6、3.6、4.3、4.6 是范式：探针→gate exit 1 点名 file:line→回滚→绿）。
  证据：archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/tasks.md tasks 2.6,3.6,4.3,4.6,8.15
  关联：本 change 每个新 gate（ESLint 生成器同步检查、CI 解释器、layout v2、R9 存在性断言、R10 CLAUDE.md 对账）都必须交付这个形状；验收里的『gate canon（配对自测+注入探针+空扫描即败）』就是在引用他们的词汇。

- **A4 — ratchet 机制可复用且消费模式已证明**：scripts/ratchets/comparator.mjs + comparator.test.mjs + r3.json 已在 main；条目 {count, samples[], change} 只按 COUNT 比对；双向严格 fail-closed（新违规红且 stale 条目也红、同 PR 缩、归零删文件）；消费方 import compareToBaseline/readBaseline——close-gate task 3.4 证据明说 'no re-implemented comparison loop' 与 'no-baseline-present = zero tolerance'。基线文件遵循工件04§D `<rule-id>.json` 命名。
  证据：scripts/ratchets/{comparator.mjs,comparator.test.mjs,r3.json}；archive/.../tasks.md tasks 1.1-1.4,3.3-3.4
  关联：S2 旁路 ratchet 与 layout-v2 基线应是新的 <rule-id>.json、经 import 消费——comparator 规格甚至预告了这一点：'R7/R11/S2 ratchets in later phases reuse it'。

- **A5 — manifest 消费先例已在代码里**：sandbox-package-boundary.test.mjs 从 docs/refactor/contexts-manifest.json 解析扫描根、fail-closed 语义（manifest 缺失→红 'cannot fall back to hardcoded paths'、scope 空→红、零文件 walk→红）；facade-surface.gate.mjs（P7）保有 committed 期望数据、永不从测得侧再生成（--print-measured 流入 reviewed diff 而非回写）。
  证据：archive/.../tasks.md tasks 3.5,2.4；docs/refactor/contexts-manifest.json 存在
  关联：『(1) manifest 落地』与『P3/P7/S3 收编引用而非重复实现』的直接模板：boundaries-manifest JSON 应以同样方式被消费（闸门直读、永不回退），且 ESLint 生成器的输出绝不能是 CI 解释器的读取对象——两者各自独立读 manifest（元规则4）。

- **A6 — close-gate-blindspots 的 research-brief 已做过本 change 需要的外部调研**：ESLint v9.24 bulk suppressions 被选为严格 fail-closed ratchet 变体（胜过 ArchUnit auto-reduce）；边界执行生态调查（Nx enforce-module-boundaries、Sheriff、eslint-plugin-boundaries）结论：全树扫描+显式豁免是常态，allowlist 限定扫描范围是反模式。
  证据：archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/research-brief.md 13,18,118 行
  关联：ESLint 生成器设计可引用该 brief 而非重新调研；也验证 S1 的发现式扫描路线（扫全部 web 源找 fetch/WebSocket、豁免显式）优于枚举 transport 文件。

- **A7 — 带存量落 gate 的顺序纪律**：change 开工时活测（计数会漂——close-gate 实测 6 处而非工件写的 5）；量测前先删死文件以免基线吸收它们（其 task 3.1 把 stub 删除排在最前）；提交基线，再扩 scope——'CI never knowingly red'。误报走三分处置并记进证据：改文案 vs 精化 matcher（附 gate 内自测证明真存量仍被抓）vs 基线兜底（task 3.2）。
  证据：archive/.../proposal.md What-Changes R3 bullet；tasks.md 3.1-3.3
  关联：S1 的 fetch/WebSocket 发现式扫描与 layout v2 会撞误报（测试文件、mock、worker 代码）；工件07 §C 的预估（112/260）必须活测重量、不可轻信，然后才提交基线。

- **A8 — 2026-07-29-establish-api-module-layout 是本 change layout v2 所傍的 v1**；其 gate 为 scripts/api-module-layout-check.mjs（pnpm test:module-layout）。两条直接可复用的教训：(a) task 1.4 验证过当时全仓不存在任何 no-restricted-imports/import-order/no-unresolved 规则，生成片段是仓里第一批此类规则、无冲突对象；(b) gate 同时扫 `from '…'` 与动态 `import('…')`，因为真实引用有动态形态——CI 解释器也必须如此。
  证据：archive/2026-07-29-establish-api-module-layout/tasks.md tasks 1.4,6.1
  关联：确认 ESLint 生成器落在白纸上；也为独立 manifest 解释器定下最低解析覆盖（仅 from 子句的扫描在那次被否）。

- **A9 — establish-api-module-layout 还证明：批量机械动工前必须在每条 lane 验证工具链解析**：单文件 tsc harness 不认 tsconfig paths（12 个 harness 而非盘点的 10），被迫中途新建编译 helper。其 design 有意把安置行留白（'decided during implementation with the code in hand'），预填的两行全错（isAdminPrincipal 归属；AuthenticatedRequest 移动制造新环）。
  证据：archive/2026-07-29-establish-api-module-layout/tasks.md tracks 1-2,4.2；design.md D2
  关联：把生成片段接进 14 个 eslint.config.* 之前，先在一个 config 上端到端验证（IDE 红 + pre-commit lint + CI）再扇出；且别在工件里预决定片段并入 @cap-console/eslint-config 还是 per-package——留成带判据的实现期决策行。

- **A10 — 整个 programme 唯一 NOT-ARCHIVABLE 的尸检是 2026-07-30-converge-contracts-rules-that-never-run**：静态追踪全净仍被拦，因为 (a) change 自己声明的验证 lane 从未实际跑过；(b) surface-impact.json 声明四个面 'unchanged' 而 diff 打脸。它也是后续 change 引用的 self-attestation 盲点规则的出处：committed 期望数据与测得数据不得互相引用。
  证据：archive/2026-07-30-converge-contracts-rules-that-never-run/verification-report.md
  关联：避坑第一条：本 change 的 sidecar 已声明 publicV1/mcp/openapi/apiPlayground unchanged——diff 必须严格不进 runtime 代码路径，且 verify 前在集成树上真跑每条声明的 workflow-gates lane；生成器/解释器都从 manifest 派生、绝不互相派生。

- **A11 — 2026-07-29-derive-runtime-vocabulary-from-registration 是单一声明源先例**：runtime 词表的四处散落声明（contract enum、port union、registry、web 文案）收敛为一个 as-const 声明+派生消费方，论证核心是『kept in sync』注释什么都不执行（'that sync is a sentence in a comment; a grep for anything that checks it returns nothing'）。
  证据：archive/2026-07-29-derive-runtime-vocabulary-from-registration/proposal.md
  关联：boundaries-manifest JSON 作为单一声明源（生成器派生 ESLint config、解释器派生 CI gate）的论证模板；R10 同理——把 CLAUDE.md 'What this subtree may depend on' 散文从无查验的 sync-comment 变成被对账的派生物。

- **A12 — 2026-07-31-scope-agent-context-and-document-layout 创建了 R10 要解析的恰好 4 份 CLAUDE.md**（apps/api、apps/web、packages/contracts、packages/sandbox），各带 what-it-may-depend-on 段；其 CI 验证信条是双侧观察（'per job, both that it runs when it should and that it is skipped when it should'），并开创跨 change 任务履行（其 task 3.4 由 close-gate-blindspots 的 PR 作载具执行、两边都记录）。
  证据：archive/2026-07-31-scope-agent-context-and-document-layout/proposal.md；archive/.../close-gate-blindspots tasks.md task 8.12
  关联：R10 的解析目标与段落形状已标准化；双侧证明模式映射到本 change 验收（证明 IDE 标红 且 干净树保持绿）；那些 CLAUDE.md 里易腐的数字正是 proposal 要将其降为约数的原因。

- **A13 — 2026-07-28-close-request-boundary-gaps 创建了 R9 断言的每一个 seam**：request-origin 单一计算复用 WEB_ORIGIN allowlist（'one trusted-origin list, not two'）、WS 握手 origin 校验走同一清单、外加修复前先建复现测试的纪律。『one list, not two』的理由正是 R9 唯一性断言（文件存在+grep 证单一实现）的论证原文。
  证据：archive/2026-07-28-close-request-boundary-gaps/proposal.md
  关联：R9 存在性断言应按落地名引用这些 seam、复用同一 one-source-of-truth 理由；断言闸门便宜（存在性+唯一性 grep）正因为那次 change 已经合并了重复实现。

- **A14 — 要继承的 CI 名称与 flake 纪律**：check 显示名是被消费的 attestation API（release.yml 按精确字符串查询），故 close-gate task 8.8 验证了 ci.yml diff 中每个既有 `name:` 的字节一致性、漂移登记进工件04 §F 而非改名；新的条件化 CI job 必须同 PR 进 scripts/ci-job-conditions.test.mjs 的 CONDITIONED 集；既有 flake 走三分诊（产品缺陷/过时 harness/环境依赖）记工件04 §F，绝不 retry-to-hide——aio 墙钟 flake 被连续五个 change 的记录继承。
  证据：archive/.../tasks.md tasks 8.5,8.8,8.11
  关联：本 change 约束『CI check 显示名不动（总则2）』有已验证的核查配方（git diff | grep name: 字节一致性）；manifest gate 的任何新/改 CI lane 必须同 PR 交付 ci-job-conditions 原子配对。

- **A15 — 登记表记账是 change 自身验收的一部分**：close-gate task 8.13 翻转工件04 C 表与工件02 A/C 表行、每个翻转格写入所属 change 名，并把 docs/refactor 编辑当作 integration-track 工作（共享文件）。登记表在 main 的 docs/refactor/02-boundaries-manifest.md 与 04-rules-registry.md。
  证据：archive/.../tasks.md task 8.13；docs/refactor/ 目录清单
  关联：本 change 必须含翻转 R1/R2/R9/R10 行与所落 P1-P8/S1-S3 登记的 tasks，每格写 enforce-boundaries-from-manifest——且既然 manifest 修改=架构决策须 change 留痕，manifest JSON 的 provenance 字段应像 ratchet 条目带 {change} 一样携带 change 名。

---

## Implications for the proposal

### 1. 消费拓扑定案：manifest 直读，双独立解释器，无 codegen

- 生态里没有『JSON manifest → 生成 flat-config 文件』的标准工具（W16）；flat config 是可执行 JS，最轻方案是 **@cap-console/eslint-config 在加载时直接 import docs/refactor/boundaries-manifest.json**——无生成步骤、无生成物漂移，天然满足元规则 4 的『单一声明』半边。这与 Sheriff 的『一份配置、两个执行器』架构（W4）同构。
- CI 侧兜底是独立 node 脚本按 sandbox-package-boundary 模式（C6）**独立**读同一 JSON 做全量扫描——两个消费者都从 manifest 派生、绝不互相派生（A5、A10 的 self-attestation 盲点规则）。ESLint 输出永不成为解释器输入。
- 防 eslint-disable 逃逸的机制论证已闭合：独立解释器不经 ESLint 管线，disable 注释对它不可见（C21、W6）；eslint-comments 插件（W12）是可选增强而非必需。
- manifest 落点定 docs/refactor/（contexts-manifest.json 已开此先例并被闸门直读，C6），顶部带同款 $comment『修改本文件=架构决策，须经 change 留痕』，条目带 provenance/change 字段（A15、W14）。

### 2. 逐规则机制选型（design 决策表素材）

- **P1–P8 包级规则**：emit 包名 pattern 的 no-restricted-imports，而非文件系统 zones——绕开 @cap/* alias 的 resolver 脆弱性（W10）；P6 单独用 @typescript-eslint 版 + allowTypeImports:true（W9），仓内现状恰是唯一一处 `import type`（C13），CI 解释器必须复刻 import kind 区分。R1 全绿起步（C13），无需 ratchet。生成落在白纸上（A8a：仓内无任何既有 import 限制规则，无冲突对象）。
- **S1 出网发现式扫描**：ESLint 侧 no-restricted-syntax esquery selector + flat-config per-file 豁免两个 transport 文件（W11）；CI 侧扫描器补 selector 抓不到的拼法（alias/window.fetch）并同时覆盖动态 import（A8b）。三字段豁免 schema 直接对标 Vercel Conformance（W14）。**存量不是零**：7 个钦定 seam 外的出网点已定位（C14），proposal 必须拍板豁免/ratchet/先归拢三选一，否则首跑即红；G8 硬编码枚举与 S1 的背书关系写进 design。
- **S2 组件旁路**：谓词设计是必拍板决策——全禁则基线是 10 个文件，区分『数据获取函数 vs 类型/错误分类器』则是 2（C15）；正向规范出处直接引用 capabilities.ts 文件头注释（C16）。ratchet 归属需逐规则拍板：ESLint 原生 bulk suppressions（W7）vs scripts/ratchets comparator（C8/A4）——避免双重记账；layout v2 属报告模式脚本，只能走 comparator。
- **layout v2**：无库捷径（W15），基于 contexts-manifest.json 自建报告脚本是正解；文件→层判定规则（*.controller/*.service/*.store 命名映射）是 manifest 的唯一缺口，须在本 change 内定义（C5）；v1 闸门不动，v2 是并行新脚本（C17）；基线数字必须开工活测并按工件07 §E 回写，不可信 112/260 快照（C17、A7）。渐进路径（报告→基线→阶段 6 转 required）有 Betterer 谱系背书（W8），空扫描即败有 ArchUnit 谱系背书（W13）。
- **R9**：四个 seam 全部实存、有锚定测试与唯一性谓词（C18），断言便宜（存在性+grep 唯一实现），理由引用 close-request-boundary-gaps 的『one list, not two』（A13）；dependency-cruiser 'required' 规则是同类先例（W6）。
- **R10**：前置工作——先给 packages/contracts 与 packages/sandbox 的 CLAUDE.md 补『What this subtree may depend on』段（C19、A12），解析器对段落缺失 fail-closed；三处易腐数字降约数的清单已定位（C19）。论证模板照抄 derive-runtime-vocabulary（A11）：把散文从 sync-comment 变成被对账的派生物。

### 3. 接线项（必须进 tasks 的工程细节）

- **turbo 缓存**：manifest JSON 必须加进 turbo.json globalDependencies 或各包 lint inputs，否则改 manifest 后 lint 命中旧缓存静默绿——正是本 change 要消灭的假安全感（C11）。
- **ESLint 扇出**：14 个 eslint.config.* 中 12 个是三行转发（C9）；规则工厂需按消费包身份分发（P1 只管 web、P2 只管 api）。**先在一个 config 端到端验证（IDE 红 + pre-commit + CI）再扇出**（A9）；片段并入共享 config 还是 per-package 留作带判据的实现期决策行，别在工件里预填（A9 的预填两行全错教训）。
- **pre-commit/IDE 双回路接线成本≈0**：规则进共享 config 链即自动生效（C10），验收的『IDE 立即标红』只需证明，无需新 hook。
- **CI 落点**：四个新脚本（boundaries 解释器/layout v2/R9/R10）按 `node X.mjs && node --test X.test.mjs` 配对模式落 scripts/ + 根 script + required job 内新 step，不改 job 显示名（C12）；`name:` 字节一致性用 git diff | grep 核查，新条件化 job 同 PR 进 ci-job-conditions CONDITIONED 集（A14）。
- **收编而非重写**：P3/P7/S3 在 manifest 里引用既有执行器路径（C2、C7）；ratchet 一律 import compareToBaseline 建 scripts/ratchets/<rule-id>.json（C8、A4）。

### 4. Change 工件与流程约束

- 工件填进既有目录 openspec/changes/enforce-boundaries-from-manifest/，不另起名（C1、A1）；sidecar 已声明 runtime 四面 unchanged，diff 必须严格不进 runtime 代码路径，verify 前真跑每条声明 lane（A10）。
- tasks 分区照抄 close-gate-blindspots：并行 track + SERIAL integration track 持有全部共享文件写者（14 个 eslint.config.*、ci.yml、根 package.json、docs/refactor 登记表）（A2）。
- 每个新 gate 交付 A3 规定的 gate canon 四件套（配对自测/三字段例外/空扫描即败/注入探针红证记 tasks.md 后回滚），仓内模板照抄 C20 三处。
- 登记表记账进验收：翻转工件04 C 表与工件02 A/C/D/E 相关行、每格写 enforce-boundaries-from-manifest（A15、C4）。
- 外部调研可引用 close-gate-blindspots 的 research-brief 结论（全树扫描+显式豁免是常态、allowlist 限定扫描是反模式）而不重做（A6）。
- 顺序纪律：先删死文件再量测、先提交基线再扩 scope、CI never knowingly red；误报三分处置记证据（A7）。
- 可选加分项（不阻塞）：turbo boundaries 作 P1–P8 的近免费额外 CI 兜底（W3）；eslint-plugin-boundaries 的 settings-as-data 模型作为工厂内部实现的参考（W1）；Nx 的 scope:/type: tag 词表作 manifest 条目命名模板（W2）。
