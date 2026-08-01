# add-domain-event-bus 研究简报

> 阶段 4 第一刀（图纸：`docs/refactor/08-ddd-target-architecture.md` §C）的前置研究汇总。
> 三路并行调研：**Web**（外部实践 + 本机实测探针）、**Codebase**（仓内现状实测）、**Archive**（归档 change 判例）。
> 每条结论标注编号（W#/C#/A#），文末「Implications for the proposal」按 change 的五个设计接缝（A–E）交叉引用这些编号。
> 本简报只汇总证据与其推论，**不代替 proposal/design 的拍板**；需要用户拍板的点集中列在末尾「必须拍板 / 开放问题」。

---

## 1. Web 路线 — 外部实践与本机实测

### 1.1 「什么不是事件」的外部判据

**W1 · 「带回执的调用不能事件化」有成名的反模式名字**
`passive-aggressive event` / `command-in-disguise`。业界把判据压缩成一句可直接抄进非事件清单的话——**「命令可以被拒绝，事件只能被忽略」**；以及「如果它一直只有单一消费者、并且你期待一个特定的回复，那它就是命令」。
证据：https://event-driven.io/en/passive_aggressive_events/
意义：工件 08 §C 的三条非事件（terminal provisioning audit detail 的 durability acknowledgement、admission work 状态转移、diagnostics write-gate 的背压/确认）**逐条命中**这个判据：都要求回执、都只有单一消费者、发布者的后续路径（reclaim）依赖回复。因此非事件清单应该写成**准入规则**（「需要回执 or 需要拒绝 or 发布者依赖其结果 → 是调用」），而不是只列三个特例——这样后续 5 个迁移 change 有可判定的标准，而不是靠记忆。

**W2 · 「用事件做 request-response」被多个独立来源列为 EDA 首要反模式**
发布者期待特定的回执事件，等于把同步调用伪装成异步消息，制造隐藏耦合；查询类、需要立刻知道结果的交互天然是 request-response。
证据：https://codeopinion.com/beware-anti-patterns-in-event-driven-architecture/ ；https://www.ben-morris.com/event-driven-architecture-and-message-design-anti-patterns-and-pitfalls/
意义：给 (E) 非事件守护提供「不是我们项目特殊」的外部依据，可写进 proposal 的 why。同时提示守护的措辞应该按**是否存在返回值/确认语义**来写，而非按「关注点名字」写——否则后续 change 换个名字就绕过了。

### 1.2 best-effort 语义的实测硬依据

**W3 · 实测推翻「Node EventEmitter 天然 best-effort」的直觉**
Node v22.22.0 上，三个监听器中第二个同步抛错时，**第三个监听器根本没被调用**，且异常直接从 `emit()` 抛回发布者（emit 未正常返回）。异步监听器的 rejection 更糟：包在 `emit()` 外面的 try/catch 抓不到，直接逃逸成 `unhandledRejection`。
证据：`scratchpad/emit-throw-probe.mjs` — 输出 `listeners run ["A","B-throws","emit-threw:boom"]`，`emit() returned normally: false`；异步 rejection 的同步 try/catch 捕获为 `null`，随后 `unhandledRejection`。
意义：直接决定 (A) 的实现形态——best-effort「订阅者抛错不得影响发布者」**必须由 bus 自己对每个订阅者单独 try/catch**（per-subscriber 隔离 + 逐个继续），不能靠裸 EventEmitter，也不能只在 publish 外层包一层 try/catch。并且必须显式决定异步订阅者策略（见 W9），否则 best-effort 承诺在第一个 async 订阅者出现时就破。这是 bus 语义 requirement 的硬依据，也是本 change 自测应钉住的行为（红证：注入一个抛错订阅者，断言发布者正常返回且后续订阅者仍被调用）。

**W4 · 框架层现成事件总线不提供 best-effort 语义**
`@nestjs/cqrs` issue #409「Exceptions thrown from within event handlers crashes the app」；`@nestjs/event-emitter`（EventEmitter2）同样不吞异常，且异常无法被 Nest Exception Filter 捕获——社区做法是每个 listener 里自己兜，或另包一层 safety emitter。
证据：https://github.com/nestjs/cqrs/issues/409 ；https://www.npmjs.com/package/@nestjs/event-emitter 及社区包装库 https://github.com/choewy/nestjs-safety-event-emitter
意义：支撑「自建窄 port + 自建同步 emitter」而不是引入现成库的决策：现成库既带来 DI/装饰器扫描的隐式魔法，又不给要的保证等级，还要额外包一层才等价。可直接写进 proposal 的 alternatives。

**W5 · Node 的 `'error'` 是被特殊对待的保留事件名**
没有 `'error'` 监听器时 `emit('error')` 会直接抛出、打印栈并退出进程；官方建议永远注册 `'error'` 监听。`captureRejections` 只是把 rejection 路由到 `'error'`，且官方明确「不要用 async 函数做 `'error'` 处理器」以免死循环。
证据：https://nodejs.org/api/events.html
意义：若 bus 底层用 Node EventEmitter，事件目录 v1 的命名必须避开 `'error'`（五个事件名本身没问题，但守护/闸门应把保留名写进去），且 bus 内部的失败上报通道**不要复用 `'error'` 事件名**——否则一个订阅者异常可能升级成进程退出，与 best-effort 承诺直接矛盾。

**W12 · 进程内同步总线的代价是 at-most-once，必须配可观测性**
进程崩溃/重启时未处理事件直接丢失；没有 DLQ 意味着失败静默。文献一致强调 best-effort + 吞异常必须配失败计数、失败原因分布、handler 归属，否则「something is wrong」永远无法定位到「哪个 handler 失败了」。
证据：https://www.geeksforgeeks.org/system-design/error-handling-in-event-driven-architecture/ ；https://www.conduktor.io/glossary/dead-letter-queues-for-error-handling
意义：bus 吞掉的订阅者异常必须至少落一条带 `eventType + subscriberName + error` 的结构化日志（可选一个计数器）。这是本 change 少数应当自带的可观测面——因为阶段 4 后续 5 个 change 会把 audit/metrics/计费搬到订阅者上，**静默失败会直接变成计费漏账**。「失败必须可见」应写成 bus 的一条 requirement，而不是留给后续。

### 1.3 类型层守护（(E) 的实现路径）— 四条连续实测

**W6 · 实测：`(e) => void` 订阅者类型挡不住带返回值的 port（假守护）**
tsc 5.9.3 strict 下，把 `(e) => ({durable: true})` 和 `async (e) => ({durable:true})` 传给 `(e: Evt) => void` 参数，**零报错**。这是语言设计（void 表示「返回值会被忽略」而非「不许返回」），不是配置问题。
证据：`scratchpad/void-guard-probe.ts` 第 11–12、39 行编译零错误；https://www.learningtypescript.com/articles/void-returning-function-assignability ；https://www.typescriptlang.org/docs/handbook/2/functions.html
意义：(E) 里「类型层让带返回值的 port 无法被注册为订阅者」如果按最自然写法实现，是**假守护**——闸门会绿，但 audit port 的 `record(): Promise<{persisted}>` 照样能注册。必须写成显式风险并采用 W7 的写法。

**W7 · 实测找到可用写法**
```ts
declare function subscribe<T extends (e: Evt) => any>(
  h: T & (ReturnType<T> extends void ? unknown : never)
): void;
```
tsc 5.9.3 strict 下精确放行 `(e)=>{}`、`(e)=>voidMethod(e)`、`m.onSettled.bind(m)`，并拒绝返回对象的、返回 Promise 的、以及只在部分分支返回值的（`1 | undefined`）处理器。
证据：`scratchpad/void-guard-probe.ts` 与 `void-guard-probe2.ts`——报错只出现在 ackingPort、asyncAckingPort、`(e)=>r.onSettled(e)`(Promise<boolean>)、分支返回 `1|undefined` 四处，合法订阅者全部通过。
意义：给 (E) 一个**已验证可行**的具体实现，可直接进 tasks，不用 apply 期现试。配套自测现成：把上述反例做成 expect-error 用例（负例必须报错、正例必须通过），满足 gate canon 的「注入探针红证 + 空扫描即败」精神。

**W8 · 实测排除两个更优雅但坏掉的变体**
(1) `<R>(h: (e:Evt) => R extends void ? void : never)` 连合法的 `(e)=>{}` 都拒（R 无处可推断，退化成 unknown）；(2) 返回类型写成 `undefined` 的变体自相矛盾——接受块体箭头 `(e)=>{}`，却拒绝委托写法 `(e)=>voidMethod(e)`（报 `'void' is not assignable to 'undefined'`）。
证据：`void-guard-probe.ts:25`、`void-guard-probe2.ts:29` 的编译错误。
意义：避免 apply 期在三种写法间来回试错并误判「类型守护做不到」。同时提示 tasks 的验收必须包含「合法订阅者不被误伤」的**正例**，否则很容易落成一个把所有人都挡住的假闸门。

**W9 · 该守护的必然副作用 + 报错信息可品牌化**
`Promise<void>` 不 extends `void`，所以 `async (e) => {}` 也会被拒。默认报错信息是 `not assignable to parameter of type 'never'`（可读性极差）；实测把 `never` 换成带说明文字键的对象类型，编译器会把整句解释**原文**打进错误里。
证据：`void-guard-probe2.ts:12`（asyncVoid 被拒）；`void-guard-probe3.ts:13` 报错中原样出现 `__CAP_ERROR__: subscribers must return void. A collaborator that returns an acknowledgement is a CALL, not an EVENT — see docs/refactor/08 §C non-event list.`
意义：两个必须拍板的接缝——
(a) 订阅者签名是纯同步 `void`，还是 `void | Promise<void>`。选后者则守护要放宽成「非 `Promise<非 void>`」且 bus 必须自己 catch rejection（见 W3）；选前者则后续 5 个订阅者迁移里凡是要做 IO 的（transcript 采集、diagnostics）会被这道守护挡住，得**提前想好出口**。
(b) 报错信息用品牌化文本承载「这是调用不是事件」的制度解释，等于把非事件清单的纪律写进编译器，比 gate 扫描更早、更便宜。

**W10 · `no-misused-promises`（checksVoidReturn）是低成本的第二道网**
typescript-eslint 该规则正为「把 async 函数传给期待 void 的回调」而生，官方措辞是这样会导致异常被静默吞掉、只在 console 里出现。
证据：https://typescript-eslint.io/rules/no-misused-promises/
意义：若 (A) 决定订阅者签名保持 `=> void` 而不上类型守护（或守护只挡带值返回），这条 lint 是低成本补充，能挡住 async 订阅者造成的 floating promise——而 floating promise 恰恰会让 best-effort 承诺失效。可作为 (E) 的备选/补充写进 alternatives。

### 1.4 事件目录、payload 与持久化边界

**W11 · 「不建 outbox」的边界条件在文献里是清晰的**
transactional outbox 存在的理由是「更新数据库 + 发消息给 broker」两件事必须原子（saga / 跨进程集成事件）；进程内、同事务、同进程消费的 domain event **不构成 dual-write 问题**。业界惯用划分是 domain events（进程内、同事务、立即同步派发）vs integration events（跨进程、需持久与最终一致）。
证据：https://microservices.io/patterns/data/transactional-outbox.html ；https://devblogs.microsoft.com/cesardelatorre/domain-events-vs-integration-events-in-domain-driven-design-and-microservices-architectures/
意义：直接支撑「不落库、零 Prisma migration」，并给出制度化写法：在事件目录 v1 里显式标注这五个是 **domain events（进程内）**，并写明「一旦出现跨进程消费者或必须持久的订阅者，即升级为 integration event 并另开 change 引入 outbox」——既守住本期零 migration，又把未来升级条件写死，不需要现在找用户拍板建表。

**W16 · CloudEvents 的必需上下文属性 + 事件版本演进纪律**
CloudEvents 收敛为 `id / source / type / specversion`，`subject` 和 `time` 可选但常用；版本演进主流纪律是「只做加法即向后兼容，消费者忽略未知字段」，破坏性变更靠新版本 + upcaster。
证据：https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md ；https://event-driven.io/en/simple_events_versioning_patterns/ ；https://codeopinion.com/event-versioning-guidelines/
意义：给 (B) 五个 zod schema 的信封一个最小可辩护基线：`eventId + occurredAt + type`（+ 可选 correlation/taskId 作为 subject）。不必整套 CloudEvents（进程内用不上 specversion/source 的跨系统语义），但带上 id/time 使未来升级到 outbox 或跨进程消费时是**加字段而非改结构**。版本纪律与项目既有 additive-only migration 纪律同构，可直接写成事件目录 v1 的演进规则（只加可选字段；破坏性变更 = 新事件名）。

**W17 · thin vs fat payload 是必须显式拍板的取舍**
thin 只带 ID、消费者需回查发布者；fat 带足上下文、消费者无需回查但契约面更大，且「事件会随时间被消费者需求撑肥」是公认演化趋势。命名惯例是聚合名 + 过去式动词，payload 只放原始类型与 ID、不放聚合实例。
证据：https://codeopinion.com/thin-vs-fat-integration-events/ ；https://verraes.net/2014/11/domain-events/ ；Microsoft DDD 指南 https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/microservice-ddd-cqrs-patterns/domain-events-design-implementation
意义：直接作用于 (B)：`TaskAdmitted` 带 `fencedToken`、`SandboxProvisioned` 带 environment 快照都是明显的 fat 选择，而这在本期是**对的**——后续 5 个订阅者迁移的目的正是切断它们对 tasks/guardrails 的直接依赖；若事件是 thin 的，订阅者仍需回查发布者，第 6 个 change 的 forwardRef 环就解不掉。建议把这条取舍写成显式设计决策（「fat by design，理由是解环」），并用「只放原始类型与 ID、不放实体实例」约束 environment 快照的形态。

**W20 · zod 运行时开销与「边界校验一次」的通行做法**
zod 在 API 边界量级上开销可忽略（典型 < 0.1ms/次），代价来自解释执行时的逐属性对象分配；社区共识是「边界校验一次，之后视为可信、避免重复校验」。
证据：https://gajus.com/blog/optimize-zod ；https://stevekinney.com/courses/full-stack-typescript/zod-best-practices
意义：影响 (B) 满足 `contracts-executed-schema-check` 的方式。两条可行路径：(a) 发布时 `safeParse` 且仅非生产环境启用——但那样闸门在 CI 里绿而生产不执行，需确认闸门语义是否接受；(b) 老实在发布点 `parse`。五个事件是**每任务数次的低频事件**，不在 per-token/per-frame 热路径上，(b) 的成本可被明确论证为可忽略。建议直接选 (b)，并把「不在 INDIRECTION_POINTS 登记」作为结论。

**W21 · 「事件目录」作为一等工件在生态里有成熟形态，但对本期是过度工程**
EventCatalog + AsyncAPI 支持从 schema 自动生成目录并随版本同步。
证据：https://www.eventcatalog.dev/docs/plugins/asyncapi/intro ；https://www.eventcatalog.dev/blog/documenting-sync-and-async-apis-with-eventcatalog
意义：作为形态参考而非落地建议——这套工具面向跨服务与外部消费者，对进程内五个事件过重，且会引入新公开面与闸门负担（与 surface-impact 的四公开面 derived 声明冲突）。可借鉴的只有两点：目录条目带版本；目录里**同时记录「什么不是事件」**——后者恰是 EventCatalog 不做而本 change 特意要做的事，值得写成差异点。

### 1.5 迁移形态与验收方法论

**W13 · 本 change 是 branch by abstraction + parallel change（expand-contract）的教科书形态**
先建抽象、新旧并存、toggle 切换、旧路径最后删。文献同时给出配套纪律：release toggle 是短命的，上线后应以天/周计删除，超期即技术债，不同寿命的 toggle 要分开登记管理。
证据：https://continuousdelivery.com/2011/05/make-large-scale-changes-incrementally-with-branch-by-abstraction/ ；https://www.nilus.be/blog/parallel_change_pattern_in_microservices_refactoring/ ；https://featureflags.io/feature-toggles/
意义：(D) 开关框架的设计要点——阶段 4 后续每个订阅者迁移各带一个开关，六个 change 累计会留下 5–6 个逃生开关。proposal 应在建框架的同时定义**开关的退役条件与登记位置**（每个开关在 deploy 文档里带 owner + 预期移除的 change 编号），否则第 6 个 change「依赖预算 ratchet 归零」时会发现代码里全是没人敢删的分支。这是把 `TASK_ADMISSION_V2_CUTOVER` 模板抄过来时容易漏掉的一半。

**W14 · 「既有测试零修改通过」= characterization test / golden master**
Michael Feathers 的标准用法：测试记录现有行为，refactoring 期间任何输出差异即意味着无意的行为变更。
证据：https://michaelfeathers.silvrback.com/characterization-testing ；https://en.wikipedia.org/wiki/Characterization_test
意义：给验收标准一个可引用的方法论名字（proposal 里可直接称 characterization 验收）。同时提示反面：characterization 只证「被覆盖的行为没变」，所以必须**额外**声明五个发布点各自有「发布被调用一次且 payload 正确」的新测试——发布是新增行为，旧测试按定义覆盖不到。

**W15 · 并行运行期的真正风险是「同一副作用执行两次」**
迁移文献的通用处方：并存期间消费者必须幂等（按事件 id / 对象 id / 事件类型去重，或用前置状态检查提前返回），且按消费者逐个切换而非一刀切。
证据：https://codeopinion.com/handling-duplicate-messages-idempotent-consumers/ ；https://www.useparagon.com/blog/migrate-off-legacy-ipaas-without-disrupting-customers
意义：本 change 因「零订阅者」天然无重复副作用风险——这点值得在 proposal 里明说，作为把 change 切这么小的理由。但**接缝要现在留好**：payload 里带稳定事件标识（见 W16），后续 change 2–5 才能在「订阅者已接上、直接调用尚未拆除」的窗口里做去重或前置状态检查。若现在不带 id，后续每个 change 都要改 contracts schema，与 additive-only 纪律和四公开面 derived 声明反复摩擦。

### 1.6 NestJS 生态接缝

**W18 · Nest 没有 Angular 式 multi-provider 数组注入**
「N 个订阅者自动注册」在 Nest 生态的标准做法是 `DiscoveryService` + 自定义装饰器扫描（`@nestjs/cqrs` 自身就是这么发现 `@EventsHandler` 的），或显式维护一个数组 token。
证据：https://michaelguay.dev/nestjs-discovery-service-custom-decorators/ ；https://www.npmjs.com/package/@nestjs-plus/discovery ；https://github.com/nestjs/cqrs/issues/98
意义：这是必须**现在**选、否则后续四个 change 各选各的接缝。既有 `AUDIT_RECORDER_TOKEN` / `TRANSCRIPT_SERVICE_TOKEN` 的 `@Optional()` 形态适合「单个可选协作者」，但阶段 4 最终要挂 5 个订阅者。走显式数组 token（如 `DOMAIN_EVENT_SUBSCRIBERS`）可保持零装饰器魔法、可静态检查、与类型守护配合良好；走 `DiscoveryService` 则注册变成运行时扫描，**类型守护基本失效**（与 (E) 直接冲突）。建议明确选前者并记下理由。

**W19 · 「用事件替代 forwardRef」是 NestJS 社区公认的解环手法**
forwardRef 能让编译通过但模块仍紧耦合；事件让模块无需互相依赖即可协作。
证据：https://dev.to/kishieel/get-rid-of-tightly-coupled-modules-and-circular-dependencies-in-nestjs-3do1 ；https://wanago.io/2022/02/28/api-nestjs-circular-dependencies/
意义：为阶段 4 第 6 步（解 tasks↔guardrails forwardRef 环）提供外部背书，可写进「切分说明」解释第 1 刀为何值得单独做：环不是靠删 forwardRef 解的，是**先有总线、再把跨模块调用逐个换成发布/订阅之后自然消失**。

---

## 2. Codebase 路线 — 仓内现状实测

### 2.1 change 目录与既有模板

**C1 · change 目录已半脚手架化**
已有 `.openspec.yaml`（schema: spec-driven，2026-08-01）与**完整的** `surface-impact.json`（四公开面全 `derived` + contracts-material-library 理由、`internalOnly: changed`、`intent: developer-workflow`、`runtimeWireBehavior: unchanged`、8 条 `protocolDifferences` 全部转录）。缺：`proposal.md`、`tasks.md`、`specs/<capability>/spec.md`。
证据：`openspec/changes/add-domain-event-bus/.openspec.yaml`、`surface-impact.json`；`scripts/openspec-metadata.mjs:1470-1495`（`surface-impact.json` 与 `tasks.md` 均为 required）
意义：sidecar 已写好且已满足阶段 2 教训（contracts→四公开面 derived + 8 protocolDifferences）。proposal 工作是在其之上撰写 proposal/tasks/specs，**不是重推 sidecar**。

**C2 · `@Optional()` 窄 port + DI token 模板 = `audit-recorder.port.ts`**
纯 `interface` + 字符串 token 常量，`@Optional()` 注入使消费者可独立构造，跨模块绑定放在 `app.module.ts`——明确是为了避开 `TasksModule -> AuditModule -> TerminalModule -> TasksModule` 环。其契约文字**就是** best-effort 的原话。
证据：`apps/api/src/audit/audit-recorder.port.ts:13-30`（"ordinary lifecycle ... are BEST-EFFORT and MUST NOT throw"）、`:112`（`export const AUDIT_RECORDER_TOKEN = 'AUDIT_RECORDER'`）；`apps/api/src/audit/audit.module.ts:46-48`（`@Global()` + `useExisting` 别名）；`apps/api/src/app.module.ts:76-81`
意义：`DOMAIN_EVENT_BUS` 逐字照抄这个形状——字符串 token、`.port.ts` 文件、best-effort JSDoc 契约、`@Global()` 模块提供 `useExisting`——DI 接线问题已被先例回答。

**C3 · DI 消费模板 = `guardrails.module.ts` 的 `useFactory` + 位置化 `inject` 数组**
`GuardrailsService` 构造函数已是 10 参数的 optional-tail 链，最后两个参数注明「sit last to preserve construction compatibility in focused tests」。
证据：`apps/api/src/guardrails/guardrails.module.ts:64-105`；`apps/api/src/guardrails/guardrails.service.ts:495-547`（构造函数）、`:538-540`
意义：bus 必须作为**第 11 个可选尾参**注入，否则 9 个目录外 spec 的位置化 `new GuardrailsService(...)` 会断——而那正是零修改验收标准本身。

### 2.2 五个发布点的真实拓扑（关键：与图纸的 1:1 假设不符）

**C4 · `TaskRunStarted` 有三个发布点，`TaskSettled` 有两个且其中一个不是终态**
`runnerMinutes.recordStart` 被三处调用：readoption 恢复路径、legacy inline `startRunningAfterCapacity`、durable `armDurableRuntime`。对称地 `recordEnd` 有两处，其中 `clearAdmissionRuntime` **不是终态结算**，是 admission-runtime 拆除。
证据：`guardrails.service.ts:1566`（readoption）、`:2623`（`startRunningAfterCapacity`，注释 "Begin the runner-minutes interval the moment the task enters RUNNING (5.4)"）、`:2971`（`armDurableRuntime`）；`:2038`（`fenceTerminal`）、`:2949`（`clearAdmissionRuntime`）
意义：「recordStart 处 = TaskRunStarted / recordEnd 处 = TaskSettled」的映射实际是 **3:1 和 2:1**，且 `clearAdmissionRuntime` 处会发出**假的 TaskSettled**。spec requirement 必须逐个枚举发布点，并声明哪个 `recordEnd` 才是结算点。

**C5 · `TaskSuperseded` 全仓没有专属接缝，且「取代者」不可从现有状态推导**
"Superseded" 只是 CAS 结果——`updateMany` 返回 `count !== 1`，或观察到更晚的生命周期状态；在那些点上代码**没有任何 handle 指向「谁取代了它」**。
证据：`apps/api/src/tasks/tasks.service.ts:2028, :2040, :2115`（`reserveDurableAdmissionCapacity` 内 `return { outcome: 'superseded' }`）、`:2434, :2445`（`performAdmissionTransition` 内 `return 'superseded'`）；`guardrails.service.ts:354`（`GuardrailsReadoptResult`）、`:811`；`apps/api/src/inline-admission/inline-admission.pipeline.ts:191,224,244,254,289,371,413,433,450`
意义：这是工件 08 §C 表里**唯一没有发布者**的事件。两条出路：payload 去掉「取代者」（只带观察方的 token），或开一条 open question 给用户。**发布一个代码根本不知道的 superseder 身份就是伪造数据。**

**C6 · `SandboxProvisioned` 恰有两条编排路径，且两条都已通过 `snapshotSandboxProvisionContext` 构好 environment 快照**
durable worker 路径在 `GuardrailsService` 内，legacy 在 inline pipeline。
证据：durable `guardrails.service.ts:963`（`snapshotSandboxProvisionContext({...})`）、`:1022`（`await selected.provider.provision(...)`）、`:1023`（`resolveSelectedRunStrict`）、`:1052`（`gateway.openSession`）；inline `inline-admission.pipeline.ts:307-320`、`:416-417`（`registerConnection` + `resolveSelectedRun`）
意义：两个发布点都紧贴 `provision()` 成功之后、`openSession` 之前/之时，`provisionPlan.environment` + `selectedRun` 已能给出 sandboxRef 与 environment 快照，**无需新增管线**。

**C7 · `TaskAdmitted` 的两条路径各自持有不同的 fenced token**
durable/worker 用 `claim.leaseToken` 加一个新铸的 `transitionToken: randomUUID()`；legacy inline 走 `TasksService.admitCreatedTask` → `guardrails.admit()`。
证据：durable `guardrails.service.ts:795-812`；legacy `tasks.service.ts:1570-1605` → `guardrails.service.ts:737`（`async admit`）；DI 适配器 `apps/api/src/task-admission/fenced-task-admission.processor.ts:40-46`
意义：payload 的 `fencedToken` 依路径不同是两样东西——zod schema 要么两者都接受，要么 spec 明确声明哪个是 canonical，否则两个发布者会**静默分歧**。

**C18 · 无事件基础设施可复用；forwardRef 环是 4 个点**
root 与 api 的 `package.json` 都没有 `@nestjs/event-emitter`；`apps/api/src` 下零个非 spec 的 `EventEmitter` 引用。`tasks ↔ guardrails` 的 forwardRef 环 = 双向模块 import + 两处懒 `ModuleRef` 解析。
证据：`guardrails.module.ts:55`（`imports: [forwardRef(() => TasksModule)]`）↔ `tasks.module.ts:57`（`forwardRef(() => GuardrailsModule)`）；`guardrails.module.ts:59-62`（"TasksService is NOT injected here — GuardrailsService resolves it lazily via ModuleRef in onModuleInit to break the construction cycle"）；`fenced-task-admission.processor.ts:43`（`moduleRef.get(GuardrailsService, { strict: false })`）
意义：确认「手写进程内同步 emitter」是唯一选项（无框架总线可采纳），并钉死第 6/6 个 change 要解开的 4 个点——值得写进 proposal 的接缝段，使切分显得可信。

### 2.3 落位与闸门（决定文件放哪、叫什么）

**C8 · contexts manifest 明确把「领域事件订阅」这个槽位预留给本阶段**
`crossContextRules.machineReadable` 带 `$comment`：「『领域事件订阅』没有条目——阶段4之前无事件总线可判，等事件落地再补声明，不在脚本里猜」。散文版 `allowed` 已含「领域事件订阅（阶段4后）」，只缺机器可读编码。
证据：`docs/refactor/contexts-manifest.json` → `crossContextRules.allowed[1]` 与 `crossContextRules.machineReadable.$comment`
意义：本 change 是这处 manifest 编辑的**声明所有者**。补编码是有书面邀请的 in-scope 工作；跳过则闸门无法给 change 2–5 的订阅者 import 打分。

**C9 · layout-v2 闸门对无人认领的顶层目录是硬失败（exit 1，不是 finding）**
在 `apps/api/src` 下新建目录而不改 `contexts-manifest.json`，CI 步骤立刻变红。
证据：`scripts/context-layout-check-v2.mjs:339-347`（`unmappedDirectories`）、`:518-529`（`runGate` 返回 exitCode 1 并逐个点名）；`ci.yml:370-371`（步骤 "Context layout gate (v2, report)" → `pnpm test:context-layout-v2`）
意义：要么把 bus 放进已被认领的目录，要么在同一 commit 里把新目录加进某个 context。**没有第三种落地即绿的选项。**

**C10 · 只有 12 个文件名后缀被分层；其余变成 `unclassified-file` finding → 新 r7 基线键 → 严格比较器判增 → 红**
`domain-event-bus.ts` 失败；`domain-event-bus.port.ts`（→ domain）或 `domain-event-bus.service.ts`（→ application）通过。
证据：`contexts-manifest.json` → `layers.fileClassification.rules`（`.module.ts`,`/main.ts`,`.controller.ts`,`.gateway.ts`,`.resolver.ts`,`.guard.ts`,`.filter.ts`,`.pipe.ts`,`.middleware.ts`,`.service.ts`,`.port.ts`,`.store.ts`）；`scripts/context-layout-check-v2.mjs:219-235`（`classifyLayer`）、`:352-364`；`scripts/ratchets/comparator.mjs:8-16`（高于基线红，低于基线同样红）
意义：「r7 ratchet 只降不升」这条约束在写第一行 import 之前就已由**文件命名**决定。现有 247 条 r7 条目中 132 条已是 `unclassified-file`，含每个 guardrails 辅助文件（`semaphore.ts`、`idle-tracker.ts` …）。

**C11 · 跨 context import 只有三种合法形态**
目标以 `.port.ts` 结尾 / 导入方是 DI 组合（`*.module.ts`、`main.ts`、`app.module.ts`）/ 目标目录是 shared kernel（`prisma`、`crypto`、`observability`）。`runner-metrics`、`metrics`、`audit` 属 `platform-ops`，而 `guardrails`/`tasks`/`task-admission`/`inline-admission` 属 `task-execution`。
证据：`scripts/context-layout-check-v2.mjs:406-420`；`contexts-manifest.json` → `contexts.task-execution.directories` vs `contexts.platform-ops.directories`；既有违规证据 `scripts/ratchets/r7.json` 的 `cross-context-import:apps/api/src/guardrails/guardrails.service.ts` = 9
意义：确认架构形态——`.port.ts` 接口 + token 落在被认领的目录，具体实现只在 `app.module.ts` 绑定；发布者**只能 import bus 的 `.port.ts`，绝不能 import `.service.ts`**。注意 `.port.ts` 分类为 `domain`，而 `allowedImports.domain === ['domain']`，所以 port 文件自身不得 import 本 context 内任何 `.service.ts`。

**C12 · R11 依赖预算 ratchet 尚不存在；本 change 若创建它，今日可测的种子数字已备**
`scripts/ratchets/` 只有 `comparator.mjs`、`r3.json`、`r7.json`。R11 已在规则登记表为阶段 4 预登记，ratchet canon（4 条 spec requirement，含证明闸门能变红的配对自测）已写好。
证据：`scripts/ratchets/`；`docs/refactor/04-rules-registry.md:64`（`R11 | 依赖预算（guardrails→五关注点只降不升） | 工件 08 §C | ratchet | 4`）；`openspec/specs/ratchet-baselines/spec.md:6,39,57,69`
今日 `guardrails.service.ts` 实测种子：`this.audit` **9**、`this.runnerMinutes` **6**、`provisioningDiagnosticRecorder` **4**、`provisioningDiagnosticWriteGate` **4**、`this.transcripts` **2**、`metrics-projection` **2**（按 r7 先例，活测种子）。

**C13 · gate canon 是固定两件套，12 个既有闸门接法完全一致**
root `package.json` 脚本 `node scripts/X.mjs && node --test --test-force-exit scripts/X.test.mjs`，加 `typecheck + lint + test` job 内的一个具名 step。**job 的 `name:` 是冻结的 attestation 字符串；step 名自由。**
证据：`package.json` 的 `test:context-layout-v2`、`test:security-seams`、`test:boundaries` 等；`.github/workflows/ci.yml:238`（`name: typecheck + lint + test`）、`:355`（"Every `name:` above and below is byte-identical to its …"）、`:370, :376, :383`；`docs/refactor/04-rules-registry.md:100-108`
意义：新增一个非事件守护闸门的成本恰是「一个 root 脚本 + 一个 step」，总则2 的字节同一性约束作用于 **job 名**（不动）。fail-closed 写法可抄 `scripts/security-seam-check.mjs:22-31` 与 `context-layout-check-v2.mjs:505-512` 的空扫描即败规则。

**C19 · contracts 两个闸门的失败模式不同，且 provider family 已有单一声明处**
`shared-export-check` 对任何消费者不可达的 export 判红（有可见 EXCEPTIONS 列表）；`executed-schema-check` 对无人 `.parse()` 的 schema 判红，其 `INDIRECTION_POINTS` 豁免名单是**声明的、绝不推断**。
证据：`scripts/contracts-shared-export-check.mjs:1-42`；`scripts/contracts-executed-schema-check.mjs:1-25` 与 `:38-80`（"DECLARED, never inferred… a blanket amnesty… is how a gate stops being a gate"）；`packages/contracts/src/provider-family.ts:1-24`（`SANDBOX_PROVIDER_FAMILIES`，"Everything that depends on which providers exist derives from here"）
意义：发布必须在发布点对 payload 调 `.parse()`（文本扫描即满足 G6），否则本 change 要新增 INDIRECTION_POINTS 条目；且 `TaskAdmitted.providerFamily` 必须从 `SANDBOX_PROVIDER_FAMILIES` **派生**，不得重声明 `z.enum`。

### 2.4 (E) 守护与 (D) 开关的仓内可行性

**C14 · 三条「非事件」在今日代码里全都带返回值 → 类型层守护能机械地恰好排除它们**
且仓内已有编译期 `.typecheck.ts` 闸门作为成熟机制（G12/G13）。
证据：`apps/api/src/audit/audit-recorder.port.ts:57-62`（`recordProvisioningFailure(...): Promise<boolean>`）、`:68`（`recordTaskCancellation(...): Promise<boolean>`）、`:24-28`（"returns a durability acknowledgement so the already-failed Task can keep its admission work reclaimable"）；消费者 `tasks.service.ts:2563-2583`（`requireProvisioningFailureAudit` 在 `!recorded` 时抛 `DurableAdmissionTerminalAuditError`）；`task-provisioning-diagnostics-write-gate.port.ts:23`（`isEnabled(): boolean`）；admission-work 转移 `guardrails.service.ts:931-1060`（`lease.authorize()` / `lease.checkpoint()` 被 await 取权威）；先例 `apps/api/src/task-admission/admission-mode-policy.typecheck.ts`、`packages/contracts/src/runtime-metadata.typecheck.ts`
意义：图纸偏好的守护（「类型层让带返回值的 port 无法被注册为订阅者」）既可行又比扫描闸门便宜，且由编译器强制而非由需要 gate-canon 自测 + 注入探针红证的脚本强制。

**C15 · 两个 cutover 开关模板，重量不同**
重的（admission v2）：Symbol token + 返回完整结果对象而非 boolean（理由写在代码里）+ 250 行 deploy runbook + quick-deploy 接线。轻的（diagnostics write gate）：构造时快照一次 env + 纯求值函数，**零 compose/quick-deploy 接线**（仅文档）。
证据：重 `apps/api/src/task-admission/task-admission-gate.ts:16-46`（"A `isEnabled(): boolean` here destroyed the closed reason…"）、`deploy/TASK_ADMISSION_V2_CUTOVER.md`、`deploy/DEPLOY.md:28`、`scripts/quick-deploy.sh:595,667,1119-1141,1541`；轻 `task-provisioning-diagnostics-write-gate.port.ts:16-47`，仅记于 `docs/task-provisioning-diagnostics.md:113` 与 `.zh.md:94`
意义：本 change 零行为变化（双写、零订阅者），**轻模板是成比例的那个**——env 快照 port + 纯 `…Enabled(env)` 求值，无 runbook、无 quick-deploy 编辑。重模板留给 change 2–5 的逐订阅者 cutover。

### 2.5 验收基线的实测数字（与文档口径有出入）

**C16 · 行为等价基线需重测：guardrails 目录今日是 120 个 `test()` + 8 个断言脚本，且 inline mirror 是 6 个不是 4 个**
120 = 57 + 54 + 3 + 3 + 3，分布在 5 个 `.spec.ts`；另有 8 个 `.test.mjs` 完全不 import `node:test`（在 `node --test` 下各算一个文件级测试）。
证据：`guardrails.service.spec.ts`(57 `test(`)、`guardrails-durable-launch-decision.spec.ts`(54)、`guardrails-branch-policy.spec.ts`(3)、`semaphore-restore.spec.ts`(3)、`transfer-progress-throttle.spec.ts`(3)；`semaphore.test.mjs:26`（"---- inline the class (mirrors semaphore.ts, no transpile step needed) ----"），同类 inline/mirror 措辞另见 `circuit-breaker.test.mjs`、`delivery-results-surfaced-and-audited.test.mjs`、`guardrails-bootstrap.test.mjs`、`guardrails-exit-roundtrip.test.mjs`、`pushback-on-success-before-teardown.test.mjs`
意义：「122 个测试」与「4 个 inline mirror」（出自 `docs/refactor-master-plan.md:137-139`）**对当前树是陈旧的**。验收必须引用新测数字，否则 verify 阶段会去追一个从未存在过的数。

**C17 · 「9 个目录外 spec 构造 GuardrailsService」这个数字今日精确可验**
13 个文件引用 `new GuardrailsService`，其中 4 个在 `apps/api/src/guardrails/` 内（3 spec + module），余 9 个在外：6 个在 `tasks/`、2 个在 `public-surface/`、1 个在 `task-admission/`。
证据：`tasks/tasks-durable-admission-{accept-queue-diagnostics.story,cleanup-coordination.story,cleanup,crash-matrix,diagnostic-recovery.story}.spec.ts` + `tasks-legacy-request-lifetime.spec.ts`；`public-surface/durable-admission-cross-surface.story.spec.ts` + `generated-private-git-branch-refresh.story.spec.ts`；`task-admission/task-admission.worker.spec.ts`
意义：这 9 个文件钉死了位置化构造签名——这正是 bus 参数必须放最后且 `@Optional()` 的原因（见 C3）。

---

## 3. Archive 路线 — 归档 change 判例

### 3.1 结构范本

**A1 · 最接近的结构范本 = `2026-07-29-isolate-legacy-admission-behind-capability-policy`**
同一 guardrails 目标、同样以「既有测试零修改通过」作行为等价硬证据、同样 port+DI token、同样「先立机制后续再迁移」的切分。工件组成：proposal/design/tasks/specs + 独立 `baseline.md` + 中途重切纪要 `track-3-recut.md`。
证据：`openspec/changes/archive/2026-07-29-isolate-legacy-admission-behind-capability-policy/{proposal.md,design.md,tasks.md,baseline.md,track-3-recut.md,specs/guardrails/spec.md}`
意义：整体照抄这套骨架：proposal 的 Non-Goals 段**逐条编号列出后续 5 个 change**（该 change 就是用 4 条编号 Non-Goals 声明「这是退役第一步，删除是最后一步」）；design 用 `D1..Dn` 编号决策且每条带 "Alternative rejected"；tasks 用 Track 分组，以 baseline-evidence 轨打头、verification 轨收口。

**A14 · tasks 的既定格式与共享文件隔离纪律**
Track 注解 + 每条任务带 requirements/surfaces/verify 三行元数据 + 落地/红证注记；共享文件的写者一律隔离进一条 **SERIAL integration 轨**。
证据：`archive/2026-08-01-unlock-extension-axes/tasks.md:1-18` 及其后每条任务的元数据栏；`archive/2026-08-01-enforce-boundaries-from-manifest/proposal.md`（共享文件碰撞风险段，明写「照抄 close-gate-blindspots 的并行 track + SERIAL integration track」）
意义：本 change 的共享写者已可预判：`guardrails.service.ts`、`tasks.service.ts`、`app.module.ts`、contracts index、两个 admission 路径。按惯例这些应集中在一条 SERIAL 集成轨，contracts schema 与 bus 机制各自成并行轨——否则 `opsx-apply-tracks` 并行集成会出现记忆里记过的「勾选丢失/集成冲突」。

### 3.2 「零修改」验收如何写才成立

**A2 · 「既有测试零修改」在范本里是决策 D5 + 独立验收任务，不是口号**
D5 规定「若某测试必须改才能通过，那就是抽取改变了行为，错的是抽取不是测试」；task 4.3 的验收方式是 **diff 层面证明**——`apps/api/src/guardrails/` 下无任何 `*.spec.ts` 被修改，目录外被触及的 spec 只允许改 stub 方法名，不得改任何断言/期望值/计数器。
证据：`archive/2026-07-29-isolate-legacy-admission-behind-capability-policy/design.md:210-227`（D5）与 `tasks.md:40`（4.3）
意义：本 change 的核心验收必须落成同形态的一条 verification 任务：以 diff 为证据，并**显式声明目录外允许的唯一改动种类**。若发布点接线要求 spec 增补 bus stub，则「允许新增 stub 构造、禁止改断言」要**提前写进 design**，否则 verify 会判 re-baseline。

**A3 · 「源码文本扫描型测试」的陷阱实录**
`sandbox-host-harness-wiring.test.mjs` 不测行为而读源码文本，曾把 `guardrails.service.ts` 硬编码为唯一持有两条 provisioning 路径的文件，抽取后必须同步改它（且要保住断言强度：两条路径各自仍解析 workspace source、provision-context 计数仍钉死为 2）。该文件今天仍在，且已把 inline-admission 列为第二个被扫文件。
证据：`archive/2026-07-29-.../tasks.md:40`；`apps/api/src/sandbox/sandbox-host-harness-wiring.test.mjs:105-119`
意义：「零修改」的验收必须先把这类文本扫描测试从统计口径里**单列**。本 change 在 guardrails/admission/provisioning 三处新增 publish 调用，极可能触发同类文件的行数/文件清单断言——提前枚举比 apply 期被红便宜，且该文件已有「按文件分别断言而非求总数」的写法可直接复用。

**A15 · 新目录/新测试必须被真正挂载**
test-suite-discovery 闸门（`wire-orphaned-test-suites`）存在的原因是曾有 40 个 apps/api 测试文件无人执行；姊妹 change 的验收里专门有一条「跑 `pnpm test:scripts` 与仓库 test-discovery 闸，确认新目录的测试真被挂载而不是静默不跑」。新建目录同时受 `api-module-layout-check` 约束，`ALLOWED_CYCLES` 必须保持为空。
证据：`archive/2026-07-28-wire-orphaned-test-suites/proposal.md:1-12`；`archive/2026-07-29-.../tasks.md:38(4.1), 42-43(4.4/4.5)`；`scripts/api-module-layout-check.mjs`
意义：DomainEventBus 若落在新顶层目录，验收必须同时包含：层次闸门空 `ALLOWED_CYCLES` 通过、新测试被 discovery 闸看见、r7 ratchet 不升。

### 3.3 最贵的一条教训：边界扫描必须双向

**A4 · 范本最贵的教训是边界只做了「向内扫描」**
D4 依据「这个块碰了谁」定抽取范围；Track 3 开工时补做「谁还碰着这个块碰的东西」的反向扫描，结论**整体翻转**（两个被判 legacy 独占的字段在块外有读者、3 个状态容器根本没被列出、12 个方法里 5 个有块外调用者），被迫中途重切并单独写 `track-3-recut.md` 记录四个候选切法的实测代价。
证据：`archive/2026-07-29-.../track-3-recut.md:1-60` 与 `design.md:153-208`（D4a supersedes D4）
意义：直接适用于本 change 两处——
(1) 五个发布点的定位必须**双向扫**（谁写这些状态 / 谁在同一时刻也读），否则 `TaskSettled`/`TaskSuperseded` 的「终态转移点」会像当年的 `settleTask` 一样是 durable 与 legacy 共享的（C4/C5 已经在实测里印证了这个风险）；
(2) 五个横切订阅者的既有同步调用点也要**在本 change 内**先做反向扫描并写进 baseline，否则后续 5 个迁移 change 会各自重演一次翻转。

### 3.4 可逐字复用的措辞与机制

**A5 · best-effort 的 SHALL 措辞已有可逐字复用的范本**
`persist-session-transcripts` 的 guardrails spec delta：「SHALL NOT change… SHALL NOT block, delay, or fail…；capture error SHALL be logged and swallowed so the terminal transition and slot release proceed unconditionally」，配 3 个 scenario（自然终态、强制失败、capture 抛错不阻断）。对应 port/DI token 实体是 `AUDIT_RECORDER_TOKEN`。
证据：`archive/2026-06-16-persist-session-transcripts/specs/guardrails/spec.md:1-30`；`apps/api/src/audit/audit-recorder.port.ts:112`
意义：DomainEventBus 的 best-effort 语义写进 spec 时直接沿用这套 SHALL 措辞与三 scenario 结构（发布成功路径、订阅者抛错路径、发布点行为不变路径），避免自创弱措辞导致 verify 判 untestable。

**A7 · 「加东西不加规则就编译不过」的既有机制是 `.typecheck.ts` 自失效夹具**
仓内已有 6 处，其中 `admission-mode-policy.typecheck.ts` 正是姊妹 change 的产出；红证记录方式是把注入后的 tsc 报错**逐字抄进 tasks.md 再 revert**（如 `unlock-extension-axes` 1.6 抄了 TS2578 三行）。
证据：6 个 `*.typecheck.ts`；`archive/2026-08-01-unlock-extension-axes/tasks.md` 任务 1.6 的「自失效红证」栏
意义：(E) 优先走类型层这条路——仓内已有成熟范本与红证记录格式，成本远低于新建扫描闸门；只有当类型层挡不住时才升级为 gate，届时才需走 gate canon 全套。（与 W7/W9 的实测写法直接对接。）

**A8 · 若确实新建闸门，gate canon 四件套的定义与证据格式已定稿**
配对自测 `node script && node --test script.test.mjs`、带 reason/ownership 的三字段例外数据、空清单即健康/空扫描即败、每个闸门一条注入探针任务（证明能变红，红证记 tasks.md 后 revert）。同 change 还立下铁律：**CI check 显示名是被消费的 attestation API**（release.yml 会查询），任何重命名都是另一个协调 change。
证据：`archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/proposal.md`
意义：对应「CI check 显示名逐字节不动」约束——新闸门应作为既有 required job 内的**新 step** 落地，而不是新 job/新显示名（与 C13 一致）。

**A9 · r7 ratchet 的基线数据本身就把本阶段预约为燃尽人**
`scripts/ratchets/r7.json` 每条 cross-context-import 条目的 `change` 字段写着「阶段 4–6 燃尽（事件订阅 + 对方 `*.port.ts` 显式导出 + 阶段6归拢）」；comparator 是 close-gate-blindspots 造的共享模块（新违规红、**陈旧条目也红**、缩减须同 PR 提交、归零即删文件）。
证据：`scripts/ratchets/r7.json`；`scripts/ratchets/comparator.mjs` 与 `comparator.test.mjs`；`archive/2026-07-31-close-gate-blindspots.../specs/ratchet-baselines/spec.md`
意义：proposal 可直接引用 r7 条目的 `change` 字段论证「本 change 属于已登记的燃尽路径」。注意 fail-closed 语义——若本 change 顺手消灭了某条 cross-context import，**必须在同一 PR 里把该条目从 r7.json 删掉**，否则「陈旧条目」照样红。

### 3.5 反面教材与 sidecar 纪律

**A6 · 全归档 151 个 change 无进程内事件总线先例；仓内唯一 outbox 语义是 `TaskAdmissionWork` 表**
design 明写「The Task row and admission outbox form the durable acceptance boundary」；仓库也没有 `@nestjs/event-emitter` 依赖。
证据：`archive/2026-07-16-fix-large-repo-task-provisioning/design.md:141,162-164`；`apps/api/prisma/schema.prisma:239,256,306`（`model TaskAdmissionWork @@map task_admission_work`）
意义：两点——(1)「不建 outbox」的措辞必须**与已存在的 admission outbox 区分**，否则读者会以为要拆现有 `TaskAdmissionWork`；(2)「无仓内先例」本身要在 proposal 里明说——close-gate-blindspots 建 ratchet 时就是这么写的（`scripts/ratchets/`, no in-repo prior art），并同时承诺该机制被后续阶段复用，这正是本 change 作为 1/6 底座该采取的论证形状。

**A10 · cutover 开关的反面教材是 task-model-selection**
默认关闭的闸门 + 绑定 buildIdentity 的手工 attestation → 每次升级静默失效、`/v1/runtime-models/query` 反复 503，最终要专开一个 change 把 attestation 做进 CI。task-admission v2 的开关文档同样是「boolean 单独永远打不开闸门，还要完整未过期的 attestation」。
证据：`archive/2026-07-22-automate-task-model-attestation-in-ci/proposal.md:3-9`；`deploy/TASK_ADMISSION_V2_CUTOVER.md:1-14`；`apps/api/src/task-admission/task-admission-gate.ts:1-46`
意义：本 change 的开关框架照抄 TASK_ADMISSION_V2 的「**读一次即冻结 + 返回完整结果而非 boolean**」形态（gate.ts 注释就是这条判例的原文），但必须显式与 attestation 门禁**划清界限**：默认新路径、逃生口回旧路径、零 attestation 依赖——否则会复制出第二个「升级即静默降级」的 503 类故障。

**A11 · contracts 两闸门的语义与逃生口已在 `converge-contracts-rules-that-never-run` 定案**
import 可达 ≠ 被执行；执行只认真 parse（`.parse/.safeParse/…`、ZodValidationPipe、UsePipes 及被执行 schema 的组合）；间接执行必须在 `INDIRECTION_POINTS` 里逐条声明 file:line。该 change 还删掉了两条「靠名字推断执行」的模式（zodToJsonSchema / parseZodValue 字面名），理由是反射产出文档不是对字节的裁决。
证据：`archive/2026-07-30-converge-contracts-rules-that-never-run/tasks.md:27(1.1)、118(5.2)、122(5.3)、107(4.4)`；`scripts/contracts-executed-schema-check.mjs` 与其 `.test.mjs`
意义：五个事件 payload schema 若只在发布点被构造而不 parse，会被 executed 闸判死。两条合法出路各有代价：真 parse（每次发布一次 zod 解析，是运行时开销与 best-effort 语义的交互点，需在 design 拍板——与 W20 的量级论证对接）；或登记 `INDIRECTION_POINTS`（该登记把发布点的 file:line 钉进闸门，等于给自己加一条「重构即红」的耦合——converge-contracts 自己在 sidecar 里把这条列为「无字节变化的新耦合」并明写出来）。

**A12 · 本 change 的 sidecar 胚胎与最像的归档在一个字段上取值相反**
胚胎：四面 derived + 8 条 protocolDifferences + `verification.id: workflow-gates`，`requiresWireCompatibilityFixture: false`。最像的归档 `unlock-extension-axes`（同为 contracts 新增、同 8 条 protocolDifferences、同 workflow-gates）取 **true**。
证据：`openspec/changes/add-domain-event-bus/surface-impact.json`；`archive/2026-08-01-unlock-extension-axes/surface-impact.json`
意义：derived 的理由段可逐句沿用；但 `requiresWireCompatibilityFixture` 的取值**必须在 design 里给出理由**——最近的同形态先例取 true 而本胚胎取 false，verify 一定会追问差异。

**A13 · sidecar 造假有归档判例**
converge-contracts 系列留下 NOT-ARCHIVABLE 事后复盘，结论是 sidecar 的每一面声明都要逐面对着 diff 核，且每条声明的 verification lane 必须真的跑过；`enforce-boundaries-from-manifest` 因此把「verify 前须在集成树真跑每条声明 lane」写进 Impact。
证据：`archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/proposal.md`（Impact 段的 NOT-ARCHIVABLE postmortem 引用）；`archive/2026-08-01-enforce-boundaries-from-manifest/proposal.md`
意义：本 change 的四面 derived 是最容易被质疑的部分（contracts 新增了五个 schema）。应在 tasks 里预留一条「逐面对 diff 复核 + 跑 `public-surface-adversarial`」的任务，并把传递引用证明（`/v1` 与 MCP 注册表是否 import 事件 schema）像 unlock-extension-axes Impact 段那样写成**可复算的证据**，而不是一句断言。

---

## 4. Implications for the proposal

按 change 的五个设计接缝 (A)–(E) 组织，末尾附落位/闸门、验收、工件编排与开放问题。每条标注支撑编号。

### (A) Bus 语义与实现形态

1. **自建，不引入框架总线。** `@nestjs/event-emitter` / `@nestjs/cqrs` 都不给 best-effort 保证（W4），仓内也无任何 event-emitter 依赖或 EventEmitter 使用（C18）。→ alternatives 段用 W4 两条 issue 把「为什么不用现成库」写实。
2. **best-effort 必须由 bus 自己实现 per-subscriber try/catch。** 裸 EventEmitter 在监听器抛错时会中断后续监听器并把异常抛回发布者，async rejection 更会逃逸成 `unhandledRejection`（W3 实测）。→ spec requirement 直接沿用 A5 的 SHALL 措辞 + 三 scenario 结构（发布成功、订阅者抛错、发布点行为不变）。
3. **必须拍板订阅者签名：纯 `void` vs `void | Promise<void>`（W9a）。** 选纯 `void`，则后续要做 IO 的订阅者（transcript 采集、diagnostics）会被守护挡住，须**提前写好出口**；选允许 Promise，则守护要放宽成「非 `Promise<非 void>`」且 bus 必须自己 catch rejection。这是 (A) 与 (E) 的耦合点，不能分开决定。
4. **订阅者注册走显式数组 token（如 `DOMAIN_EVENT_SUBSCRIBERS`），不走 `DiscoveryService`。** Nest 无 multi-provider 数组注入（W18）；DiscoveryService 会把注册变成运行时扫描，令 (E) 的类型守护失效。→ 决策与理由都要落 design。
5. **失败必须可见，是本 change 自带的 requirement。** 吞掉的订阅者异常至少落一条 `eventType + subscriberName + error` 的结构化日志（W12）。理由要写明：阶段 4 后续把 audit/metrics/计费搬到订阅者上之后，静默失败会直接变成计费漏账。
6. **事件名避开 `'error'`，bus 内部失败上报通道不复用 `'error'`（W5）。** 否则一个订阅者异常可能升级成进程退出，与 best-effort 承诺矛盾。
7. **文件命名与落位：`domain-event-bus.port.ts`（→ domain 层）+ 具体实现 `*.service.ts`（→ application 层）。** 裸 `.ts` 会产生 `unclassified-file` finding → 新 r7 键 → 比较器判增 → 红（C10）。port 文件自身不得 import 本 context 的 `.service.ts`（`allowedImports.domain === ['domain']`，C11）。DI 形状逐字照抄 `audit-recorder.port.ts` + `audit.module.ts` 的 `@Global()` + `useExisting`（C2）。
8. **注入进 `GuardrailsService` 时必须是第 11 个可选尾参**（C3 + C17），否则 9 个目录外 spec 的位置化构造会断——而那正是零修改验收本身。

### (B) 事件目录 v1 与五个 payload schema

1. **信封最小基线：`eventId + occurredAt + type`（+ 可选 taskId/correlation 作 subject）。** 不做整套 CloudEvents，但带 id/time 使未来升级 outbox/跨进程时是加字段而非改结构（W16）。
2. **`eventId` 不是可选装饰，是后续 change 的硬前置。** 本 change 因零订阅者天然无重复副作用风险（值得在 proposal 里作为「为何切这么小」的理由明说），但 change 2–5 会进入「订阅者已接上、直接调用尚未拆除」的窗口，那时需要按事件 id 去重或前置状态检查（W15）。现在不带 id，后续每个 change 都要改 contracts schema，与 additive-only 纪律和四面 derived 声明反复摩擦。
3. **fat by design，理由写成「为了解环」。** `TaskAdmitted` 带 `fencedToken`、`SandboxProvisioned` 带 environment 快照是有意的 fat 选择——若 thin，订阅者仍需回查发布者，第 6 个 change 的 forwardRef 环解不掉（W17 + C18）。同时用「只放原始类型与 ID、不放实体实例」约束 environment 快照形态。
4. **`TaskAdmitted.providerFamily` 必须从 `SANDBOX_PROVIDER_FAMILIES` 派生，不得重声明 `z.enum`**（C19）。
5. **`fencedToken` 存在语义分叉，必须在 spec 里裁决。** durable 路径是 `claim.leaseToken` + 新铸 `transitionToken`，legacy 路径是 `guardrails.admit()` 的 token（C7）。schema 要么两者都接受并带判别字段，要么明确 canonical 是哪个——否则两个发布者静默分歧。
6. **executed-schema 闸门的满足方式建议选「发布点真 `.parse()`」。** 五个事件是每任务数次的低频事件，不在 per-token/per-frame 热路径，开销可被论证为可忽略（W20 + A11）；登记 `INDIRECTION_POINTS` 的代价是把发布点 file:line 钉进闸门 = 一条「重构即红」的新耦合（A11 自己把这种登记列为「无字节变化的新耦合」）。→ 结论写成「不在 INDIRECTION_POINTS 登记」。
7. **事件目录 v1 显式标注这五个是 domain events（进程内），并写死升级条件**：「一旦出现跨进程消费者或必须持久的订阅者，即升级为 integration event 并另开 change 引入 outbox」（W11）。演进规则与仓内 additive-only 纪律同构：只加可选字段；破坏性变更 = 新事件名（W16）。
8. **「不建 outbox」的措辞必须与仓内已存在的 `TaskAdmissionWork` admission outbox 划清界限**（A6），否则读者会以为要拆现有表。
9. **不引入 EventCatalog/AsyncAPI。** 面向跨服务与外部消费者，对进程内五事件过重，且引入新公开面与闸门负担（W21）。只借鉴两点：条目带版本；目录里同时记录「什么不是事件」——后者正是本 change 相对该生态的差异点，值得写明。

### (C) 五个发布点（本轮最大的图纸偏差）

1. **图纸的 1:1 映射与代码不符，spec 必须逐点枚举。** `TaskRunStarted` 有 **3** 个发布点（readoption / legacy `startRunningAfterCapacity` / durable `armDurableRuntime`），`recordEnd` 有 **2** 处且 `clearAdmissionRuntime` **不是终态结算**（C4）。若照「recordEnd 处 = TaskSettled」机械接线，会发出假的 TaskSettled。→ spec requirement 必须点名哪个 `recordEnd` 才是结算点。
2. **`TaskSuperseded` 是唯一没有发布者的事件，且「取代者」不可从现有状态推导**（C5）。两条出路二选一：payload 去掉「取代者」只带观察方 token；或开一条 open question 给用户。**不得发布代码根本不知道的 superseder 身份**——那是伪造数据。→ 见「开放问题 Q1」。
3. **`SandboxProvisioned` 与 `TaskAdmitted` 各有恰好两条路径，且所需数据已在手**（C6/C7）：两个 provisioning 发布点都紧贴 `provision()` 成功之后、`openSession` 之前/之时，`provisionPlan.environment` + `selectedRun` 已给出 sandboxRef 与快照，无需新增管线。
4. **发布点定位必须做双向扫描并写进 baseline**（A4）。范本最贵的教训是只做了向内扫描，Track 3 补做反向扫描后结论整体翻转、被迫中途重切。C4/C5 已经在实测层面印证了同类风险（终态转移点是 durable 与 legacy 共享的）。→ baseline 轨必须包含：五个发布点的「谁写 / 谁在同一时刻也读」双向清单，以及五个横切订阅者既有同步调用点的反向扫描（否则后续 5 个迁移 change 各自重演一次翻转）。
5. **发布是新增行为，旧测试按定义覆盖不到**（W14）。→ 五个发布点各需一条新测试：「发布被调用一次且 payload 正确」。

### (D) Cutover 开关框架

1. **用轻模板（diagnostics write-gate 形态），不用重模板。** 本 change 零行为变化（双写、零订阅者），成比例的是「构造时快照一次 env + 纯 `…Enabled(env)` 求值」，无 runbook、无 quick-deploy 编辑（C15）。重模板留给 change 2–5 的逐订阅者 cutover。
2. **但要抄重模板的一个形状：返回完整结果对象而非 boolean。** `task-admission-gate.ts:16-46` 的注释就是这条判例的原文（「A `isEnabled(): boolean` here destroyed the closed reason…」，C15/A10）。
3. **必须显式与 attestation 门禁划清界限：默认新路径、逃生口回旧路径、零 attestation 依赖**（A10）。task-model-selection 的反面教材是「默认关闭 + 绑 buildIdentity 的手工 attestation」→ 每次升级静默失效 → `/v1/runtime-models/query` 反复 503。
4. **建框架的同时定义开关的退役条件与登记位置**（W13）。阶段 4 六个 change 累计留下 5–6 个逃生开关；每个开关在 deploy 文档里带 owner + 预期移除的 change 编号，否则第 6 个 change（依赖预算 ratchet 归零）会发现代码里全是没人敢删的分支。这是照抄 `TASK_ADMISSION_V2_CUTOVER` 模板时最容易漏掉的一半。

### (E) 非事件清单与守护

1. **把非事件清单写成准入规则，不是三个特例。** 采用 W1 的判据：「需要回执 or 需要拒绝 or 发布者依赖其结果 → 是调用」（业界名：passive-aggressive event / command-in-disguise；「命令可以被拒绝，事件只能被忽略」）。W2 给出「不是我们项目特殊」的外部背书。措辞按**是否存在返回值/确认语义**写，不按关注点名字写——否则后续 change 换个名字就绕过（W2）。
2. **守护优先走类型层，不新建扫描闸门。** 三条非事件今日在代码里全带返回值（`recordProvisioningFailure(): Promise<boolean>`、`recordTaskCancellation(): Promise<boolean>`、`isEnabled(): boolean`、`lease.authorize()/checkpoint()` 被 await 取权威，C14），类型守护能机械地恰好排除它们；仓内已有 6 处 `.typecheck.ts` 自失效夹具与成熟红证格式（A7）。
3. **⚠ 最自然的写法是假守护，必须在 proposal 里写成显式风险。** `(e) => void` 参数类型**放行**返回对象与返回 Promise 的处理器（W6 实测，语言设计使然）。若照此实现，闸门会绿而 audit port 的 `record(): Promise<{persisted}>` 照样能注册。
4. **采用 W7 已验证的写法（可直接进 tasks，不必 apply 期现试）**：
   `subscribe<T extends (e: Evt) => any>(h: T & (ReturnType<T> extends void ? unknown : never))`。实测精确放行 `(e)=>{}`、`(e)=>voidMethod(e)`、`m.onSettled.bind(m)`，拒绝返回对象/返回 Promise/分支返回值三类。W8 已排除两个更优雅但坏掉的变体，避免 apply 期误判「类型守护做不到」。
5. **验收必须同时含正例与负例**（W8）：负例必须报错、正例必须通过——否则很容易落成一个把所有人都挡住的假闸门。红证按 A7 的格式：注入后 tsc 报错逐字抄进 tasks.md 再 revert。
6. **报错信息品牌化**（W9b）：把 `never` 换成带说明文字键的对象类型，编译器会把整句解释原文打进错误里（实测原样输出 `__CAP_ERROR__: subscribers must return void. A collaborator that returns an acknowledgement is a CALL, not an EVENT — see docs/refactor/08 §C non-event list.`）。等于把非事件清单的纪律写进编译器，比 gate 扫描更早、更便宜。
7. **备选/补充：`typescript-eslint` 的 `no-misused-promises`（checksVoidReturn）**（W10）——若签名保持 `=> void` 而不上守护，这是低成本第二道网，挡住 async 订阅者造成的 floating promise（floating promise 恰恰会让 best-effort 承诺失效）。写进 alternatives。
8. **只有当类型层挡不住时才升级为 gate**（A7）。届时才需走 gate canon 全套：root 脚本 + 配对自测 + 既有 required job 内的**新 step**（绝不新 job/新显示名，因为 CI check 显示名是 release.yml 消费的 attestation API，C13/A8）。

### 落位、闸门与 ratchet

1. **新目录必须在同一 commit 加进 `contexts-manifest.json`，否则 layout-v2 硬失败 exit 1**（C9）。没有第三种落地即绿的选项。
2. **manifest 的「领域事件订阅」机器可读编码是本 change 有书面邀请的 in-scope 工作**（C8）——`$comment` 明写「等事件落地再补声明，不在脚本里猜」。跳过则闸门无法给 change 2–5 的订阅者 import 打分。
3. **文件命名先于第一行 import 决定 r7 结果**（C10）。
4. **跨 context import 只有三种合法形态**（C11）：发布者只能 import bus 的 `.port.ts`，实现只在 `app.module.ts` 绑定。
5. **R11 依赖预算 ratchet 尚不存在**（C12）。若本 change 创建其基线，今日活测种子：`this.audit` 9、`this.runnerMinutes` 6、`provisioningDiagnosticRecorder` 4、`provisioningDiagnosticWriteGate` 4、`this.transcripts` 2、`metrics-projection` 2。
6. **r7 已把本阶段登记为燃尽人**（A9），proposal 可直接引用条目的 `change` 字段论证正当性；但 comparator 是 fail-closed 双向的——**顺手消灭某条 cross-context import 就必须在同一 PR 删掉该 r7 条目**，否则「陈旧条目」照样红。
7. **新目录/新测试的挂载要单独验收**（A15）：层次闸门 `ALLOWED_CYCLES` 保持为空 + 新测试被 test-discovery 闸看见 + r7 不升。

### 验收基线（必须重测后再写进 proposal）

1. **「122 个测试」与「4 个 inline mirror」对当前树是陈旧的**（C16）。实测：guardrails 目录 **120 个 `test()`**（57+54+3+3+3，5 个 `.spec.ts`）+ **8 个** 断言脚本 `.test.mjs`（各算一个文件级测试），inline mirror 是 **6 个**不是 4 个。→ 验收必须引用重测数字，否则 verify 会去追一个从未存在过的数（同时说明「122」大概率是把两类计数混算的历史值，proposal 应说明口径）。
2. **「9 个目录外 spec」这个数字精确且今日可验**（C17）：13 处 `new GuardrailsService` − 4 处目录内 = 9（tasks/ 6、public-surface/ 2、task-admission/ 1）。
3. **零修改验收写成 D5 形态 + 一条 diff 证据任务**（A2）：guardrails 目录内零 `*.spec.ts` 修改；目录外**只允许**某一类改动，且该类改动必须**提前写进 design**（若发布点接线要求 spec 增补 bus stub，就写「允许新增 stub 构造、禁止改断言/期望值/计数器」），否则 verify 判 re-baseline。
4. **文本扫描型测试单列出统计口径**（A3）：`sandbox-host-harness-wiring.test.mjs` 读源码文本而非测行为，本 change 在 guardrails/admission/provisioning 三处新增 publish 极可能触发其文件清单/计数断言。提前枚举比 apply 期被红便宜；该文件已有「按文件分别断言而非求总数」的写法可复用。
5. **称之为 characterization 验收**（W14），并同时声明五条新测试补上「发布」这一新增行为（旧测试按定义覆盖不到）。

### 工件骨架与 tasks 编排

1. **整体照抄 `2026-07-29-isolate-legacy-admission-behind-capability-policy` 的骨架**（A1）：proposal + design（`D1..Dn` 编号 + 每条 "Alternative rejected"）+ tasks（Track 分组，baseline-evidence 轨打头、verification 轨收口）+ specs + 独立 `baseline.md`。
2. **Non-Goals 段逐条编号列出后续 5 个 change**（A1），并用 W13 的 branch-by-abstraction / parallel change 术语说明「先建抽象、并存、toggle、最后删」的形态，用 W19 说明第 6 刀（解 forwardRef 环）为何必须排在最后：环不是靠删 forwardRef 解的，是把跨模块调用逐个换成发布/订阅后自然消失。第 6 刀要解的 4 个具体点已由 C18 钉死，写进接缝段使切分可信。
3. **「无仓内先例」要在 proposal 里明说**（A6），并承诺该机制被后续阶段复用——这是 close-gate-blindspots 建 ratchet 时用过的论证形状。
4. **共享写者集中进一条 SERIAL 集成轨**（A14）：`guardrails.service.ts`、`tasks.service.ts`、`app.module.ts`、contracts index、两个 admission 路径。contracts schema 与 bus 机制各自成并行轨——否则 `opsx-apply-tracks` 并行集成会重演「勾选丢失/集成冲突」。
5. **tasks 每条带 requirements/surfaces/verify 三行元数据 + 落地/红证注记**（A14）。
6. **sidecar 已就绪，不要重推**（C1）——proposal 工作是在其之上写 proposal/tasks/specs。但要补两条任务（A13）：逐面对着 diff 复核四面 derived 声明 + 在集成树真跑 `public-surface-adversarial`，并把传递引用证明（`/v1` 与 MCP 注册表是否 import 事件 schema）写成**可复算的证据**而非一句断言。sidecar 造假有 NOT-ARCHIVABLE 判例。

### 必须拍板 / 开放问题

- **Q1（阻塞 (C)）— `TaskSuperseded` 的「取代者」怎么办？** 代码在所有 superseded 观察点都没有 superseder 的 handle（C5）。选项：(a) payload 去掉「取代者」，只带观察方 token 与被取代任务 id；(b) 开一条 open question 请用户裁决是否值得为此新增管线。**不可伪造。**
- **Q2（阻塞 (A)/(E)）— 订阅者签名允不允许 `Promise<void>`？** 影响守护写法、bus 是否需自己 catch rejection、以及后续做 IO 的订阅者（transcript 采集、diagnostics）有无出口（W9a + W3）。
- **Q3（阻塞 (B)）— `fencedToken` 的 canonical 定义？** durable 与 legacy 两条路径持有的是不同的 token（C7）。
- **Q4（阻塞 sidecar 一致性）— `requiresWireCompatibilityFixture` 为何取 `false`？** 最近的同形态先例 `unlock-extension-axes` 取 `true`（A12）。理由必须写进 design，否则 verify 会追问。
- **Q5（影响 (C) 范围）— `clearAdmissionRuntime` 处的 `recordEnd` 明确不发 `TaskSettled`，需要在 spec 里作为反向要求写死吗？** 建议写死（负向 requirement 比注释更能挡住后续 change 的误接线，C4）。
