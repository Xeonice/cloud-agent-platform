# Design: add-domain-event-bus

> 每个数字与判据的实测出处在 `research-brief.md`（W=Web 实践与实测、C=Codebase 实测、A=Archive 判例）。动机见 `proposal.md`，要求见 `specs/`。

## Context

阶段 4 要把五个横切关注点（audit 普通路径、metrics、diagnostics、transcript 收尾、runner 计费）从 `GuardrailsService` 的同步直调改成订阅，最后解开 tasks↔guardrails 的 forwardRef 环。这条路上今天**一件机制都没有**：root 与 `apps/api` 的 `package.json` 均无 `@nestjs/event-emitter`，`apps/api/src` 下零个非 spec 的 `EventEmitter` 引用，151 个归档 change 里也没有进程内事件总线的先例（C18/A6）。

本 change 是 branch by abstraction / parallel change 的第一步（W13）：**只建机制，零订阅者，零既有调用移除，guardrails 行为零变化**。因为零订阅者，并行期最典型的风险（同一副作用执行两次，W15）在本 change 内天然不存在——这正是把第一刀切到这么小的理由。

设计必须在写第一行代码之前拍板的约束：

- **文件命名先于第一行 import 决定闸门结果**（C10）。只有 12 个后缀被分层；`domain-event-bus.ts` 会产生 `unclassified-file` finding → 新 r7 键 → 严格比较器判增 → 红。
- **新顶层目录不进 `contexts-manifest.json` 是硬失败**（C9，`context-layout-check-v2.mjs` 返回 exit 1 而非 finding）。没有第三种落地即绿的选项。
- **跨 context import 只有三种合法形态**（C11）：目标以 `.port.ts` 结尾 / 导入方是 DI 组合（`*.module.ts`、`main.ts`、`app.module.ts`）/ 目标目录是 shared kernel。且 `.port.ts` 被分类为 `domain` 层，而 `allowedImports.domain === ['domain']`——port 文件自身不得 import 任何 `.service.ts`。
- **`GuardrailsService` 构造函数今天恰好 10 个参数**（实测：`moduleRef, creds, sandbox, config, provisionLookup, audit, prisma, transcripts, provisioningDiagnosticRecorder, provisioningDiagnosticWriteGate`），最后两个带注释「sit last to preserve construction compatibility in focused tests」。目录外有 **9 个** spec 用位置化 `new GuardrailsService(...)` 构造（13 处引用 − 目录内 4 处；tasks/ 6、public-surface/ 2、task-admission/ 1，C17）。
- **行为等价基线是 characterization**（W14）：guardrails 目录今日 **120 个 `test()`**（57+54+3+3+3）+ **8 个** `.test.mjs` 断言脚本（含 6 个 inline mirror）。主计划里的「122 测试 / 4 个 inline mirror」对当前树是陈旧的（C16）。
- **发布点拓扑与图纸的 1:1 假设不符**（C4/C5/C6/C7），照图纸机械接线会发出假的 `TaskSettled`。

## Goals / Non-Goals

**Goals:**

- 建立一个**进程内同步**领域事件总线：窄 port + DI token，per-subscriber 隔离的 best-effort，失败可见。
- 建立**事件目录 v1**（五个 payload schema + 统一信封 + 演进规则 + 升级为 integration event 的条件），并让后续五个订阅者迁移共用同一套语义，而不是各解释一遍。
- 把「什么不是事件」写成**准入规则**并由**编译器**强制，而不是三个特例注释。
- 在既有发布点接入发布，**保留全部既有同步调用**（双写过渡）。
- 让机制**落地即绿**：layout-v2、r7、test-discovery、contracts 两闸门、公开面四证据 lane 全部预先算清。

**Non-Goals:**

- 迁移任何一个横切关注点到订阅（五条各自是一个独立 change）。
- 解 tasks↔guardrails 的 forwardRef 环（4 个点已由 C18 钉死；环是把跨模块调用逐个换成发布/订阅后**自然消失**的，W19，所以必须排最后）。
- 引入 outbox 或任何持久化（本期是进程内 domain events，不构成 dual-write，W11）；零 Prisma migration。
- 引入 `@nestjs/cqrs` / `@nestjs/event-emitter` / EventCatalog / AsyncAPI（W4/W21）。
- 任何 HTTP、MCP、OpenAPI、api-playground 的形状变化。

## Decisions

### D1 — 手写进程内总线，不引框架

总线是本仓自有的 `.port.ts` 接口 + `.service.ts` 实现，逐字照抄 `apps/api/src/audit/audit-recorder.port.ts` 的形状（纯 `interface` + 字符串 token + best-effort JSDoc 契约）与 `audit.module.ts` 的 `@Global()` + `useExisting` 绑定（C2）。

**Alternative rejected:** `@nestjs/event-emitter` / `@nestjs/cqrs`。两者都不提供本 change 需要的保证等级（per-subscriber 隔离 + 失败可见），社区做法都是再包一层（W4）；引入后我们仍要写同样的隔离层，却多了一个依赖、一套装饰器魔法和一条与 D3 类型守护冲突的运行时发现路径。

### D2 — best-effort 由 bus 自己实现，且失败必须留痕

`publish` 对每个订阅者单独 try/catch，任何订阅者抛错都不中断派发循环、不向发布者传播；被吞掉的异常至少落一条带 `eventType + subscriberName + error.message` 的结构化日志（warn 及以上）。**沉默不是可接受的结果。**

理由是 W3 的实测推翻了「EventEmitter 天然 best-effort」的直觉：Node v22.22.0 上第二个监听器同步抛错时第三个根本没被调用，异常直接从 `emit()` 抛回发布者。而阶段 4 后续会把 audit/metrics/**计费**搬到订阅者上——静默失败会直接变成计费漏账（W12）。措辞沿用 `persist-session-transcripts` 已归档的 SHALL 范本（A5）。

**Alternative rejected:** 复用 `EventEmitter` 再在外层包一次 try/catch——外层 catch 只能拿到第一个抛错者，后面的订阅者已经被跳过，隔离语义拿不回来。

### D3 — 显式数组 token 注册，绝不运行时扫描

订阅者经**一个显式声明的数组注入 token**（`DOMAIN_EVENT_SUBSCRIBERS`）注册；不用 `DiscoveryService`、`MetadataScanner` 或自定义 handler 装饰器。

Nest 没有 Angular 式 multi-provider 数组注入，生态标准做法是 `DiscoveryService` + 装饰器扫描（`@nestjs/cqrs` 自身就是这么发现 `@EventsHandler` 的，W18）。但运行时扫描会让 D4 的编译期守护**基本失效**——注册不再是一个有类型的调用点。这个接缝必须现在选，否则后续四个 change 各选各的。

**Alternative rejected:** `DiscoveryService` + `@OnDomainEvent()` 装饰器。优雅、可自动发现，但与本 change 最重要的机制（编译期非事件守护）直接冲突。

### D4 — 订阅者签名是纯同步 `void`，用**已实测**的品牌化类型守护，并预先给好 IO 出口

拍板 Q2：订阅者签名不接受 `Promise<void>`。守护写成 W7 已在 tsc 5.9.3 strict 下实测通过的形态：

```ts
subscribe<T extends (e: DomainEvent) => any>(
  handler: T & (ReturnType<T> extends void ? unknown : BrandedNonEventError),
): void;
```

`BrandedNonEventError` 是带说明文字键的对象类型，编译器会把整句解释**原文**打进错误里（W9b 实测），等于把「这是调用不是事件」的制度写进编译器。

⚠ 最自然的写法是**假守护**：tsc 5.9.3 strict 下把返回对象、返回 Promise 的处理器传给 `(e) => void` 参数**零报错**（W6 实测，`void` 表示「返回值会被忽略」而非「不许返回」，是语言设计而非配置问题）。W8 另外排除了两个更优雅但坏掉的变体（`R extends void ? void : never` 连合法的 `(e)=>{}` 都拒；返回类型写 `undefined` 的变体拒绝委托写法）。

**IO 出口必须现在给**，否则后续 transcript 采集与 diagnostics 两个订阅者会被这道守护挡死：要做 IO 的订阅者在一个**返回 `void` 的方法**里启动异步工作并自带 `.catch(...)`，不把 promise 交回 bus。这条出口写进了 spec 的正例 scenario，防止守护被后续 change 以「挡住了合法用法」为由拆掉。

**Alternative rejected:** 签名放宽成 `void | Promise<void>`。那样守护要退化成「非 `Promise<非 void>`」，bus 还得自己 catch rejection（W3：异步 rejection 会逃逸成 `unhandledRejection`），且 `Promise<boolean>` 的 audit port 与 `Promise<void>` 的边界会变得难以在类型层区分——守护的整个价值来自它恰好排除三条非事件（C14）。
**次选保留:** typescript-eslint 的 `no-misused-promises`（`checksVoidReturn`）可作第二道网（W10），但不作为主机制。

### D5 — 非事件写成准入规则，由自失效 `.typecheck.ts` 夹具证明

规则用返回/回执语义表述，而不是关注点名字：**需要回执、可以被拒绝、或发布者依赖其结果的协作是 CALL，不是 EVENT**（业界名 passive-aggressive event / command-in-disguise：「命令可以被拒绝，事件只能被忽略」，W1/W2）。今日三条非事件只作为该规则的**已知例证**列出：terminal audit detail 的 `recordProvisioningFailure`/`recordTaskCancellation`（`Promise<boolean>`）、admission-work 的 `lease.authorize()`/`lease.checkpoint()`（await 取权威）、diagnostics write gate 的 `isEnabled(): boolean`（C14）。

强制手段是仓内已有 5 处先例的 `*.typecheck.ts` 自失效夹具（`admission-mode-policy.typecheck.ts` 正是姊妹 change 的产出，A7）：负例用 `@ts-expect-error`，守护一旦被削弱，未使用的指令会以 TS2578 让夹具自己变红。`.typecheck.ts` 被 layout 闸门当作测试类文件排除（`context-layout-check-v2.mjs:82`），不产生分层 finding。

**Alternative rejected:** 新建一个扫描闸门。成本是 gate canon 全套（配对自测 + 三字段例外数据 + 空扫描即败 + 注入探针红证，A8），而编译器免费、更早、且不可能「扫描到零条却显示健康」。

### D6 — 事件目录 v1：单一声明数组 + 最小信封 + fat payload

五个事件名在 contracts 里**只声明一次**（一个 exported const 数组），判别联合与 type→schema 映射从它派生；不存在第二份事件名清单。信封最小基线 `eventId + occurredAt + type + taskId`（CloudEvents 收敛出的必需上下文属性子集，W16）。演进规则 additive-only：只加可选字段、消费者容忍未知字段（不用 `.strict()`）、破坏性变更 = 新事件名。

payload **fat by design**：带足上下文使订阅者无需回查发布者——因为切断这条回查依赖正是后续迁移的目的；若事件是 thin 的，订阅者仍需回查发布者，第 6 刀的 forwardRef 环就解不掉（W17）。约束是「只放原始类型、ID 字符串与由它们构成的普通对象，不放实体实例/provider 句柄/连接对象/回调」。`providerFamily` 从 `packages/contracts/src/provider-family.ts` 的 `SANDBOX_PROVIDER_FAMILIES` **派生**，不重声明 `z.enum`（C19）。

**Alternative rejected:** thin payload（只带 ID）。契约面更小，但把回查依赖留给每个订阅者，与本阶段目标正相反。
**Alternative rejected:** 整套 CloudEvents（`source`/`specversion`）。进程内用不上其跨系统语义，且会把信封变成对外契约。

### D7 — 发布点内真 `.parse()`，不登记 `INDIRECTION_POINTS`

`publish` 内在派发前对 payload 调 schema 的 `.parse()`；校验失败 = 丢弃 + 一条结构化日志 + **不向发布者抛**（与 D2 同一条 best-effort 纪律）。

`contracts-executed-schema-check` 只认真 parse，间接执行必须逐条声明 file:line（A11）。登记 `INDIRECTION_POINTS` 等于把发布点的 file:line 钉进闸门，给自己加一条「重构即红」的耦合。而 zod 在这种量级上开销可忽略（典型 < 0.1ms/次，W20），五个事件是**每任务数次**的低频事件、不在 per-token/per-frame 热路径上，成本可明确论证为可忽略。结论：本 change 给 `INDIRECTION_POINTS` **新增零条**。

**Alternative rejected:** 只在非生产环境 `safeParse`。闸门在 CI 绿而生产不执行，是让闸门停止成为闸门的经典形态。

### D8 — 进程内 domain events，不建 outbox，且写死升级条件

目录内在声明这五个是 **domain events（进程内、同步、不持久）**，与 integration events 区分；并写死升级条件：**第一个跨进程消费者，或第一个要求持久投递的订阅者**，即把该事件升级为 integration event 并**另开 change 引入 outbox**（W11）。声明必须与仓内已存在的 `TaskAdmissionWork` admission outbox **划清界限**——否则读者会以为本 change 要拆现有 outbox（A6）。本期零 Prisma migration、零落库。

**Alternative rejected:** 现在就建 outbox。进程内、同事务、同进程消费的 domain event 不构成 dual-write 问题；提前建表会把一个零行为变化的 change 变成一个有数据迁移的 change。

### D9 — `TaskSuperseded` 不带取代者身份（拍板 Q1，选项 a）

所有 superseded 观察点（`reserveDurableAdmissionCapacity` 的三处 `outcome: 'superseded'`、`performAdmissionTransition` 的两处、inline pipeline 的九处早返）都**没有任何 handle 指向「谁取代了它」**——superseded 只是 CAS 结果（`updateMany` 返回 `count !== 1`）或观察到更晚的生命周期状态（C5）。payload 因此只带观察方真正持有的东西：被取代的 task id、失败方持有的 fence token、观察点判别符、以及可得时的观察状态。

**发布一个代码根本不知道的 superseder 身份就是伪造数据。** 另一条出路（新增管线把 winner 的 handle 传到观察点）被拒绝：为一个零订阅者的事件新增跨路径管线，代价与收益完全不成比例，且会把「本 change 不新增数据管线」这条纪律（D11）破掉。

### D10 — canonical `fenceToken` = admission **transition token**，路径由 `admissionMode` 显式标注（拍板 Q3）

durable 路径同时持有 `claim.leaseToken`（admission-work 租约）与新铸的 `transitionToken = randomUUID()`，legacy 路径持有 `guardrails.admit()` 的 token（C7）。canonical 取**每次 admission transition 铸出的 transition token**，两条路径语义一致；durable 的 `leaseToken` 属于 admission-work 生命周期而非本次转移，不得代入该字段。两条路径的区别用一个显式 `admissionMode: 'durable' | 'legacy'` 判别符承载，而不是让订阅者从 token 的形状去猜。

**Alternative rejected:** schema 两种 token 都接受。那会让两个发布者**静默分歧**，且第一个订阅者接上时才会发现两边含义不同。

### D11 — 发布点逐点枚举（3 / 1 / 2 / 2 / 3），并把「不发」写成负向要求（拍板 Q5）

实测拓扑（C4/C6/C7/C5）：

| 事件 | 发布点数 | 位置 |
| --- | --- | --- |
| `TaskRunStarted` | **3** | readoption 恢复路径 / legacy `startRunningAfterCapacity` / durable `armDurableRuntime`（各自紧贴既有 `runnerMinutes.recordStart`） |
| `TaskSettled` | **1** | 仅 `fenceTerminal`；`clearAdmissionRuntime` 的第二处 `recordEnd` **不是**终态结算 |
| `SandboxProvisioned` | **2** | durable（`GuardrailsService`）/ legacy（inline pipeline），均在 `provider.provision(...)` 成功且连接注册之后 |
| `TaskAdmitted` | **2** | durable 容量预留提交后 / legacy `admit()` 得出结果后 |
| `TaskSuperseded` | **3** | durable 容量预留返回 superseded / durable admission transition 返回 superseded / inline pipeline **整次运行**返回 superseded（内部多个早返合并为至多一次） |

「recordStart 处 = TaskRunStarted、recordEnd 处 = TaskSettled」的直觉映射实际是 **3:1 和 2:1**；照图纸机械接线会在 `clearAdmissionRuntime` 处发出**假的 `TaskSettled`**。因此「`clearAdmissionRuntime` 不发 `TaskSettled`」写成**负向 requirement**，负向要求比注释更能挡住后续 change 的误接线。

同时约束：payload 一律用发布点**已在手**的数据组装（durable 的 `snapshotSandboxProvisionContext` 快照 + `resolveSelectedRunStrict`，legacy 的 `registerConnection` + `resolveSelectedRun`，C6），**不新增 provider 调用、不新增数据库读、不新增 resolver**。发布点定位在 tasks 里做**双向扫描**（谁写这些状态 / 谁在同一时刻也读）并写进 baseline——范本最贵的教训正是只做了向内扫描，Track 3 补做反向扫描后结论整体翻转、被迫中途重切（A4）。

#### D11 baseline — apply 期双向扫描实测（4.1，结论：拓扑不变）

接线前对着**接线后的树**逐点复核过一遍（向内：谁写这些生命周期状态；反向：同一时刻谁也在读同一状态）。**3 / 1 / 2 / 2 / 3 全部成立，design 表无需修改**。落点与当时预估的行号一致：

| 事件 | 发布点 | 落点（接线后） |
| --- | --- | --- |
| `TaskRunStarted` ×3 | readoption / legacy / durable | `guardrails.service.ts` `readopt` recordStart 后、`startRunningAfterCapacity` recordStart 后、`armDurableRuntime` recordStart 后（三处均紧贴既有 `recordStart`，未替换未移动） |
| `TaskSettled` ×1 | 终态 fence | `fenceTerminal`；`clearAdmissionRuntime` 就地留负向注释 |
| `SandboxProvisioned` ×2 | durable / legacy | `guardrails.service.ts` `connections.set` 之后；`inline-admission.pipeline.ts` **两处丢弃检查之后** |
| `TaskAdmitted` ×2 | legacy / durable | `admitUntracked`（running/queued 各一支）；`reserveDurableAdmissionCapacity` 既有 audit 同闸 |
| `TaskSuperseded` ×3 | 容量预留 / admission transition / inline run | `reserveDurableAdmissionCapacity` superseded 出口；`observeAdmissionSupersession`（两个 return 共用）；`run()` 单一出口 |

反向扫描改掉的**两处**照图纸接线（都不动 design，属实现落点修正）：

1. **legacy `SandboxProvisioned` 不能贴着 `registerConnection` 发。** 反向扫描发现 `registerConnection` 之后还有两处 fence/terminal 复检，任一命中都会 `teardownSandbox('superseded-remove')` 把刚建的沙箱销毁。贴着注册点发布会广播一个已经不存在的沙箱，与"superseded provision 零发布"直接冲突；发布点因此下移到两处复检之后。
2. **legacy admission 的 `superseded` 不是 `TaskSuperseded` 发布点。** `startRunning` 在交给 inline pipeline 之前自己就会因失去 fence 返回 `superseded`——那是 guardrails 内部的失败，不在 D11 声明的三个 producer 边界里，故零发布（`guardrails-domain-event-publishing.spec.ts` 用计数式 fence 把这条实测钉住了：fence 早失效则 0 条，晚失效才由 pipeline 出口发 1 条）。

另两条实测澄清（写进来是因为它们决定了"发不发"）：

- **`TaskAdmitted` 只在本次调用真正提交了转移时发**（legacy 取 `started === 'transitioned'`，durable 复用既有 audit 的 `transitioned && outcome !== 'superseded'` 闸）。两条路径共用同一判据，避免 D10 警告的"两个发布者静默分歧"；已在目标态、被拒、superseded 一律零发布。
- **legacy 的 canonical fence token 在 `admitUntracked` 铸出并下传** `startRunning`/`safeAdmissionTransition`，所以事件带的就是真正 fence 该次转移的那个 token，而不是为发事件另铸的第二个。

### D12 — bus 是 `GuardrailsService` 的第 11 个 `@Optional()` 尾参

构造函数今天是 10 参数的 optional-tail 链，最后两个参数已带注释说明「sit last to preserve construction compatibility」（C3）。bus 必须接在最后，否则目录外 **9 个** 位置化 `new GuardrailsService(...)` 的 spec 会断——而那 9 个文件不改，正是零修改验收本身（C17）。

**Alternative rejected:** 用 setter 注入或 `moduleRef` 懒解析绕开构造函数。前者让「无 bus 时行为完全不变」难以在类型上表达，后者会给一个本要**解**耦合的 change 增加第 5 个懒解析点。

### D13 — 落位：`apps/api/src/domain-events/`，归 `platform-ops`，同 commit 补 manifest

- 目录 `apps/api/src/domain-events/`，在**同一 commit** 加进 `contexts-manifest.json` 的 `contexts.platform-ops.directories`（与 `audit`、`metrics`、`observability` 同列）。归 platform-ops 而非 task-execution，因为总线是横切机制而非任务领域概念；跨 context 由 `.port.ts` 形态放行（C11），不需要把它塞进 shared kernel。
- 文件名：`domain-event-bus.port.ts`（→ domain 层：接口 + `DOMAIN_EVENT_BUS` token + `DOMAIN_EVENT_SUBSCRIBERS` token）、`domain-event-bus.service.ts`（→ application 层：实现）、`domain-event-publishing-cutover.port.ts`（→ domain：env 快照 + 纯求值）、`domain-events.module.ts`（→ composition）。裸 `.ts` 一律禁止：会产生 `unclassified-file` finding → 新 r7 键 → 比较器判增 → 红（C10）。
- port 文件自身不得 import 任何 `.service.ts`（`allowedImports.domain === ['domain']`）。发布者**只 import `.port.ts`**，实现只在 `app.module.ts` / `domain-events.module.ts` 绑定。
- **补上 `crossContextRules.machineReadable` 的「领域事件订阅」编码**——该槽位由现存 `$comment` 明确预留给本阶段（「等事件落地再补声明，不在脚本里猜」，C8）。编码只做**归因**（声明总线目录与其 port 文件，使闸门能把订阅者的 import 判为「领域事件订阅」而不是笼统的 port import），**不新增任何 portFileSuffix 尚未放行的权限**——manifest 的既定纪律是「散文的机器可读编码，零新增语义」。若某个编码写法需要新的放行语义，那就是信号：形态错了，回到 D13 重新落位而不是放宽规则。

### D14 — cutover 开关：轻模板 + 结果对象 + 默认开 + 零 attestation，**关闭即等于「没注入 bus」**

- 形态取**轻模板**（diagnostics write gate：构造时快照 env 一次 + 纯求值，无 runbook、无 `quick-deploy.sh` 接线，C15）——本 change 零行为变化，重模板不成比例。
- 但**抄重模板的返回形状**：返回完整决策对象（至少 `enabled` + 机器可读 reason/source）而非裸 boolean。`task-admission-gate.ts` 的代码注释就是这条判例的原文（「A `isEnabled(): boolean` here destroyed the closed reason…」）。
- **默认新路径（发布开）**，env 未设或无法识别都算开；逃生口是显式设成关闭值。
- **零 attestation 依赖**：一个 boolean 足以打开。反面教材是 task-model-selection——默认关闭 + 绑 buildIdentity 的手工 attestation → 每次升级静默失效 → `/v1/runtime-models/query` 反复 503，最终要专开一个 change 把 attestation 做进 CI（A10）。
- **关闭时的实现形态是「不绑定 provider」**：开关在组合根求值一次，关闭时 `domain-events.module.ts` 干脆不把 bus provider 放进 providers 数组，于是每个发布点的 `this.bus?.publish(...)` 短路，**零次 `publish` 调用**。这使逃生口与「9 个目录外 spec 不注入 bus」是**同一条代码路径**——characterization 基线顺便证明了逃生口，而不是另造一条只有开关关闭时才走的分支。
- 建框架的同时**登记退役条件**：deploy 文档里写清变量名、默认值、owner、以及移除它的那个 change。阶段 4 六个 change 累计会留下 5–6 个逃生开关，不登记的话第 6 刀会发现代码里全是没人敢删的分支（W13）。

### D15 — 零修改验收：目录内**零**改动，目录外**唯一允许**的改动种类提前写死

沿用范本的 D5 形态（A2）：「若某测试必须改才能通过，那就是改动改变了行为，错的是改动不是测试」。具体：

- `apps/api/src/guardrails/**/*.spec.ts` 修改数 = **0**；目录内 120 个 `test()` + 8 个 `.test.mjs` 原样通过。
- 目录外**唯一允许**的改动种类：位置化 `new GuardrailsService(...)` 处**增补或省略尾部可选 bus 实参**。不得改任何断言、期望值、计数器、scenario。这条必须提前写在 design 里，否则 verify 判 re-baseline（A2）。
- **源码文本扫描型测试单列**：`sandbox-host-harness-wiring.test.mjs` 读源码文本而非测行为，本 change 在 guardrails/inline-admission 两处新增 publish 极可能触发其文件清单/计数断言。若必须改，必须保住断言强度——按文件分别断言（两条 provisioning 路径各自仍解析 workspace source、provision-context 计数仍按文件钉死），**不得**松成一个总数（A3）。
- 发布是新增行为、旧测试按定义覆盖不到（W14），故每个发布点各需一条「发布恰好一次且 payload 能 parse」的新测试。
- 新目录/新测试的挂载单独验收：`api-module-layout-check` 的 `ALLOWED_CYCLES` 保持为空、新测试被 test-discovery 闸看见、`pnpm test:scripts` 通过、r7 不升（A15）。

### D16 — R11 依赖预算 ratchet 用**活测**种子创建，双向 fail-closed

`scripts/ratchets/` 今天只有 `comparator.mjs`、`r3.json`、`r7.json`；R11（guardrails→五关注点只降不升）已在规则登记表为阶段 4 预登记（C12）。本 change 播种基线，种子取本 change 自己树上的实测值而非文档抄录：`this.audit` 9、`this.runnerMinutes` 6、`provisioningDiagnosticRecorder` 4、`provisioningDiagnosticWriteGate` 4、`this.transcripts` 2、metrics-projection 2。

comparator 是**双向** fail-closed：高于基线红，**低于基线（陈旧条目）同样红**。因此若本 change 顺手消灭了某条 cross-context import，必须在同一 PR 里把该 r7 条目删掉（A9）。

### D17 — `requiresWireCompatibilityFixture: false` 的理由（拍板 Q4）

最近的同形态先例 `unlock-extension-axes` 同为 contracts 新增、同 8 条 `protocolDifferences`、同 `verification.id: workflow-gates`，却取 `true`（A12）。差异的判据是**新 schema 是否投影到线上形状**：`unlock-extension-axes` 的扩展轴经 runtime metadata 投影进 `/v1` 与 MCP，需要 wire fixture 钉住；本 change 的五个事件 schema 只被**进程内发布者**消费，不进任何 controller DTO、MCP tool 注册表或 OpenAPI 文档，四公开面的 `derived` 完全来自 contracts 包的**文件级传递可达性**（`CLASSIFIER_SURFACE_MAP.contracts` 的保守映射），而非任何真实投影。

这个理由是**可证伪的**，所以配一条可复算的证据任务：证明 `v1`、`mcp`、`openapi`、`public-surface`（api-playground）四处**零 import 事件目录**，并在集成树真跑 `public-surface-adversarial`。若该证明失败（出现任何 import），取值翻成 `true` 并在归档前改 sidecar——sidecar 造假有 NOT-ARCHIVABLE 判例（A13）。

## Risks / Trade-offs

- **[类型守护写成假守护，闸门绿但 audit port 照样能注册]** → D4 采用 W7 已实测的写法，并用 `.typecheck.ts` 的 `@ts-expect-error` 自失效夹具锁死：守护一旦被削弱，TS2578 让夹具自己红（A7）。同时必须有**正例**（`(e)=>{}`、`(e)=>voidMethod(e)`、`.bind()` 的 void 方法），否则很容易落成一个把所有人都挡住的假闸门（W8）。
- **[纯同步 `void` 签名把后续要做 IO 的订阅者挡死]** → D4 预先给出出口（void 方法内启动自带 `.catch` 的异步工作），并把该出口写成 spec 正例，防止后续 change 以「守护挡住合法用法」为由拆掉它。
- **[照图纸接线发出假的 `TaskSettled`]** → D11 逐点枚举 + 负向 requirement + 每个发布点的计数测试；发布点定位做双向扫描并写进 baseline（A4）。
- **[fat payload 把契约面撑大，且事件会随消费者需求继续变肥]** → D6 的 additive-only 纪律（只加可选字段、不 `.strict()`、破坏性变更 = 新事件名）使增长是加法；`providerFamily` 从单一声明派生使词表不会分叉（C19）。
- **[`.parse()` 在发布路径上引入运行时开销]** → 五个事件是每任务数次的低频事件，zod 在此量级 < 0.1ms/次（W20）；且校验失败按 D7 是「丢弃 + 记日志 + 不抛」，不会把一个校验问题升级成生命周期故障。
- **[逃生开关变成没人敢删的分支]** → D14 同时登记 owner 与退役条件；且逃生口复用「无 bus 注入」这条既有路径，删除开关时删的是组合根的一个条件，而不是散落在 11 个发布点的 `if`（W13）。
- **[并行期同一副作用执行两次]** → 本 change 零订阅者，风险为零（W15）。但接缝现在留好：payload 带稳定 `eventId`，使 change 2–5 在「订阅者已接上、直接调用尚未拆除」的窗口里能做去重或前置状态检查；若现在不带 id，后续每个 change 都要改 contracts schema，与 additive-only 纪律和四公开面 derived 声明反复摩擦。
- **[文件命名/新目录导致闸门在写完代码后才红]** → D13 在写第一行 import 之前定死目录、context 归属与四个文件名；layout-v2 对无人认领目录是 exit 1 而非 finding（C9）。
- **[r7 陈旧条目导致「树变好了却还是红」]** → D16 明确 comparator 双向 fail-closed，缩减必须同 PR 删条目（A9）。
- **[四面 derived 被质疑（contracts 新增了五个 schema）]** → D17 的零 import 证明写成可复算证据，而非一句断言；并在集成树真跑每条声明的 verification lane（A13）。
- **[并行 apply 时共享文件互相覆盖]** → 共享写者（`guardrails.service.ts`、`tasks.service.ts`、`inline-admission.pipeline.ts`、`app.module.ts`、contracts index）集中进一条 **SERIAL 集成轨**，contracts schema 与 bus 机制各自成并行轨（A14）。

## Migration Plan

- **数据**：无。零 Prisma migration、零新表、零写库路径（D8）。
- **线上形状**：无。HTTP / MCP / OpenAPI / api-playground 均无形状变化（D17）。
- **部署**：普通镜像发布。新增一个环境变量（发布 cutover），**默认开**，未设即新路径；无 compose 编辑、无 `quick-deploy.sh` 接线、无 runbook（D14）。
- **回滚**：三级，从便宜到彻底——(1) 设逃生口环境变量并重启：bus provider 不绑定，`this.bus?.publish(...)` 全部短路，行为与本 change 之前**逐字节相同**（该路径与 9 个目录外 spec 走的是同一条）；(2) 本 change 零订阅者、零持久化，回滚无状态需要回卷；(3) revert 整个 change。
- **退役**：cutover 开关随阶段 4 的最后一刀（解 forwardRef 环）一并删除，登记在 deploy 文档里（D14）。

## Open Questions

四个阻塞问题已在本文档拍板：Q1→D9（不带取代者）、Q2→D4（纯同步 `void` + 出口）、Q3→D10（transition token 为 canonical + `admissionMode` 判别符）、Q5→D11（写成负向 requirement）；Q4→D17（`false`，附可证伪证明）。

留待 apply 期以实测回答、不阻塞本文档的：

1. `sandbox-host-harness-wiring.test.mjs` 是否会因新增 publish 而必须更新——跑一次即知；若需更新，改法已由 D15 限定（保住按文件的断言强度）。
2. `crossContextRules.machineReadable` 的「领域事件订阅」编码的确切字段名——由 D13 的约束（纯归因、零新增放行语义）定死性质，具体键名在 apply 时对着 `enforce-boundaries-from-manifest` 的解释器实测确定。
3. R11 的六个 collaborator 键名与统计口径（例如 metrics-projection 是按符号还是按调用点计）——种子数字已实测（D16），键名在建 ratchet 时随其配对自测一并钉死。
