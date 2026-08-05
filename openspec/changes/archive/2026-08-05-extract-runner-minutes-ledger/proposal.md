# Proposal: extract-runner-minutes-ledger

> 溯源编号引用 `research-brief.md`（W=Web 实践与判例、C=Codebase 实测、A=Archive 判例）。
> `P#` 是 propose 阶段在**本树**补测、简报未覆盖的新证据，逐条给了出处。

## Why

阶段 4 第二刀（`adjudicate-audit-event-migration`）的路线校准把三组横切关注点（runner / diagnostics / transcript）全部判为 **LIKELY-CALL**：缺的不是 payload 字段，而是回执、完成时序与**状态所有权**，事件化不减耦。用户据此拍板：**先真抽一组量出真实收益，再定剩余刀数与归属**，而不是按推断一次性重排。本刀就是那一组——选 runner 是因为它在三组里唯一没有回执、没有时序约束，纯粹是状态所有权问题。

研究把这一刀的形状改小了，也改准了：

- **Extract Class 早已完成一半。** `RunnerMinutesLedger` 与 `deriveRunnerMinutes` 已经在 `apps/api/src/runner-metrics/`（manifest 里 platform-ops 的既有目录），留在 guardrails 的只有**一个实例字段 + 5 处写 + 1 处读**。本刀在 Fowler 目录里的名字是 **Move Field + Remove Middle Man**，不是 Extract Class，也**不需要新建目录**（W1/C2/A5）。`runnerMinuteIntervals()`（`guardrails.service.ts:3879-3881`，其上 `:3878` 是文档注释）函数体只有一行 `return this.runnerMinutes.intervals();`，是教科书级中间人。
- **它同时消灭一条真实的架构违规边。** manifest 的 `crossContextRules.forbidden` 只承认 `*.port.ts` + DI token 这一种跨上下文形态，而 `metrics.service.ts:8` 今天直接 `import { GuardrailsService }`（task-execution）——本身已是违规。把账本所有权迁进 `runner-metrics`（与 metrics 同属 platform-ops）让 metrics 不再需要经 guardrails 中转（W3/W4/W20/C8）。
- **收益的实数必须写在最前面，而不是藏在验收里。** 全部本树活测：guardrails **4,131 行**，最大可摘 **24 行（0.58%）**，「guardrails 仍调用协作者」形态下净减约 12 行（C4）；R11 `this.runnerMinutes` **6 → 5**（6→0 结构上不可达，见下）（C5）；r7 `cross-context-import` `guardrails.service.ts` **9 → 8**、`metrics.service.ts` **2 → 2 不动**（metrics 仍因 `semaphoreProjection()` import guardrails，C8）；tasks↔guardrails 的 forwardRef 环 **0 条边消失**（环的两条边是 transcript 与 `GUARDRAILS_SERVICE_TOKEN`，与 runner 无关，C7/A19）。
- **这些小数字正是本刀存在的理由。** 阶段 4 原验收是「guardrails 3,806 → <2,000 行；forwardRef 环归零」；文件今天已长到 **4,131**（+325，实测全部来自阶段 4 自己的第一刀 `add-domain-event-bus` 一个 commit），严格小于意味着需甩 **≥2,132 行**。而协作者接线最保守口径只有几十行、最激进口径（把每一个碰过协作者的方法整个删掉）约 1,000 行，删完仍剩三千余行——**五协作者燃尽路线在算术上到不了 <2,000**。⚠ 原文此处写的「diagnostics/transcript 各约 30 行」是**无出处估值**（整套工件里只有裸数字、没有行号或命令），不得再当实测引用；「剩下 ~2,100 行是编排体」同样是**减法残差不是测量**。这个结论只有在真抽一组之后才有资格摆上桌，本刀把它从推断变成实测——并据此触发了 Q4 的拍板（改结构判据）。

因此本刀交付两件东西：**(range A) 真做这一次所有权迁移**，**(range B) 用它量出的实数为剩余两组产出前置条件图与预估表**（Mikado 形态，W16/A2）。

## What Changes

本刀**不碰 `packages/contracts/src/**`**——这是保住 sidecar `unchanged×4` 的硬约束（A12/C15）。

- **所有权迁移**：在 `apps/api/src/runner-metrics/` 落一个拥有运行区间状态的所有者（application service）+ **`runner-minutes-ledger.port.ts` + DI token**，照抄第一刀 `audit/audit-recorder.port.ts` 的 recorder 模板（W3/W4/A6）。guardrails **不得** import 具体 `*.service.ts`，否则 r7 finding 只换行号、一分不降。新文件必须用受分类的后缀（`.port.ts` / `.service.ts` / `.module.ts`）；裸 `.ts` 会新增 `unclassified-file` 键、r7 only-down 直接红（C3/A6）。
- **删掉中间人**：移除 `guardrails.service.ts:3879-3881` 的 `runnerMinuteIntervals()` 及其 `:3878` 文档注释，**不留空转发器**（W2/A11——留下的无调用点转发器是 opsx-verify 的历史抓手，写成 scenario 而非散文）。`metrics.service.ts:74` 改为直接向新所有者拉取。
- **guardrails 侧被访问的成员名保留为 `runnerMinutes`，改的只是「编排器怎么拿到它背后的对象」**。这一个决定同时化解三处互相咬合的约束（§(B)/C6/C9/C10/W18）：`guardrails.service.spec.ts` 被既有 spec 场景要求**零 diff 行**却持有 14 处 `runnerMinutes` 反射断言；guardrails spec 正文逐字点名接收者 `runnerMinutes.` 并要求两处 `recordEnd`「remain in place and unchanged」；改符号名让 `\b` 正则归零已被第二刀 branded 为**假燃尽**。
  - **P1（本树新测）**：那些反射断言的形状是 `internals.runnerMinutes.intervals()`（`guardrails.service.spec.ts:1375-1385`、`:3011-3021`），所以**注入的 port 必须同时暴露 `intervals()`**（读）与 `recordStart`/`recordEnd`（写），哪怕 guardrails 的生产代码删掉读取面之后不再调用 `intervals()`。这是保住零 diff 的硬形状要求。
- **R11 目标写死 6 → 5，措辞是「首次下降」而不是「燃尽」**（C5）：R11 按**符号引用**计数，只要 guardrails 还调协作者，5 处写引用必然存活，真正能消失的只有 `:3880` 的读。同 PR 把 `scripts/ratchets/r11.json` 的 `count` 改 5、**刷新已过时一代的 samples**（记的是 1566/2038/2623/2949/2971/3555，活树是 1824/2319/2917/3264/3286/3880，A8）、在 `change` 字段写反伪造对账（「差值精确等于摘掉的 1 处读引用；符号串未变」）；**不删条目、不动 `symbol`**（C19/A9）。同 commit 改 `scripts/ratchets/r11-dependency-budget.test.mjs` 的硬编码映射，并按判例放**集成轨**（A10）。tasks 里仍写「归零删条目 vs 降数改 count」的显式二分——本刀落后者，但这是给第 4/5 刀的模板。
- **行为等价用 characterization 证明，落点必须选对**（W17/A13）：**迁移之前**先写固定 intervals 夹具 + 冻结 `now` 的测试钉住 `deriveRunnerMinutes` 的完整输出对象，迁移后同测试**不改一字**通过。等价夹具只能是 `metrics/metrics.verify.test.mjs`（读 dist 真实实现），**不是** `metrics/runner-minutes.test.mjs`——后者是手写 inline 镜像（`:13` 自注「mirror runner-minutes.ts」），实现搬走了它照样绿（C12，与第二刀在 `delivery-results-surfaced-and-audited.test.mjs` 上记录的失败模式相同）。新测试落 `runner-metrics/`，**绝不落 `apps/api/src/guardrails/`**，否则自伤 135/6/8 characterization 基线（C11/A14）。
- **双向扫描的完整爆炸半径**（A3 的最贵教训）：guardrails 之外必改 5 处——`metrics.service.ts:74`（生产读取方）+ `metrics.verify.test.mjs:468/:537`、`task-resource.test.mjs:137`、`terminal-diagnostics-metrics.service.spec.ts:71`（4 处 stub 了 `runnerMinuteIntervals: () => …` 的假 guardrails）。最后一条是 `*.spec.ts`，按既有 spec 需要一条 (a)/(b) 分类留痕条目（C13）。
- **range B 调研工件 `research-findings.md`**（adjudication.md 的同位物，A1/A17）：把**全部剩余节点**画成 **Mikado 前置条件图** + 一张**交付结果表**（行数差 / R11 差 / r7 差 / forwardRef 受影响面 / 测试改动条数）。次序已拍板（Q5）：**legacy 退役 → diagnostics → transcript → metrics-projection → 编排体拆分**，legacy 退役是根节点，transcript 与 metrics-projection 的前置都写显式 **none**（排在后面是次序安排、不是依赖）。路线级结论（数字已按实测订正）：diagnostics 目标上下文已在 manifest 声明，**首选形态是「反转 gate」但必须与抽走 `tryBegin`/`tryResume` 配对**——只反转 gate 是 WriteGate **4→2**（**不是 4→0**：legacy 管线自己在 `inline-admission.pipeline.ts:670` 独立询问 gate，且构造参数不随抽取消失），组口径 8→6；配对后组口径 **8→4**（legacy 存活）/ **8→2**（legacy 退役后）；**8→0 不可达**——`:654/:657` 是第 9、10 个构造参数，删掉会让 bus 从第 11 位变第 9 位，与既有场景「bus 是尾参、前 10 个保持顺序与类型」字面冲突，归零必须同刀 MODIFY 该场景。transcript 组**不是一次文件搬家**（token 未导出会启动期 DI 失败 / 反向 import 会把 r7 计数**升**上去 / r7 是路径键、搬家是换键不是缩数 / 新目录未同 commit 进 manifest 是 exit 1 硬闸），且抽取**不会**自然消解时序（W7），验收用**顺序断言**而非 sleep（W8）；两组各有真实 /v1 控制器，surface-impact 极可能要升 `derived`（W19）。
- **不做的接线动作**：不新建目录、不改 `GuardrailsService` 的既有 10 个构造参数与 `bus` 尾参位置（22 处 `new GuardrailsService(...)`、15 个文件、10 处在 guardrails 目录外，且被 spec 场景冻结，C14）。
  - **P3（本树新测，Q2 就此关闭）**：`GuardrailsService` **已经** `implements OnModuleInit`（`:467`）、构造首参**已经**是 `ModuleRef`（`:607`）、`onModuleInit()` 已存在于 `:787` 并已用 `this.moduleRef.get(TOKEN, { strict: false })` + try/catch 解析 `tasks` / `gateway` / forge 三组协作者。所以 Q2 的 (b) 是**零构造改动**的既有形态，不是待选方案——直接在该方法里加第四条同款解析即可。
  - **P4（本树新测，propose 阶段发现的 spec 内部冲突及其唯一合法解）**：`guardrails.service.spec.ts` 被既有 spec 冻结为**零 diff**（`openspec/specs/guardrails/spec.md:845`），而它在 `:94` 用**位置化构造**建实例、随后反射读 `internals.runnerMinutes.intervals()`——**此时没有 injector**。于是「guardrails 不得自建 ledger」与「位置化构造仍可用」直接对撞。排除法只剩一条路：端口文件额外导出一个 `createDetachedRunnerMinutes()` 工厂作无注入器时的后备。其余三条都被实测堵死——留 `new RunnerMinutesLedger()` 则 r7 仍是 9（headline 收益归零）；在 guardrails 内手写一份 fallback 实现等于复制账本语义；改单测则违反零 diff 硬约束。
  - **P5（本树新测，直接推翻了 P4 的落法，用闸门自身 `measureSource` 实测）**：把后备装进一个仍叫 `runnerMinutes` 的**数据字段**、再在 `onModuleInit` 里 `this.runnerMinutes = moduleRef.get(...)`，会让本刀的 **R11 净变化为零**——R11 的计数约定（`scripts/ratchets/r11-dependency-budget.mjs:31-38`）明写「every textual occurrence … including the constructor parameter that injects it, a pass-through into a helper, and a type annotation」，**赋值当然算**；删读取面 −1、加赋值 +1，实测 **6**。而 r11.json 要下调到 5、comparator 又是双向 fail-closed → **直接红**。正确落法：`runnerMinutes` 改成**私有 getter**，后备与 DI 解析各用一个**另名**成员（`detachedRunnerMinutes` / `ownedRunnerMinutes`），实测 **5**（恰为五处写）。五处写调用点字节不变、反射断言走原型 getter 照常通过。**同一条约定还有一个坑**：`measureSource` 逐行匹配**不剥注释**（`r11-dependency-budget.test.mjs:205` 把「注释也计数」当既定语义钉住），所以新成员的文档注释里**不得出现 `this.runnerMinutes` 字面量**，否则计数被悄悄顶回 6。
  - **P6（本树新测）**：detached 后备**必须是真账本、不能是 no-op**——`guardrails.service.spec.ts` 的 7 个反射断言点全是**否定式**（`deepEqual(intervals(), [])` 或 `some(endedAt===null)===false`），一个什么都不记的后备会让它们**全部空转通过**：零 diff 字面满足，断言却静默失效。spec 已据此加了一条正向可证伪场景。

## Capabilities

### New Capabilities

- `runner-minutes-accounting`: 运行分钟账本的**状态所有权**能力——账本状态归 platform-ops 的单一所有者；对外只经一个 `*.port.ts` + DI token 暴露（写 `recordStart`/`recordEnd`、读 `intervals()`），**不整体 re-export `RunnerMinutesLedger`**；接口语汇限定在 `RunningInterval` / `taskId`，不得引入 admission / fence 等 task-execution 词汇（W13/W20）；消费方（metrics）**必须直连所有者、不得经 guardrails 中转**，且编排器上不得留下无调用点的转发器；派生输出（`deriveRunnerMinutes`）逐字节不变，由读真实实现（非 inline 镜像）的可执行 characterization 证明。

### Modified Capabilities

- `guardrails`: ①把「An existing synchronous collaborator call … SHALL be removed only when … proves, with an executable test, that the same recorded semantics are still produced by another declared owner」（`openspec/specs/guardrails/spec.md:661`）在 runner 组上兑现——这是第二刀写死的准入条件，本刀是第一个用它移除**读取面**的刀；②裁定 `:697` 与 `:726` 管的是**接缝/位置**而非**字节文本**，并把该裁定写进 ADDED 需求——实测这两条的场景全是行为口径，**无需 MODIFY**（Q3）；与之相对，`:661` 必须 **MODIFY**：它把可接受的新 owner 封闭枚举为两种（事件订阅者 / 同一行标识的第二写者），本刀的「被直读的单一所有者」两种都不是，不加第三种形态就是字面违反活 spec（Q3 已拍板）；③新增「读取面被删除后编排器上不留转发器、metrics 直连所有者」的场景（A11/W2）；④新增 range B 的**前置条件图 + 交付结果表必须落进 change 目录的持久工件**这一要求（对照第二刀「Every guardrails audit symbol reference is adjudicated in a durable artifact」，`:868`）。characterization 需求（`:830`）本树复测仍是 135 `test()` / 6 `*.spec.ts` / 8 `.test.mjs`（C11），数字不改。
- `domain-event-bus`: **P2（本树新测，简报未覆盖）**——「The dependency budget ratchet is seeded with measured counts」（`openspec/specs/domain-event-bus/spec.md:379`）的场景 *The audit delta equals the adjudicated removals* 逐字要求「…**and no other collaborator's count changed**」。本刀把 `this.runnerMinutes` 从 6 降到 5，会让这条场景在集成树上**字面为假**。必须 MODIFY：把该场景收窄为「审计那一刀的对账」，并把反伪造口径（符号串不变 + 差值等于被删引用数 + 非零条目只缩不删）表述为**逐协作者、逐 change** 的通则，而不是钉死在 `this.audit` 一个键上。这是本刀不做就会静默违反既有 spec 的一处。

（`resource-metrics` **不在**修改之列：`GET /metrics` 的 runner-minutes 字段语义与取值逐字节不变，属实现换源，不是需求变更；`ratchet-baselines` 亦不修改——本刀是遵守它的 shrink-only 双向 fail-closed 纪律，不改其需求。）

## Impact

**代码**

- `apps/api/src/runner-metrics/` — 新增所有者与 `*.port.ts`（+ 视 DI 形态可能新增 `runner-minutes.module.ts`，composition 分类安全）。**不得改名或删除**现有两个裸 `.ts`（`runner-minutes.ts` / `metrics-projection.ts`）：它们的 r7 `unclassified-file` tolerated 条目会立刻变陈旧而判红（A6）。新所有者**不得自建 Logger**（logger context 是被断言的行为，须经 port 延迟读取编排器的 logger 字段，A4）。
- `apps/api/src/guardrails/guardrails.service.ts` — 删 `:3877-3881` 的读取面；`:585-593` 字段声明改为注入 port（**字段名不变**）；`:109-112` import 块调整；5 处写调用点（`:1824/:2319/:2917/:3264/:3286`）**位置与文本不动**。**不得**在本文件注释里写调研结论，也不得出现带引号的事件名（`guardrails-domain-event-publishing.spec.ts` 用全文件正则对事件名做精确出现次数断言，A18）。
- `apps/api/src/metrics/metrics.service.ts` — `:8` 的 `GuardrailsService` import 与 `:74` 的中转读取改为直连新所有者的 port；`semaphoreProjection()` 那条 guardrails 依赖**保留**（本刀不动），故 r7 `metrics.service.ts` 计数 2→2。`metrics.module.ts` 的模块级 `GuardrailsModule` 依赖是另一条边（r7 不计），本刀只降源码边、不降模块边——调研里要说清。
- `scripts/ratchets/r11.json` + `scripts/ratchets/r11-dependency-budget.test.mjs` — 见 What Changes；两者与 `guardrails.service.ts` / `metrics.service.ts` 同属**共享写者**，按判例收进串行集成轨（A10/A17）。
- **不触碰**：`packages/contracts/**`（硬约束）、`docs/refactor/contexts-manifest.json`（不新建目录，layout-v2 的「新目录须同 commit 进 manifest」风险本刀不触发）、`GuardrailsService` 构造签名。

**测试与验收**

- characterization 基线：135 `test()` / 6 `*.spec.ts` / 8 `.test.mjs`（C11 本树复测）。`guardrails.service.spec.ts` 的 14 处 `runnerMinutes` 反射断言**预期零改动**（P1 的 port 形状要求即为此服务）；若任何一处必须改，说明所有权迁移改变了行为，按 D5 判例**错的是改动不是测试**。
- assertion-rewrite ledger（A15）：模板照抄第二刀 adjudication.md §3 的五列；采纳保名方案后**预期只有 `terminal-diagnostics-metrics.service.spec.ts:71` 一条**（其 subject 被本刀改变），若为零条也要**显式记「零条」**而非省略。任何走得比 D5 判例更远的改写必须逐条说明理由，否则 verify 判 re-baseline。
- 运行时耦合探针（A4）：跑扫源码文本的结构断言（`sandbox-host-harness-wiring.test.mjs` 一类）确认文件构成变化没打红；确认新所有者未自建 Logger。
- 闸门：`pnpm test:dependency-budget`（R11）、`pnpm test:context-layout-v2`、api-module-layout-check、test-discovery，以及 `node scripts/public-surface-adversarial.mjs verify …`（**声明 unchanged 也必须真跑**，`converge-contracts` 有 NOT-ARCHIVABLE 判例，A12）。CI 步骤显示名逐字节不动，本刀触到的两条是 `Context layout gate (v2, report)` 与 `Dependency budget ratchet (R11)`（C20）。当前五路对抗 verify 在 `sidecar` 就红，因为缺 `tasks.md`（C1）——propose 补齐后重跑。
- **当前工作在 `main` 上，任何提交前必须先开分支**（C1）。

**Sidecar / 公开面**

`surface-impact.json` 的 `unchanged×4 + protocolDifferences []` 经本树复核**成立且无需改动**：`GET /metrics` 与 `GET /tasks/:taskId/metrics` 是非版本化控制台路由，`v1/` 下无 metrics 控制器、无 MCP 工具、无 OpenAPI 注册（C15/W19，兑现该文件自带的复核指令）。`RunnerMinutesSchema` 在 `packages/contracts/src/metrics.ts:605`，只要不编辑该文件就仍是 unchanged（A12）。`internalOnly.scope` 需按最终范围微调（现文写「落到一个拥有该状态的 application service」正确，但未反映「类已在 runner-metrics、本刀是 Move Field + Remove Middle Man」与「R11 6→5 而非燃尽」）。

**Non-Goals**（每条都是后续独立 change）

1. diagnostics 组（recorder 4 + WriteGate 4）与 transcript 组（`this.transcripts` 2）的实际迁移——本刀只产出它们的前置条件图与预估。
2. 解 tasks↔guardrails 的 forwardRef 环（要靠 transcript 那一刀，C7）。
3. 拆 guardrails 的**编排体**（~2,100 行）——这是阶段 4 数字目标真正的去处，见 Q4。
4. legacy inline-admission 退役——仍不在本刀范围内，但**已被拍板为下一刀**（range B 前置条件图的根节点）。本刀只负责把它的实测范围写进 `research-findings.md`（tasks 3.18）。
5. 事件目录扩充 / 词表第四条判据（happens-before / flush-before-destroy，W6/C16/A16）——runner 组不需要它，留给 transcript 那一刀；改动落 `openspec/specs/domain-event-bus/spec.md` 唯一定义处，`domain-events/README.md:49` 保持指针形态。

**待拍板**（完整版见 `research-brief.md` §5）

- ~~**Q1（决定整刀叙事）**~~ **已拍板：定 6→5，并把事件路线的天花板写进 range B**（用户 2026-08-05 决定）。拍板前补测推翻了原选项的措辞——**「升级到 6→0」不存在**：
  - **天花板是 1 不是 0（P5，本树新测）**：3 处 `recordStart` 有 `TaskRunStarted` 覆盖、`:2319` 的 `recordEnd` 有 `TaskSettled` 覆盖，但 `:3264`（`clearAdmissionRuntime`，被顶替的尝试交还运行时、任务本身尚未终态）**没有任何合法可覆盖事件**：既有 spec 明令「clearAdmissionRuntime 发布零个 TaskSettled」「TaskSettled 只在一个接缝发布」，源码 `:3252-3261` 的注释还写明这个「2 调用点 : 1 事件」的不对称是**故意的**，且「spec carries it as a negative requirement so a later change cannot 'fix' the asymmetry」。
  - **原措辞「要改 14 处热点断言」是错的，真实情况更糟（P6，本树新测）**：7 个断言点全部是**否定式**（`deepEqual(intervals(), [])` 或 `some(endedAt === null) === false`），guardrails 一旦不再记账，它们会**全部空转通过**——零 diff 字面满足，断言却静默失效，`:3207` 的消息 "while historical accounting remains" 直接变成假话。红测试会喊，空转不会。
  - **第三条代价**：记账搬去订阅者后会变 fail-open——既有场景要求发布逃生开关关闭时「every retained synchronous collaborator call still runs」，而同步记账今天与该开关无关。
  - 这三条已落进 `specs/domain-event-bus/spec.md`（需求正文 + 一条可证伪场景）与 tasks 3.10/3.11，后续刀不必重推。
- ~~**Q2（决定接线形态）**~~ **已由 P3/P4 实测关闭，无需拍板**：定 (b) `onModuleInit` + `ModuleRef` 惰性解析（该钩子与 `ModuleRef` 构造参数**本就存在**，加一条同款解析即可，构造签名零改动），兜底由端口文件的 `createDetachedRunnerMinutes()` 提供并在 `onModuleInit` 被替换。(a) 第 12 个尾参已排除：与「bus 是尾参」spec 场景字面冲突，且并不能解决位置化构造的兜底问题。
- ~~**Q3（决定 spec delta 体量）**~~ **已拍板：MODIFY `:661`**（用户 2026-08-05）。拍板前的实测把问题重新定位了：`:697`/`:726` 那两条**不需要** MODIFY——它们的场景全是行为口径（"the existing `recordStart` call still runs"、"invoked exactly as many times as before"），没有一句钉接收者文本或声明类型，而该文件真要求文本同一时用的是另一套措辞（`:903` "byte-identical to their pre-change form"）。**真缺口在 `:661`**：它把可接受的新 owner **封闭枚举**为两种（事件的注册订阅者 / 同一行标识的第二写者），本刀「被 metrics 直读的所有者」两种都不是，而 delta 原本复述 `:661` 时把这个枚举丢了——不 MODIFY 就是**字面违反活 spec**。已按用户决定在 delta 追加 `## MODIFIED Requirements`，整块复述 `:657-693`（heading + 3 段 + 6 场景）并加第三种形态「directly-read single owner」+ 五条准入前置 + 三条新场景（含两条否定场景，堵死写侧移除套用该形态）。**操作要点（实测）**：MODIFIED 是**整块替换**（`specs-apply.js:210` `nameToBlock.set(key, mod)`），漏写的场景会被从活 spec 里**删掉**；heading 必须逐字一致（只宽容首尾空白）；且 `openspec validate` **不检查** header 是否存在，那道闸门在 apply/archive 才触发——validate 绿不构成证明。
- ~~**Q4（决定阶段 4 验收本身）**~~ **已拍板：(b) 改结构判据**（用户 2026-08-05），且**由本刀执行文档编辑**（tasks 3.13-3.16）。算术（实测）：目标是严格小于，`4,131 − 1,999 = 需甩 ≥2,132 行`；而协作者接线在最保守口径（点名它们的行的并集）只有几十行，即便用最激进口径（把每一个碰过协作者的方法整个删掉）也只有约 1,000 行，删完仍剩三千余行、距目标差一千余行——**任何口径都到不了**。⚠ 拍板时已知两个显然候选**本身是坏的**，所以判据必须重新设计而不是照搬：R11「归零」不可达（Q1 已定 runner 地板；audit 裁定 CALL×9）；「forwardRef 环归零」**今天没有闸门**——`scripts/api-module-layout-check.mjs:134-135` 对「全由 `*.module.ts` 构成的环」直接放行，该豁免还被活 spec `openspec/specs/monorepo-foundation/spec.md:50` 复述，而 guardrails↔tasks 正是全仓唯一的 module-only 豁免环。故新判据每条都必须**自带落法**：或今天可测（R11 / r7 已在 required CI job 内且双向 fail-closed），或写明需要新增哪个窄闸门。行数从此降级为**趋势数据**，不再是验收判据。另一实测：行数目标**没有任何闸门在管**，改它是纯文档编辑，不动 CI。
- ~~**Q5（决定 range B 建议强度）**~~ **已拍板：legacy 退役先行**（用户 2026-08-05），剩余次序「legacy 退役 → diagnostics → transcript → metrics-projection → 编排体拆分」；diagnostics 的「反转 gate」保留为首选形态，但**必须与抽走 `tryBegin`(:2946)/`tryResume`(:3014) 配对**才拿得到那一档收益。⚠ **理由不得引用四条常见论据**——「legacy 退役让 diagnostics 归零 / 解 forwardRef 环 / 明显拉低行数 / transcript 依赖它」，四条本树实测**均不成立**。可写的理由只有两条：① 实测效果——退役后 diagnostics 地板从 4 降到 2，因为 `:731/:732` 是 `:682` 那个 `new InlineAdmissionPipeline(...)` 表达式的实参，随适配器整体消失；② 仓内既有判据——归档的 legacy 隔离 change 已裁定「为一个计划删除的单元搭接口 = 给拆除工作搭脚手架」，判据是**退役日剩余成本最小**。数字同时订正（见下）。
