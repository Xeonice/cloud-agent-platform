<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.

     ✅ CORRECTED partition（apply 阶段对真实耦合重扫后修正；原 propose 草稿的两处错误已改，见下）。
     发布点的 file:line 仍由 4.1 在接线前亲自复核一遍——本次重扫只核对了**文件归属**，没有重跑 D11 的拓扑判断。

     本次重扫改掉草稿的三件事：
     1. ❌ 草稿称"三个发布点宿主文件彼此不相交、理论上可再拆三轨" —— **是错的**。
        `InlineAdmissionPipeline` 由 `guardrails.service.ts:554` 的 `new InlineAdmissionPipeline(...)`
        位置化构造，bus 要进 inline 管线**只能**经由 guardrails.service.ts 传入 ⇒ 4.9/4.10 与 4.2–4.6
        写同一个文件。integration 不可拆，这条现在有实证而不只是 A14 的裁定。
     2. ➕ integration 漏了 `apps/api/src/guardrails/guardrails.module.ts`：GuardrailsService **不是**
        靠装饰器解析的类 provider，而是 `useFactory` + 位置化 `inject:` 数组（module 内 9 参 factory →
        `new GuardrailsService(10 参)`）。4.2 加第 11 个 `@Optional()` 尾参**必须**同时改这个 module，
        否则 bus 永远是 undefined、全部发布静默短路而测试照绿。
        （对比：TasksService 是普通类 provider `TasksService,`，4.7 加尾参**不需要**改 tasks.module.ts。）
     3. ➕ bus-mechanism 增加 depends: manifest-ratchets-and-registry。新目录 `apps/api/src/domain-events/`
        没进 contexts-manifest.json 时 `context-layout-check-v2` 是 **exit 1**（C9/D13"同 commit"），
        2.1 是 3.x 落地即绿的前置。已实测：manifest 里声明一个磁盘上还不存在的目录**无害**
        （contextOf 只是 dir→context 映射，unmapped 是从磁盘文件反推的），所以 2.1 先行不会让 Track 2 自己红。

     文件所有权（并行期唯一写者，越界即冲突）：
     - contracts-event-catalog  → packages/contracts/src/domain-event.ts（1.1–1.6，含 in-band 声明块，
                                  不另开 docs 文件）、packages/contracts/src/domain-event.test.mjs、
                                  packages/contracts/src/index.ts（本 change 内只有本轨写它；
                                  design A14 把 "contracts index" 列为共享写者是针对跨 change 的，
                                  若同树另有 in-flight change 触碰 index.ts，冲突归 integration 收口）
                                  ✔ 无需改 packages/contracts/package.json：test glob 已是 `src/**/*.test.mjs`
     - manifest-ratchets-and-registry → docs/refactor/contexts-manifest.json（2.1 目录声明 + 2.2
                                  crossContextRules.machineReadable 归因槽位）、
                                  docs/refactor/04-rules-registry.md、07-baselines-and-dependencies.md、
                                  scripts/ratchets/r11.json + R11 检查器 + 其配对自测、deploy/DEPLOY.md、
                                  以及（若 2.2 的归因要真被闸门读到 / 2.4 的检查器要真进 CI）
                                  scripts/context-layout-check-v2.mjs(+.test.mjs)、root package.json、
                                  .github/workflows/ci.yml —— 这三处**只有本轨可写**
                                  ✔ 无需改 test:scripts glob：`scripts/ratchets/*.test.mjs` 已在内
     - bus-mechanism            → apps/api/src/domain-events/**（新目录，本轨独占；.spec.ts 走
                                  apps/api 的 dist glob、.typecheck.ts 被 layout 闸门第 82 行排除，
                                  两者都无需注册）、root 与 apps/api 的 package.json（仅"零新增依赖"
                                  证据，**只读不写**——写权在 Track 2）
     - integration（SERIAL）    → apps/api/src/guardrails/guardrails.service.ts、
                                  **apps/api/src/guardrails/guardrails.module.ts**（新增，见上 #2）、
                                  apps/api/src/tasks/tasks.service.ts、
                                  apps/api/src/inline-admission/inline-admission.pipeline.ts、
                                  apps/api/src/app.module.ts、三个新增发布测试文件、
                                  目录外 9 个位置化 new GuardrailsService(...) 的 spec、
                                  apps/api/src/sandbox/sandbox-host-harness-wiring.test.mjs（若必须改；
                                  注意在 apps/api/src/sandbox/ 下，不在 scripts/）、
                                  openspec/changes/add-domain-event-bus/design.md 与 surface-impact.json
                                  （4.1 / 4.18 的条件写入）
       按 design A14（"共享写者集中进一条 SERIAL 集成轨"）不拆——现在还多一条实证理由（上 #1），
       且它们共用同一份 characterization 基线与同一次 cutover 接线，拆开会让"零修改验收"横跨
       多个 worktree 无法一次成证；4.6(legacy TaskAdmitted) 与 4.7(durable TaskAdmitted) 由同一个 agent
       写也正是 D10 要防的"两个发布者静默分歧"。

     跨轨共享文件（唯一真·多写者）：
     - openspec/changes/add-domain-event-bus/tasks.md —— 每条轨都要把自己的 `- [ ]` 改 `- [x]`。
       并行合并极易丢勾选：整合时以**代码实际落地**为准复核勾选，不要信任 merge 后的复选框。
     - packages/contracts/src/domain-event.ts —— 条件共享：若 4.1 重扫翻了 D11 拓扑并波及 payload 形状，
       integration 需要回改 Track 1 的产物；先改 design 再改 schema，别在接线里就地改字段。

     实测归属（4.1 时复核，勿当成已验证的行号）：
     - guardrails.service.ts：recordStart ×3 @1566(readoption)/2623(startRunningAfterCapacity)/
       2971(armDurableRuntime)；recordEnd ×2 @2038(fenceTerminal，=TaskSettled)/
       2949(clearAdmissionRuntime，**不发**)；admit() @737（legacy TaskAdmitted）
     - tasks.service.ts：reserveDurableAdmissionCapacity @1969（durable TaskAdmitted + superseded #1）、
       performAdmissionTransition @2393（superseded #2）
     - inline-admission.pipeline.ts：legacy SandboxProvisioned + run 级 TaskSuperseded（内部 9 处早返合一）
     - 目录外位置化 `new GuardrailsService(...)` = 9 个文件（tasks/ 6、public-surface/ 2、task-admission/ 1），本次重扫复核通过
       （全树 11 个文件命中 `new GuardrailsService(` − 目录内 2 个 spec = 9；均只传前几参，尾部可选参不传，
        故第 11 参加上去这 9 个文件**很可能一行都不用改**——4.14 的"增补或省略"里应优先取"省略"）
     - `new TasksService(` 命中 20+ 个 spec，但全是 `new TasksService(db.prisma())` 形态（只传第 1 参），
       TasksService 又是普通类 provider ⇒ 4.7 的尾参**零波及**
     - guardrails characterization 基线本次实测复核：5 个 spec 的 test() = 3+54+57+3+3 = **120**，
       `.test.mjs` = **8** —— 与 4.13 写的数字一致，可直接当验收基线

     命名先于第一行 import 定死（C10/C9）：新目录 apps/api/src/domain-events/ 只放
     *.port.ts / *.service.ts / *.module.ts / *.spec.ts / *.typecheck.ts，裸 .ts 一律禁止；
     目录必须与代码同 commit 进 contexts-manifest.json（2.1），否则 layout-v2 是 exit 1。

     cutover 变量名本文件钉死，跨轨共用：`CAP_DOMAIN_EVENT_PUBLISHING_ENABLED`（默认开）。 -->

## 1. Track: contracts-event-catalog (depends: none)

- [x] 1.1 新建 `packages/contracts/src/domain-event.ts`：`DOMAIN_EVENT_TYPES` 作为五个事件名的**唯一** exported const 数组（`TaskAdmitted`/`SandboxProvisioned`/`TaskRunStarted`/`TaskSettled`/`TaskSuperseded` 的字面量），并声明共用信封 schema（`eventId` UUID 每次 publish 唯一 / `occurredAt` ISO-8601 UTC / `type` 判别符 / `taskId` 主体）；断言无重复字面量、无字面量等于 `error`
  - requirements: ["domain-event-bus/event-catalog-v1-declares-exactly-five-events-sharing-one-envelope", "domain-event-bus/a-subscriber-failure-never-escalates-into-a-process-level-failure"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [x] 1.2 写五个 payload schema：fat by design（订阅者无需回查发布者）、只放原始类型/ID 字符串/由它们构成的普通对象；不用 `.strict()`；`providerFamily` 从 `packages/contracts/src/provider-family.ts` 的 `SANDBOX_PROVIDER_FAMILIES` 派生，schema 文件内零 `aio`/`boxlite`/`cloud-http` 字面量
  - requirements: ["domain-event-bus/event-payloads-are-fat-primitive-only-and-derive-shared-vocabulary"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [x] 1.3 `TaskSuperseded` payload 只带观察方真正持有的东西：被取代的 taskId、失败方持有的 fence token、观察点判别符、可得时的观察状态；schema 字段名内零 `supersededBy`/`supersederTaskId`/`winnerToken` 及任何指代取代者的等价字段
  - requirements: ["domain-event-bus/tasksuperseded-carries-no-superseder-identity"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [x] 1.4 admission 相关事件的 `fenceToken` 语义写死为**每次 admission transition 铸出的 transition token**（durable 的 admission-work `leaseToken` 不得代入），并加 `admissionMode: 'durable' | 'legacy'` 显式判别符，就地注释两条路径的 token 出处
  - requirements: ["domain-event-bus/the-canonical-fence-token-is-the-admission-transition-token"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [x] 1.5 判别联合类型与 `type → schema` 映射从 `DOMAIN_EVENT_TYPES` **派生**（`satisfies Record<DomainEventType, ZodType>` 之类的编译期全覆盖形式），确保仓内不存在第二份事件名清单
  - requirements: ["domain-event-bus/event-catalog-v1-declares-exactly-five-events-sharing-one-envelope"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [x] 1.6 目录文件内写 in-band 声明块：这五个是 **domain events（进程内、同步、不持久）**、与 integration events 的区分、升级条件逐字（第一个跨进程消费者 **或** 第一个要求持久投递的订阅者 → 升级为 integration event 并**另开 change 引入 outbox**）、演进规则 additive-only（只加可选字段、容忍未知字段、破坏性变更 = 新事件名）；并显式点名 `TaskAdmissionWork` 是**既有的、本 change 不触碰的** admission outbox，与"本 change 不引入 outbox"划清界限
  - requirements: ["domain-event-bus/catalog-v1-is-in-process-additive-only-and-declares-its-upgrade-condition"]
  - surfaces: ["contracts", "docs"]
  - verify: "workflow-gates"
- [x] 1.7 `packages/contracts/src/index.ts` 导出目录的全部公开符号（类型常量数组、信封、五个 payload schema、联合类型、type→schema 映射），使 `contracts-shared-export-check` 的"每个 export 可达"成立
  - requirements: ["domain-event-bus/event-catalog-v1-declares-exactly-five-events-sharing-one-envelope"]
  - surfaces: ["contracts"]
  - verify: "workflow-gates"
- [x] 1.8 新建 `packages/contracts/src/domain-event.test.mjs`：枚举恰好五个字面量且唯一、无 `error`；缺 `eventId`/`occurredAt`/`taskId` 各自 parse 失败；同一发布点两次发布 `eventId` 不同而 `type` 相同；未知字段被容忍（无 `.strict()`）；`SANDBOX_PROVIDER_FAMILIES` 追加成员后事件 schema 零改动即接受；payload 带函数/类实例/连接句柄时 parse 失败；`SandboxProvisioned` 解析结果含 taskId + sandbox 引用 + provider family + 环境快照（足以让订阅者记录 provisioning 而无需回查 guardrails）
  - requirements: ["domain-event-bus/event-catalog-v1-declares-exactly-five-events-sharing-one-envelope", "domain-event-bus/event-payloads-are-fat-primitive-only-and-derive-shared-vocabulary", "domain-event-bus/catalog-v1-is-in-process-additive-only-and-declares-its-upgrade-condition"]
  - surfaces: ["contracts", "ci"]
  - verify: "workflow-gates"

## 2. Track: manifest-ratchets-and-registry (depends: none)

- [x] 2.1 `docs/refactor/contexts-manifest.json`：把 `apps/api/src/domain-events` 加进 `contexts.platform-ops.directories`（与 `audit`、`metrics`、`observability` 同列），理由就地注明"总线是横切机制而非任务领域概念"
  - requirements: ["domain-event-bus/the-bus-lands-in-a-declared-context-with-classified-file-names"]
  - surfaces: ["docs", "ci"]
  - verify: "workflow-gates"
- [x] 2.2 填 `crossContextRules.machineReadable` 里为"领域事件订阅"预留的槽位：**纯归因**编码（声明总线目录与其 port 文件，使闸门能把订阅者的 import 判为领域事件订阅），**零新增** `portFileSuffix` 尚未放行的语义；同步改写现有 `$comment`（"等事件落地再补声明"已兑现）。若某写法需要新的放行语义，即视为落位形态错，回 design D13 重议而非放宽规则
  - requirements: ["domain-event-bus/the-bus-lands-in-a-declared-context-with-classified-file-names"]
  - surfaces: ["docs", "ci"]
  - verify: "workflow-gates"
- [x] 2.3 新建 `scripts/ratchets/r11.json`：六个 collaborator 键位 + 本树**活测**种子（`this.audit` 9、`this.runnerMinutes` 6、`provisioningDiagnosticRecorder` 4、`provisioningDiagnosticWriteGate` 4、`this.transcripts` 2、metrics-projection 2），键名与统计口径（按符号还是按调用点）就地写死，`change` 字段登记阶段 4 燃尽路径
  - requirements: ["domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 2.4 建 R11 检查器 + 其配对自测（`scripts/ratchets/*.test.mjs`，复用 `comparator.mjs` 只读）：**双向 fail-closed**——高于基线红、低于基线的陈旧条目同样红；自测含两条注入探针红证（往 `guardrails.service.ts` 注入一处多余调用 → 红且点名 collaborator；抽掉一处调用而不同 commit 降基线 → 红）
  - requirements: ["domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 2.5 `docs/refactor/04-rules-registry.md` 的 R11 行从"阶段 4 预登记"更新为已播种基线（指向 `scripts/ratchets/r11.json` 与其检查器）；`docs/refactor/07-baselines-and-dependencies.md` 记录种子出处为活测而非文档抄录
  - requirements: ["domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 2.6 `deploy/DEPLOY.md` 增一节登记 cutover 开关：变量名 `CAP_DOMAIN_EVENT_PUBLISHING_ENABLED`、默认值（发布**开**，未设即新路径）、owner、退役条件（随阶段 4 最后一刀"解 tasks↔guardrails forwardRef 环"的 change 一并删除）；**不新建** deploy runbook 文件、**不改** `scripts/quick-deploy.sh`、**不改** compose 文件
  - requirements: ["domain-event-bus/the-cutover-toggle-is-registered-with-an-owner-and-a-retirement-condition"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"

## 3. Track: bus-mechanism (depends: contracts-event-catalog, manifest-ratchets-and-registry)

- [x] 3.1 新建 `apps/api/src/domain-events/domain-event-bus.port.ts`：`DomainEventBusPort` 接口 + `DOMAIN_EVENT_BUS` / `DOMAIN_EVENT_SUBSCRIBERS` 字符串 DI token + 订阅注册类型（**稳定 name** + 事件类型 + handler），形状逐字照抄 `apps/api/src/audit/audit-recorder.port.ts`（纯 interface + 字符串 token + best-effort JSDoc 契约）；该文件不 import 任何 `.service.ts`（其层级为 `domain`，`allowedImports.domain === ['domain']`）
  - requirements: ["domain-event-bus/the-domain-event-bus-is-a-declared-in-process-port-with-synchronous-dispatch", "domain-event-bus/subscribers-are-registered-explicitly-and-only-registered-subscribers-run"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.2 在 port 上写 `subscribe` 的品牌化编译期守护，采用 tsc 5.9.3 strict 下已实测通过的形态 `subscribe<T extends (e: DomainEvent) => any>(handler: T & (ReturnType<T> extends void ? unknown : BrandedNonEventError)): void`；`BrandedNonEventError` 是带**人类可读说明文字键**的对象类型，使编译器把整句解释原文打进错误（说明须含"订阅者必须返回 void"与"返回回执的协作是 CALL 不是 EVENT"）。⚠ 不得退化成 `(e) => void` 参数——那是零报错的假守护
  - requirements: ["domain-event-bus/subscriber-handlers-must-return-void-enforced-at-compile-time"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.3 在 port/目录旁写"非事件准入规则"散文：**需要回执、可以被拒绝、或发布者依赖其结果的协作是 CALL，不是 EVENT**（用返回/回执语义表述，不用关注点名字）；今日三条非事件——terminal provisioning audit detail 的 `recordProvisioningFailure`/`recordTaskCancellation`（`Promise<boolean>`）、admission-work 的 `lease.authorize()`/`lease.checkpoint()`（await 取权威）、provisioning diagnostics write gate 的 `isEnabled(): boolean`——**仅作该规则的已知例证**列出，不写成三个特例
  - requirements: ["domain-event-bus/the-non-event-admission-rule-is-declared-and-mechanically-enforced"]
  - surfaces: ["developer-workflow", "docs"]
  - verify: "workflow-gates"
- [x] 3.4 新建 `apps/api/src/domain-events/domain-event-bus.service.ts`：`publish` 同步派发给该事件类型的每个已注册订阅者、按注册序、返回前完成投递；不 await 返回值、不排队/不延迟/不批处理/不推到后续 tick、不持久化；每个订阅者放进**各自的** try/catch，抛错不中断派发循环、不外传给发布者（抛非 `Error` 值同样隔离）；**不得**用裸 `EventEmitter` 实现该保证
  - requirements: ["domain-event-bus/the-domain-event-bus-is-a-declared-in-process-port-with-synchronous-dispatch", "domain-event-bus/subscriber-failures-are-isolated-per-subscriber"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.5 失败可见：每次吞掉订阅者失败落**恰好一条** warn 及以上的结构化日志，至少含 `eventType` + `subscriberName` + `error.message`；两个失败订阅者产出两条各自点名、互不覆盖的记录；空/缺 name 的注册在**构造期**拒绝（而非失败时产生匿名记录）；失败路径只调 logger、零 re-entrant `publish`；事件名不得使用 `'error'`
  - requirements: ["domain-event-bus/swallowed-subscriber-failures-are-observable", "domain-event-bus/a-subscriber-failure-never-escalates-into-a-process-level-failure"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.6 `publish` 内在派发**之前**对 payload 调该事件 schema 的真 `.parse()`；校验失败 → 零订阅者被调用 + 一条点名 eventType 与校验失败的结构化日志 + **不向发布者抛**；本 change 给 `scripts/contracts-executed-schema-check.mjs` 的 `INDIRECTION_POINTS` **新增零条**
  - requirements: ["domain-event-bus/payload-validation-happens-inside-publish-and-cannot-fail-the-publisher"]
  - surfaces: ["developer-workflow", "contracts"]
  - verify: "workflow-gates"
- [x] 3.7 新建 `apps/api/src/domain-events/domain-event-publishing-cutover.port.ts`（形态取轻模板 `task-provisioning-diagnostics-write-gate.port.ts`：构造时快照 env 一次 + 纯求值）：读 `CAP_DOMAIN_EVENT_PUBLISHING_ENABLED` 恰一次且此后不再读；返回**完整决策对象**（至少 `enabled` + 机器可读 reason/source，抄重模板 `task-admission-gate.ts` 的形状，不返回裸 boolean）；未设或不可识别 = **开**（reason 标 `default`）；显式逃生值 = 关；实现内零 attestation、零 buildIdentity、零签名校验
  - requirements: ["domain-event-bus/the-publish-cutover-toggle-is-snapshot-once-result-shaped-default-on-and-attestation-free"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.8 新建 `apps/api/src/domain-events/domain-events.module.ts`：`@Global()` + `useExisting` 绑定（模板 `apps/api/src/audit/audit.module.ts`），`DOMAIN_EVENT_SUBSCRIBERS` 绑定为**空数组**（本 change 零订阅者）；开关在组合根求值一次，关闭时**干脆不把 bus provider 放进 providers 数组**，使逃生口与"目录外 9 个 spec 不注入 bus"走同一条代码路径
  - requirements: ["domain-event-bus/subscribers-are-registered-explicitly-and-only-registered-subscribers-run", "domain-event-bus/the-publish-cutover-toggle-is-snapshot-once-result-shaped-default-on-and-attestation-free"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.9 新建 `apps/api/src/domain-events/domain-event-bus.service.spec.ts`：三订阅者按注册序在 publish 返回前全部跑完（marker 断言）；零订阅者时 no-op（不抛、无 IO、无 DB、无 error 级日志）；A/B/C 中 B 抛错时 A 与 C 各恰好一次且发布者无异常；全部订阅者都抛仍正常返回且发布者下一语句执行；抛字符串/`undefined`/非 `Error` 对象同样隔离；两个失败订阅者两条可区分日志；不在数组 token 内的 handler 不被调用；本 change 的订阅数组为空；publish 期间不触发 `uncaughtException`/`unhandledRejection`；无效 payload 被丢弃 + 记一条日志 + 不抛
  - requirements: ["domain-event-bus/the-domain-event-bus-is-a-declared-in-process-port-with-synchronous-dispatch", "domain-event-bus/subscriber-failures-are-isolated-per-subscriber", "domain-event-bus/swallowed-subscriber-failures-are-observable", "domain-event-bus/a-subscriber-failure-never-escalates-into-a-process-level-failure", "domain-event-bus/payload-validation-happens-inside-publish-and-cannot-fail-the-publisher"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"
- [x] 3.10 新建 `apps/api/src/domain-events/domain-event-bus.typecheck.ts` 自失效夹具（范本 `apps/api/src/task-admission/admission-mode-policy.typecheck.ts`）：负例各带 `@ts-expect-error`——返回对象的 `(e) => ({ durable: true })`、`async (e) => {}`、真实 `recordProvisioningFailure`（`Promise<boolean>`）、真实 write gate `isEnabled()`（`boolean`）、`lease.authorize()`；正例必须零报错——`(e) => {}`、`(e) => someVoidMethod(e)`、`.bind()` 的 void 方法、以及**自带 `.catch(...)` 的 fire-and-forget 出口**（void 方法内启动异步工作、不把 promise 交回 bus）。守护被削弱时未使用的 `@ts-expect-error` 以 TS2578 让夹具自己红
  - requirements: ["domain-event-bus/subscriber-handlers-must-return-void-enforced-at-compile-time", "domain-event-bus/the-non-event-admission-rule-is-declared-and-mechanically-enforced"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"
- [x] 3.11 新建 `apps/api/src/domain-events/domain-event-publishing-cutover.spec.ts`：构造后改 env 决策不变；未设 env 时 `enabled: true` 且 reason 标 `default`；逃生值时 `enabled: false` 且返回对象**带上关闭原因**（调用方能记录"为什么关"而非只知道"关了"）；实现内零 attestation/构建身份/签名引用，且不可能因 attestation 过期或缺失而被留在关闭态
  - requirements: ["domain-event-bus/the-publish-cutover-toggle-is-snapshot-once-result-shaped-default-on-and-attestation-free"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"
- [x] 3.12 零运行时发现证据：本 change 新增文件内搜 `DiscoveryService`、`MetadataScanner`、`@nestjs/cqrs`、`@nestjs/event-emitter` 均零命中；root 与 `apps/api` 的 `package.json` 均**不新增**这两个包（diff 为证）
  - requirements: ["domain-event-bus/subscribers-are-registered-explicitly-and-only-registered-subscribers-run"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"

## 4. Track: integration (depends: contracts-event-catalog, manifest-ratchets-and-registry, bus-mechanism)

- [x] 4.1 发布点**双向扫描**并写进 baseline：向内（谁写这些生命周期状态）+ 反向（同一时刻谁也在读），逐点记录 file:line，复核 D11 的 3 / 1 / 2 / 2 / 3 拓扑与本文件头部的实测行号；若扫描结论与 design 表不符，**先改 design 再接线**，不得照图纸机械接
  - requirements: ["guardrails/taskrunstarted-is-published-at-exactly-three-declared-points", "guardrails/tasksettled-is-published-only-at-the-terminal-fence", "guardrails/sandboxprovisioned-is-published-on-both-provisioning-paths-after-the-provider-boundary-succeeds", "guardrails/taskadmitted-is-published-on-both-admission-paths", "guardrails/tasksuperseded-is-published-once-per-observation-at-three-declared-producer-boundaries"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.2 `apps/api/src/guardrails/guardrails.service.ts`：把 bus 作为**第 11 个 `@Optional()` 尾参**注入（前 10 参 `moduleRef, creds, sandbox, config, provisionLookup, audit, prisma, transcripts, provisioningDiagnosticRecorder, provisioningDiagnosticWriteGate` 顺序与类型一字不动），所有发布走 `this.bus?.publish(...)` 并包成"发布错误被吞、生命周期转移/拆卸/槽位释放无条件继续"的形态；**零既有同步协作者调用被移除**。⚠ 同一任务内**必须**一并改 `apps/api/src/guardrails/guardrails.module.ts`：该 provider 是 `useFactory` + 位置化 `inject:` 数组（9 参 factory → `new GuardrailsService(10 参)`），不加 `{ token: DOMAIN_EVENT_BUS, optional: true }` 与对应实参的话，生产路径上 bus 恒为 undefined、全部发布静默短路而所有测试照绿
  - requirements: ["guardrails/guardrails-publishes-domain-events-without-changing-lifecycle-behavior"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.3 `guardrails.service.ts` 接三处 `TaskRunStarted`：readoption 恢复路径（~1566）、legacy `startRunningAfterCapacity`（~2623）、durable `armDurableRuntime`（~2971），各自**紧贴**既有 `runnerMinutes.recordStart(taskId)` 且不替换、不移动它；legacy 带 `admissionMode: legacy`、durable 带 `admissionMode: durable`；`armDurableRuntime` 对已 armed 任务二次调用早返时**不重发**
  - requirements: ["guardrails/taskrunstarted-is-published-at-exactly-three-declared-points"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.4 `guardrails.service.ts` 接**唯一**一处 `TaskSettled`：`fenceTerminal`（~2033/2038）记录任务自身终态时发布，携带该终态；`clearAdmissionRuntime`（~2947/2949）的第二处 `recordEnd` **不是**终态结算、**不发** `TaskSettled`（负向要求）；两处 `recordEnd`、连接移除、会话反注册全部原样保留
  - requirements: ["guardrails/tasksettled-is-published-only-at-the-terminal-fence"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.5 `guardrails.service.ts` 接 durable `SandboxProvisioned`：仅在 `provider.provision(...)` 成功返回、归属复验通过、连接完成注册**之后**发一次；payload 用发布点已在手的 `snapshotSandboxProvisionContext` 快照 + `resolveSelectedRunStrict` 组装，**零新增** provider 调用 / DB 读 / resolver；provision 抛错、被取消、为 detaching transfer 回卷、或复验发现丢失 fence 而丢弃沙箱时，均零发布
  - requirements: ["guardrails/sandboxprovisioned-is-published-on-both-provisioning-paths-after-the-provider-boundary-succeeds"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.6 `guardrails.service.ts` 接 legacy `TaskAdmitted`：`admit()`（~737）得出 `running`/`queued` 结果后发一次，带 outcome + 该次转移的 transition token + `admissionMode: legacy`；并发调用 join 同一 in-flight admission promise 时**只发一次**
  - requirements: ["guardrails/taskadmitted-is-published-on-both-admission-paths", "domain-event-bus/the-canonical-fence-token-is-the-admission-transition-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.7 `apps/api/src/tasks/tasks.service.ts` 接 durable `TaskAdmitted`：`reserveDurableAdmissionCapacity`（~1969）提交任务转移后发一次，带 outcome（`running`/`queued`）+ `admissionMode: durable` + 本次预留铸出的 transition token（**不得**代入 admission-work `leaseToken`）；被拒或 superseded 的预留零发布
  - requirements: ["guardrails/taskadmitted-is-published-on-both-admission-paths", "domain-event-bus/the-canonical-fence-token-is-the-admission-transition-token"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.8 `tasks.service.ts` 接两处 durable `TaskSuperseded`：容量预留返回 `superseded`（含 lease 转移回卷那条）与 `performAdmissionTransition`（~2393）返回 `superseded`，各发一次，只带被取代 taskId + 失败方持有的 fence token + 观察点判别符（+ 可得时的观察状态），**零** superseder 身份字段
  - requirements: ["guardrails/tasksuperseded-is-published-once-per-observation-at-three-declared-producer-boundaries", "domain-event-bus/tasksuperseded-carries-no-superseder-identity"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.9 `apps/api/src/inline-admission/inline-admission.pipeline.ts` 接 legacy `SandboxProvisioned`：`provider.provision(...)` 成功且连接经 `registerConnection` 注册后发一次，payload 取该接缝已在手的 `registerConnection` 引用 + `resolveSelectedRun` 结果，零新增管线
  - requirements: ["guardrails/sandboxprovisioned-is-published-on-both-provisioning-paths-after-the-provider-boundary-succeeds"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.10 `inline-admission.pipeline.ts` 接 run 级 `TaskSuperseded`：整次 pipeline 运行**至多一个**——把内部 9 处 `superseded` 早返（@190/223/243/253/288/370/412/432/449 一带）汇聚到单一 run 出口发布，而非逐处发；非 superseded 结局零发布
  - requirements: ["guardrails/tasksuperseded-is-published-once-per-observation-at-three-declared-producer-boundaries"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.11 `apps/api/src/app.module.ts` 接跨模块 DI 绑定（引入 `DomainEventsModule`），并接上 cutover 的"关闭即不绑定 bus provider"路径；发布者只 import `.port.ts`，实现仅在 `domain-events.module.ts` / `app.module.ts` 绑定（跨 context import 的三种合法形态之一）
  - requirements: ["domain-event-bus/the-domain-event-bus-is-a-declared-in-process-port-with-synchronous-dispatch", "domain-event-bus/the-publish-cutover-toggle-is-snapshot-once-result-shaped-default-on-and-attestation-free", "guardrails/guardrails-publishes-domain-events-without-changing-lifecycle-behavior"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.12 新增发布测试（**新文件**：`guardrails-domain-event-publishing.spec.ts`、`tasks-domain-event-publishing.spec.ts`、`inline-admission-domain-event-publishing.spec.ts`，零改既有 spec）：每个已声明发布点各一条"恰好发布一次且 payload 能对着其 schema `.parse()` 通过"；负向三条（`clearAdmissionRuntime` 零 `TaskSettled`、失败/取消/superseded provision 零 `SandboxProvisioned`、superseded 预留零 `TaskAdmitted`）；两条搜索型断言钉死 `TaskRunStarted` 发布点恰 3 处、`TaskSettled` 恰 1 处且在终态 fence 内；一条"发布抛错时终态转移、计时器清理、runner-minutes 结束、槽位释放照常"的断言
  - requirements: ["guardrails/taskrunstarted-is-published-at-exactly-three-declared-points", "guardrails/tasksettled-is-published-only-at-the-terminal-fence", "guardrails/sandboxprovisioned-is-published-on-both-provisioning-paths-after-the-provider-boundary-succeeds", "guardrails/taskadmitted-is-published-on-both-admission-paths", "guardrails/tasksuperseded-is-published-once-per-observation-at-three-declared-producer-boundaries", "guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"
- [x] 4.13 characterization 出证：`git diff` 过滤 `apps/api/src/guardrails/**/*.spec.ts` 命中**零文件**；目录内 120 个 `test()`（5 个 spec：57+54+3+3+3）+ 8 个 `.test.mjs` 断言脚本原样通过；且不注入 bus 构造时（目录外位置化形态）全生命周期行为与改动前一致、无空引用错误
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization", "guardrails/guardrails-publishes-domain-events-without-changing-lifecycle-behavior"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"
- [x] 4.14 目录外 9 个位置化 `new GuardrailsService(...)` 的文件（`tasks/` 6：`tasks-durable-admission-accept-queue-diagnostics.story`、`tasks-durable-admission-cleanup-coordination.story`、`tasks-durable-admission-cleanup`、`tasks-durable-admission-crash-matrix`、`tasks-durable-admission-diagnostic-recovery.story`、`tasks-legacy-request-lifetime`；`public-surface/` 2；`task-admission/` 1）：**唯一允许**的改动是增补或省略尾部可选 bus 实参；逐 hunk 出 diff 证据证明零断言、零期望值、零计数器、零 scenario 被改
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"
- [x] 4.15 源码文本扫描型测试从行为测试口径中**单列**并跑一次 `sandbox-host-harness-wiring.test.mjs`，确认是否因 guardrails/inline-admission 新增 publish 而必须更新；若必须更新，保住按文件的断言强度（两条 provisioning 路径各自仍解析 workspace source、provision-context 计数仍按文件钉死），**不得**松成一个总数
  - requirements: ["guardrails/existing-guardrails-behavior-is-proven-unchanged-by-characterization"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 4.16 挂载与闸门：`pnpm test:context-layout-v2` exit 0 且零 unmapped 目录、零 `unclassified-file` finding；r7 比较器零新键零增数，且本 change 若消灭了任何 cross-context import 条目须**同 PR 删除**该条目（comparator 双向 fail-closed）；R11 活测重算与基线相等且退出 0；test-discovery 闸门报告本 change 新增的每个测试文件均被执行；`pnpm test:scripts` 通过；`api-module-layout-check` 的 `ALLOWED_CYCLES` 仍为空
  - requirements: ["domain-event-bus/the-bus-lands-in-a-declared-context-with-classified-file-names", "domain-event-bus/the-dependency-budget-ratchet-is-seeded-with-measured-counts"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 4.17 contracts 两闸门：`scripts/contracts-executed-schema-check.mjs` 把五个事件 schema 记为**真执行**（由 3.6 的 publish 内 `.parse()` 满足）且 `INDIRECTION_POINTS` 列表 diff 显示**零新增**；`scripts/contracts-shared-export-check.mjs` 通过（目录每个 export 可达）
  - requirements: ["domain-event-bus/payload-validation-happens-inside-publish-and-cannot-fail-the-publisher"]
  - surfaces: ["contracts", "ci"]
  - verify: "workflow-gates"
- [x] 4.18 四公开面 `derived` 的**可复算证明**：证明 `v1`、`mcp`、`openapi`、`public-surface`（api-playground）四处零 import 事件目录（无 controller DTO / MCP tool 注册 / OpenAPI 文档投影），并在集成树真跑 `public-surface-adversarial`；若出现任何 import，则把 `surface-impact.json` 的 `requiresWireCompatibilityFixture` 翻成 `true` 并在归档前改 sidecar（sidecar 造假有 NOT-ARCHIVABLE 判例）
  - requirements: ["domain-event-bus/catalog-v1-is-in-process-additive-only-and-declares-its-upgrade-condition"]
  - surfaces: ["public-v1", "mcp", "openapi", "playground"]
  - verify: "workflow-gates"
- [x] 4.19 零持久化证据：diff 内零 `apps/api/prisma/schema.prisma` 改动、零新 migration 目录、零把已发布事件写进任何表的代码路径；`TaskAdmissionWork` 模型及其处理逻辑零改动，且目录声明确实点名它是既有且不受影响的 admission outbox
  - requirements: ["domain-event-bus/catalog-v1-is-in-process-additive-only-and-declares-its-upgrade-condition"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.20 逃生口活证：设 `CAP_DOMAIN_EVENT_PUBLISHING_ENABLED` 为逃生值跑完整任务生命周期 → 零次 `publish` 调用、每个既有同步协作者调用次数与改动前一致、可观察生命周期行为与本 change 之前逐字节相同（该路径与 4.14 的 9 个目录外 spec 是同一条代码路径）
  - requirements: ["domain-event-bus/the-publish-cutover-toggle-is-snapshot-once-result-shaped-default-on-and-attestation-free", "guardrails/guardrails-publishes-domain-events-without-changing-lifecycle-behavior"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"
