# Proposal: adjudicate-audit-event-migration

> 溯源标注引用 `research-brief.md` 的发现编号（W=Web 实践与判例、C=Codebase 实测、A=Archive 判例）。
> `P#` 是 propose 阶段在**本树**补测、简报里没有的新证据，逐条给了命令级出处。

## Why

阶段 4（图纸 `docs/refactor/08-ddd-target-architecture.md` §C）的第二刀本应是**第一个真正把横切关注点从 guardrails 的同步调用链上摘下来**的 change：第一刀 `add-domain-event-bus` 只建总线、零订阅者、零调用移除，把"谁来当第一个订阅者"整个留给了本刀。

研究把这条刀的前提推翻了，而且是**结构性**地推翻，不是"漏了几处"：

- **guardrails 里 4 类可摘的 best-effort 审计，没有一处能被第一刀已发布的 5 个事件覆盖**（C2）。force-fail 需要 `cause` 与"本地 CAS 归属"这个控制流判别（C3），exit 需要 `code/abnormal/tail`（C5），provisioning 需要 `stage/attempt`（C6），change-request 需要 `url/number/reused`（C7）——五个 payload（`packages/contracts/src/domain-event.ts:258-335`）里一个都没有。
- **根因是图纸 §C 与 R11 的测量对象根本不是同一批调用**（C23）。§C 把 audit 列为四个事件的订阅者，指的是 `tasks.service.ts` 的**生命周期转移**审计（`recordTransition`）；guardrails 的 4 处是 provisioning-progress / exit-detail / change-request / force-fail 四种**细节**审计。"照图纸做订阅"与"把 R11 的 `this.audit` 燃尽"是两件事。
- **P1（本树新测，简报未覆盖）：连图纸 §C 指名的那批也一样落空。** `recordTransition(taskId, status, userId?, failure?)`（`apps/api/src/audit/audit-recorder.port.ts:73-78`）需要 **actor** 与 **failure**，而事件信封只有 `eventId/occurredAt/type/taskId`（`packages/contracts/src/domain-event.ts:129-134`），`TaskSettled` 只有 `status`。`audit-history` 的既有需求把归属写成了 SHALL（"Event is attributed to a user identity"、"A local account is attributed without a GitHub identity"，`openspec/specs/audit-history/spec.md:96-106`），所以订阅者拿不到 actor **不是降级、是违反既有 spec**。
- **P2（本树新测）：即使扩事件目录补齐字段，四处里也没有一处能靠事件化真正减耦。** force-fail 缺的是控制流归属不是数据，任何 fat 化的 `TaskSettled` 都会在远端/cancelled 赢家那里多发一次，直接打红两条既有**行为**断言（C4：`assert.equal(forceFailureAuditCalls, 0)`、`assert.equal(forceFailAudits, 0)`）；exit 的 `tail` 来自 `gateway.readSessionLogTail` 的一次 IO（C5），把它塞进 payload 意味着 IO 仍留在 guardrails——耦合只是换了个位置，依赖预算不降反而多一条 contracts 依赖。

所以本刀能诚实交付的东西不是"搬 audit"，而是**把"什么不该被事件化"从第一刀的散文 worked example 升格为 spec 级规则，并逐处裁定这 9 个引用**。这件事有独立价值且必须现在做：第一刀已经把机制（`VoidOnlyDomainEventHandler` 类型守护、`@ts-expect-error` 自失效夹具 C13/A16）与词汇（passive-aggressive event，W1；两档持久性 batch / blocking-strict，W2）都建好了，规则不趁热写死，第 3–6 刀每刀都要重新辩论一次同一个判断，而每次辩论的结论都会被写进不同的 change 里。

同时必须在 proposal 里直说的一条反证（W8）：GitLab 这个最接近的产品级审计先例走的是**相反方向**——废弃"动作后调用"、改为 service 层集中埋点、请求内同步持久化，并没有把 audit 变成 pub/sub 订阅者。**本条迁移路线的收益是 guardrails 的依赖预算（R11），不是审计正确性**；把审计改成异步/入队更会把系统从 SOC 2 合规列移到被标记列（W15：批处理延迟被视作弱点，理想是同事务同步捕获）。

## What Changes

下面是**推荐默认范围**（Q1 待用户拍板；三个替代结局如何改写这张清单见本节末表与 §待拍板）。本刀**不碰 `packages/contracts`**——这是保住 sidecar `unchanged×4` 的硬约束（C19/A17/W17）。

- **产出「9 处逐处裁定」独立工件**（A13 的 `track-3-recut.md` 形态）：每处一行——`file:line` / 返回类型 / 发布者是否依赖结果 / 判定 CALL 或 EVENT / 对应事件 / 无对应事件时升级为哪个 open question。裁定必须**双向扫描**：不仅问"guardrails 调了谁"，还要问"**谁依赖这次 audit 写入的时序/结果**"（`audit.verify.test.mjs`、`delivery-results-surfaced-and-audited.test.mjs`、admission work 的 reclaim 路径）。范本最贵的教训正是只向内扫导致结论中途翻转、被迫重切（A13）。
- **把非事件准入规则写成 spec 级负向 requirement，判据分三类且各带实战样本**：
  1. **需要回执** — `recordProvisioningFailure`(`:3787`) 与 `recordTaskCancellation`(`:3815`) 返回 `Promise<boolean>` 的 durability 回执，未确认即抛 `TaskAdmissionCoordinationError('checkpoint')` 让 running work 保持 leased/可回收（C14，既有覆盖 `task-admission.worker.spec.ts:1099-1120`）。规则本身写成**总线契约的性质**而非个案判断（W3）：总线 `publish` 返回 void 且按设计吞掉订阅者失败（`domain-event-bus.port.ts:17-31`），**回执在物理上活不过这一跳**，因此任何调用方要对审计结果分支的调用点 MUST 保持为直接 port 调用。业界名逐字进 rationale：passive-aggressive event（W1）；Spring `@TransactionalEventListener` 同样只 log 不上抛（W4）堵死"让订阅者把异常抛回来"这条路。
  2. **信息缺失** — `recordForceFailed`(`:3529`)：`TaskSettled` 既不带 `force_failed:${cause}` 的 cause，也不带"只有本地确认的 CAS 回调才写 cause-specific 行"这个归属判别（C3）。
  3. **事件化不减耦** — `recordExited`(`:2063/:2067`)：补齐 `tail` 要求生产者仍做那次 IO（P2）。
  规则由**既有编译期守护**强制，不新建闸门（C13/A16：`domain-event-bus.typecheck.ts:72-91` 已把这两个回执方法钉成 `@ts-expect-error` 负例）；spec 只是把它从 worked example 升格为**实战首例**。
- **给两档持久性起名并写进 spec**（W2，Kubernetes 判例）：best-effort 调用点 = `batch` 档（可丢），回执调用点 = `blocking-strict` 档（失败必须对调用方可见）。第 3–5 刀直接继承这套分类，不再逐刀辩论。
- **覆盖对账写成正向 requirement**（W15）：「每一处被移除的同步调用，其审计语义 MUST 可从至少一个已发布事件的订阅者路径抵达；未被覆盖的调用点 MUST 保持为调用。」配一条**表驱动的孤儿事件测试**（W14）：对每个事件类型断言已注册订阅者名字的**精确集合**，绑定到第一刀刻意保留为可枚举数组的 `DOMAIN_EVENT_SUBSCRIBERS`（`domain-event-bus.port.ts:39-47`）。这条测试正是阻止第 3–6 刀静默孤儿化某条审计路径的东西，且因为注册是有类型的数组而非装饰器发现，它很便宜。
- **处置唯一有处置空间的一处**：`recordProvisioningProgress`(`:1197`) 是 provider composite 的 audit-only 提示，与 admission worker 的两处 durable checkpoint 共用 dedupe 身份 `task.provisioning:{taskId}:{attempt}:{stage}`（C6）。**先证明 worker 的 checkpoint 覆盖 provider-composite 的全部 stage，证明成立才删**（不成立则同样保留为 CALL 并写进裁定表）。这是本刀唯一会动 R11 数字的一处：`guardrails-symbol-reference:this.audit` **9 → 8**；私有 helper `recordAudit`(`:3676`) 因仍有 3 个调用点（`:2066/:2769/:3528`）**不会**变成死代码，不删（对照 C8 的"全摘"上限 9→4）。
- **同 PR 更新 R11 基线并留痕**：降数**不删条目**（A7：归零才删条目、零 total 的文件本身即失败）；顺手刷新 `r11.json` 已过时两代的 samples 行号（A6：现存记的是第一刀接线前的树 988/1794/…，当前树是 1197/2063/2067/2770/3529/3778/3787/3806/3815；comparator 只按 count 比对，samples 是文档，别当闸门问题去"修"）；并记一条**防假燃尽对账**（C20）：字段名未改（`\bthis\.audit\b` 正则口径下改名 `this.auditRecorder` 会让计数瞬间归零 = 假燃尽），9→8 的差值精确对应被删的 `:1197`。
- **MODIFY 第一刀被本刀证伪的需求**（A4，四条）：guardrails『Every existing synchronous collaborator call SHALL be retained unchanged — this change adds a second write and removes none』；guardrails『120 test() 零修改』（本刀要显式改测试，必须 MODIFY 成"分类处理 + 留痕"的新形态而非默默违反）；domain-event-bus 把种子 `this.audit` **9** 写进正文那条；domain-event-bus『This change registers zero subscribers』场景。MODIFIED 块按判例**整段重述需求全文**（标题 + 正文 + 全部 Scenario）后再改，不写 diff（A3）。
- **测试基线按本树活测写死，改写逐条留痕**：guardrails 目录今日是 **135 个 `test()`**（6 个 `.spec.ts`：57+54+15+3+3+3）+ **8 个** `.test.mjs`（P3 本轮复测确认，与 C15/A10 一致；主计划的"122"陈旧两代、第一刀的"120"已被它自己新增的 `guardrails-domain-event-publishing.spec.ts`(15) 推高）。留痕模板用 (a)/(b) 二分（W11/A12）：每条被改写的断言必须声明它编码的是 (a) 实现细节（方法内同步调用顺序）→ 替换为"操作完成后审计行集合"的结果断言，还是 (b) 真实需求 → **重新表达并保留**，不得放宽。本刀走得比 `isolate-legacy-admission` 的 D5 判例（"测试必须改就是改动错了"）更远，必须**显式超越并说明理由**，否则 verify 按 D5 判 re-baseline。
- **文档校正**：`deploy/DEPLOY.md` §14 的 `CAP_DOMAIN_EVENT_PUBLISHING_ENABLED` 说明写着"removes **zero** existing direct calls"与"关闭即逐字节一致"（`:851`/`:876-880`）。删掉 `:1197` 之后第一句不再为真，须同 PR 改写（C21/A8/Q4）。

**推荐默认范围下不需要的东西**（这正是把范围收到这里的好处）：不新增 cutover 开关（本刀不引入"新旧两条路"，删除的那一处由既有 worker checkpoint 覆盖，逃生口就是回滚版本）——从而完全绕开 C9/A9 那个 **(D) 与 (E) 在字面实现下互斥**的结构性张力；不改 `guardrails.module.ts` 的 `useFactory` 位置化 `inject:` 数组（C18/A15 的接线陷阱不触发）；不碰 `packages/contracts`；零 Prisma migration；零新闸门（A19：改数字复用既有配对自测与两条注入探针即可）。

### Q1 的四个结局如何改写上面这张清单

| 结局 | 本刀内容 | R11 `this.audit` | sidecar | 需新增 cutover 开关 |
|---|---|---|---|---|
| **(a) 推荐默认**：裁定 + 规则升格 + 删 `:1197` | 如上 | 9 → **8**（冗余证明不成立则 9→9，只刷 samples） | `unchanged×4` 保持 | 否 |
| (b) 扩事件目录补齐 payload | 必须**另开 change**（W16 治理：新事件类型应享有第一刀给原五个事件的同等目录+schema 审查），本刀降级为它的前置裁定 | 不变 | 那个 change 翻 `derived` + 原样转录 8 条 protocolDifferences | 是（在那个 change 里） |
| (c) 重定义为"接管 `tasks.service.ts` 的 `recordTransition`" | **被 P1 挡住**：信封无 actor、`TaskSettled` 无 failure，而 `audit-history` 把归属写成 SHALL → 仍需先扩目录，等价于 (b) | 一分不降（R11 的 `SOURCE_REL` 只有 `guardrails.service.ts`，C23） | 同 (b) | 是 |
| (d) 推迟本刀 | 先做第 3 刀（metrics/计费）或先做事件目录扩充 change | 不变 | — | — |

若拍板 (a)，change 名 `adjudicate-audit-event-migration` 与内容不符（本刀不 move 任何 audit 到事件上），**建议改名**（例如 `adjudicate-audit-event-migration`）——目录已建，改名本身需用户确认。

## Capabilities

### New Capabilities

无。本刀不引入新能力：非事件准入规则、订阅者注册接缝、总线契约都属于第一刀已建的 `domain-event-bus` 能力，本刀只是**收紧并证伪**其中的若干需求。

### Modified Capabilities

- `domain-event-bus`（第一刀新建，**尚未归档**，见 Q5）：把散文里的"非事件准入规则"升格为带三类判据（回执 / 信息缺失 / 事件化不减耦）的 spec 级负向 requirement 与两档持久性命名；新增"每个事件类型的已注册订阅者是一个精确集合"的对账要求；MODIFY『registers zero subscribers』场景与把种子 `this.audit` 9 写死在正文的那条需求。
- `guardrails`：MODIFY『每个既有同步协作者调用 SHALL 保持不变』——本刀首次移除一处（`:1197`），并把移除的准入条件（"必须先证明其审计语义已被另一个所有者覆盖"）写进需求；MODIFY『120 test() 零修改』的 characterization 需求为"行为断言零改动 + 顺序型断言分类改写并逐条留痕"，基线数字改为本树活测的 135/6/8。
- `audit-history`：新增/修订一条场景，声明 **provider-composite 各 provisioning stage 的 checkpoint 由 admission worker 单一所有**——这是删除 `:1197` 的正当性所在，必须在 spec 里可验证，否则删除即丢行（C6）。若冗余证明不成立，本条改为"guardrails 的 audit-only 提示与 worker checkpoint 共用 dedupe 身份、二者缺一不可"的显式声明。

## Impact

**代码**

- `apps/api/src/guardrails/guardrails.service.ts` — 仅 `:1197` 一处删除（含其外层 `recordAudit(...)` 包装的实参表达式）。`:2063/:2067/:2770/:3529/:3778/:3787/:3806/:3815` 全部**原样保留**并在裁定表里各有一行判据。构造签名、`guardrails.module.ts` 的 factory 与位置化 `inject:` 数组**不变**（C18/A15）。
- `apps/api/src/audit/` — 本刀**不新增订阅者文件**。（一旦后续刀新增，文件必须命名为 `*.service.ts`：audit 与 domain-events 同属 `platform-ops`、import 是上下文内的不产生 cross-context-import，但 `audit-domain-event-subscriber.ts` 这类名字会被判 `unclassified-file`，产生 r7 里没有的新键、comparator 直接红——**文件命名先于第一行 import 决定闸门结果**，C10。此结论写进 design 供第 3 刀继承。）
- `scripts/ratchets/r11.json` — count 9→8 + samples 刷新 + `change` 字段记录本刀的燃尽口径。
- `deploy/DEPLOY.md` §14 — 见 What Changes 末条。
- **不触碰**：`packages/contracts/**`（硬约束）、`apps/api/src/tasks/tasks.service.ts`、`app.module.ts`、`domain-events/` 的公共导出形状。

**测试与验收**

- 零行为改动的证明基线：135 `test()` / 6 `.spec.ts` / 8 `.test.mjs`（P3）。`.test.mjs` 按第一刀纪律**单列口径**（A11）。
- 需要复核的三个真实 audit 断言热点（**不是**任务描述指向的 `guardrails.service.spec.ts:412-474`，那是 diagnostics 的 `beginAttempt` 顺序测试、与 audit 无关，A11）：`guardrails-durable-launch-decision.spec.ts` 46 处（顺序型 `:2108`/`:2283`）、`delivery-results-surfaced-and-audited.test.mjs` 61 处、`guardrails.service.spec.ts` 14 处（交错型 `:2830`，用 `auditStarted` 钉同步顺序）。推荐默认范围下这三处**预期零改动**——若任何一处必须改，说明删除 `:1197` 改变了行为，按 A12/D5 **错的是改动不是测试**。
- 目录外必改一条（C12）：`domain-event-bus.service.spec.ts:265-267` 的 `test('this change registers zero subscribers')`。推荐默认范围下订阅者数仍为 0，故**本刀不改它**；但若 Q1 取 (b)/(c)，它必然红，届时改成"恰好注册 N 条且每条 eventType 在目录内"而非删掉。
- 会静默漂移的 inline 源码镜像（C16）：`delivery-results-surfaced-and-audited.test.mjs` 自建 harness 逐行复刻 `deliverResult` 并断言 `recordChangeRequest` 调用一次、参数含 url/number/reused，**不读真实源码所以不会自动变红**。`recordChangeRequest` 的处置一旦改变（Q3），必须同 PR 更新，否则留下"断言强度还在但对象已不存在"的假绿。
- 源码文本扫描面（C17）：`guardrails-domain-event-publishing.spec.ts:484-535` 用全文件正则 `countOf(source, 'task\\.settled')` 对三个文件计数钉死——在 `guardrails.service.ts` 里写任何含带引号事件名的注释都会打红；裁定说明写进独立工件，不写进源码注释。
- 运行时耦合探针（A14）：跑 `sandbox-host-harness-wiring.test.mjs` 与 audit 相关的文本扫描测试；日志 context 是被断言的行为（自建 Logger 即红）。
- 闸门：`node scripts/ratchets/r11-dependency-budget.mjs` 活测取新基线（**不在 propose 阶段预测死**，A5）+ context-layout-v2 + api-module-layout-check + test-discovery + `public-surface-adversarial`（sidecar 声明 unchanged 也要真跑，A13 有 NOT-ARCHIVABLE 判例）。

**Sidecar / 公开面**

现有 `unchanged×4 + protocolDifferences []` 经复核**合法**，且只在完全不碰 `packages/contracts/src/**` 时成立（C19/A17）：分类器规则表里只有 `contracts` 一条能映射到四公开面，`apps/api/src/audit/**`、`apps/api/src/guardrails/**`、`scripts/ratchets/r11.json` 都不匹配。`internalOnly.scope` 需按最终范围改写——现文写着"guardrails 移除对应的 best-effort 同步 audit 调用"与"R11 从 9 降至保留的回执调用数"，两句在推荐默认范围下都不准确。

**Non-Goals**（每条都是后续一个独立 change）

1. 扩充事件目录（给 `TaskSettled` 加 `cause/exitCode/abnormal/tail`、给信封加 actor、新增 delivery 类事件）——W16 治理判据要求它另开 change，享有第一刀给原五个事件的同等目录 + schema 审查。
2. 把 `tasks.service.ts` 的 `recordTransition/recordTaskCreated` 改为订阅（图纸 §C 的原意，被 P1 阻塞于上一条）。
3. metrics / diagnostics / transcript 收尾 / runner 计费改订阅（第 3–5 刀）。
4. 解 tasks↔guardrails forwardRef 环（第 6 刀）。
5. 引入 outbox / publication registry——把**带回执**的两处上总线的唯一正确做法（W5 · Spring Modulith：每个 (event, listener) 在原事务内写一行，失败留 incomplete、重启重投），需要一次 Prisma migration，本刀声明零 migration。**否决理由是范围而非原则**：记成"若后续某刀要把这两处上总线，必须先加一张 publication registry 表"，这同时给第 3 刀（runner 计费，静默丢 = 漏账）留了具体升级路径。
6. 把 audit 改成异步/入队——W15 明确的**反向**改动，会把系统从 SOC 2 合规列移到被标记列；本刀把它写成显式负向 requirement 预先堵死。

**待拍板**（逐条见 `research-brief.md` §5）

- **Q1（阻塞全局）** 四处 best-effort audit 全部无事件覆盖，取 (a)/(b)/(c)/(d) 哪个结局？本文推荐 **(a)**，理由是 (c) 被 P1 挡住、(b) 按治理判据应另开 change、(d) 会让第一刀建好的规则空转到第 3 刀。附带确认：是否随之改名。
- **Q2（仅在 (b)/(c) 下存在）** 第二刀自己的 cutover 开关形态；子问题"被 flag 关掉的代码算不算进 `guardrails-symbol-reference:this.audit`"直接改变 R11 目标数（W13/A9）。推荐默认范围下本问题**消失**，这是选 (a) 的一项实质收益。
- **Q3** `recordChangeRequest` 的处置：(a) 本期保留调用（推荐，成本最低）；(b) 随事件目录扩充 change 处理。无论哪个，`delivery-results-surfaced-and-audited.test.mjs` 的 inline 镜像必须同 PR 跟随。
- **Q4** `deploy/DEPLOY.md` §14 的改写范围：表格行与 `:876-880` 散文哪些句子必须改、是否顺带登记退役条件（W13：开源项目里约 75% 的 toggle 存活 49 周）。
- **Q5（阻塞 spec delta 写法）** 第一刀的归档 PR 与本刀的先后顺序。`openspec/specs/domain-event-bus/` 在本树**不存在**（归档提交 bebd211 只在 `chore/archive-domain-event-bus` 分支，C1/A2 两路独立证实），`## MODIFIED Requirements` 指向 domain-event-bus 的需求在归档 PR 合并前**无锚点**；若不先归档，两份 delta 会对同一 capability 重复 ADDED。
