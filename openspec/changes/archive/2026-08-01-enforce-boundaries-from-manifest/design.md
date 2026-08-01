# Design — enforce-boundaries-from-manifest

> 引用编号沿用 `research-brief.md`（W=Web、C=Codebase、A=Archive）。动机见 `proposal.md`，需求见 `specs/*/spec.md`。本文件只拍板 HOW，并落定 proposal 明示留给 design 的三个决策（S1 存量处置、S2 谓词、ratchet 机制归属）。

## Context

边界规则现存三种形态：工件02 的 A/C/D 散文表、四份 CLAUDE.md 的依赖清单、capabilities.ts 文件头承诺——全部无执行面或执行面互不同源（C2、C16、C19）。仓内已有两个可复用先例：contexts-manifest.json 的「manifest + 闸门直读」模式（C6）与 sandbox-package-boundary 的独立 node 扫描器模式（C21）。约束：runtime 四面（publicV1/mcp/openapi/apiPlayground）unchanged，diff 不进 runtime 代码路径（A10）；CI required job 显示名不可动（C12）；阶段 6 与 7b 都预约消费本次产物（C3）。

## Goals / Non-Goals

**Goals:**

- 工件02 边界表落成单一机器可读声明源 `docs/refactor/boundaries-manifest.json`，规则内容零发明。
- 从 manifest 派生两条互相独立的执行回路：ESLint（IDE + pre-commit）与独立 CI 解释器（全量兜底、disable 免疫）。
- layout-check v2 报告模式 + 活测 ratchet 基线，为阶段 6 转 required 铺路。
- R9 安全 seam 存在性/唯一性断言、R10 CLAUDE.md 依赖段对账，全部 gate canon 四件套交付。

**Non-Goals:**

- 不归拢存量越界代码（S1 的 7 处出网点、S2 的 2 处旁路只记账不搬代码）——本 change 是建闸门，不是 web 重构。
- 不动 v1 闸门 api-module-layout-check.mjs，不在本 change 把 layout v2 转 required（阶段 6 的事）。
- 不实现阶段 7b 防回流规则，只保证规则工厂可被其复用。
- 不引入 codegen、不引入新运行时依赖、不采纳 Sheriff/Nx/dependency-cruiser 整套框架。

## Decisions

### D1 消费拓扑：manifest 直读、双独立解释器、无 codegen

`@cap-console/eslint-config` 在加载时直接 `import` manifest JSON 生成规则；CI 兜底是独立 node 脚本按 sandbox-package-boundary 模式独立读同一 JSON。两个消费者各自从 manifest 派生规则、绝不互相派生（ESLint 输出永不成为解释器输入）。
**为什么不 codegen**：生态无「JSON → flat-config 生成」标准工具（W16），生成物必然引入漂移面；flat config 本身是可执行 JS，直读即单一声明。**为什么不采现成框架**：Sheriff/Nx tags/dependency-cruiser 的规则模型与工件02 的 A/C/D 三表不重合，且引入依赖换不来 disable 免疫的兜底回路；Sheriff 的「一份配置、两个执行器」架构（W4）只借拓扑不借实现。

### D2 P1–P8 用包名 pattern，不用文件系统 zones；P6 单独走 typescript-eslint

生成器 emit `no-restricted-imports` 的包名 patterns 并按消费包身份分发（P1 只作用于 apps/web 等）。**为什么不用 import/no-restricted-paths zones**：zone 不经 resolver 不解析 tsconfig alias（W10），本仓全部走 `@cap/*` 包名 import，包名 pattern 天然免疫。P6 用 `@typescript-eslint/no-restricted-imports` + `allowTypeImports: true`（W9）；CI 解释器复刻 import-kind 区分并覆盖动态 `import('…')`（A8）。R1 实测全绿起步（C13），无 ratchet。

### D3 S1 存量处置（proposal 留给 design 的三选一）：按语义分流「豁免 2 文件 + ratchet 2 文件」

7 处钦定 seam 外出网点（C14）不做单一处置，按存量语义分两类：

- **`lib/mock-session.ts`（5 处 fetch）→ manifest 三字段豁免**（rule=S1、path、reason，对标 Vercel Conformance schema，W14）。理由：它是 capabilities 开关的 mock 侧半边，其 fetch 是结构性的，不是待还的债——放进 ratchet 会制造永远清不掉的条目，污染「基线只能减」语义。**否决的替代**：把 mock-session.ts 升格为第三个 transport 文件——会稀释 G8 闸门 `CONSOLE_TRANSPORTS=[real.ts, ws-client.ts]` 的枚举（S1 正是要背书这份枚举，C14），豁免条目保住 seam 定义同时留 change 痕。
- **`admin-reveal-modal.tsx:51`、`update-banner.tsx:298`（各 1 处）→ ratchet 基线**。理由：组件内直连 fetch 正是 S1 要防的形态，属于应归拢进 seam 的债；归拢本身超出本 change 范围（Non-Goal），ratchet 保持收紧压力。

每处存量恰好落一本账（豁免或 ratchet），绝不两本都记（spec 已锚定该不变量）。

### D4 S2 谓词（proposal 必拍板）：只禁「数据获取函数的值 import」，type-only 与登记过的非取数导出放行

全禁则基线 10 文件，区分则基线 2（C15）。拍板**区分**：类型 import 与错误分类器不在运行时选择 transport，不构成旁路 capabilities 开关；把它们计入 ratchet 是 8 条修不掉也不该修的假债。机制：

- `@typescript-eslint/no-restricted-imports` 作用于组件目录、指向 real.ts，`allowTypeImports: true` 放行 `import type`；
- 非取数的值导出（`ApiError`、`runtimeModelErrorFromApiError` 等错误分类器）不硬编码在规则里，而是登记进 manifest S2 条目的 `allowNames` 数据字段——**新导出默认被禁（fail-closed），扩 allowNames = 改 manifest = 架构决策留痕**。这是 settings-as-data（W1）的应用，避免了「按函数名枚举取数函数」的反向漂移。
- 基线 = 已知 2 处旁路（api-stream-panel.tsx、session-cast-log.tsx），规则文案引用 capabilities.ts 文件头 SINGLE-switch-point 注释为规范出处（C16）。

### D5 ratchet 机制归属（proposal 要求逐规则拍板）：按执行器家族分账，一债一账

- **ESLint 执行的规则（S1 的 2 处、S2 的 2 处）→ ESLint 原生 bulk suppressions**（v9.24+，W7）：`eslint-suppressions.json` 是唯一账本，per-file per-rule 计数只减不增，修了违规不删条目会因 unused suppression 变红——IDE、pre-commit、CI lint 三处免费获得单向 ratchet。**否决 comparator 管 ESLint 规则**：要让规则在存量文件保持 error 就得加 flat-config 豁免或 disable 注释，前者构成第二本账（spec 禁止双重记账）且不限计数（同文件可静默新增违规），后者正是本 change 要消灭的逃逸面。
- **脚本执行的检查（layout v2）→ `scripts/ratchets/<rule-id>.json` + 共享 comparator**（C8、A4）：报告模式不经 ESLint 管线，suppressions 够不着，comparator 是唯一选项。
- **账本与独立性的边界**：CI 解释器为容忍同 4 处存量会读 `eslint-suppressions.json`——但它自己重新计数、只把账本当已提交的数据文件比对上限，不消费 ESLint 的运行时输出；「双消费者绝不互相派生」的不变量约束的是规则派生，账本是与 manifest 同级的数据输入。任何一条债只出现在一种机制里。

### D6 layout v2：文件→层判定规则落 contexts-manifest.json，不落脚本头

spec 允许二选一，拍板进 manifest：层判定（`*.controller`/`*.gateway`→interface、`*.service`→application、`*.store`→domain/store 等命名映射）是架构决策，应受 contexts-manifest.json 顶部 change 留痕 $comment 管辖；脚本保持纯解释器，与 D1 拓扑同构。判不出层的文件报 unclassified、绝不静默跳过（fail-closed）。基线数字开工活测并按工件07 §E 回写，不信 112/260 快照（C17、A7）。报告→基线→阶段 6 转 required 的毕业路径以 Betterer 谱系为先例（W8）。

### D7 CI 落点：既有 required job 内加 step，不建新 job

四个新脚本（boundaries 解释器 / layout v2 / R9 / R10）按 `node X.mjs && node --test X.test.mjs` 配对模式落 `scripts/` + 根 package.json script + 既有 required job 内新 step。**为什么不建新 job**：branch protection 按显示名钉 required 检查，改名/新增 job 需要手动同步保护规则的运营步（C12、A14 的教训）；`name:` 字节一致性用 `git diff | grep` 核查。manifest 路径进 turbo.json globalDependencies，否则改 manifest 后 lint 命中旧缓存静默绿（C11）。每个新 gate 交付 canon 四件套：配对自测、三字段例外、空扫描即败（run-suite.mjs:88-91 模板）、注入探针红证记 tasks.md 后回滚（A3、C20）。

### D8 R9 / R10：断言便宜化，解析 fail-closed

R9 四个安全 seam 断言 = 文件存在 + grep 唯一实现（唯一性谓词如 `decryptStored` 只此一处定义），目标路径与谓词全部落成 manifest D 表数据条目（C18），理由引用「one list, not two」（A13）。R10 解析 CLAUDE.md 的「What this subtree may depend on」段与 manifest A 表对账；前置：先给 packages/contracts 与 packages/sandbox 补该段（现缺，C19），解析器对段落缺失 fail-closed 而非跳过；顺手三处易腐精确数字降约数。

### D9 展开顺序：单点端到端先行，再扇出

先在一个 eslint.config 验证完整回路（IDE 红 + pre-commit 拦 + CI 红）再扇出 14 处（A9）；片段并入共享 config 还是 per-package 是带判据的实现期决策，不在工件预填（A9 的预填两行全错教训）。tasks 分区照抄 close-gate-blindspots：并行 track + SERIAL integration track 独占全部共享文件（14 个 eslint.config、ci.yml、根 package.json、docs/refactor 登记表）（A2）。

## Risks / Trade-offs

- [esquery selector 抓不到 alias/`window.fetch`/动态 import 拼法（W11）] → CI 独立解释器覆盖全部变体拼法；ESLint 侧只求 IDE 即时性，不求完备。
- [eslint-disable 逃逸（一条 disable 禁掉 no-restricted-syntax 全部 selector，W11）] → 解释器不经 ESLint 管线，disable 天然不可见（C21）；eslint-comments 插件（W12）列为可选增强，不做硬依赖。
- [S2 `allowNames` 带来数据漂移面：real.ts 每加一个合法非取数导出都要改 manifest] → 有意的 fail-closed 摩擦：新导出默认被禁，扩名单必须留 change 痕；名单预期极小。
- [解释器读 suppressions 账本可能被误读为「消费 ESLint 输出」] → 设计上解释器独立重扫重计数，账本只作提交进库的数据上限；在解释器头注释写明该边界。
- [ratchet 基线引用过期快照导致首跑即红或虚宽] → 全部基线开工活测，工件07 §E 回写；CI never knowingly red（A7）。
- [并行 apply 时共享文件互相踩踏] → SERIAL integration track 独占共享文件写权（A2）。
- [改 manifest 后 turbo 缓存回放旧绿] → globalDependencies 接线 + 在 tasks 中加「改 manifest 触发 lint 重跑」的验证步（C11）。

## Migration Plan

纯开发/CI 工具面，无数据迁移、无运行时部署。落地顺序：manifest JSON → 规则工厂接一个 config 端到端 → CI 解释器 → 扇出 14 config → 活测基线 + suppressions/ratchets 账本 → R9/R10 脚本 → turbo/ci.yml 接线 → 工件02/04 登记表翻转（每格写本 change 名）。回滚 = revert 提交即可（闸门全部只加不改语义，v1 闸门原样在位）。verify 前在集成树真跑每条声明 lane（A10）。

## Open Questions

- S1/S2 进 ratchet 的 4 处存量何时归拢进 seam：留给后续 web 专项 change（可挂阶段 7b 或独立小 change），本 change 只保证账本收紧压力在。
- 规则片段最终落共享 config 单点还是 per-package 分发：实现期按「12 个三行转发 config 是否需要差异化」判据现场定（A9、C9）。
- 可选增强是否顺手带上（turbo boundaries 作 P1–P8 近免费二重兜底 W3；eslint-comments 禁 disable 边界规则 W12）：不阻塞本 change，默认不做，若实现期零成本可加。
