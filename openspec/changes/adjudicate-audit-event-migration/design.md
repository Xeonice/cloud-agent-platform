# Design: adjudicate-audit-event-migration

> 动机与证据见 `proposal.md`；需求见 `specs/**`。本文只讲 **怎么做**，以及每个技术选择为什么排除了其它做法。
> 溯源沿用简报编号（W/C/A），`D#` 是本文新增的可执行判据（含本树实测出处）。

## Context

阶段 4 第一刀 `add-domain-event-bus` 只建总线：5 个事件、**零订阅者**、**零调用移除**，并把"谁当第一个订阅者"整个留给本刀。研究把这个前提结构性推翻——guardrails 里 4 类 best-effort 审计没有一处能被已发布的 5 个 payload 覆盖，连图纸 §C 点名的 `recordTransition` 也因信封无 actor 而落空（P1）。

于是本刀的产物不是"搬 audit"，而是**把"什么不该被事件化"从第一刀的散文 worked example 升格为 spec 级规则，并逐处裁定 9 个 `this.audit` 引用**。约束条件（全部在本树实测确认）：

- **9 处引用**位于 `apps/api/src/guardrails/guardrails.service.ts` 的 `:1197 / :2063 / :2067 / :2770 / :3529 / :3778 / :3787 / :3806 / :3815`；`scripts/ratchets/r11.json` 的 `count: 9` 与之相符，但 `samples` 记的仍是第一刀接线前的 `988/1794/2483/3204/3453/3462/3481/3490`，**已过时两代**。
- **总线契约物理上吞掉回执**：`apps/api/src/domain-events/domain-event-bus.port.ts` 的 CONTRACT 明写 `publish` 同步派发、每个订阅者独立错误边界、失败不上抛。任何"让订阅者把失败还给调用方"的设计在这条契约下不成立。
- **硬约束**：不碰 `packages/contracts/**`（保住 sidecar `unchanged×4`，C19/A17）；零 Prisma migration；零新闸门（A19）。
- **guardrails 目录测试基线**：135 `test()` / 6 `*.spec.ts` / 8 `.test.mjs`（本树活测），已被 spec 钉死——任何往该目录加测试文件的做法都会自伤基线。

## Goals / Non-Goals

**Goals:**

1. 产出一份**逐处裁定**的持久工件：9 行，每行带 `file:line` / 返回类型 / 调用方是否读结果 / 持久性档位 / 判定 / 判据名 / 双向依赖。
2. 把三条拒绝判据（`acknowledgement-required` / `information-missing` / `no-decoupling-gain`）与两档持久性（`batch` / `blocking-strict`）写成 **spec 级规则**，供第 3–6 刀直接继承，不再逐刀辩论。
3. 给"每个事件类型的已注册订阅者是一个**精确集合**"配一条表驱动测试，堵死后续刀静默孤儿化。
4. 只在**可执行的 per-stage 覆盖证明成立**时删除 `:1197`，并同 PR 更新 R11 基线与 `deploy/DEPLOY.md` §14。

**Non-Goals:**

- 扩事件目录（加 `cause/exitCode/tail`、给信封加 actor）—— 另开 change，享受与原五个事件同等的目录 + schema 审查（W16）。
- 注册任何订阅者；接管 `tasks.service.ts` 的 `recordTransition`（被 P1 阻塞）。
- 引入 outbox / publication registry（需要 migration，本刀声明零 migration）。
- 把审计改成异步/入队——W15 的**反向**改动，本刀反而把它写成负向 requirement 预先堵死。

## Decisions

### D1 — 本刀交付「裁定 + 规则」而非迁移（Q1 = (a)）

选 (a) 的实现后果是把 (b)/(c) 才需要的机制全部消掉：不新增 cutover 开关（从而绕开 C9/A9 那个 (D)/(E) 在字面实现下互斥的张力）、不动 `guardrails.module.ts` 的位置化 `inject:` 数组（C18/A15 不触发）、不碰 contracts。

- 备选 (b) 扩事件目录：按治理判据应另开 change，本刀降级为其前置裁定。
- 备选 (c) 接管 `recordTransition`：被 P1 挡住（信封只有 `eventId/occurredAt/type/taskId`，而 `audit-history` 把归属写成 SHALL），且 R11 的 `SOURCE_REL` 只有 `guardrails.service.ts`，一分不降。
- 备选 (d) 推迟：第一刀建好的机制空转到第 3 刀，每刀重新辩论同一判断。

### D2 — 裁定工件是 change 目录里的独立文件，不是源码注释

工件落在 `openspec/changes/adjudicate-audit-event-migration/adjudication.md`（A13 的 `track-3-recut.md` 形态），一行一个符号引用。

**为什么不写进 `guardrails.service.ts` 的注释**：`guardrails-domain-event-publishing.spec.ts` 用 `new RegExp("'" + eventType + "'")` 对**整个文件**做出现次数计数并断言精确值（本树实测该文件 `:505-513` 断言 `task\.settled` 在 guardrails 恰好 1 次）。裁定说明里必然出现带引号的事件名，写进源码注释即打红一条与本刀无关的测试。**注释是被断言的文本面**，这条结论对第 3–6 刀同样成立。

**为什么不做成 JSON + 校验脚本**：A19 要求零新闸门；数值对账已有承担者——`r11-dependency-budget.mjs` 的 `count` 比对 + 本刀在 `change` 字段里记的燃尽口径，足以让"工件说删了 N 行"与"树上真少了 N 行"互相钉死。

### D3 — 两档持久性词汇的**规范定义**在 capability spec，代码侧只放指针

spec 要求"exactly one file defines them"。定义处选 `openspec/specs/domain-event-bus/spec.md`（归档后；见 D11），代码侧在 `apps/api/src/domain-events/README.md` 放**一行引用**（"tier 名义定义见 domain-event-bus capability spec"），不重述定义。

排除的落点：`packages/contracts/**`（硬约束）；`domain-event-bus.port.ts` 的 JSDoc（会让词表定义与端口契约耦合，且端口文件是 `domain` 层、其 import 面被 context-layout 管着，改动收益低于风险）；`guardrails.service.ts`（同 D2）。

### D4 — 三条判据表述为**协作的性质**，强制手段复用既有编译期守护

判据不写成"audit 是特例"，而写成返回语义 / payload 充分性 / IO 归属三种性质，每条挂一个实战样本（`recordProvisioningFailure`+`recordTaskCancellation` / `recordForceFailed` / `recordExited`）。

强制不靠新闸门：`apps/api/src/domain-events/domain-event-bus.typecheck.ts:72-91` 已把两个回执方法钉成 `@ts-expect-error` 负例（自失效夹具——守护一旦失效，`@ts-expect-error` 自己变成未使用而报错）。本刀只把它从"worked example"升格为"实战首例"，一行机制都不新建。

### D5 — 删除 `:1197` 由**可执行的 per-stage 覆盖证明**决定，且预期是「不成立」

证明的形状（不是散文比对）：驱动 provider composite，捕获两个回调的 stage 序列，断言

```
stages(onProvisioningProgress) ⊆ stages(beforeProvisioningBoundary → lease.checkpoint → worker advanceStage)
```

并对每个 checkpoint stage 断言 `task.provisioning:{taskId}:{attempt}:{stage}` 行仍被 admission worker 写出。

**本树预读强烈提示证明不成立**（写进 design 是为了让 apply 阶段不把它当形式）：production 里 `beforeProvisioningBoundary` 只有**一处**调用——`packages/sandbox-provider-boxlite/src/boxlite-provider.ts:998` 的 `runtime_setup`；而 `onProvisioningProgress` 报的 stage 至少有 aio 的 `readiness`(`aio-provider.ts:401`)、`runtime_setup`(`:413`) 与 boxlite 的 `readiness`(`:900/:940`)、`workspace_transfer`(`:1276`)。worker 侧的行只有两个来源：claim 时的 `claim.stage`(`task-admission.worker.ts:401`) 与 checkpoint 回调里的 `parsedStage`(`:612`)，后者只能由那唯一一处 boundary 喂进来。因此 `readiness` 大概率**没有** worker 所有者。

据此，**默认预期结局是：保留 `:1197`、R11 `this.audit` 9→9、只刷 samples**；specs 两个分支（"0 if retained, 1 if proof succeeded"）已经写好，apply 阶段按证明结果落其中一支即可，**不得**为了让数字下降而放宽证明。

### D6 — 覆盖证明测试落在 `apps/api/src/task-admission/`，不落在 guardrails 目录

理由是自伤基线：guardrails 的 spec 把"6 个 `*.spec.ts` / 135 `test()`"钉成 characterization 基线，往该目录加文件即自打一枪。而且证明的**主语是 checkpoint 的所有者**（admission worker），放在所有者旁边才是它该在的位置。测试挂载靠 glob discovery（`scripts/test-discovery-check.mjs` 已从允许清单改为 glob），新文件无需登记。

### D7 — 精确订阅者集合测试**扩写既有 spec 文件**，不新建文件

落点 `apps/api/src/domain-events/domain-event-bus.service.spec.ts`——`test('this change registers zero subscribers')` 就在同一文件（`:265-267`），语义相邻；扩写避免新增文件带来的 `unclassified-file` / r7 新键风险（C10）。表的 key **从导出的事件类型字面量派生**，所以加第六个事件类型而不加行会直接红；断言用集合相等（不是计数、不是子集），未列出的注册与被静默删掉的注册都会红。

### D8 — R11 只降数不删条目，并同 PR 记反伪造对账

- `count`：按 D5 的证明结果落 9 或 8；`samples`：**无论如何刷新**（现值过时两代；comparator 只比 count，samples 是文档，不是闸门问题）。
- `change` 字段追加本刀口径：符号仍为 `this.audit`（`\b` 锚定正则），**改名 `this.auditRecorder` 会让计数瞬间归零 = 假燃尽**，故对账口径是"差值精确等于裁定表里 REMOVED 的行数"。
- 条目**不删**：归零才删条目（A7）。私有 helper `recordAudit` 仍有 `:2066/:2769/:3528` 三个调用点，不会变死代码，不删。

### D9 — `deploy/DEPLOY.md` §14 的改写绑定 D5 的结果

现文两处与本刀相关：`:851` 附近的"removes **zero** existing direct calls"，与 `:876-880` 的"关闭 toggle 即 byte-identical"。

- 保留 `:1197`（预期分支）：两句仍为真，只补一句说明第二刀完成了 9 处裁定、注册 0 订阅者、移除 0 调用。
- 删除成立：两句**必须同 PR 改写**，点名被移除的调用与它的新所有者，并撤回 byte-identical 声明——因为逃生口已从"关 toggle"退化为"版本回滚"。
- 不新增第二行 toggle：本刀不创造第二条活路径。

### D10 — 留给第 3 刀的接线结论：订阅者文件必须叫 `*.service.ts`

一旦后续刀在 `apps/api/src/audit/` 新增订阅者，文件名先于第一行 import 决定闸门结果（C10）：audit 与 domain-events 同属 `platform-ops`，import 不产生 cross-context-import；但 `audit-domain-event-subscriber.ts` 这类名字匹配不到任何 file→layer 规则，被 `scripts/context-layout-check-v2.mjs` 判 `unclassified-file`，在 `r7.json` 里产生新键、comparator 直接红。本刀不新增该文件，但把结论写在这里供继承。

### D11 — 排序：本刀合并前置于第一刀的归档 PR

`openspec/specs/domain-event-bus/` 在本树**不存在**（归档提交只在 `chore/archive-domain-event-bus` 分支），因此 `## MODIFIED Requirements` 指向 domain-event-bus 的四条需求在归档 PR 合并前**无锚点**。apply 前用 `ls openspec/specs/domain-event-bus/spec.md` 判一次：不存在则先推第一刀归档，否则两份 delta 会对同一 capability 重复 ADDED。

## Risks / Trade-offs

- **覆盖证明不成立，本刀零代码删除、R11 一分不降** → specs 已按双分支写；本刀的价值锚在规则与裁定，不锚在数字。把"9→9"如实写进裁定表与 R11 `change` 字段，比编一个能过的弱证明便宜得多。
- **规则升格后仍被第 3–6 刀绕过** → 两道非评审强制：编译期 `@ts-expect-error` 自失效夹具（D4）+ 表驱动精确订阅者集合测试（D7）。二者都不依赖有人记得读 spec。
- **MODIFIED 需求无锚点导致 delta 无法归档** → D11 的排序与检测命令。
- **inline 源码镜像假绿**：`delivery-results-surfaced-and-audited.test.mjs` 自建 harness 逐行复刻 `deliverResult`，不读真实源码，`recordChangeRequest` 处置一变它也不会自动红 → Q3 取"本期保留调用"即零改动；若改，必须同 PR 更新且保持逐参数断言强度。
- **源码文本扫描面被无关注释打红** → D2：裁定不进源码注释。
- **假燃尽（改名让正则归零）** → D8 的符号不变对账。
- **测试改写滑向 re-baseline**（`isolate-legacy-admission` D5 判例：测试必须改就是改动错了）→ 本刀允许改写但只限"方法内同步调用顺序"型断言，且每条走 (a)/(b) 分类留痕；三处真实 audit 热点（`guardrails-durable-launch-decision.spec.ts` 46 处、`delivery-results-surfaced-and-audited.test.mjs` 61 处、`guardrails.service.spec.ts` 14 处）**预期零改动**，任何一处必须改都说明行为被改变了。

## Migration Plan

**部署面：零变更。** 无 Prisma migration、无新环境变量、无新闸门、无 compose/runbook 改动；`CAP_DOMAIN_EVENT_PUBLISHING_ENABLED` 的默认与语义不变（只可能改文档描述，见 D9）。

**上线顺序**：第一刀归档 PR（D11）→ 本刀 PR（裁定工件 + spec delta + 两条测试 + R11 + DEPLOY 文案，以及证明成立时的那一处删除）。

**回滚**：保留 `:1197` 分支下，本刀无运行时行为改动，回滚等于回滚代码；删除成立分支下，逃生口是**版本回滚**（关 toggle 不再恢复被删调用——这正是 D9 必须改写 DEPLOY 文案的原因）。

**闸门清单（活测，不在 propose 阶段预测死，A5）**：`node scripts/ratchets/r11-dependency-budget.mjs`、context-layout-v2、api-module-layout-check、test-discovery、`public-surface-adversarial`（sidecar 声明 `unchanged` 也必须真跑，A13 有 NOT-ARCHIVABLE 判例）、以及 `sandbox-host-harness-wiring.test.mjs` 与 audit 相关文本扫描脚本（A14；日志 context 是被断言的行为）。

**同 PR 必须跟随的元数据**：`surface-impact.json` 的 `internalOnly.scope` 现文写着"新增领域事件订阅者"与"R11 从 9 降至保留的回执调用数"，在 (a) 范围下两句都不准确，须按最终结局改写。

## Open Questions

**四项已于 2026-08-01 由用户拍板结案（全部取推荐项）：**

- **Q1 → (a) 裁定 + 规则升格**。本刀不迁移任何 audit：产出 9 处逐处裁定工件、把非事件准入规则升格为 spec 级负向 requirement（需要回执 / 信息缺失 / 事件化不减耦 三判据）、给两档持久性命名（`batch` / `blocking-strict`）供第 3–6 刀继承、只删 `:1197`（须先证明 worker checkpoint 覆盖，PROOF-FAIL 则不删）。不新增 cutover 开关、不碰 contracts、零 Prisma migration。
- **change 改名 → `adjudicate-audit-event-migration`**（本刀不 move 任何 audit，原名会让归档记录误导后人）。目录、sidecar `change` 字段、全部文内引用已同步。
- **Q3 `recordChangeRequest` → 本期保留为调用**（(a) 结局下本就保留，裁定表按 `batch` / `CALL` / information-missing 记录）。
- **Q4 `deploy/DEPLOY.md` §14 → 仅改被证伪的两句 + 顺带登记退役条件复核**（业界数据：开源项目约 75% 的 feature toggle 存活超 49 周）。
- **Q5（与第一刀归档 PR 的先后）自动消失**：第一刀归档 PR #199 已合并，`openspec/specs/domain-event-bus/spec.md` 已在主 specs 中。

**用户另行拍板的路线校准项（新增本刀范围，见 tasks track 3）：** 在裁定工件中顺带**预扫阶段 4 剩余三组**（`this.runnerMinutes` 6、`provisioningDiagnosticRecorder` 4 + `provisioningDiagnosticWriteGate` 4、`this.transcripts` 2），用同一套三判据各出一个初判。目的是在投入第 3–5 刀之前校准路线：若它们同样大面积撞上"信息缺失/不减耦"，阶段 4 达成 guardrails <2,000 行与解 forwardRef 环的路径需要从"事件化"改为"直接抽 application service"，该结论应在本刀交付时即可见。初判**不是**裁定，不写进 spec requirement，只作为下一刀 propose 的输入证据。

---

### 原始待答项（已全部结案，保留原文以备追溯）


- **Q1（阻塞全局）** 四处 best-effort audit 全无事件覆盖，取 (a)/(b)/(c)/(d)？本文按推荐的 **(a)** 展开。附带：change 名与内容不符（本刀不 move 任何 audit），是否改名（例如 `adjudicate-audit-event-migration`）需用户确认。
- **Q3** `recordChangeRequest` 处置：(a) 本期保留调用（推荐，成本最低，inline 镜像零改动）；(b) 随事件目录扩充 change 处理。
- **Q4** `deploy/DEPLOY.md` §14 改写范围：除 D9 点名的两句外，是否顺带登记退役条件的复核（W13：开源项目里约 75% 的 toggle 存活 49 周）。
- **Q5** 第一刀归档 PR 与本刀的先后（D11 给了检测命令与默认排序，仍需用户确认由谁先推）。
- **Q2 在 (a) 下消失**（本刀不引入第二条活路径，故不存在"被 flag 关掉的代码算不算进 R11"这个问题）——这是选 (a) 的一项实质收益。
