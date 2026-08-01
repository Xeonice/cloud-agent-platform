# Proposal: add-domain-event-bus

> 溯源标注引用 `research-brief.md` 的发现编号（W=Web 实践与实测、C=Codebase 实测、A=Archive 判例）。

## Why

阶段 4 要把五个横切关注点（audit 普通路径、metrics、diagnostics、transcript 收尾、runner 计费）从 guardrails 的同步直调逐个改成订阅，最终解开 tasks↔guardrails 的 forwardRef 环、把 guardrails 压到 <2,000 行。今天这条路上**一件机制都没有**：root 与 `apps/api` 的 `package.json` 都无 `@nestjs/event-emitter`，`apps/api/src` 下零个非 spec 的 `EventEmitter` 引用（C18），151 个归档 change 里也没有进程内事件总线的先例（A6）。没有总线，第一个关注点迁移就无从开始；而若让某个迁移 change 顺手把总线一并建了，则"总线保证等级、事件目录、什么不是事件"这些**要被后面五个 change 共用**的制度性决定，会被埋进一个以"搬 audit"为验收标准的 change 里，后续每个 change 各解释一遍。

Why now：`docs/refactor/contexts-manifest.json` 的 `crossContextRules.machineReadable` 已用 `$comment` 把"领域事件订阅"这个槽位预留给本阶段，并明写"等事件落地再补声明，不在脚本里猜"（C8）；`scripts/ratchets/r7.json` 每条 cross-context-import 条目的 `change` 字段写着"阶段 4–6 燃尽（事件订阅 + …）"（A9）。机制不落地，闸门就无法给后续订阅者的 import 打分——燃尽路径已登记，燃尽人还没到岗。

## What Changes

本 change 是 branch by abstraction / parallel change（expand-contract）的第一步：先建抽象、新旧并存、逐个切换、旧路径最后删（W13）。它只做"建"——**零订阅者、零既有调用移除、guardrails 行为零变化**。正因为零订阅者，并行期最典型的风险（同一副作用执行两次，W15）在本 change 内天然不存在，这是把第一刀切到这么小的理由。

- **进程内同步领域事件总线**：窄 port + DI token，形状逐字照抄 `audit-recorder.port.ts` + `audit.module.ts` 的 `@Global()` + `useExisting`（C2）。best-effort 由 bus **自己**对每个订阅者单独 try/catch 实现——W3 实测推翻了"EventEmitter 天然 best-effort"的直觉：Node v22.22.0 上第二个监听器同步抛错时第三个根本没被调用，异常直接从 `emit()` 抛回发布者，异步 rejection 更会逃逸成 `unhandledRejection`。同理不引入 `@nestjs/cqrs` / `@nestjs/event-emitter`：两者都不提供这个保证等级，社区做法都是再包一层（W4）。
- **失败必须可见**，写成本 change 自带的 requirement：被吞掉的订阅者异常至少落一条带 `eventType + subscriberName + error` 的结构化日志（W12）。理由是阶段 4 后续会把 audit/metrics/计费搬到订阅者上，静默失败会直接变成计费漏账。
- **事件目录 v1**：五个事件（`TaskAdmitted`/`SandboxProvisioned`/`TaskRunStarted`/`TaskSettled`/`TaskSuperseded`）的 payload 用 contracts zod 声明（R12），信封最小基线 `eventId + occurredAt + type`（W16），fat payload by design（理由是解环：thin 会让订阅者仍需回查发布者，第 6 刀的 forwardRef 环就解不掉，W17），`providerFamily` 从 `SANDBOX_PROVIDER_FAMILIES` 派生而非重声明 `z.enum`（C19），发布点真 `.parse()`（W20/A11，结论是**不**登记 `INDIRECTION_POINTS`）。目录显式标注这五个是**进程内 domain events**，并写死升级条件（一旦出现跨进程消费者或必须持久的订阅者，即升级为 integration event 并另开 change 引入 outbox，W11）——本期不落库、零 Prisma migration，且措辞须与仓内已存在的 `TaskAdmissionWork` admission outbox 划清界限（A6）。
- **在既有发布点接入发布，五个横切订阅者的既有同步调用一律保留**（双写过渡）。发布点拓扑与图纸的 1:1 假设不符，spec 必须逐点枚举：`TaskRunStarted` 有 **3** 个发布点（readoption / legacy `startRunningAfterCapacity` / durable `armDurableRuntime`），`recordEnd` 有 **2** 处且 `clearAdmissionRuntime` 那处**不是**终态结算（照图纸机械接线会发出假的 `TaskSettled`，C4）；`SandboxProvisioned` 与 `TaskAdmitted` 各恰有 2 条路径且所需数据已在手，无需新增管线（C6/C7）。
- **非事件清单写成准入规则，而不是三个特例**："需要回执 or 需要拒绝 or 发布者依赖其结果 → 是调用"（业界名 passive-aggressive event / command-in-disguise；"命令可以被拒绝，事件只能被忽略"，W1/W2），并由编译期守护强制而非扫描闸门（仓内已有 6 处 `.typecheck.ts` 自失效夹具作范本，A7）。⚠ 最自然的写法是**假守护**：tsc 5.9.3 strict 下把返回对象、返回 Promise 的处理器传给 `(e) => void` 参数**零报错**（W6 实测，语言设计使然）；采用 W7 已实测可行的写法，并把非事件纪律做成品牌化编译错误文本（W9b 实测：说明整句会被编译器原文打进错误里）。
- **cutover 开关框架**：用轻模板（构造时快照 env + 纯求值，无 runbook、无 quick-deploy 接线，C15），但抄重模板"返回完整结果对象而非 boolean"的形状；默认新路径、逃生口回旧路径、**零 attestation 依赖**（A10 的反面教材是 task-model-selection：默认关闭 + 绑 buildIdentity 的手工 attestation → 每次升级静默失效 → 反复 503）。建框架的同时定义开关的退役条件与登记位置，否则第 6 刀会发现代码里全是没人敢删的分支（W13）。
- **配套落位**：`contexts-manifest.json` 补"领域事件订阅"的机器可读编码（C8，有书面邀请的 in-scope 工作）；R11 依赖预算 ratchet 播种基线（C12，今日活测种子：`this.audit` 9、`this.runnerMinutes` 6、`provisioningDiagnosticRecorder` 4、`provisioningDiagnosticWriteGate` 4、`this.transcripts` 2、metrics-projection 2）。

不破坏：无 HTTP、MCP、数据库、环境变量的行为面变化（surface-impact 四公开面按制度声明 derived）。

## Capabilities

### New Capabilities

- `domain-event-bus`：总线语义（同步派发、per-subscriber 隔离的 best-effort、失败可见、事件名避开 Node 保留的 `'error'`，W5）、事件目录 v1（五个 payload schema + 信封 + 演进规则：只加可选字段、破坏性变更 = 新事件名）、非事件准入规则与其编译期守护、订阅者注册接缝（显式数组 token，不用 `DiscoveryService`——后者把注册变成运行时扫描会令类型守护失效，W18）、cutover 开关框架及其退役纪律。

### Modified Capabilities

- `guardrails`：编排在既有接缝上新增领域事件发布，且发布 SHALL NOT block、delay 或 fail 既有生命周期转移（措辞范本 A5）；三个 `TaskRunStarted` 发布点与**哪一处 `recordEnd` 才是 `TaskSettled` 结算点**逐点声明，并把"`clearAdmissionRuntime` 处不发 `TaskSettled`"写成负向要求（C4）。

## Impact

**代码**

- `packages/contracts/` — 五个事件 payload schema 与目录条目；`contracts-executed-schema-check` 要求发布点真 parse，`shared-export-check` 要求每个 export 可达（C19/A11）。
- 新的 bus 落位目录 — `*.port.ts`（判为 domain 层）+ `*.service.ts` 实现（判为 application 层）。裸 `.ts` 会产生 `unclassified-file` finding → 新 r7 键 → 比较器判增 → 红（C10）：**文件命名在写第一行 import 之前就决定了 r7 结果**。新顶层目录必须在同一 commit 加进 `contexts-manifest.json`，否则 layout-v2 闸门是硬失败 exit 1，没有第三种落地即绿的选项（C9）。跨 context import 只有三种合法形态，发布者只能 import bus 的 `.port.ts`（C11）。
- `apps/api/src/guardrails/guardrails.service.ts` — 3 处 `TaskRunStarted`、1 处 `TaskSettled`、1 处 durable `SandboxProvisioned`；bus 必须作为**第 11 个可选尾参**注入（C3），否则 9 个目录外位置化 `new GuardrailsService(...)` 的 spec 会断——而那正是零修改验收本身（C17：13 处引用 − 目录内 4 处 = 9，分布 tasks/ 6、public-surface/ 2、task-admission/ 1）。
- `apps/api/src/tasks/tasks.service.ts`、`apps/api/src/inline-admission/inline-admission.pipeline.ts` — legacy 路径的 `TaskAdmitted`/`SandboxProvisioned`、以及 superseded 观察点。
- `apps/api/src/app.module.ts` — 跨模块 DI 绑定（模板 C2）。
- `docs/refactor/contexts-manifest.json`、`scripts/ratchets/` — 见 What Changes 末条。

**测试与验收**（characterization 验收，W14）

行为等价基线须引用重测数字：guardrails 目录今日是 **120 个 `test()`**（5 个 `.spec.ts`：57+54+3+3+3）+ **8 个** `.test.mjs` 断言脚本 + **6 个** inline mirror——主计划里的"122 测试 / 4 个 inline 镜像"对当前树是陈旧的（C16）。零修改按 A2 的 D5 形态落成一条 **diff 证据**任务，且"目录外允许的唯一改动种类"必须提前写进 design，否则 verify 判 re-baseline。发布是新增行为、旧测试按定义覆盖不到，故五个发布点各需一条"发布被调用一次且 payload 正确"的新测试（W14）。源码文本扫描型测试（`sandbox-host-harness-wiring.test.mjs`）须从统计口径里单列（A3）。新目录/新测试的挂载单独验收：`api-module-layout-check` 的 `ALLOWED_CYCLES` 保持为空、新测试被 test-discovery 闸看见、r7 不升（A15）。发布点定位必须做**双向扫描**并写进 baseline——范本最贵的教训正是只做了向内扫描，Track 3 补做反向扫描后结论整体翻转、被迫中途重切（A4）。

**未受影响** — 唯一并行的 active change `session-approval-flow` 不触碰 guardrails；sidecar（`.openspec.yaml` + 完整 `surface-impact.json`）已就绪，本轮工作是在其之上写 proposal/specs/tasks，不重推 sidecar（C1）；但四面 derived 声明须逐面对着 diff 复核并真跑 `public-surface-adversarial`（A13 有 NOT-ARCHIVABLE 判例）。

**Non-Goals**（每条都是后续一个独立 change；本 change 不移除任何既有同步调用）

1. audit 普通路径改订阅。
2. metrics 改订阅。
3. diagnostics 改订阅。
4. transcript 收尾改订阅。
5. runner 计费（`recordStart`/`recordEnd`）改订阅。
6. 解 tasks↔guardrails forwardRef 环——4 个点已钉死（双向模块 import ×2 + `GuardrailsService` 的懒 `ModuleRef` 解析 + `fenced-task-admission.processor` 的 `moduleRef.get`，C18）。环不是靠删 forwardRef 解的，是把跨模块调用逐个换成发布/订阅之后**自然消失**（W19），所以它必须排在最后。

另外不做：引入 outbox（本期是进程内 domain events，不构成 dual-write，W11）；引入 EventCatalog/AsyncAPI 事件目录工具链（面向跨服务与外部消费者，对进程内五事件过重且引入新公开面，W21）。

**待拍板**（阻塞 specs/design，逐条见 research-brief §4 末节）

- Q1 `TaskSuperseded` 的"取代者"：所有 superseded 观察点都没有 superseder 的 handle（C5），payload 要么去掉取代者只带观察方 token，要么新增管线——**不可伪造**。
- Q2 订阅者签名允不允许 `Promise<void>`：决定守护写法、bus 是否需自己 catch rejection、以及后续要做 IO 的订阅者有无出口（W9a + W3）。
- Q3 `fencedToken` 的 canonical 定义：durable 路径是 `claim.leaseToken` + 新铸 `transitionToken`，legacy 路径是 `guardrails.admit()` 的 token（C7）。
- Q4 `requiresWireCompatibilityFixture` 为何取 `false`：最近的同形态先例 `unlock-extension-axes` 取 `true`（A12）。
- Q5 `clearAdmissionRuntime` 处不发 `TaskSettled` 是否写成负向 requirement（建议写死，C4）。
