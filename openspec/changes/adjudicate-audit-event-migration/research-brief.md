# adjudicate-audit-event-migration 研究简报

> 阶段 4 第二刀（图纸：`docs/refactor/08-ddd-target-architecture.md` §C）的前置研究汇总。
> 三路并行调研：**Web**（外部实践与判例）、**Codebase**（仓内现状实测）、**Archive**（归档 change 与直接前作 `add-domain-event-bus` 的判例）。
> 每条结论带编号（W#/C#/A#），文末「Implications for the proposal」按本 change 的五个设计接缝 (A)–(E) 交叉引用这些编号。
> 本简报只汇总证据与推论，**不代替 proposal/design 的拍板**。需要用户拍板的点集中列在末尾「必须拍板 / 开放问题」。
>
> ⚠ **读者先看这一条**：Codebase 路线得出了一条阻塞性结论（C2/C23）——按当前事件目录，guardrails 里 5 处可摘的 best-effort `this.audit` 调用**没有一处**能被第一刀已发布的 5 个事件覆盖。本 change 在不拍板的情况下**可迁移量为 0**。propose 之前必须先解决 Q1。

---

## 1. Web 路线 — 外部实践与判例

### 1.1 「保留为调用」这一判定的外部命名与背书

**W1 · 业界给这个错误起过名字：passive-aggressive event**
「形状是事实、真实意图却是让某个已知消费者做特定的活并把结果交回来」的消息，就是 passive-aggressive event。Oskar Dudycz 的判据可逐字抄：*"If we'll always have a single consumer for an event that needs to run the specific logic and expect to get the particular event back, then it should be a command."* Martin Fowler 被引用为同一说法的出处（"events as passive-aggressive commands"）。
证据：https://event-driven.io/en/passive_aggressive_events/ ；https://sarahtaraporewalla.com/architecture/commands-not-passive-aggressive-events
意义：这是本 change **核心分流决策**可引用的、有名字的正当性来源。`recordProvisioningFailure`（~3787）与 `recordTaskCancellation`（~3815）恰好三条全中：单一消费者、跑特定逻辑、返回一个调用方要分支判断的 durability 回执。把它们事件化就是教科书级的 passive-aggressive event。→ 在 spec 的负向 requirement rationale 与工件 08 §C 非事件清单里**逐字使用这套词汇**，把「我们觉得该保留」变成一条公认的架构规则。

**W2 · Kubernetes 用两档持久性档位跑同一个审计子系统，且给了现成档位名**
`batch`（缓冲、异步——*"if the rate of incoming events overflows the buffer, events are dropped"*）、`blocking`（API 响应等待每条事件）、`blocking-strict`（*"Same as blocking, but when there is a failure during audit logging at the RequestReceived stage, the whole request to the kube-apiserver fails."*）。
证据：https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/
意义：现存最好的先例，证明一个严肃的审计子系统**故意在同一产品里跑两档持久性**，而不是二选一。它把本 change 的分流（best-effort → 事件 vs 回执 → 保留调用）正当化为**设计**而非妥协，并给了现成命名：7 个 best-effort 调用点属 `batch` 档（可丢），2 个回执调用点属 `blocking-strict` 档（失败必须对调用方可见）。→ 建议在 spec 里**显式命名这两档**，让第 3–5 刀直接继承分类，而不是每刀重新辩论一次。

**W3 · 第一刀的 bus 契约已在机制层写死「回执不可能跨过总线」**
`domain-event-bus.port.ts` 的 CONTRACT 写明 publish 是同步的、BEST-EFFORT PER SUBSCRIBER（*"A throwing subscriber neither stops the ones after it nor escapes to the publisher — `publish` returns normally either way"*），且未通过目录校验的 payload 是 *"dropped and logged, never thrown back at the publisher"*。
证据：`apps/api/src/domain-events/domain-event-bus.port.ts:17-31`；`apps/api/src/domain-events/domain-event-bus.service.ts:84-136`
意义：这是比任何外部引用都强的机制级证明——**总线根本没有回程通道**，`recorded` 布尔在物理上活不过这一跳。→ 负向 requirement 应写成**总线契约的性质**（「总线返回 void 且按设计吞掉订阅者失败，因此任何调用方需要分支判断审计结果的调用点 MUST 保持为直接 port 调用」），而不是逐个案例的判断。这样它对第 3–6 刀是自执行的。

**W4 · Spring 的 transaction-bound 事件监听器有完全相同的限制，且被记录为已知坑**
*"Spring framework simply logs exceptions that are thrown from @TransactionalEventListener and does nothing else."* AFTER_COMMIT 监听器还在事务资源关闭之后运行，其写入不会加入原事务。
证据：https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html ；坑的讨论 https://dev.to/haraf/understanding-transactioneventlistener-in-spring-boot-use-cases-real-time-examples-and-4aof
意义：独立佐证「监听器吞掉失败」是进程内事件总线的**框架级正常语义**，不是本仓实现的怪癖。→ 写进 design，堵住评审提出「让订阅者把异常抛回来不就保住回执了」这条路。

**W5 · 唯一在保住持久性的同时走总线的主流框架是 Spring Modulith，靠的是 Event Publication Registry**
每个 (event, listener) 在原事务内写一行，监听器成功则标记完成、失败则留 incomplete，重启时重新投递（`spring.modulith.events.republish-outstanding-events-on-restart`）；2.0 加了 staleness monitor。
证据：https://docs.spring.io/spring-modulith/reference/events.html ；https://deepwiki.com/spring-projects/spring-modulith/3.1-event-publication-registry
意义：这是 design 需要的「已考虑并否决的备选」条目。它说明把带持久性回执的调用点事件化的**唯一正确做法是 outbox / publication 表**——而那需要一次 Prisma migration，本 change 声明零 migration。→ 否决理由是**范围**而非原则：记成「若后续某刀要把这两处放上总线，必须先加一张 publication registry 表」。这同时给第 3 刀（metrics + `runnerMinutes` 计费，静默丢 = 漏账，见 port 自己的 D2 注记）留了一条具体的升级路径。

**W6 · 本仓避开的默认 NestJS 路径正是业界最常见的陷阱**
`@nestjs/event-emitter` 同步 emit 且**不隔离** handler 错误——`@OnEvent` 里的异常会传播回发布者，且 Nest exception filter 抓不到。社区解法是包一层在 `setTimeout` 里 catch 再 rethrow（MetaMask `safe-event-emitter`）。
证据：https://github.com/nestjs/event-emitter/issues/52 ；https://github.com/MetaMask/safe-event-emitter
意义：两个用途。（1）正面：第一刀手写 bus + per-subscriber 错误边界的做法对「为什么不用 @nestjs/event-emitter」是站得住的，放进 design 的 prior-art 段。（2）**对本 change 的警示**：audit port 的 CONTRACT（「best-effort … MUST NOT throw」）此前由 **port 实现**负责兑现；一旦 audit 变成订阅者，必须确认这条不变量在**两层**都被强制（订阅者函数体 + 总线边界）——否则「audit 抛错不可能发生」被静默降级成「记一条 warn」，这是一个**关闭开关也看不出来的真实行为差**。

### 1.2 事件负载的形状与耦合

**W7 · thin vs fat 事件的取舍**
thin 事件迫使消费者回调生产者取缺失数据，重新制造运行时耦合；fat 事件（event-carried state transfer）避免回调，但有过度暴露生产者内部、把留存/PII 责任扩散给消费者的风险。
证据：https://www.thoughtworks.com/insights/blog/architecture/thin-events-the-lean-muscle-of-event-driven-architecture ；https://codeopinion.com/thin-vs-fat-integration-events/
意义：这给出一条 change spec 尚未点名的 **pre-apply 工作项**：对每个被摘掉的 `this.audit.*` 调用的实参，与第一刀冻结的 TaskAdmitted / SandboxProvisioned / TaskSettled / TaskSuperseded schema 的 payload 做**逐字段 diff**。若订阅者不得不注入 guardrails/tasks 去补字段，则第 6 刀要打破的 tasks↔guardrails 环会**从 audit 模块绕回来**——R11 的数字下降而真实耦合上升。→ 该 diff 属于研究/设计工件；任何缺口都是与 `recordChangeRequest` 并列的第二个 open question。**（Codebase 路线已把这条 diff 做完，结论是四处全部落空，见 C2。）**

**W8 · GitLab —— 产品级审计轨迹最接近的大规模先例 —— 走的是相反方向**
它**废弃**了「继承 AuditEventService 并在动作之后调用」的风格，改为在 service 层调用单一入口 `Gitlab::Audit::Auditor.audit`，在请求内同步持久化，多事件块用 thread-local `EventQueue` + 批量插入，并明确记载块形式 *"does not support asynchronous actions or multi-process spans"*（这类场景改用直接调用并显式传 `created_at`）。它还有跳过 DB 持久化的 "streaming-only events" 供高频动作使用。
证据：https://docs.gitlab.com/development/audit_event_guide/ ；重构范例 https://gitlab.com/gitlab-org/gitlab/-/merge_requests/108918
意义：两件事值得抄进 design。（1）**要诚实处理的反证**：一个成熟的审计产品把**埋点**集中化了，却没有把 audit 变成 pub/sub 订阅者——所以本 change 的收益是 guardrails 的依赖预算（R11），**不是审计正确性**，spec 应当直说。（2）他们对 async / 跨进程 span 的明确警告可直接映射到 TaskSettled：若结算发布点所在的调用栈（boot re-adoption、detached tmux 回收）与旧调用点不同，审计行的时间戳/actor 上下文会漂移。→ 写一条正向 requirement：**订阅者的时间与 actor 一律从事件 payload 派生，绝不从环境请求上下文取**。

### 1.3 验收方法论（对应验收项 1/3/4 与 (C)）

**W9 · ArchUnit 的 `FreezingArchRule` 是「只减不增」基线的标准形态**
首次运行把当前违规记进 store，只对**新增**违规失败，并**自动**把已修复的违规从 store 里移除，因此「允许的违规基线只能缩小，不能增长」。
证据：https://loiane.com/2026/07/architecture-testing-java-archunit/ ；模式讨论 https://aipatternbook.com/architecture-fitness-function
意义：印证 R11 的设计，但也点出一处**有意的分歧**需要写清：ArchUnit 自动缩小，本仓 comparator 是**双向 fail-closed**（下降却不更新基线也是红）。自动缩小优化开发摩擦，fail-closed 优化留痕。本 change 是第一个真正让 R11 数字动起来的 change（9 → 保留的引用数），→ 在 design 里花一行说明**这是有意选择**，否则第一个撞上「我修好了 CI 反而红了」的人会去「修」comparator。

**W10 · Characterization / golden-master 测试是验收项 (3) 的标准技法**
先记录改前代码的可观测行为，再断言重构后复现它；文献特别推荐在「逐属性手写断言不可维护」时使用，并区分 characterization test（意图：钉住既有行为）与 approval test（工具：与批准过的快照比对）。
证据：https://en.wikipedia.org/wiki/Characterization_test ；https://understandlegacycode.com/blog/characterization-tests-or-approval-tests/
意义：给「迁移前后同一任务生命周期产生的审计行集合相同（顺序可不同）」一个标准实现形状：用 recording fake 抓一个固定生命周期场景的审计行集合，开关 OFF 时快照为 golden master，开关 ON 时断言**集合相等（顺序无关）**。⚠ 注意总线是**按注册顺序同步分发**的，所以单次 publish 内部顺序是确定的——唯一正当的乱序来源是**发布点位置与旧调用点不同**。→ 顺序无关的豁免必须**窄范围限定到这一条**，不能给整张断言开空白支票。

**W11 · 「同步顺序交错断言」的失败模式在测试坏味文献里有名字**
over-mocking / interaction-choreography 把测试耦合到实现而非行为，于是「行为完全相同的重构也会让它红」。处方是**通过公共面断言状态/结果**，只 mock 真正的边界——不是删掉测试。
证据：https://bool.dev/blog/detail/top-10-unit-testing-antipatterns-in-dotnet ；https://qaskills.sh/blog/test-smells-anti-patterns-guide-2026
意义：给 change 要求的「tasks.md 逐条留痕」提供有原则的改写规则：每条被改写的断言必须声明它编码的是 (a) **实现细节**——某方法内部的同步调用顺序——此时替换为「操作完成后审计行集合」的结果断言；还是 (b) **真实需求**——例如「准入行持久之前不得出现审计行」——此时必须**重新表达为对发布点的顺序要求并保留**，而非放宽。把 (a)/(b) 分类做成留痕模板，就在构造上堵死了 change 自己申明的风险（「静默调整断言让它变绿」）。

**W12 · GitHub Scientist 是「证明新旧两条路径结果一致」的成熟机制**
两条路都跑（顺序随机化）、比对结果、记录不匹配；其自身指引是：**写路径**要改造两个系统，然后 *"verify the results at read time with science"*，而不是盲目双写。
证据：https://github.com/github/scientist ；https://github.blog/developer-skills/application-development/scientist/
意义：对验收项 (4)「开关关闭 = 迁移前行为的活证」而言，这是比人工活验更便宜也更强的兑现方式：在**一个测试里**把同一生命周期夹具跑两遍（每种开关状态一遍）打到 recording audit fake 上，diff 两份行集合。⚠ 写路径的告诫很关键：**不要**在生产里对真 recorder 同时跑两条路（会写重复审计行）；比对属于测试夹具，运行时开关保持纯粹的二选一。

**W13 · branch-by-abstraction + toggle 是本次切换的标准模式，但 toggle 债是实测存在的**
flag 管理文献引用的研究显示开源项目中约 **75%** 的 toggle 存活长达 49 周；Fowler 的指引是 release toggle 短命，rollout 完成即须退役。
证据：https://continuousdelivery.com/2011/05/make-large-scale-changes-incrementally-with-branch-by-abstraction/ ；https://flagshark.com/blog/feature-flag-technical-debt-guide/
意义：本 change 继承第一刀的开关框架与退役纪律 → 在 tasks.md 里把**退役触发条件写明并定期**（例如「不晚于第 4 刀 / provisioning diagnostics 一并删除」）。不写的具体代价：两条路都要一路绿到第 3–6 刀，于是每一次后续横切迁移都要在 guardrails 的百余条测试上付双份维护；而且 **R11 的数字会变得含义不明**（旧调用点仍以 flag 分支形式存在）——**必须决定并写明：被 flag 关掉的代码算不算进 `guardrails-symbol-reference:this.audit`**，这个决定直接改变 ratchet 的目标数。

**W14 · 事件驱动系统的测试指引把「验证负向结果」列为一等义务**
*"no orphaned events, no silent data loss"*——因为 pub/sub 解耦意味着生产者无从知道有没有人在听。
证据：https://totalshiftleft.ai/blog/testing-event-driven-microservices
意义：直接服务验收项 (C) 事件覆盖对账。→ 建议一条**表驱动测试**，对第一刀的每个事件类型断言**已注册订阅者名字的精确集合**，绑定到第一刀刻意保留为可枚举数组的 `DOMAIN_EVENT_SUBSCRIBERS`（`apps/api/src/domain-events/domain-event-bus.port.ts:39-47`）。这条测试正是阻止第 3–6 刀静默孤儿化某条审计路径的东西，而且因为注册是**有类型的数组**而非装饰器发现，它很便宜。

### 1.4 合规与治理

**W15 · SOC 2 实务指引把审计轨迹的「完整性」列为最常见的 finding**
不是访问控制，而是「是否所有关键组件都埋了点」；并规定事件应**实时**捕获，批处理带来数小时延迟的日志被视作弱点；理想是**在与动作同一事务内同步捕获**。
证据：https://auditkit.dev/blog/soc-2-audit-log-requirements
意义：把「覆盖对账」从内部整洁规则升级为合规级要求，值得在 spec 里写成正向条款（「每一处被移除的同步调用，其审计语义 MUST 可从至少一个已发布事件的订阅者路径抵达；未被覆盖的调用点 MUST 保持为调用」）。它同时**预先堵死**一个看似合理的未来「改进」——把 audit 订阅者改成异步/入队——那会把本系统从合规列移到被标记列。→ 趁词汇还热，把它写成一条显式负向 requirement。

**W16 · 事件目录治理把「新增一个事件类型」当作有 owner、有下游消费者记录的受审查变更**
存在专门在 PR 上审查 schema 变更的工具（EventCatalog governance GitHub Action）；共识是**光有 schema registry 是必要但不充分的治理**。
证据：https://github.com/event-catalog/governance-action ；https://medium.com/towards-data-engineering/schema-registry-event-catalog-the-missing-piece-in-governing-event-driven-architectures-0cecb98a0ecd
意义：为 change 的规则「不得擅自新增事件 → 升级 open question」提供外部背书。它还提示了 `recordChangeRequest` 的推荐解法形状：选项 (a) 本期保留该调用 是低风险默认，且保住 R11 目标的诚实性；选项 (b) 扩充事件目录 应当**另开一个 change**，让新事件类型享有第一刀给原四个事件的同等目录 + schema 审查——**不要**追加进一个声明 contracts 未触碰的 change。

### 1.5 本 change 目录的当前状态

**W17 · change 目录目前只有 `.openspec.yaml`（2026-08-01 建）与 `surface-impact.json`**
sidecar 已声明 publicV1 / mcp / openapi / apiPlayground 四面全部 `unchanged`、`protocolDifferences: []`，其论证建立在「事件 payload schema 已在第一刀落地、本 change 不碰 contracts」这一断言之上。
证据：`openspec/changes/adjudicate-audit-event-migration/surface-impact.json`
意义：研究阶段复核该断言有个具体的检验点：四个事件类型定义在 `@cap-console/contracts`（被 `apps/api/src/domain-events/domain-event-bus.port.ts:1` 导入），且 `apps/api/src/v1/v1-events.controller.ts` 存在——所以只要 audit 订阅者缺任何一个 payload 字段（见 W7 与 C2/C5），修法必然要改 contracts，sidecar 立刻翻 `derived` 并承担 protocolDifferences 转录义务（阶段 2 教训）。→ **必须先解决 payload 覆盖 diff，surface-impact 才能维持现状。**

---

## 2. Codebase 路线 — 仓内现状实测

### 2.1 阻塞结论：事件覆盖全部落空

**C1 · 前提修正：第一刀已合并 main 但尚未归档，`openspec/specs/domain-event-bus/` 不存在**
其 spec delta 仍只在 change 目录里。
证据：`git log` 4c91b54（feat(events): add the in-process domain event bus…）；`ls openspec/specs/domain-event-bus` → No such file or directory；`openspec/changes/add-domain-event-bus/specs/guardrails/spec.md` 存在
意义：第二刀写 spec delta 时的「上游 spec」只能引 `openspec/changes/add-domain-event-bus/specs/{domain-event-bus,guardrails}/spec.md`，**不能**引 `openspec/specs/domain-event-bus/`；且落地前后要确认第一刀的归档顺序，否则两份 delta 会对同一 capability 重复 ADDED。直接决定 spec delta 的 header（ADDED vs MODIFIED）与引用路径，写错会在 opsx-verify 的 spec 归属检查上红。

**C2 · 【本 change 的核心结论】guardrails 里 5 处可摘的 best-effort `this.audit` 调用，没有一处能被第一刀已发布的 5 个事件覆盖**
四种审计行各自需要的数据在 v1 payload 里**全部不存在**。事件目录只有 `task.settled{status}`、`task.admitted{admissionMode,outcome,fenceToken}`、`sandbox.provisioned{admissionMode,providerFamily,sandbox,environment}`、`task.superseded{observationPoint,fenceToken?,observedStatus?}`、`task.run_started{startPoint,admissionMode?}`。
证据：`packages/contracts/src/domain-event.ts:258-335`（五个 payload 全文）vs `apps/api/src/audit/audit.service.ts:106-289`（四个写入方法各自消费的字段）
意义：(C) 事件覆盖对账不是「查一下有没有漏网」，而是**四处全部落空**。按约束「不得擅自新增事件」，四处都必须升级为 open question 交用户拍板，**本 change 的可迁移量可能为 0**——这是 propose 前必须先解决的阻断问题。

**C3 · `recordForceFailed`（guardrails.service.ts:3529）结构上不可事件化**
审计行类型是 `force_failed:${cause}`（deadline/idle/circuit_breaker/…），而 `TaskSettled` 只带 `status`，不带 cause；更关键的是该调用被包在 `if (this.terminalTaskStatuses.get(taskId) === terminal)` 里——注释明写「只有本地确认的 TasksService CAS 回调才拥有 cause-specific 的 log/audit，跨副本同状态观测已在自己的线性化点发过」。`fenceTerminal` 的 `task.settled` 发布点没有这个判别信息。
证据：`apps/api/src/guardrails/guardrails.service.ts:3521-3531`；`apps/api/src/audit/audit-mapping.ts:234-236`（`forceFailKind`）；`apps/api/src/guardrails/guardrails.service.ts:2314-2325`（settled 发布点只有 status）
意义：这是「负向 requirement」的第二个实战样本：可写成『recordForceFailed SHALL 保留为调用，因为 TaskSettled 既不携带 cause 也不携带本地 CAS 归属』——判据与回执型两处并列但**理由不同**（信息缺失 vs 需要回执）。

**C4 · guardrails.service.spec.ts 里现存两条负向断言直接证明上一条**
`assert.equal(forceFailureAuditCalls, 0)` 与 `assert.equal(forceFailAudits, 0)`——远端/cancelled 赢家拿下终态时，guardrails 必须**不**写 force-fail 审计行。若把 recordForceFailed 改成 `task.settled` 订阅，这两条会变红（因为 fenceTerminal 在这些场景仍会发 settled）。
证据：`apps/api/src/guardrails/guardrails.service.spec.ts:1367`、`:2302`；stub 注入见 `:1305-1310`、`:2274-2278`
意义：这不是「同步顺序钉死、可以显式改写」的测试，而是**行为断言**——按验收 (1) 必须零改动通过。它们红了就说明迁移改变了行为，**错的是迁移不是测试**。

**C5 · `recordExited`（guardrails.service.ts:2063-2067）需要 `code / abnormal / tail`，`TaskSettled` 一个都没有**
tail 来自 `gateway.readSessionLogTail`；且现有测试钉死「审计挂起不阻塞结构化失败落库」的交错语义。
证据：`apps/api/src/guardrails/guardrails.service.ts:2044-2070`；`apps/api/src/audit/audit.service.ts:276-289`（description 由 code+reason+tail 拼装）；`apps/api/src/guardrails/guardrails.service.spec.ts:2830-2877`（`auditStarted` + 永不 resolve 的 recordExited）
意义：要事件化就得给 TaskSettled 加 exitCode/abnormal/tail 字段 → 触碰 `packages/contracts` → surface-impact 从 unchanged 翻 derived（见 C19）。这正是必须交用户拍板的 open question。

**C6 · `recordProvisioningProgress`（guardrails.service.ts:1197）是 provider composite 的 audit-only 提示**
与 admission worker 自己的两处 durable-checkpoint 调用共用同一 dedupe 身份 `task.provisioning:{taskId}:{attempt}:{stage}`。`SandboxProvisioned` 只在成功后发一次且不带 stage/attempt，无法覆盖逐阶段行。
证据：`apps/api/src/guardrails/guardrails.service.ts:1190-1202`（注释：「audit-only hints; monotonic durable checkpoints remain owned by the admission worker」）；`apps/api/src/task-admission/task-admission.worker.ts:399-405`、`:610-617`；`apps/api/src/audit/audit.service.ts:119-127`（dedupeKey）
意义：这是四处里**唯一**有「可能冗余、可直接删」论证空间的一处，但需要先证明 worker 的 checkpoint 覆盖了 provider-composite 的全部 stage——否则删除即丢行。**仍然不是「改订阅」。**

**C7 · `recordChangeRequest`（guardrails.service.ts:2770）没有任何对应事件**
交付推回发生在终态之后的 `deliverResult` 里，且 payload 需要 url/number/reused。prompt 已预判，实测确认。
证据：`apps/api/src/guardrails/guardrails.service.ts:2755-2775`；`packages/contracts/src/domain-event.ts:92-98`（DOMAIN_EVENT_TYPES 只有五个，无 delivery 类事件）
意义：open question 候选 A（本期保留调用）成本最低；候选 B（第一刀事件目录扩充另开 change）会把 contracts 拖进来。

**C8 · R11 算术上限是 9→4（不是任意值），且 `recordAudit` 会变成死代码**
保留的两处回执各自贡献 2 个 `this.audit` 引用（null 检查 + 调用）。可摘的 5 个引用是 1197(1)、2063+2067(2)、2770(1)、3529(1)。私有 helper `recordAudit` 只有这 4 个调用点。
证据：`apps/api/src/guardrails/guardrails.service.ts:1197/2063/2067/2770/3529/3778/3787/3806/3815`；`recordAudit` 定义在 `:3676`，调用点仅 `:1196/:2066/:2769/:3528`；`scripts/ratchets/r11-dependency-budget.mjs:126-139`（`\bthis\.audit\b` 逐行计数）
意义：(E) 基线目标值只能是 **4**；且 opsx-verify 历来抓「摘完留下的无调用点死代码」（add-repo-content-store 的 `remove()`、detach-workspace-clone 的 parking），`recordAudit` 必须同 PR 删除。注意 `:624` 的 `private readonly audit?: AuditRecorderPort` 写作 `audit` 不含 `this.`，**不计入 9**。

### 2.2 cutover 开关：与第一刀不兼容

**C9 · cutover 开关语义与第一刀不兼容，是本 change 最大的设计缺口**
第一刀的逃生口实现形态是「关闭 ⇒ 组合根不绑定 bus provider」，于是 `this.bus?.publish()` 全部短路。第二刀若删掉同步调用，关闭开关就等于**审计行彻底丢失**，而不是「回到迁移前」。DEPLOY.md 里现有的「closing it … every existing synchronous collaborator call still runs, and the lifecycle behaviour is byte-identical」会直接变成假话。
证据：`apps/api/src/domain-events/domain-events.module.ts:46-90`（closed ⇒ providers 数组里没有 bus）；`apps/api/src/domain-events/domain-event-publishing-cutover.port.ts:22-31`；`deploy/DEPLOY.md:876-880`
意义：必须在 design 里拍板第二刀自己的开关形态：(a) 复用 publish 开关但把旧调用留在其逆条件下（则 `this.audit` 引用数不降、R11 归零失败）；(b) 新增一个**订阅侧** cutover（第二个逃生变量，DEPLOY.md §14 再登记一行 + 退役条件）；(c) 其它。验收 (D)「关闭即逐字节一致」的活证只有在 (b)/(c) 下才可能成立。

### 2.3 落位、注册与闸门

**C10 · 订阅者的落位与文件名直接决定 r7 是否新增条目**
`audit` 与 `domain-events` 同属 `platform-ops` 上下文，所以 audit→domain-events 的 import 是**上下文内**的，不产生 cross-context-import；但层方向按文件名后缀判定——`*.service.ts` ⇒ application（可 import `.port.ts` 的 domain 层，合法）；**任何不匹配后缀表的文件名（例如 `audit-domain-event-subscriber.ts`）会被判 `unclassified-file`，产生一个 r7 里没有的新键，comparator 直接红**。
证据：`docs/refactor/contexts-manifest.json` 的 `contexts.platform-ops.directories` 含 `audit` 与 `domain-events`；`layers.fileClassification.rules`（.service.ts→application、.port.ts→domain）；`scripts/ratchets/comparator.mjs:175-180`（无基线条目的违规 = 红）；r7.json 现存同类样本 `unclassified-file:apps/api/src/audit/audit-mapping.ts`
意义：「新增/改动的闸门走 gate canon 全套 + r7 不上升」的具体兑现方式：订阅者必须命名为 `*.service.ts`（或同 PR 给 r7 加条目并说明——但那与「不上升」矛盾）。api-module-layout-check v1 只查相对路径与目录环，单向 audit→domain-events 不成环，实测两个闸门当前全绿。

**C11 · 订阅者注册有两条已存在的路，各有代价**
(1) 静态数组 `DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS`（README 声称「每个阶段 4 迁移加一条」）——但它是 `Object.freeze([])` 的**模块级常量**，装不下需要 DI 的 `AuditService`，必须改成 `useFactory + inject:[{token: AUDIT_RECORDER_TOKEN, optional:true}]`（该写法在 `guardrails.module.ts:73` 已有先例）；(2) 运行时 `bus.subscribe(handler, subscription)` 在 audit 侧 `onModuleInit` 自注册（实现已支持）。
证据：`apps/api/src/domain-events/domain-events.module.ts:26-34`、`:60-90`；`apps/api/src/domain-events/domain-event-bus.service.ts:99-111`（subscribe 实现）；`apps/api/src/guardrails/guardrails.module.ts:73`
意义：这是 (A) 的落位决策点，必须写进 design。走 (1) 会改 domain-events 目录的公共导出形状；走 (2) 则 README 的「每个迁移加一条数组项」需要同步修订，否则文档与实现分叉。

**C12 · 目录外必须显式改写的测试已确定一条**
`domain-event-bus.service.spec.ts` 有一条 `test('this change registers zero subscribers')` 直接 `assert.deepEqual([...DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS], [])`——第二刀注册第一个订阅者时它必然红。
证据：`apps/api/src/domain-events/domain-event-bus.service.spec.ts:265-267`
意义：按验收 (1)「绝不静默调整断言让它变绿」，这条必须在 tasks.md 逐条留痕：为何改、改成什么（建议改成「恰好注册 audit 一条，且其 eventType 在目录内」而不是删掉）。

**C13 · 编译期守护已经把这两处回执方法写成 `@ts-expect-error` 负例**
`bus.subscribe(audit.recordProvisioningFailure, …)` 与 `bus.subscribe((e)=>audit.recordTaskCancellation(e.taskId), …)` 都在自失效夹具里。保留它们为调用不是判断题，是**编译器强制**。
证据：`apps/api/src/domain-events/domain-event-bus.typecheck.ts:72-91`；守护类型见 `apps/api/src/domain-events/domain-event-bus.port.ts:150-166`（`VoidOnlyDomainEventHandler`）
意义：(B) 的「工件 08 §C 非事件清单第一项的实战首例」已经有编译期红证在库；spec 的正向 requirement 可以直接引用该夹具作为「守护仍然咬得住」的证据任务，**无需新建闸门**。

**C14 · 两处回执调用的真实调用点与失败语义**
都在 `recoverDurableTerminalAdmissionWithTask` 里，未确认 durability 就抛 `TaskAdmissionCoordinationError('checkpoint', …)`，从而让 running work 行保持 leased / 可回收，等 expiry recovery 重试审计边界。worker spec 有端到端证据。
证据：`apps/api/src/guardrails/guardrails.service.ts:1459`（cancellation）、`:1529`（provisioning failure）、helper 定义 `:3772-3826`；`apps/api/src/task-admission/task-admission.worker.spec.ts:1099-1120`（'pending cancellation audit leaves terminal work leased and reclaimable'）
意义：spec 的正向 requirement 应当把「回执失败 ⇒ work 保持可回收」写成场景，并把 worker spec 那条列为既有覆盖，避免被 verify 判成「只有注释没有断言」。

### 2.4 测试基线与源码文本扫描面

**C15 · guardrails 目录当前测试实测是 135 个 `test()` / 6 个 `.spec.ts` + 8 个 `.test.mjs`**
（57 + 54 + 15 + 3 + 3 + 3），不是 prompt 里的 122，也不是第一刀基线的 120——第一刀新增的 `guardrails-domain-event-publishing.spec.ts` 贡献 15 条。
证据：逐文件 `grep -c '^\s*test('`：guardrails.service.spec.ts 57、guardrails-durable-launch-decision.spec.ts 54、guardrails-domain-event-publishing.spec.ts 15、guardrails-branch-policy.spec.ts 3、semaphore-restore.spec.ts 3、transfer-progress-throttle.spec.ts 3；8 个 `.test.mjs` 见 `apps/api/src/guardrails/*.test.mjs`
意义：验收 (1) 的分母必须用实测数写进 spec（第一刀就是这么写的：「120 个 test() across 5 spec files (57+54+3+3+3)」）。抄 prompt 的 122 会被 verify 判成文档数字与树不符。

**C16 · `.test.mjs` 里有一个 inline 源码镜像会随迁移漂移**
`delivery-results-surfaced-and-audited.test.mjs` 自建 harness 逐行复刻 `deliverResult` 并断言 `recordChangeRequest` 被调用 1 次、参数含 url/number/reused。它**不读真实源码，所以不会自动变红**——这正是危险处。
证据：`apps/api/src/guardrails/delivery-results-surfaced-and-audited.test.mjs:109-114`（构造 audit）、`:192`（镜像调用）、`:285-332`（T3/T4 断言）
意义：主计划阶段 4 验收明写「4 个 inline 镜像 `.test.mjs` 同步防漂移」。若 `recordChangeRequest` 的处置变了（保留/移除/换事件），这个镜像必须同 PR 更新，否则留下一个断言强度还在但对象已不存在的**假绿**。

**C17 · 第一刀的发布点源码文本扫描断言用的是全文件正则**
`countOf(source, 'task\\.settled')` 对 guardrails/tasks/inline-admission 三个文件计数钉死（run_started 3/0/0、settled 1/0/0），并断言 `clearAdmissionRuntime` 段落内不出现 `publishDomainEvent`。
证据：`apps/api/src/guardrails/guardrails-domain-event-publishing.spec.ts:484-535`
意义：两个约束：(a) 订阅者放在 `audit/` 目录不会触发它；(b) 但**在 `guardrails.service.ts` 里写任何含 `'task.settled'` 字面量的注释都会把计数打红**——迁移期在发布点旁写说明注释时要避开带引号的事件名。

**C18 · `GuardrailsService` 不是普通类 provider**
而是 `guardrails.module.ts` 里的 `useFactory` + 位置化 `inject:` 数组。任何新增构造参数（例如为订阅侧 cutover 注入新 port）都必须同时改 module，否则依赖永远 undefined 而测试照绿——这是第一刀 tasks.md 明确记下的坑。
证据：`apps/api/src/guardrails/guardrails.module.ts:73`（audit token 的 optional inject）、`:101`/`:114`（factory 形参与实参）；`openspec/changes/add-domain-event-bus/tasks.md` 头部注释第 2 条
意义：若 design 选择「订阅侧开关注入 guardrails」，这条是硬前置；若选择开关只落在 audit/domain-events 侧则可回避——**又一个支持把开关放在订阅端的理由**。

### 2.5 公开面与图纸偏差

**C19 · surface-impact 的「四公开面 unchanged」断言复核通过，但只在不碰 `packages/contracts/src/**` 的前提下成立**
分类器规则表里只有 `contracts` 这一条能把改动映射到四公开面，`apps/api/src/audit/**` 与 `apps/api/src/guardrails/**` 不匹配任何 `PUBLIC_SURFACE_RULES`；`scripts/ratchets/r11.json` 也不在 developerWorkflow 白名单里。一旦为了覆盖 recordExited/recordForceFailed 而给事件 payload 加字段，四面立刻翻 derived，并触发 protocolDifferences 转录义务。
证据：`scripts/public-surface-files.mjs:4-14`（PUBLIC_SURFACE_RULES）+ `scripts/public-surface-adversarial.mjs:45-53`（CLASSIFIER_SURFACE_MAP.contracts → 四面）；`scripts/openspec-metadata.mjs:1070-1141`（protocolDifferences 仅在 changed/derived 时强制）；对照 `openspec/changes/add-domain-event-bus/surface-impact.json` 的 derived + 8 条 protocolDifferences
意义：直接回答研究任务里「须复核该断言」：当前 sidecar 的 4×unchanged + 空 protocolDifferences **合法**；但它同时把「不碰 contracts」变成本 change 的**硬约束**。open question 若拍板扩充事件目录，surface-impact 必须同时改成 derived 并把 8 条 protocolDifferences 原样转录。

**C20 · 负向 requirement 的可直接照抄范本，以及 R11 计数口径的 gaming 风险**
范本是第一刀 `TaskSettled` 那条 requirement 里对 `clearAdmissionRuntime` 的写法（「… is NOT a terminal settlement, and it SHALL NOT publish TaskSettled。两个 recordEnd 调用点都保持不变」+ 一条「零事件发布」场景 + 一条「全树只找到一个发布点」场景）。风险面：R11 用 `\bthis\.audit\b` 逐行正则计数，把字段改名成 `this.auditRecorder` 会让计数**瞬间归零**，配上同 PR 的基线更新就是一次**假燃尽**。
证据：`openspec/changes/add-domain-event-bus/specs/guardrails/spec.md`（Requirement: TaskSettled is published only at the terminal fence 全节）；`scripts/ratchets/r11-dependency-budget.mjs:31-38`（计数约定）、`:126-139`（正则实现）
意义：(B) 有现成句式；(E) 的留痕除了改 count 之外，还应在 tasks.md 记一条「字段名未变、9→4 的差值逐处对应到被摘的 5 个引用」的对账，堵住 verify 期最容易被质疑的假燃尽路径。

**C21 · cutover 开关的登记位与退役纪律已经建好表**
DEPLOY.md §14「Registered cutover toggles (documented-only, no wiring)」只有一行 `CAP_DOMAIN_EVENT_PUBLISHING_ENABLED`，owner 写的就是「本 change 及其五个后继订阅迁移 change 的 owner」，退役条件是「由阶段 4 最后一刀（解 forwardRef 环）连同组合根分支与本行一起删除」。
证据：`deploy/DEPLOY.md:841-880`
意义：(D) 若新增第二个开关，照这张表加一行（变量名/默认值/owner/退役条件）即满足纪律；同时 `:876-880` 那段「关闭即逐字节一致」的说明**必须随本 change 改写**，否则文档与新行为不符。

**C22 · 新增的订阅者测试文件无需任何注册即可被发现**
apps/api 的编译套件 glob 是 `dist/**/*.spec.js`，源码套件是 `src/**/*.test.mjs`（走 run-suite.mjs，空扫描即败）。放在 `apps/api/src/audit/` 下的 `*.spec.ts` 构建后自动进套件。
证据：`apps/api/package.json` 的 `scripts.test` / `test:compiled` / `test:src`
意义：避免重复第一刀「新目录/新测试挂载单独验收」的顾虑；但仍需按 gate canon 给任何**新建闸门**配对自测——本 change 目前**没有新建闸门的必要**（守护走既有 typecheck 夹具 + 既有 R11/R7）。

**C23 · 图纸 §C 的事件→订阅者表与 guardrails 的实际 `this.audit` 调用不是同一批东西**
§C 把 audit 列为 TaskAdmitted/SandboxProvisioned/TaskSettled/TaskSuperseded 的订阅者，那对应的是**生命周期转移审计**（`recordTransition`，调用点在 `tasks.service.ts`），而 guardrails 的 4 处 best-effort 调用是 provisioning-progress / exit-detail / change-request / force-fail 四种**细节审计**。R11 只测量 `guardrails.service.ts`，所以「照图纸做订阅」与「把 R11 的 this.audit 燃尽」是**两件不同的事**。
证据：`docs/refactor/08-ddd-target-architecture.md:52-63`（事件表）vs `apps/api/src/tasks/tasks.service.ts:1066/1633/2001/2181/2541/2587`（recordTaskCreated/recordTransition 调用点）vs `apps/api/src/guardrails/guardrails.service.ts` 的 9 处；`scripts/ratchets/r11-dependency-budget.mjs:55`（SOURCE_REL 只有 guardrails.service.ts）
意义：这是把 C2 的阻断结论解释清楚的**根因**，也是给用户拍板时的第三个候选：把本刀重新定义为「audit 订阅 TaskAdmitted/TaskSettled 接管 tasks.service 的 recordTransition」——那样事件覆盖成立，但 R11 的 `this.audit` **一分不降**，(E) 的 ratchet 目标要改写。

---

## 3. Archive 路线 — 归档 change 与前作判例

### 3.1 结构范本与 spec 写法

**A1 · 直接前作 add-domain-event-bus 的工件骨架是本 change 唯一应照抄的模板**
proposal(69) + design(236) + tasks(278，带 34 行 track 分区注释头) + specs/domain-event-bus(369) + specs/guardrails(196) + research-brief(425) + verification-report(225) + surface-impact.json(78) + .openspec.yaml(2)。design 用 D1–D17 编号决策、每条带 Alternative rejected；proposal 用 **W/C/A 溯源标注**（W=Web 实测、C=Codebase 实测、A=Archive 判例）逐句挂证据。
证据：`openspec/changes/add-domain-event-bus/`（proposal.md / design.md / tasks.md / specs/*/spec.md / verification-report.md）
意义：第二刀直接沿用同一骨架与溯源标注制度，省去重新发明结构；design 的 D 编号还要被本 change 引用（如「负向要求范本 = D11」「逃生口形态 = D14」）。

**A2 · 第一刀在本工作树上尚未归档**
代码已合并（4c91b54 + merge eeac7d0 在 HEAD），但归档提交 bebd211 `chore(openspec): archive add-domain-event-bus` 只存在于分支 `chore/archive-domain-event-bus`（本地 + origin），`git merge-base --is-ancestor bebd211 HEAD` 为 NO，因此 `openspec/specs/domain-event-bus/` 在本树**不存在**。
证据：`git branch -a --contains bebd211` → chore/archive-domain-event-bus；`openspec/specs/` 无 domain-event-bus 目录
意义：本 change 的 `## MODIFIED Requirements` 若指向 domain-event-bus 的需求，在归档 PR 合并前**无锚点**（openspec 校验/归档时会找不到被改的需求）。propose 前必须先确认归档 PR 合并，或把相关要求写成 guardrails/audit-history 上的 ADDED/MODIFIED。（与 C1 同源，两路独立得出。）

**A3 · 「系列中的第二刀 MODIFY 第一刀刚 ADD 的需求」有直接判例**
`converge-contracts-to-genuinely-shared` ADDED『A shared type SHALL have exactly one declaration』到 monorepo-foundation，紧随其后的 `converge-contracts-rules-that-never-run` 用 `## MODIFIED Requirements` **整段重述**该需求全文（标题 + 正文 + 全部 Scenario），而不是写 diff 或只写增量段落。
证据：`openspec/changes/archive/2026-07-30-converge-contracts-to-genuinely-shared/specs/monorepo-foundation/spec.md:3` 与 `openspec/changes/archive/2026-07-30-converge-contracts-rules-that-never-run/specs/monorepo-foundation/spec.md:55`
意义：本 change 的 spec 写法照此：MODIFIED 块必须**复制第一刀需求的完整文本再改**，不能只写「新增一句」。

**A4 · 第一刀有 4 条需求会被本 change 直接证伪，必须逐条 MODIFIED**
否则归档后 specs 自相矛盾：(1) guardrails『Guardrails publishes domain events without changing lifecycle behavior』明写『Every existing synchronous collaborator call (audit, …) SHALL be retained unchanged — this change adds a second write and removes none』；(2) domain-event-bus『Subscribers are registered explicitly…』的 Scenario『This change registers zero subscribers』；(3) domain-event-bus『The dependency budget ratchet is seeded with measured counts』把种子 `this.audit` **9** 写进需求正文；(4) guardrails『Existing guardrails behavior is proven unchanged by characterization』把「120 test() 零修改、目录外唯一允许改尾参」写成 SHALL。
证据：`openspec/changes/add-domain-event-bus/specs/guardrails/spec.md:5` 与 `:171`；`specs/domain-event-bus/spec.md:100-104`、`:352-358`
意义：这四条是本 change 的**spec 必改清单**；(4) 尤其关键——第一刀把「零测试修改」写成了需求，本 change 要显式改测试，必须把它改成「分类处理 + 留痕」的新形态而**非默默违反**。

### 3.2 R11 口径与 ratchet 纪律

**A5 · R11 的计数口径是每个符号引用，不是每个调用点**
检查器头部明写「every textual occurrence of the collaborator's symbol inside the measured file counts as one, including the constructor parameter, a pass-through, and a type annotation」，键名前缀 `guardrails-symbol-reference:` 就是为防误读成调用点数。实测 9 处 `this.audit` 中有 **3 处是守卫/判空**而非调用：`:2063 if (this.audit) {`、`:3778 if (!this.audit) {`、`:3806 if (!this.audit) {`。
证据：`scripts/ratchets/r11-dependency-budget.mjs:33-41`；`grep this.audit apps/api/src/guardrails/guardrails.service.ts` → 1197/2063/2067/2770/3529/3778/3787/3806/3815
意义：任务描述里的「9 降到保留的回执调用数（=2）」按该口径**不成立**：保留两处回执调用会同时保留它们的两处 `if (!this.audit)` 守卫，**下限是 4 而非 2**。基线新值必须用 `node scripts/ratchets/r11-dependency-budget.mjs` 活测得出，不能在 propose 阶段预测死。（与 C8 一致。）

**A6 · `scripts/ratchets/r11.json` 的 samples 行号已经过时**
记的是第一刀接线前的树（988/1794/1798/2483/3204/3453/3462/3481/3490），当前树是 1197/2063/2067/2770/3529/3778/3787/3806/3815。闸门仍绿是因为 comparator 只按 count 比对，samples 是文档。
证据：`scripts/ratchets/r11.json` 的 samples 数组 vs 当前 grep 结果；`scripts/ratchets/comparator.mjs:16`（『comparison keys on COUNT only — samples[] are documentation』）；`node scripts/ratchets/r11-dependency-budget.mjs` 现 exit 0
意义：本 change 编辑该条目时应**顺手刷新 samples**（否则留下越来越假的锚点），但**不要**把 samples 漂移当成闸门问题去「修」——它不参与比对，改 samples 不影响红绿。

**A7 · ratchet-baselines 已归档 spec 规定：条目归零时基线条目要删除**
且「total 为零的 baseline 文件本身即失败，应删除文件」；R11 检查器另外规定条目删除后仍继续测量（重新引入即红为『violations with no baseline entry』）。
证据：`openspec/specs/ratchet-baselines/spec.md:6-37`；`scripts/ratchets/r11-dependency-budget.mjs:22-30`（ENDGAME 段）
意义：audit 条目本期**不会归零**（保留回执调用 + 守卫），所以是**降数不删条目**；tasks 里要写清，避免实现者按「归零删条目」的纪律误删。

### 3.3 cutover 开关的结构性张力

**A8 · 第一刀的 cutover 语义与 DEPLOY.md 的逐字承诺**
「关闭 ⇒ 组合根根本不绑定 bus provider ⇒ 每个 `this.bus?.publish()` 短路」，并且 deploy/DEPLOY.md 逐字承诺关闭后「every existing synchronous collaborator call still runs, and the lifecycle behaviour is byte-identical」。
证据：`apps/api/src/domain-events/domain-events.module.ts:60-90`（`if (decision.enabled)` 才 push bus provider）；`deploy/DEPLOY.md:851`、`:876-880`
意义：一旦 audit 只走订阅，关闭 `CAP_DOMAIN_EVENT_PUBLISHING_ENABLED` 就等于**审计静默归零**——那句承诺当场变假。本 change 必须处理两个开关的交互（同一开关三态？两开关的合法组合矩阵？），并同 PR 改写 DEPLOY.md §14 的这段散文与表格行（表格行现写着「registers zero subscribers and removes zero existing direct calls」）。（与 C9/C21 同源。）

**A9 · 逃生口若按字面「回旧路径」实现，(D) 与 (E) 在同一实现形态下互斥**
即把被摘掉的 audit 调用保留在 `guardrails.service.ts` 的 `if (!cutover.enabled)` 分支里，则 `this.audit` 的符号引用**不会减少**，R11 基线降不下来。
证据：`scripts/ratchets/r11-dependency-budget.mjs:33-41`（符号引用口径，含 pass-through 与类型注解）+ SOURCE_REL 固定为 `apps/api/src/guardrails/guardrails.service.ts`
意义：这是本 change **最需要在 design 里拍板的结构性张力**。可选解（须交用户/design 定夺）：逃生口不复原 guardrails 内调用，而是在 `apps/api/src/audit/` 侧绑定一个「直调转发」适配器；或逃生口 = 不注册订阅者 + 由 audit 侧兜底；或接受 R11 只降到含分支的实际数。**propose 前不定，apply 期必然返工。**

### 3.4 验收基线与测试改写纪律

**A10 · 验收基线数字在任务描述里陈旧两代**
主计划写「122 测试 / 4 inline mirror」→ 第一刀实测改为「120 test()（5 个 spec：57+54+3+3+3）+ 8 个 .test.mjs（含 6 inline mirror）」→ 第一刀又新增了 `guardrails-domain-event-publishing.spec.ts`(15 test)，**当前树是 6 个 spec 共 135 个 test() + 8 个 .test.mjs**。
证据：`openspec/changes/add-domain-event-bus/design.md:17`（C16 重测说明）；实测 `apps/api/src/guardrails/*.spec.ts`：57+54+15+3+3+3=135
意义：本 change 的 characterization 基线必须重测后写死 **135/6/8**，照抄「122」会在 verify 期被判 re-baseline（第一刀 design D15 与 A2 判例都规定基线数字必须是自己树上的活测）。（与 C15 一致。）

**A11 · guardrails 套件里 audit 断言的真实分布**
`guardrails-durable-launch-decision.spec.ts` **46 处**（含顺序型断言 'cancelled terminal recovery confirms audit before exact cleanup' `:2108`、'work or Task provisioning causes audit then remove exact ownership' `:2283`）、`delivery-results-surfaced-and-audited.test.mjs` **61 处**（是 .test.mjs 脚本不是 spec）、`guardrails.service.spec.ts` **14 处**（含交错型断言 'classified exit persists one structured failure without waiting for audit' `:2830`，用 `auditStarted` 标志钉同步顺序）。**任务描述指向的 412–474 行其实是 diagnostics 的 `beginAttempt` 顺序测试，与 audit 无关。**
证据：`apps/api/src/guardrails/guardrails-durable-launch-decision.spec.ts:2108,2283`；`guardrails.service.spec.ts:2830-2877`；`delivery-results-surfaced-and-audited.test.mjs`；`guardrails.service.spec.ts:412-474` 是 'legacy diagnostics begin after the running fence…'
意义：「必须改写并逐条留痕」的清单要按这**三个真实热点**重建，而不是按 412–474。特别注意 `delivery-results-surfaced-and-audited.test.mjs` 属于 8 个 `.test.mjs` 基线，改它要**单列口径**（第一刀 A3/D15 对源码文本扫描型与脚本型测试有单列纪律）。

**A12 · `isolate-legacy-admission-behind-capability-policy` 提供了本仓「从 guardrails 摘东西」的完整判例**
D5 写死『若某测试必须改才能通过，那就是改动改变了行为，错的是改动不是测试』；D2a 处理不可避免的测试改动时的判据是『stub 的形状变，断言一个不变』（4 个 spec 只改被计数方法的名字，计数器与断言原样）。
证据：`openspec/changes/archive/2026-07-29-isolate-legacy-admission-behind-capability-policy/design.md:27-37`、`:87-118`、`:212-233`
意义：本 change 走得更远（断言真的要改），所以必须**显式超越**这条判例并说明为什么：留痕格式建议逐条给「原断言钉的是什么同步顺序 / 改订阅后该顺序为何不再成立 / 新断言改钉什么不变量」，否则 verify 会按 D5 判成 re-baseline。

**A13 · 同一判例的 `track-3-recut.md` 是「测量→决定→结果」的独立侧工件范本**
98 行：为什么停 / 四个候选切法的实测代价表 / 这说明什么 / 已做的决定 / 交付结果表；记录的最贵教训是耦合集**只向内扫**导致结论中途翻转、被迫重切。第一刀因此把「发布点双向扫描并写进 baseline」写成了 tasks 4.1。
证据：`.../track-3-recut.md:11-27`、`:79-99`；`openspec/changes/add-domain-event-bus/tasks.md:199-202`（4.1 双向扫描）与 `design.md:140-161`（D11 baseline 回写）
意义：本 change 的「9 处逐处裁定」应产出同形态的**独立 baseline/adjudication 表**（每处：file:line、返回类型、发布者是否依赖结果、判定 CALL/EVENT、对应事件、若无对应事件则升级 open question），并且必须**双向扫**：不仅问「guardrails 调了谁」，还要问「谁依赖这次 audit 写入的时序/结果」（`audit.verify.test.mjs`、delivery-results 脚本、admission work reclaim 路径）。

**A14 · 该判例还记下两处「只有跑起来才暴露、静态分析看不出」的耦合**
日志 context 是被断言的行为（自建 Logger 即红，必须经 port 延迟读取编排器字段）；一个扫源码文本的测试把「两条管线在同一个文件里」写死了（`sandbox-host-harness-wiring.test.mjs`）。
证据：`.../track-3-recut.md:92-99`
意义：audit 订阅者搬家后同样会改日志 context 与源码文本扫描面；tasks 里应预置一条「跑 `sandbox-host-harness-wiring.test.mjs` 与 audit 相关文本扫描测试，若必须改则保住按文件的断言强度」，第一刀 tasks 4.15 已有现成措辞可抄。

### 3.5 接线陷阱、既有机制与 sidecar 纪律

**A15 · 第一刀 tasks.md 的 34 行分区注释头记录了三条 apply 期实证的接线陷阱，其中两条对本 change 依然生效**
`GuardrailsService` 不是普通类 provider 而是 `guardrails.module.ts` 里的 `useFactory` + 位置化 `inject:` 数组（改构造签名必须同时改 module，否则依赖恒为 undefined、全部短路而测试照绿）；`InlineAdmissionPipeline` 由 `guardrails.service.ts:554` 位置化构造，任何要进 inline 管线的依赖只能经 guardrails 传入 ⇒ 相关文件不可拆并行轨，必须走 SERIAL 集成轨。
证据：`openspec/changes/add-domain-event-bus/tasks.md:8-21`、`:42-55`
意义：本 change 若从构造函数上**移除** audit 依赖或**新增** cutover 依赖，同样要同 commit 改 `guardrails.module.ts` 的 factory；且 `guardrails.service.ts` / `audit/` / `app.module.ts` 的共享写者仍应集中一条 SERIAL 轨。（与 C18 一致。）

**A16 · 订阅者注册接缝已经建好且带编译期守护**
`DOMAIN_EVENT_SUBSCRIBERS` 数组 token + `defineDomainEventSubscriber()`（数组注册同样过 void 守卫），`DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS` 现为 `Object.freeze([])`；非事件准入规则的散文与三条 worked example（含 audit port『ordinary recorders 返回 `Promise<void>` 是 best-effort，terminal detail 返回 `Promise<boolean>` 是 CALL』的原文论证）已写在 port 与 README。typecheck 夹具已把 `recordProvisioningFailure` / `recordTaskCancellation` / `isEnabled` / `lease.authorize` 钉成负例。
证据：`apps/api/src/domain-events/domain-event-bus.port.ts:45,177-190`；`apps/api/src/domain-events/domain-events.module.ts:33`；`apps/api/src/domain-events/README.md`
意义：本 change 的「两处回执调用保留为 CALL」**不需要新建机制**，只需引用既有守护并在 spec 里把它从『worked example』升格为『实战首例』；README 里那段「port 不是统一的 best-effort，所以判据是返回语义不是『audit』这个词」的论证可逐字复用进 proposal/spec。（与 C13 一致。）

**A17 · sidecar 的公开面声明从第一刀的 `derived ×4 + protocolDifferences 8 条` 变成本 change 的 `unchanged ×4 + protocolDifferences []`**
后者与 8+ 个归档判例一致（unchanged 一律配空 pd；derived/changed 才转录那 8 条标准清单）。第一刀之所以 derived，是因为 `packages/contracts/src/domain-event.ts` 被 index.ts 再导出，触发了 `CLASSIFIER_SURFACE_MAP.contracts` 的保守映射。
证据：两份 surface-impact.json 对照；归档统计：converge-contracts-* / close-gate-blindspots / enforce-boundaries-from-manifest 等 unchanged 均 pd=0，unlock-extension-axes derived 则 pd=8
意义：`unchanged` **只在完全不碰 contracts 时成立**。研究阶段一旦发现要给事件目录加字段（例如 audit 订阅者缺上下文），sidecar 必须翻 derived 并转录那 8 条 protocolDifferences，并按第一刀 D17/tasks 4.18 补一条「四面零 import 事件目录 + 真跑 `public-surface-adversarial`」的可复算证明（sidecar 造假有 NOT-ARCHIVABLE 判例）。（与 C19 一致。）

**A18 · 第一刀的 verification-report 结构可直接复用**
① 判定统计表（UNMET / SPEC-DEFECT / MET 三路）② 『Evidence actually executed on this tree』命令-结果表（typecheck / r11 / context-layout-v2 / contracts-executed-schema-check / api-module-layout-check / test-discovery / `node --test` 计数 / run-suite / public-surface-tests fast）③ 逐需求 re-trace 表 ④ 公开面裁定 ⑤『Scope findings（超出 spec 的实现，记录但不阻塞）』。第一刀在 ⑤ 里记了 4 项自造范围（DI logger token 未绑定、cutover 的 explicitly-enabled 分类、unset vs unrecognised 来源区分、R11 的 symbol 文档漂移校验）。
证据：`openspec/changes/add-domain-event-bus/verification-report.md:6-52`、`:55-89`、`:93-113`、`:161-208`
意义：本 change 的 verify 报告照此排版；另外那 4 项 scope creep 是第一刀主动留给后续 change 删除的（『Recorded here so a later change can delete them without re-deriving why they exist』）——本 change 若用得上 **DI logger token**（audit 订阅者的失败日志），正好把它从死代码变成活代码，可在 proposal 里点名。

**A19 · 每新增/改动的闸门要走 gate canon 全套**
脚本与自测配对调用（`node <script> && node --test <script>.test.mjs`），自测须对 over-count / stale-entry / malformed-entry / zero-total 四种红路各出证；R11 自测已含两条注入探针（往 guardrails.service.ts 注入多余调用 → 红并点名 collaborator；抽掉调用而不同 commit 降基线 → 红）。
证据：`openspec/specs/ratchet-baselines/spec.md:69-79`；`openspec/changes/add-domain-event-bus/tasks.md:133-136`
意义：本 change 若只是改 r11.json 的数字则**无需新闸门**（复用既有配对自测）；但若为「审计行集合等价」新建对账闸门，必须同样配自测 + 注入探针，否则 verify 会判 gate canon 不合规。

---

## 4. Implications for the proposal

按本 change 的五个设计接缝 (A)–(E) 组织，前置一节阻塞结论，末尾附 spec 写法、验收基线、sidecar、工件编排与开放问题。每条标注支撑编号。

### 0. 阻塞结论：propose 之前必须先拍板

1. **本 change 的原始定义（把 guardrails 的 best-effort audit 调用改成订阅第一刀已发布的事件）在当前事件目录下可迁移量为 0**（C2）。四类审计行需要的数据——force-fail 的 `cause` + 本地 CAS 归属（C3）、exit 的 `code/abnormal/tail`（C5）、provisioning 的 `stage/attempt`（C6）、change-request 的 `url/number/reused`（C7）——**在五个 payload 里一个都没有**。这不是「漏网几处」，是**全落空**。
2. **根因是图纸 §C 与 R11 测量对象不是同一批调用**（C23）：§C 把 audit 列为四个事件的订阅者，指的是 `tasks.service.ts` 的生命周期转移审计 `recordTransition`；guardrails 的 4 处是**细节审计**。「照图纸做订阅」与「把 R11 的 `this.audit` 燃尽」是两件事。
3. **W7 的 thin-vs-fat 工作项因此有了实测答案**：任何补齐字段的做法都要改 `packages/contracts`，sidecar 立刻从 `unchanged×4` 翻 `derived` 并欠 8 条 protocolDifferences（C19/A17/W17）。
4. **W16 的治理判据给出推荐处置**：新增事件类型应享有第一刀给原四个事件的同等目录 + schema 审查，**另开 change**，不要追加进一个声明 contracts 未触碰的 change。
5. → 见 **Q1**。在 Q1 拍板之前，proposal 无法写出可验证的范围。

### (A) 订阅者落位与注册

1. **文件必须命名为 `*.service.ts` 并落在 `apps/api/src/audit/`**（C10）。audit 与 domain-events 同属 `platform-ops`，import 是上下文内的，不产生 cross-context-import；但 `audit-domain-event-subscriber.ts` 这类不匹配后缀表的名字会被判 `unclassified-file`，产生 r7 里没有的新键，comparator 直接红。**文件命名先于第一行 import 决定闸门结果。**
2. **注册路径二选一，必须写进 design**（C11）：走静态数组 `DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS` 就要把 `Object.freeze([])` 常量改成 `useFactory + inject:[{token: AUDIT_RECORDER_TOKEN, optional:true}]`（`guardrails.module.ts:73` 有先例），会改 domain-events 目录的公共导出形状；走 `onModuleInit` 自注册则 README 的「每个迁移加一条数组项」必须同步修订，否则文档与实现分叉。
3. **订阅者的时间与 actor 一律从事件 payload 派生，绝不取环境请求上下文**（W8）。GitLab 明确警告块式审计「不支持异步动作与跨进程 span」；TaskSettled 的发布点可能坐在 boot re-adoption / detached tmux 回收的调用栈上，与旧调用点不同 → 时间戳/actor 会漂移。写成正向 requirement。
4. **audit 的 MUST NOT throw 不变量要在两层都确认**（W6）。此前由 port 实现兜底；变成订阅者后总线会把抛错降级成 warn 日志，**关闭开关的路径看不出这个差异**。→ 在订阅者函数体与总线边界各写一条断言。
5. **本 change 用得上第一刀留下的 DI logger token**（A18）——第一刀把它记为「未绑定的 scope finding，留给后续 change 删除」；audit 订阅者的失败日志正好把它从死代码变成活代码，可在 proposal 里点名。
6. **新增的订阅者 `*.spec.ts` 无需任何注册即被套件发现**（C22），不必重复第一刀「新测试挂载单独验收」的顾虑。

### (B) 保留为调用的判定 → 正向/负向 requirement

1. **负向 requirement 写成总线契约的性质，不写成个案判断**（W3）：「总线 `publish` 返回 void 且按设计吞掉订阅者失败（`domain-event-bus.port.ts:17-31`），因此任何**调用方需要对审计结果分支**的调用点 MUST 保持为直接 port 调用」。这样它对第 3–6 刀是自执行的，不需要每刀重新辩论。
2. **用 passive-aggressive event 这个业界名字做 rationale**（W1）。`recordProvisioningFailure`(~3787) 与 `recordTaskCancellation`(~3815) 三条全中：单一消费者、跑特定逻辑、返回调用方要判的回执。→ 词汇逐字进 spec rationale 与工件 08 §C 非事件清单。
3. **`recordForceFailed` 是负向清单的第二个样本，但理由不同**（C3）：不是「需要回执」，是**信息缺失**——`TaskSettled` 既不带 `force_failed:${cause}` 的 cause，也不带「本地 CAS 回调」这个归属判别。写成『recordForceFailed SHALL 保留为调用』，并在 rationale 里把两类理由并列（回执 vs 信息缺失），给后续刀两条可判定的判据。
4. **C4 的两条负向断言是这条 requirement 的现成红证**：`assert.equal(forceFailureAuditCalls, 0)`(`:1367`) 与 `assert.equal(forceFailAudits, 0)`(`:2302`)。它们是**行为断言**不是顺序断言——若把 recordForceFailed 改成订阅 `task.settled` 就会红，而按验收 (1) 这类断言必须零改动通过。→ 在 spec 里把它们列为「守护仍然咬得住」的既有覆盖。
5. **编译期守护已经存在，不需要新建闸门**（C13/A16）。`domain-event-bus.typecheck.ts:72-91` 已把这两处方法写成 `@ts-expect-error` 负例；`VoidOnlyDomainEventHandler`（port `:150-166`）在类型层强制。→ spec 的正向 requirement 直接引用该夹具作为证据任务，并把 README 里「判据是返回语义不是『audit』这个词」的论证逐字复用。
6. **两处回执调用的失败语义要写成场景**（C14）：未确认 durability ⇒ 抛 `TaskAdmissionCoordinationError('checkpoint', …)` ⇒ running work 保持 leased / 可回收 ⇒ expiry recovery 重试。把 `task-admission.worker.spec.ts:1099-1120` 列为既有覆盖，避免 verify 判成「只有注释没有断言」。
7. **给两档持久性起名**（W2）：7 个 best-effort 调用点 = `batch` 档（可丢），2 个回执调用点 = `blocking-strict` 档（失败必须对调用方可见）。Kubernetes 的先例把「同一产品跑两档」正当化为设计而非妥协，并让第 3–5 刀直接继承分类。
8. **诚实处理反证**（W8）：GitLab 这个最接近的产品级审计先例走的是相反方向——集中埋点、请求内同步持久化、**不**把 audit 变成 pub/sub 订阅者。→ proposal 的 why 必须直说：**本 change 的收益是 guardrails 的依赖预算（R11），不是审计正确性。**
9. **否决记录**：把带回执的调用点事件化的唯一正确做法是 outbox / publication registry（W5 · Spring Modulith），需要一次 Prisma migration，本 change 声明零 migration → **否决理由是范围而非原则**。记成「若后续某刀要把这两处上总线，必须先加一张 publication registry 表」，这同时给第 3 刀（metrics + runnerMinutes 计费，静默丢 = 漏账）留了具体升级路径。
10. **前置堵死一个未来的坏「改进」**（W15）：把 audit 订阅者改成异步/入队会把系统从 SOC 2 合规列移到被标记列（批处理延迟被视作弱点，理想是同事务同步捕获）。→ 趁词汇还热，写成显式负向 requirement。

### (C) 事件覆盖对账

1. **对账结论是「四处全部落空」，不是「几处漏网」**（C2/C3/C5/C6/C7）。按约束「不得擅自新增事件」，四处**全部**升级 open question。
2. **正向条款措辞**（W15）：「每一处被移除的同步调用，其审计语义 MUST 可从至少一个已发布事件的订阅者路径抵达；未被覆盖的调用点 MUST 保持为调用。」SOC 2 实务把审计轨迹**完整性**列为最常见 finding，这条因此不是内部整洁而是合规级要求。
3. **`recordProvisioningProgress` 是唯一有「可能冗余、可直接删」论证空间的一处**（C6），但删除前必须证明 admission worker 的两处 durable checkpoint（`task-admission.worker.ts:399-405`/`:610-617`，共用 dedupe 身份 `task.provisioning:{taskId}:{attempt}:{stage}`）覆盖了 provider-composite 的**全部 stage**——否则删除即丢行。**它仍然不是「改订阅」。**
4. **加一条表驱动的孤儿事件测试**（W14）：对每个事件类型断言**已注册订阅者名字的精确集合**，绑定到 `DOMAIN_EVENT_SUBSCRIBERS`（`port.ts:39-47`）。因为注册是有类型的数组而非装饰器发现，这条测试很便宜，且正是阻止第 3–6 刀静默孤儿化审计路径的东西。
5. **对账要双向扫**（A13）：不仅问「guardrails 调了谁」，还要问「**谁依赖这次 audit 写入的时序/结果**」——`audit.verify.test.mjs`、`delivery-results-surfaced-and-audited.test.mjs`、admission work reclaim 路径。范本最贵的教训就是只向内扫导致结论中途翻转、被迫重切。
6. **产出一张独立的裁定表工件**（A13 的 `track-3-recut.md` 形态）：每处一行——file:line / 返回类型 / 发布者是否依赖结果 / 判定 CALL 或 EVENT / 对应事件 / 若无对应事件则升级为哪个 open question。

### (D) Cutover 开关

1. **第一刀的开关形态在第二刀不成立，这是本 change 最大的设计缺口**（C9/A8）。第一刀「关闭 ⇒ 不绑定 bus provider ⇒ `this.bus?.publish()` 全短路」；第二刀若删掉同步调用，关闭开关 = **审计行彻底丢失**，而不是「回到迁移前」。
2. **(D) 与 (E) 在字面实现下互斥**（A9）：把旧调用留在 `if (!cutover.enabled)` 分支里，`this.audit` 的符号引用**不会减少**（R11 是**符号引用**口径，含守卫与类型注解，A5/C8），R11 降不下来。→ 必须在 design 里拍板，见 **Q2**。
3. **候选解**：(a) 复用 publish 开关 + 旧调用留逆条件分支（R11 不降）；(b) 新增**订阅侧** cutover，逃生口在 `apps/api/src/audit/` 侧绑一个「直调转发」适配器（R11 可降，DEPLOY.md §14 加一行）；(c) 逃生口 = 不注册订阅者 + audit 侧兜底。**把开关放在订阅端还有一个独立理由**：`GuardrailsService` 是 `useFactory` + 位置化 `inject:` 数组，往它加构造参数必须同步改 module，否则依赖恒 undefined 而测试照绿（C18/A15）——开关落在 audit/domain-events 侧可完全回避这个坑。
4. **DEPLOY.md 必须同 PR 改写**（C21/A8）：§14 表格行现写着「registers zero subscribers and removes zero existing direct calls」，散文 `:876-880` 写着「关闭即逐字节一致」——两处在本 change 之后都不再为真。新开关照 §14 表格加一行（变量名 / 默认值 / owner / 退役条件）。
5. **退役触发条件写明并定期**（W13）：约 75% 的 toggle 在开源项目里存活长达 49 周；不写退役条件的具体代价是两条路都要绿到第 3–6 刀，guardrails 的 135 条测试付双份维护。**并且必须决定并写明：被 flag 关掉的代码算不算进 `guardrails-symbol-reference:this.audit`** ——这个决定直接改变 (E) 的目标数。
6. **验收 (4) 用 Scientist 形态在测试里兑现，而不是人工活验**（W12）：同一生命周期夹具在一个测试里跑两遍（每种开关状态一遍）打到 recording audit fake 上，diff 两份行集合。⚠ **不要**在生产里对真 recorder 同时跑两条路（会写重复审计行）；比对属于测试夹具，运行时开关保持纯粹二选一。

### (E) R11 ratchet 与留痕

1. **目标值是 9 → 4，不是 9 → 2**（C8/A5）。R11 的口径是**每个符号引用**，保留的两处回执各贡献 2 个引用（`if (!this.audit)` 守卫 + 调用）。任务描述里的「降到保留的回执调用数（=2）」按该口径不成立。→ 基线新值必须 `node scripts/ratchets/r11-dependency-budget.mjs` 活测得出，不能在 propose 阶段预测死。
2. **`recordAudit` 私有 helper 会变成死代码，必须同 PR 删除**（C8）。它的调用点只有被摘的那 4 处（`:1196/:2066/:2769/:3528`）。opsx-verify 历来抓这类残留（add-repo-content-store 的 `remove()`、detach-workspace-clone 的 parking）。
3. **降数不删条目**（A7）。ratchet-baselines spec 规定归零才删条目、零 total 的文件本身即失败；audit 条目本期不会归零（保留回执调用 + 守卫）。→ tasks 写清，避免实现者误按「归零删条目」纪律删掉。
4. **顺手刷新 `r11.json` 的 samples 行号，但别把漂移当闸门问题去修**（A6）。现存 samples 记的是第一刀接线前的树，comparator 只按 count 比对、samples 是文档。
5. **防假燃尽的对账留痕**（C20）：R11 用 `\bthis\.audit\b` 逐行正则计数，改字段名为 `this.auditRecorder` 会让计数瞬间归零——配上同 PR 的基线更新就是一次假燃尽。→ tasks.md 记一条「字段名未变；9→4 的差值逐处对应到被摘的 5 个引用（1197 / 2063 / 2067 / 2770 / 3529）」的对账。
6. **说明 comparator 的双向 fail-closed 是有意选择**（W9）。ArchUnit 的 `FreezingArchRule` 自动缩小基线（优化开发摩擦），本仓是双向 fail-closed（优化留痕）。本 change 是第一个真正让 R11 数字动起来的 change → design 里花一行写明，否则第一个撞上「我修好了 CI 反而红了」的人会去「修」comparator。
7. **改数字不需要新闸门**（A19/C22）：复用既有配对自测与两条注入探针即可。只有当为「审计行集合等价」新建对账闸门时，才要走 gate canon 全套（配对自测 + over-count / stale-entry / malformed-entry / zero-total 四种红路出证）。

### Spec delta 写法与上游锚点

1. **上游 spec 尚不存在**（C1/A2）：第一刀已合并未归档，`openspec/specs/domain-event-bus/` 在本树没有。→ 引用只能指向 `openspec/changes/add-domain-event-bus/specs/{domain-event-bus,guardrails}/spec.md`；`## MODIFIED Requirements` 若指向 domain-event-bus 的需求，在归档 PR 合并前**无锚点**。见 **Q5**。
2. **MODIFIED 块必须整段重述需求全文**（A3）：标题 + 正文 + 全部 Scenario 复制后再改，不写 diff、不只写增量段落。判例是 `converge-contracts-rules-that-never-run`。
3. **四条必改需求**（A4）：guardrails『…SHALL be retained unchanged — this change adds a second write and removes none』；domain-event-bus『This change registers zero subscribers』场景；domain-event-bus 把种子 `this.audit` 9 写进正文那条；guardrails『120 test() 零修改』那条。**第 4 条最关键**——第一刀把「零测试修改」写成了需求，本 change 要显式改测试，必须把它 MODIFY 成「分类处理 + 留痕」的新形态，而非默默违反。
4. **负向 requirement 有现成句式**（C20）：第一刀 `TaskSettled` 那条里对 `clearAdmissionRuntime` 的写法（「… is NOT a terminal settlement, and it SHALL NOT publish TaskSettled」+ 一条「零事件发布」场景 + 一条「全树只找到一个发布点」场景）。

### 测试与验收基线

1. **基线数字必须重测后写死 135 / 6 spec / 8 `.test.mjs`**（C15/A10）。prompt 的「122」陈旧两代，第一刀的「120」也已被自己新增的 `guardrails-domain-event-publishing.spec.ts`(15) 推高。照抄会被 verify 判成文档数字与树不符。
2. **要改写的测试清单按三个真实热点重建，不是按 412–474**（A11）。任务描述指向的 412–474 其实是 diagnostics 的 `beginAttempt` 顺序测试，与 audit 无关。真实热点：`guardrails-durable-launch-decision.spec.ts` 46 处（顺序型 `:2108`/`:2283`）、`delivery-results-surfaced-and-audited.test.mjs` 61 处（脚本，**单列口径**）、`guardrails.service.spec.ts` 14 处（交错型 `:2830`，用 `auditStarted` 钉同步顺序）。
3. **目录外已确定必改一条**（C12）：`domain-event-bus.service.spec.ts:265-267` 的 `test('this change registers zero subscribers')`。建议改成「恰好注册 audit 一条，且其 eventType 在目录内」而非删掉，并逐条留痕。
4. **留痕模板用 (a)/(b) 二分**（W11/A12）：每条被改写的断言必须声明它编码的是 (a) **实现细节**（方法内部同步调用顺序）→ 替换为「操作完成后审计行集合」的结果断言；还是 (b) **真实需求**（如「准入行持久之前不得出现审计行」）→ **重新表达为对发布点的顺序要求并保留**，不得放宽。本 change 走得比 A12 的 D5/D2a 判例更远（断言真的要改），所以必须显式超越并说明理由：逐条给「原断言钉的是什么同步顺序 / 改订阅后为何不再成立 / 新断言改钉什么不变量」，否则 verify 按 D5 判成 re-baseline。
5. **验收 (3) 用 characterization / golden-master 形态**（W10）：recording fake 抓固定生命周期场景的审计行集合，开关 OFF 快照为 golden master，开关 ON 断言集合相等。⚠ **顺序无关的豁免必须窄范围限定**：总线按注册顺序同步分发，单次 publish 内部顺序是确定的，唯一正当的乱序来源是**发布点位置与旧调用点不同**——不能给整张断言开空白支票。
6. **`delivery-results-surfaced-and-audited.test.mjs` 是会静默漂移的 inline 源码镜像**（C16）：它自建 harness 逐行复刻 `deliverResult` 并断言 `recordChangeRequest` 调用一次、参数含 url/number/reused，**不读真实源码所以不会自动变红**。若 `recordChangeRequest` 的处置改变，必须同 PR 更新，否则留下「断言强度还在但对象已不存在」的假绿。
7. **迁移期在发布点旁写注释要避开带引号的事件名**（C17）：`guardrails-domain-event-publishing.spec.ts:484-535` 用全文件正则 `countOf(source, 'task\\.settled')` 对三个文件计数钉死。订阅者放 `audit/` 不会触发它，但在 `guardrails.service.ts` 里写任何含 `'task.settled'` 字面量的注释都会打红。
8. **预置一条运行时耦合探针任务**（A14）：跑 `sandbox-host-harness-wiring.test.mjs` 与 audit 相关的源码文本扫描测试；日志 context 是被断言的行为（自建 Logger 即红）。若必须改，保住「按文件分别断言而非求总数」的强度，第一刀 tasks 4.15 有现成措辞。

### Sidecar / 公开面

1. **当前的 `unchanged×4 + protocolDifferences []` 合法，但只在完全不碰 `packages/contracts/src/**` 时成立**（C19/A17/W17）。分类器规则表里只有 `contracts` 一条能映射到四公开面；`apps/api/src/audit/**`、`apps/api/src/guardrails/**` 与 `scripts/ratchets/r11.json` 都不匹配。
2. **这条把「不碰 contracts」变成本 change 的硬约束**。若 Q1 拍板扩充事件目录，surface-impact 必须同时改成 `derived` 并把第一刀那 8 条 protocolDifferences **原样转录**，并按第一刀 D17 / tasks 4.18 补一条「四公开面零 import 事件目录 + 真跑 `public-surface-adversarial`」的**可复算证明**——sidecar 造假有 NOT-ARCHIVABLE 判例。
3. **payload 覆盖 diff 必须在 sidecar 定稿之前完成**（W7/W17），否则 sidecar 会以一个已被推翻的断言为基础。

### 工件骨架与 tasks 编排

1. **整体照抄 `add-domain-event-bus` 的骨架与溯源标注制度**（A1）：proposal（W/C/A 逐句挂证据）+ design（D 编号 + 每条 Alternative rejected）+ tasks（Track 分组 + 分区注释头）+ specs + 独立裁定表工件 + verification-report。design 要引用第一刀的 D 编号（负向要求范本、逃生口形态）。
2. **verify 报告照 A18 的五段式排版**：判定统计表 / 本树实际执行的命令-结果表 / 逐需求 re-trace / 公开面裁定 / Scope findings。
3. **共享写者集中一条 SERIAL 集成轨**（A15）：`guardrails.service.ts`、`audit/`、`app.module.ts`、`guardrails.module.ts`（若动构造签名）。`InlineAdmissionPipeline` 由 `guardrails.service.ts:554` 位置化构造，相关文件不可拆并行轨。
4. **裁定表 + 双向扫描是 tasks 的打头轨**（A13），验证轨收口。

---

## 5. 必须拍板 / 开放问题

- **Q1（阻塞全局，决定本 change 是否成立）— 四处 best-effort audit 全部无事件覆盖，怎么办？**（C2/C3/C5/C6/C7/C23/W16）
  候选：
  **(a) 缩范围**——本期只处置 `recordProvisioningProgress`（先证明 admission worker 的 checkpoint 覆盖全部 stage 再删，C6），其余三处写成负向 requirement 保留。R11 从 9 降到 8，(E) 的「燃尽」叙事要改写成「首次下降」。
  **(b) 扩事件目录**——给 `TaskSettled` 加 `cause/exitCode/abnormal/tail`、给 `SandboxProvisioned` 加 `stage/attempt`、新增 delivery 类事件。**必须另开 change**（W16 治理判据），且 sidecar 翻 `derived` + 8 条 protocolDifferences（C19/A17）。
  **(c) 重定义本刀**——改成「audit 订阅 TaskAdmitted/TaskSettled 接管 `tasks.service.ts` 的 `recordTransition`」（C23）。事件覆盖成立、图纸 §C 得到兑现，但 R11 的 `this.audit` **一分不降**，(E) 的 ratchet 目标必须整体改写。
  **(d) 推迟本刀**，先做第 3 刀或先做事件目录扩充 change。
- **Q2（阻塞 (D)/(E)，且两者互斥）— 第二刀自己的 cutover 开关是什么形态？**（C9/A8/A9）
  (a) 复用 `CAP_DOMAIN_EVENT_PUBLISHING_ENABLED` + 旧调用留逆条件分支 → R11 降不下来；(b) 新增订阅侧 cutover + audit 侧「直调转发」逃生适配器 → R11 可降，DEPLOY.md §14 加一行；(c) 不注册订阅者 + audit 侧兜底。**附带子问题：被 flag 关掉的代码算不算进 `guardrails-symbol-reference:this.audit`？**（W13）——这个决定直接改变 (E) 的目标数。
- **Q3（阻塞 (C) 的一处）— `recordChangeRequest` 的处置？**（C7/C16/W16）
  (a) 本期保留调用（成本最低、保住 R11 目标的诚实性）；(b) 事件目录扩充另开 change。无论哪个，`delivery-results-surfaced-and-audited.test.mjs` 的 inline 镜像必须同 PR 跟随（它不会自动变红）。
- **Q4（文档一致性，无论 Q2 怎么定都要做）— DEPLOY.md §14 的改写范围？**（C21/A8）
  表格行「registers zero subscribers and removes zero existing direct calls」与散文 `:876-880`「关闭即逐字节一致」在本 change 之后都不再为真，必须同 PR 改写。若新增开关，还要补一行（变量名/默认值/owner/退役条件）。
- **Q5（阻塞 spec delta 写法）— 第一刀的归档 PR 与本 change 的先后顺序？**（C1/A2）
  `openspec/specs/domain-event-bus/` 在本树不存在（归档提交 bebd211 只在 `chore/archive-domain-event-bus` 分支）。propose 前须确认归档 PR 合并；否则 `## MODIFIED Requirements` 指向 domain-event-bus 的需求会找不到锚点，且两份 delta 会对同一 capability 重复 ADDED。
