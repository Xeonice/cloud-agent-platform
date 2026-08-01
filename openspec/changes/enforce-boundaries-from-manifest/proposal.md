# Proposal: enforce-boundaries-from-manifest

> 溯源标注引用 `research-brief.md` 的发现编号（W=Web、C=Codebase、A=Archive）。

## Why

架构边界规则今天只存在于散文（工件02 的 A/C/D 表、CLAUDE.md 的依赖清单、capabilities.ts 的文件头承诺），执行面要么缺失、要么散落成互不同源的硬编码闸门——越界 import 最快也要到 CI 才被抓，多数根本没人抓（C2、C16、C19）。本 change 把工件02 定稿的边界表落成机器可读的单一声明源 JSON，并从它派生两条独立执行回路：ESLint（IDE 即时标红 + pre-commit）与独立 CI 解释器（全量扫描兜底、对 eslint-disable 免疫），同时为阶段 6 layout v2 转 required 建立 ratchet 基线——这是母计划阶段 3 的既定交付，且阶段 7b 的防回流规则已预约复用本次的生成器（C3）。

## What Changes

- **落地 `docs/refactor/boundaries-manifest.json` 单一声明源**：工件02 A 表（P1–P8）、C 表（S1–S3）、D 表（4 个安全 seam）的机器可读化，规则内容零发明（C2）。顶部带与 contexts-manifest.json 同款的「修改本文件=架构决策，须经 change 留痕」$comment，条目携带 provenance/change 字段（C6、A15、W14）。已落地的 P3/P7/S3 收编为对既有执行器路径的引用，不重复实现（C2、C7）。
- **消费拓扑：manifest 直读、双独立解释器、无 codegen**。生态无「JSON → flat-config 生成」标准工具（W16）；`@cap-console/eslint-config` 在加载时直接 import 该 JSON（无生成物、无漂移），CI 侧兜底是独立 node 脚本按 sandbox-package-boundary 模式（C6）独立读同一 JSON——两个消费者各自从 manifest 派生、绝不互相派生（元规则 4；A5、A10 的 self-attestation 盲点规则）。这与 Sheriff「一份配置、两个执行器」架构同构（W4）。独立解释器不经 ESLint 管线，disable 注释对它天然不可见（C21、W6）。
- **R1 包级规则（P1–P8）落 ESLint + CI 双回路**：emit 包名 pattern 的 no-restricted-imports 而非文件系统 zones，绕开 @cap/* alias 的 resolver 脆弱性（W10）；P6（sandbox-core 只可 type-only import contracts）用 @typescript-eslint 版 + `allowTypeImports: true`（W9），共享 config 已带该依赖，仓内现状恰是唯一一处 `import type`（C13）；CI 解释器复刻 import-kind 区分并覆盖动态 `import('…')`（A8）。实测全绿起步，无需 ratchet（C13）；仓内此前无任何 import 限制规则，落在白纸上无冲突（A8）。
- **R2 S1（web 出网只经 real.ts / ws-client.ts）**：发现式扫描而非文件枚举——ESLint 侧 no-restricted-syntax esquery selector + flat-config per-file 豁免两个 transport 文件（W11）；CI 扫描器补 selector 抓不到的拼法（alias、window.fetch）（W11、A8）。**存量不是零**：钦定 seam 外还有 7 处出网点（mock-session.ts 5 处、admin-reveal-modal、update-banner；C14），处置三选一（三字段豁免 / ratchet / 先归拢）在 design 拍板；三字段豁免 schema 对标 Vercel Conformance（W14）。G8 闸门硬编码的 CONSOLE_TRANSPORTS 枚举由本规则背书（C14）。
- **R2 S2（组件不得旁路 capabilities.ts seam 直连 real.ts）**：谓词设计（全禁→基线 10 文件，区分数据获取函数 vs 类型/错误分类器→基线 2）是 design 必拍板决策（C15）；规范出处直接引用 capabilities.ts 文件头的 SINGLE-switch-point 注释（C16）；存量走 ratchet，机制归属（ESLint bulk suppressions vs scripts/ratchets comparator）逐规则拍板、禁止双重记账（W7、C8）。
- **R7 layout-check v2 雏形（报告模式，不拦截）**：新独立脚本读 docs/refactor/contexts-manifest.json 做三类检查——跨上下文 import 合法形态、层方向（interface→application→domain/store）、Prisma 只在 `*.store.ts`（C5）；无库捷径，自建是正解（W15）。manifest 唯一缺口「文件→层判定规则」在本 change 内定义（C5）；基线数字开工活测并按工件07 §E 回写，不可信 112/260 快照（C17、A7）；ratchet 基线 import 共享 comparator 建 `scripts/ratchets/<rule-id>.json`（C8、A4）。v1 闸门 api-module-layout-check.mjs 不动，v2 并行（C17）。报告→基线→阶段 6 转 required 的毕业路径有 Betterer 谱系背书（W8）。
- **R9 安全 seam 存在性断言**：request-origin 的 the-ONE-computation、REST/WS 会话校验统一入口、assertSafeProviderUrl、凭据加密读取 helper 四项全部实存且有唯一性谓词（C18），断言=文件存在 + grep 唯一实现，理由引用 close-request-boundary-gaps 的「one list, not two」（A13）。
- **R10 CLAUDE.md 依赖清单对账**：解析 4 份 CLAUDE.md 的「What this subtree may depend on」段与 manifest A 表比对；前置工作——先给 packages/contracts 与 packages/sandbox 补该段落（现缺，C19），解析器对段落缺失 fail-closed；顺手把三处易腐精确数字降为约数（C19、A12）。论证模板照抄 derive-runtime-vocabulary：把无查验的 sync 散文变成被对账的派生物（A11）。
- **接线与流程**：manifest JSON 进 turbo.json globalDependencies（否则改 manifest 后 lint 命中旧缓存静默绿，C11）；先在一个 eslint.config 端到端验证（IDE 红 + pre-commit + CI）再扇出 14 处（A9、C9）；四个新脚本按 `node X.mjs && node --test X.test.mjs` 配对模式落 scripts/ + 根 script + required job 内新 step，CI check 显示名不动（C12、A14）；每个新 gate 交付 gate canon 四件套（配对自测/三字段例外/空扫描即败/注入探针红证记 tasks.md 后回滚；A3、C20）；翻转工件04 C 表与工件02 相关行、每格写本 change 名（A15、C4）。

无 **BREAKING**：runtime 四面（publicV1/mcp/openapi/apiPlayground）unchanged（sidecar 已声明），diff 严格不进 runtime 代码路径（A10）；对开发者的唯一行为变化是越界 import 在 IDE/pre-commit/CI 变红。

## Capabilities

### New Capabilities

- `boundaries-manifest`: 机器可读边界声明源 `docs/refactor/boundaries-manifest.json` 的存在、schema（含 provenance/change 字段、三字段豁免条目、对既有执行器的收编引用）、change 留痕约束，及「双消费者各自独立派生、绝不互相派生」的拓扑不变量。
- `boundary-lint-rules`: manifest 派生的 ESLint 规则面——P1–P8 包级 no-restricted-imports（含 P6 type-only）、S1 出网发现式 selector、S2 seam 旁路规则——经共享 config 覆盖 14 个 flat config，IDE 即时标红 + pre-commit 生效，含 turbo 缓存失效接线。
- `boundary-ci-interpreter`: 独立读 manifest 的 CI 全量扫描兜底闸门——对 eslint-disable 免疫、复刻 type-only 区分、覆盖动态 import 与 fetch/WebSocket 变体拼法、gate canon 四件套。
- `context-layout-report`: layout-check v2 报告模式——读 contexts-manifest.json 做跨上下文/层方向/Prisma 位置三类检查，文件→层判定规则定义，ratchet 基线经共享 comparator，v1 闸门不动。
- `security-seam-assertions`: R9 四个安全 seam 的存在性+唯一实现断言闸门。
- `agent-docs-reconciliation`: R10 CLAUDE.md「What this subtree may depend on」段与 manifest 的对账闸门，段落缺失 fail-closed，含补齐 contracts/sandbox 两份段落的前置。

### Modified Capabilities

（无——`ratchet-baselines` 按其 spec 预告的方式被原样消费（新基线文件 + import comparator，A4），不改其需求；`monorepo-foundation` 的共享 eslint-config 结构不变，只是新增规则内容。）

## Impact

- **代码面**：新增 `docs/refactor/boundaries-manifest.json`；`packages/eslint-config/index.js`（读 manifest 的规则工厂）；14 个 `eslint.config.*` 的接线（是否留在共享 config 单点覆盖为实现期决策，A9）；`scripts/` 下 4 个新配对脚本（boundaries 解释器 / layout v2 / R9 / R10）+ 根 package.json 新 `test:X` script + `ci.yml` required job 内新 step（显示名不动）；`scripts/ratchets/` 新基线文件；`turbo.json` globalDependencies；`packages/contracts`、`packages/sandbox` 两份 CLAUDE.md 补段 + 三处易腐数字降约数；`docs/refactor/02-boundaries-manifest.md` 与 `04-rules-registry.md` 登记表翻转。
- **共享文件碰撞风险**：ci.yml、根 package.json、14 个 eslint.config、docs/refactor 登记表——tasks 分区照抄 close-gate-blindspots 的「并行 track + SERIAL integration track 持有全部共享文件写者」（A2）。
- **依赖**：零新增运行时依赖；typescript-eslint 已在共享 config 依赖内；ratchet 复用既有 comparator（C8）。
- **运行时/对外面**：publicV1 / MCP / OpenAPI / API Playground 全部 unchanged（surface-impact.json 已声明）；verify 走 workflow-gates lane，verify 前须在集成树真跑每条声明 lane（A10）。
- **后续阶段依赖本 change**：阶段 6 layout v2 转 required 消费本次 ratchet 基线；阶段 7b lib/api 归拢的防回流规则接入本次的规则工厂（C3）。
