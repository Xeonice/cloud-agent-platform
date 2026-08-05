# extract-runner-minutes-ledger 研究简报

> 阶段 4 第三刀（路线校准后的「最小验证刀」）的前置研究汇总。
> 三路并行调研：**Web**（外部实践与判例）、**Codebase**（本树实测）、**Archive**（归档 change 的判例，尤其是直接前作 `2026-08-05-adjudicate-audit-event-migration` 与结构范本 `2026-07-29-isolate-legacy-admission-behind-capability-policy`）。
> 每条结论带编号（W#/C#/A#），§4「Implications for the proposal」按本 change 的设计接缝 (A)–(F) 交叉引用这些编号。
> 本简报只汇总证据与推论，**不代替 proposal/design 的拍板**。需要用户拍板的点集中列在 §5。
>

> ---
> ## ⚠ 勘误（propose 拍板后补测，2026-08-05）——以下三类结论已被本树实测推翻，**勿再引用原值**
>
> 1. **diagnostics 天花板不是 8→2。** 「8→2」是 legacy **退役后**的地板，不是当下的天花板；legacy 存活时是 **8→4**。
>    并且 **8→0 不可达**：`:654/:657` 是第 9、10 个构造参数，删掉会让 bus 从第 11 位变第 9 位，与既有场景「bus 是尾参、前 10 个保持顺序与类型」字面冲突。
>    影响 C17（:212/:214）、§4(D) 第 4 条（:399）、§5 Q6（:450）。
> 2. **反转 gate 不会让 WriteGate 4→0，是 4→2。** legacy 管线自己在 `inline-admission.pipeline.ts:670` 独立询问 gate，且该管线是在 `guardrails.service.ts:682` 被 `new` 出来的；
>    构造参数 `:657` 也不随任何抽取消失。影响 W9/W10/W11 的意义段（:68/:73）、§4(D)（:397）、§5 Q6（:450）。
> 3. **「diagnostics/transcript 各约 30 行」是无出处估值，「剩 ~2,100 行是编排体」是减法残差。**
>    两者在整套工件里都只有裸数字、没有行号或命令支撑，重测后区间随计数规则在几十行到约一千行之间大幅摆动。
>    需甩量的正确值是 `4,131 − 1,999 = ≥2,132 行`（原文 ~2,131 按等于 2,000 计算，差 1）。影响 C18（:216-218）、§4(D) 第 6 条（:391）、§5 Q7（:453-454）。
>    ⚠ 阶段 4 的**数字验收目标本身已于 2026-08-05 被用户拍板作废**，改为结构判据（见 proposal 的 Q4）；:150 与 :217 引用的 `<2,000 行` 已不是验收标准。
> ---
> ⚠ **读者先看这三条**：
> 1. **本刀的「抽取」已经做完了一半**——`RunnerMinutesLedger` 类早已在 `apps/api/src/runner-metrics/`（manifest 里 platform-ops 的既有目录），留在 guardrails 的只是**实例字段 + 5 处写 + 1 处读**。本刀的净内容是 Move Field + Remove Middle Man，不是 Extract Class，也**不需要新建目录**（W1/C2/A5）。
> 2. **R11 `this.runnerMinutes` 6 → 0 结构上不可达**，诚实天花板是 **6 → 5**：R11 按符号引用计数，只要 guardrails 还调协作者，5 处写引用必然存活，能真正消失的只有 `:3880` 的 `intervals()`（C5）。任务描述若隐含「燃尽」，口径必须先改。
> 3. **`guardrails.service.spec.ts` 是被 spec 场景钉成「零 diff 行」的热点文件，而它恰好持有 14 处 `runnerMinutes` 反射断言**（C9/W18）。这条冲突决定了字段名能不能改，而字段名又同时决定 R11 口径（C6）与 spec 里「SHALL remain in place and unchanged」的字面成立性（C10）——**三个问题是同一个决定**，见 §4 (B)。
>
> 一句话的收益预告，供 range B 定调：本刀从 4,131 行的 guardrails 里最多摘掉 **24 行（0.58%）**，让 forwardRef 环消失 **0 条边**，让 r7 跨上下文 import 从 guardrails 侧 9 → 8。**这不是失败，这是本刀存在的理由**——它把「协作者燃尽能不能到 <2,000 行」这个问题从推断变成了实测（C4/C7/C8/C18）。

---

## 1. Web 路线 — 外部实践与判例

### 1.1 本刀的重构命名与判据

**W1 · 这一刀在 Fowler 目录里有名字，而且是「两步中的第二步」**
Extract Class 早已完成（`RunnerMinutesLedger` 已独立在 `runner-metrics/runner-minutes.ts`），剩下的是 **Move Field**（实例字段换主人）+ **Remove Middle Man**（删转发访问器）。`runnerMinuteIntervals()` 是教科书级 Middle Man——函数体只有一行 `return this.runnerMinutes.intervals();`。
证据：`apps/api/src/guardrails/guardrails.service.ts:3878-3881`（一行转发）与 `:593`（字段）；`apps/api/src/runner-metrics/runner-minutes.ts`；https://refactoring.com/catalog/hideDelegate.html ；https://refactoring.guru/remove-middle-man
意义：design 应直接用「Move Field + Remove Middle Man」命名本刀，而不是含糊的「抽 application service」。类已经在正确的上下文里，本刀的净内容就是一个字段 + 6 个调用点换主人——**工作量与风险的实数估算应据此下调**，同时也解释了为什么收益数字必然小（见 C4）。

**W2 · Remove Middle Man 的判据与「metrics 必须直连、不得经 guardrails 中转」逐字吻合**
Fowler 的判据：当调用方对 delegate 的耦合已大到每加一个交互点就要在中间人身上新开一个方法时，就该删掉中间人让调用方直连。
证据：https://refactoring.guru/remove-middle-man ；https://imartynov.substack.com/p/89-refactoring-book-hide-delegate
意义：给 surface-impact 里那条硬约束提供外部背书，可写进 design 判据段。反过来它也给出可测的验收形态：**迁移后 guardrails 上 runner 相关的公开方法数 = 0**；留一个空转发器就是没做完（与 A11 的死代码判例同指）。

**W3 · 【最强约束，本地实证】跨上下文直接 import 具体 `*.service.ts` 是 manifest 明令 forbidden，而 metrics 今天正在这么干**
`crossContextRules.forbidden` 只承认对方显式导出的 `*.port.ts` + DI token 这一种合法形态；`metrics.service.ts:8` 直接 import 了 `GuardrailsService`（task-execution）——这本身已是一条违规边。把账本迁进 `runner-metrics`（platform-ops，与 metrics 同上下文）会直接消灭这条违规边，代价是 guardrails → 新所有者变成新的跨上下文**写**边，必须以 `*.port.ts` + token 落地（`runner-metrics` 不在 `sharedKernelDirectories` 白名单里，只有 prisma/crypto/observability 三个，没有捷径）。
证据：`docs/refactor/contexts-manifest.json` `crossContextRules.forbidden` / `machineReadable.sharedKernelDirectories`；`apps/api/src/metrics/metrics.service.ts:8`
意义：**这条直接决定归属答案**：选 platform-ops/`runner-metrics` 而非在 task-execution 内新建 service——前者「读边违规消失、只新增一条写边」，后者「读边违规仍在、还多一条写边」。落地必须是 recorder 风格的 port，不能让 guardrails import 具体 service。

**W4 · 仓内已有同形状先例可照抄，且目录已存在**
第一刀的 audit 走的就是 `audit/audit-recorder.port.ts`；`runner-metrics/` 已在 manifest 的 platform-ops directories 里并已装着 `runner-minutes.ts` 与 `metrics-projection.ts`。
证据：`apps/api/src/audit/audit-recorder.port.ts`；`docs/refactor/contexts-manifest.json` `contexts.platform-ops.directories`；`apps/api/src/runner-metrics/` 实存两文件
意义：两个后果。①命名与形态直接沿用（`runner-metrics/runner-minutes-ledger.port.ts`，recorder 语义），复用第一刀已被闸门接受的模板。②本刀**不需要新建目录**，因此「新目录不同 commit 进 manifest → layout-v2 exit 1」这条风险**对本刀不适用**——该风险留给后两刀（若它们需要新目录）。

### 1.2 事件化判据的词表缺口（为第 4/5 刀准备）

**W5 · 「需要回执就不该事件化」是业界成文共识，且有专名**
把需要对方做事并回话的消息做成事件 = **commands in disguise / passive-aggressive event**，属公认反模式；微软 DDD 文档同样把「需要立即反馈或返回值」列为域事件不适用的场景。
证据：https://www.ben-morris.com/event-driven-architecture-and-message-design-anti-patterns-and-pitfalls/ ；https://event-driven.io/en/passive_aggressive_events/ ；https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation
意义：第二刀升格为 spec 级的三条判据（`acknowledgement-required` / `information-missing` / `no-decoupling-gain`）可以在 design 里附外部对照，证明这不是本仓自创的托词；「command in disguise」可作为拒绝理由的通用语言。

**W6 · 「完成时序」在业界的表达方式是显式 flush 契约，不是通知——建议**新增第四条判据**而非扩写判据 1**
OTel 规范写死「Shutdown MUST include the effects of ForceFlush」，即销毁前必须以**可等待的操作**把数据冲干净；事件语义天然不提供 happens-before 保证。
证据：https://opentelemetry.io/docs/specs/otel/trace/sdk/ ；https://oneuptime.com/blog/post/2026-02-06-otel-sdk-shutdown-java-spring-boot/view
意义：给第四条判据提供可直接引用的措辞蓝本——「调用方依赖协作者的完成先于某个后续的破坏性步骤（happens-before / flush-before-destroy）」。它的机理（顺序保证）与判据 1（读返回值分支）不同，**混写会让后续判定含糊**，因此建议新增而非扩写。

**W7 · 别指望「换个 provider/module」自动解决时序**
NestJS 官方明确同一 module 内多个 provider 的生命周期钩子**不保证**拓扑顺序（issue #14773 至今开着），社区解法是显式 await 或把 provider 拆到独立 module。
证据：https://github.com/nestjs/nest/issues/14773 ；https://docs.nestjs.com/fundamentals/lifecycle-events
意义：直接回答 range B ②「transcript 的时序阻塞点在抽取后是否自然消解」——**倾向于否**：抽取只换所有者，happens-before 仍必须由 teardown 路径上的显式 await 承担。与本仓血泪史同构（跨 provider 的 `onApplicationBootstrap` 无序导致活任务被误判 failed 的生产事故）。

**W8 · 「先取数据再销毁容器」是有成文案例的已知竞态类**
容器一旦 dead / marked-for-removal 就取不到日志，testcontainers 有专门 issue，通用建议是删除前先落盘。
证据：https://github.com/testcontainers/testcontainers-go/issues/606 ；https://java.testcontainers.org/features/container_logs/
意义：`transcript.capture(taskId)` 必须先于 stop-only `teardownSandbox` 不是本仓特例。验收应用**顺序断言**（fake 记录调用序列，断言 capture 完成早于 teardown 调用）而不是超时/sleep，这样测试不受环境速度影响。

### 1.3 剩余两组的路线级信息

**W9 · `gate.isEnabled()` 被调用方直接分支，是 Fowler 点名的反模式**
「point conditional at a long-lived toggle point」的处方是 Feature Decisions Object / 构造期注入 / Strategy，让调用方对开关一无所知。
证据：https://martinfowler.com/articles/feature-toggles.html （Decoupling Decision Points from Decision Logic）
意义：对第二组（`provisioningDiagnosticRecorder` + `WriteGate`，各 4 次）是路线级信息：把 gate 反转成「关闭时注入 no-op recorder」或由 diagnostics 上下文自持决策对象，能一次性**消灭** WriteGate 这个 collaborator（R11 上 4→0），而不只是换个地方。建议 range B ② 把「反转 gate」列为该组**首选形态**，抽 service 为次选。

**W10 · 把横切观测从编排器里拿掉的标准机制是 Decorator/Interceptor**
不是在业务方法里散落埋点。
证据：https://blog.ploeh.dk/2010/09/20/InstrumentationwithDecoratorsandInterceptors/ ；https://www.davidguida.net/using-decorators-to-handle-cross-cutting-concerns%20-%20part-2-a-practical-example/
意义：给第二组一个比「抽 application service」更彻底的候选：用 diagnostics decorator 包住 provisioning 调用，则 recorder 活句柄的 open→settle 全落在装饰器内部，**gate 分支与句柄结算同时**从 guardrails 消失。⚠ 但这个「8 次一次清零」的估算被 C17 部分推翻（`:731/:732` 是进 legacy inline-admission 的透传，需 legacy 退役才动得了）——见 §4 (E)。

**W11 · 「返回必须结算的活句柄」不是怪癖，有两个成熟原型**
OTel 的 Activity/Span（open→end 作用域生命周期）与 Unit of Work（打开记录、稍后统一 commit），两者都是同步句柄语义，从不建模成 fire-and-forget 事件；TypeScript 5.2 起还有 `using` / `Symbol.dispose` 把「必须结算」变成编译期可强制的作用域资源。
证据：https://deviq.com/design-patterns/unit-of-work-pattern/ ；https://oneuptime.com/blog/post/2026-02-06-dotnet-built-in-diagnostics-apis-opentelemetry/view ；https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html
意义：给出一条**归属主判据**：句柄的 open 与 settle 必须归**同一个所有者**，否则跨对象半开状态无人负责。range B ② 判断 diagnostics 归属时应以「open 与 settle 能否被同一 owner 完整包住」为主判据；能包住（装饰器方案能）则阻塞点自然消解，不能包住则该组不适合抽。

### 1.4 形态与治理惯例

**W12 · Prometheus 生态的主流做法是「谁拥有状态谁自己暴露」**
pull 模型下应用只维护自身指标当前值；prom-client 的 Gauge `collect()` 回调正是让**拥有者**在抓取时刻自报，避免中间人代收。
证据：https://prometheus.io/docs/instrumenting/writing_exporters/ ；https://www.npmjs.com/package/prom-client
意义：为「metrics 直接向新所有者拉取」提供生态背书；并给一个**备选形态**：若直连 import 在某方向上又触发跨上下文规则，可让新所有者注册 collect/read 回调由 metrics 组装，仍然不经 guardrails。⚠ 本仓 metrics 是 JSON 快照而非 prom registry，**形态借鉴、不照搬**。

**W13 · 模块化单体的通行铁律是「每个模块拥有自己的数据，只经窄 API 对外」**
共享状态是最难解开的耦合；Spring Modulith 用包约定 + 构建期测试强制这一点。
证据：https://modularmonolith.io/ ；https://www.javacodegeeks.com/2026/07/spring-modulith-2-0-enforcing-module-boundaries-before-microservices.html
意义：支撑「状态所有权」这一刀的立论，并给出一条戒律：**新所有者对外只应暴露一个读方法**（`intervals()` 等价物），不要把 `RunnerMinutesLedger` 整体 re-export，否则只是把 god object 的内脏换了个位置。

**W14 · ratchet 基线是成熟实践，但本仓比生态更严**
dependency-cruiser 自带 `.dependency-cruiser-known-violations.json`、madge 有 baseline 模式，但生态工具普遍**自动重生成基线**；本仓 R11 是**双向 fail-closed**（降了不更新也红）。
证据：https://github.com/pekala/eslint-plugin-dependency-cruiser ；`scripts/ratchets/r11-dependency-budget.mjs` + `docs/refactor/04-rules-registry.md:64`（R11 六键位基线：`this.audit` 9 / `this.runnerMinutes` 6 / recorder 4 / writeGate 4 / `this.transcripts` 2 / metrics-projection 2，按符号引用计）
意义：本刀必须**在同一 PR** 把 `this.runnerMinutes` 从 6 改成迁移后的实数；**不能按生态直觉「让工具自己重生成」**。这是最容易踩的红。

**W15 · 测「forwardRef 环是否消失」不要手工数**
dependency-cruiser 能查**间接**环并可写成规则，madge 只报直接环（间接环会漏）。
证据：https://dev.to/jacobandrewsky/avoid-cross-module-dependencies-with-dependency-cruiser-3b0b ；madge 直接环限制见 https://www.xjavascript.com/blog/detect-circular-dependencies-in-project/
意义：range B ① 要求「是否有边因此消失」是实测数据而非估算——工具选型直接定 dependency-cruiser，抽取前后各跑一次输出环列表做 diff。⚠ 但 C7/A19 已从模块接线层面给出确定答案（零条），所以这是**佐证手段而非阻塞前置**，见 §4 (D)。

**W16 · 「先做最小验证再定后续」有成方法论：Mikado Method**
设短时窗做一次真实尝试、记录暴露的前置条件、把改动 revert，产出**前置条件图**而不是代码。
证据：https://understandlegacycode.com/blog/a-process-to-do-safe-changes-in-a-complex-codebase/ ；https://www.methodsandtools.com/archive/mikado.php
意义：外部背书用户的拍板形态；并给 range B 的 `research-findings.md` 一个成型产出格式——把剩余两组画成**前置条件图**（谁必须先于谁），而不是只给一个刀数列表。

**W17 · 行为等价的标准安全网是 characterization / golden master**
先记录当前输出，再动结构。
证据：https://en.wikipedia.org/wiki/Characterization_test ；https://understandlegacycode.com/blog/characterization-tests-or-approval-tests/
意义：「metrics 派生结果逐字节不变」应实现为：**迁移之前**先写固定 intervals 夹具 + 冻结 `now` 的 characterization 测试钉住 `deriveRunnerMinutes` 的完整输出对象，迁移后同测试**不改一字**通过。⚠ 落点必须避开 C12 的 inline 镜像陷阱。

**W18 · 【本地实证】`guardrails.service.spec.ts` 至少 9 处以 `internals.runnerMinutes` 反射式伸手断言**
正是「钉死账本在 guardrails 里」的实现事实型测试。
证据：`apps/api/src/guardrails/guardrails.service.spec.ts:1375,1380,3011,3021,3072,3078,3132,3136,3199,3207,3274,3280,3341,3347`
意义：这批就是需要「显式改写并逐条留痕」的清单，现在就能把留痕表按行号填完。⚠ 但 C9 给出了更强的结论：这个文件被 spec 场景要求**零 diff 行**，所以「改写」本身要先过一道拍板，见 §4 (B)。

**W19 · 【本地实证】runner-minutes 的派生结果没有经任何 /v1 操作暴露；但后两组各自有 /v1 控制器**
metrics 只有 `GET /metrics` 与 `GET /tasks/:taskId/metrics` 两个控制台路由，`v1/` 下无 metrics 控制器；而 `v1/` 下**存在** `v1-task-provisioning-diagnostics.controller.ts` 与 `v1-transcript.controller.ts`。
证据：`apps/api/src/metrics/metrics.controller.ts:20,33`；`apps/api/src/v1/` 无 metrics 控制器；`apps/api/src/v1/v1-task-provisioning-diagnostics.controller.ts`；`apps/api/src/v1/v1-transcript.controller.ts`
意义：兑现 surface-impact.json 自带的复核指令——本刀四公开面 `unchanged` 站得住。但**后两组各自对应真实 /v1 操作，surface-impact 极可能要升级为 `derived` 并转录 protocolDifferences**（阶段 2 教训）。这是 range B ② 两组预估成本中一项不可忽略的**固定开销**。

**W20 · DDD 里 metering/telemetry 属 generic subdomain，但 generic 上下文是「单体温床」**
惯例是放在上游、稳定、与核心域解耦的位置；同一批资料警告业务语汇会悄悄渗进来。
证据：https://dev.to/lukaszreszke/subdomains-and-bounded-contexts-16b1 ；https://dzone.com/articles/ddd-strategic-patterns-how-to-define-bounded-conte
意义：支持把账本落在 platform-ops（generic）而非 task-execution（core）；并给一条护栏：**新所有者的接口只能说 `RunningInterval` / `taskId` 这种最小语汇**（现状已合规），不得引入 admission / fence 等 task-execution 词汇，否则下一轮又会长成新的耦合中心。

---

## 2. Codebase 路线 — 本树实测

### 2.1 起点与归属

**C1 · change 目录目前只有两个脚手架文件且未跟踪，五路对抗 verify 在第一路就红**
`.openspec.yaml` + `surface-impact.json` 两件；`git status --short` → `?? openspec/changes/extract-runner-minutes-ledger/`；`git branch --show-current` → **`main`**；`node scripts/public-surface-adversarial.mjs verify extract-runner-minutes-ledger --phase verify` → `sidecar.passed=false`，`"…/tasks.md is required"`，其余四路（registry / restMetadata / mcpSdkMetadata / behavior）全部 "Not run"。
意义：surface-impact.json 已把本刀范围编码正确，propose 只需补 proposal / design / tasks / specs。⚠ **当前工作在 `main` 上，任何提交前必须先开分支**。要满足的五路名字逐字是 `sidecar` / `registry` / `restMetadata` / `mcpSdkMetadata` / `behavior`。

**C2 · `RunnerMinutesLedger` 与 `deriveRunnerMinutes` 已经在 guardrails 之外**
它们在 `apps/api/src/runner-metrics/`，manifest 已把该目录划给 platform-ops；留在 guardrails 的只有实例、5 处写与读取面。
证据：`runner-metrics/runner-minutes.ts:23`（`RunningInterval`）/`:43`（`deriveRunnerMinutes`）/`:79`（`class RunnerMinutesLedger`）/`:112`（`intervals()`）；`docs/refactor/contexts-manifest.json:120-136`；`guardrails.service.ts:593` `private readonly runnerMinutes = new RunnerMinutesLedger();`
意义：这是**所有权迁移，不是文件迁移**。「新目录必须同 commit 进 manifest 否则 layout-v2 exit 1」这条约束大概率**不触发**；反之，选 task-execution 就需要一次新目录声明。

**C3 · `runner-metrics/` 没有 `.module.ts`，且两个现有文件已作为 `unclassified-file` 躺在 r7 基线里**
`ls apps/api/src/runner-metrics/` 只有 `metrics-projection.ts` 与 `runner-minutes.ts`；r7.json 持有 `unclassified-file:apps/api/src/runner-metrics/metrics-projection.ts` 与 `…/runner-minutes.ts`（各 count 1，共 132 个同类键）。
意义：新所有者**必须**用受分类的后缀命名（`.service.ts` → application，`.port.ts` → domain，按 `contexts-manifest.json` 的 `layers.fileClassification`），否则会**新增**一条 `unclassified-file` 条目——r7 是 only-down，新增即红。新建 `runner-metrics.module.ts` 被分类为 composition，是安全的。

### 2.2 收益的实数

**C4 · guardrails 里最大可摘足迹是 4,131 行中的 ~24 行（0.58%）；「guardrails 仍调用新 service」形态下净减约 12 行**
逐项清单：import 块 `:109-112`（4 行）；字段文档 + 声明 `:585-593`（9 行）；写点 `:1824`(1) `:2319`(1) `:2916-2917`(注释+调用,2) `:3264`(1) `:3286`(1)；读取面 `:3877-3881`（空行+文档+方法,5）。合计 24。
意义：这是 range B ① 的**头条数据**。`docs/refactor-master-plan.md:147` 的阶段 4 目标是「guardrails 3,806 → <2,000 行」，而文件已长到 4,131，即需要甩掉 ~2,131 行——runner 抽取最多贡献 24 行。**这个测量本身就是「剩余刀该怎么切」的论据**。

**C5 · R11 `this.runnerMinutes` 6→0 结构上不可达，诚实天花板是 6→5**
R11 按**符号引用**计数、用 `\b` 锚定正则；只要 guardrails 还调协作者，5 处写引用必然存活，真正能消失的只有 `:3880` 的 `return this.runnerMinutes.intervals();`。
证据：`scripts/ratchets/r11-dependency-budget.mjs:31-38`（"COUNTING CONVENTION — per SYMBOL REFERENCE… 阶段 4 is done with a collaborator when guardrails stops NAMING it at all"）、`:127`；活测 → `this.runnerMinutes: 6`；6 处为 `:1824, :2319, :2917, :3264, :3286`（写）+ `:3880`（读）
意义：验收写的是「R11 `this.runnerMinutes` 计数下降且有留痕」——6→5 字面满足，6→0 不满足。另注：字段声明 `:593` 没有 `this.` 前缀，**不计数**，所以把它改成构造参数对 R11 是中性的。

**C6 · 靠改字段名逃出 R11 正则，已被第二刀在基线里branded 为「假燃尽」**
`r11.json` 的 `guardrails-symbol-reference:this.audit` 条目 `change` 字段写着：「符号串仍为 `this.audit`（改名成 `this.auditRecorder` 会让 `\b` 锚定正则瞬间归零＝假燃尽，故对账口径钉在符号不变上）」；`comparator.mjs:184-185` 规定实测 0 对上容忍 6 是红，直到同 PR 删条目。
意义：封死最便宜的逃生口。若新所有者注入成 `this.runnerLedger`，R11 测得 0、闸门红，而**读起来像燃尽完成**（guardrails 仍 5 次点名协作者）。design 必须显式裁定，包括 `r11-dependency-budget.mjs:78-81` 的 `COLLABORATORS[1].symbol` 是否重指。

**C7 · tasks↔guardrails 的 forwardRef 环与 runner 组完全无关**
环的 guardrails→tasks 边是 **transcript** service；tasks→guardrails 边是 `GUARDRAILS_SERVICE_TOKEN`。
证据：`tasks.module.ts:57` `forwardRef(() => GuardrailsModule)`（为 `:80-81` 的 `provide: GUARDRAILS_SERVICE_TOKEN, useExisting: GuardrailsService`）；`guardrails.module.ts:59` `imports: [forwardRef(() => TasksModule)]`，其 tasks 侧唯一需求是 `:11` `import { SessionTranscriptService } from '@/tasks/session-transcript.service'`，再以 `TRANSCRIPT_SERVICE_TOKEN` useExisting 重新 provide
意义：决定性地回答研究问题 ①，并预防一个错误答案：诚实结论是**「零条 forwardRef 边因此消失」**。同时回答 ③——**环要靠 transcript 那一刀（第 5 组）解**，不是 runner、也不是 diagnostics。这是剩余刀次序的强论据。

**C8 · metrics 侧的 r7 计数不会降，只有 guardrails 侧能 9→8，且必须走 `.port.ts`**
metrics 停止从 guardrails 拉 runner 区间后，它**仍**因 `semaphoreProjection()` 而 import guardrails。
证据：活测 `runGate()` → `cross-context-import apps/api/src/metrics/metrics.service.ts:8 imports '@/guardrails/guardrails.service'` 与 `:9 imports '@/task-provisioning-diagnostics/…'`（count 2）；`cross-context-import apps/api/src/guardrails/guardrails.service.ts:109 imports '@/runner-metrics/runner-minutes'` 是该文件 9 条中的 1 条；`metrics.service.ts:73` `projectCapacity(this.guardrails.semaphoreProjection())`、`:74` `deriveRunnerMinutes(this.guardrails.runnerMinuteIntervals(), now)`；闸门提示语："legal forms are a '.port.ts' interface, DI composition, or the shared kernel"
意义：量化真实预算收益——**r7 `guardrails.service.ts` 9→8，`metrics.service.ts` 2→2**。也决定形态：新所有者必须从 guardrails 经 `runner-metrics/*.port.ts` + DI token 抵达，否则跨上下文 finding 只是换了个行号，一分不降。

### 2.3 与既有 spec 的正面冲突

**C9 · `guardrails.service.spec.ts` 有 14 处 `runnerMinutes` 反射断言，而该文件正是 LIVE spec 场景要求「零 diff 行」的三个热点之一**
证据：grep 命中 `:1375,1380,3011,3021,3072,3078,3132,3136,3199,3207,3274,3280,3341,3347`（跨 7 个 test，均经 `service as unknown as { runnerMinutes: … }` 伸手私有字段）；`openspec/specs/guardrails/spec.md:836`（"the three real audit assertion hotspots — … `guardrails.service.spec.ts` (14 audit assertions…) — SHALL pass **unmodified**"）与 `:843-846`（"#### Scenario: The three audit hotspots are unmodified … **THEN** zero of the three files appear in the diff"）
意义：**正面相撞**。任何改名或移除私有 `runnerMinutes` 字段的形态都会强迫编辑一个 diff-frozen 热点文件。两条逃生口：(a) **保留字段名 `runnerMinutes`** 承接注入的所有者——测试零改动，但 R11 停在 5~6；(b) 在本 change 的 spec delta 里修订该场景，论证热点规则的作用域是 *audit* 断言（`:836` 的 "Under this change's scope"），这 14 条是 runner 账务断言。**必须在 design 裁定，不能到 apply 才发现**。

**C10 · guardrails capability spec 用否定式措辞把 runner 调用点钉在原地**
`:697`（"adjacent to that path's existing `runnerMinutes.recordStart(taskId)` call, and SHALL NOT replace or move it"）；`:726`（"The second `runnerMinutes.recordEnd` call site — the admission-runtime teardown in `clearAdmissionRuntime` — is NOT a terminal settlement… **Both `recordEnd` call sites SHALL remain in place and unchanged.**"）
意义：确认预扫标记的 2:1 `recordEnd` 不对称是**受 spec 保护**的；并追加一条预扫没暴露的约束：spec 正文**逐字点名接收者 `runnerMinutes.`**。若接收者变了，design 必须声明「in place and unchanged」管的是**接缝/位置**（保留）还是**字节文本**（变了）——若是后者，必须 MODIFY 该需求。

**C11 · characterization 基线（135 个 `test()` / 6 个 `*.spec.ts` / 8 个 `.test.mjs`）在本树活测准确，且它本身是一条 spec 场景**
逐文件：`guardrails.service.spec.ts` 57、`guardrails-durable-launch-decision.spec.ts` 54、`guardrails-domain-event-publishing.spec.ts` 15、`guardrails-branch-policy.spec.ts` 3、`semaphore-restore.spec.ts` 3、`transfer-progress-throttle.spec.ts` 3 = 135；`ls apps/api/src/guardrails/*.test.mjs | wc -l` → 8。
证据：`openspec/specs/guardrails/spec.md:832`、`:840-841`
意义：新所有者的测试必须落在 `apps/api/src/guardrails/` **之外**（例如 `runner-metrics/`），以逐字节保住 135/8 分布；且**不得把任何既有 guardrails 测试搬到新所有者目录**。

### 2.4 测试与调用点的完整爆炸半径

**C12 · `apps/api/src/metrics/runner-minutes.test.mjs` 是手写 inline 镜像，钉不住行为等价**
它在测试文件里**重新实现**了 `deriveRunnerMinutes` 与 `RunnerMinutesLedger` 而不是 import 真实实现，所以真实实现移动或改变时它不会红。
证据：`runner-minutes.test.mjs:13`（`// ---- inline the pure function + ledger (mirror runner-minutes.ts) ----`）、`:15`、`:26`；对照 `metrics.verify.test.mjs:58` `const { deriveRunnerMinutes } = require(path.join(DIST_RUNNER, 'runner-minutes.js'))` 读的是**真实编译产物**
意义：行为等价**不能**由 `runner-minutes.test.mjs` 兑现——它的 8 个测试会在断言一段不再存在的代码时保持绿（与第二刀在 `delivery-results-surfaced-and-audited.test.mjs` 上记录的失败模式完全相同，见 adjudication.md §2.4）。等价夹具必须是 **`metrics.verify.test.mjs`**（`:338-339` 对 dist 断言 `response.runnerMinutes.minutes === 1`）。spec 场景 "The inline source mirror moves with its subject"（`specs/guardrails/spec.md:857-860`）适用。

**C13 · guardrails 之外有 5 处 stub 了 `runnerMinuteIntervals: () => …` 的假 guardrails，全部必须重指**
`metrics/metrics.verify.test.mjs:468`、`:537`；`metrics/task-resource.test.mjs:137`；`metrics/terminal-diagnostics-metrics.service.spec.ts:71`；加上生产读取方 `metrics.service.ts:74`。
编辑规则：`openspec/specs/guardrails/spec.md:834`（"Outside `apps/api/src/guardrails/`, the only permitted edit to a `*.spec.ts` remains adding or omitting the trailing optional bus argument… except where a test's own subject is changed by this change, in which case it SHALL be rewritten under the same (a)/(b) ledger"）
意义：这是「metrics 直接向新所有者拉取」的**完整爆炸半径**，并指出 `terminal-diagnostics-metrics.service.spec.ts:71` 是唯一需要写 (a)/(b) 留痕条目（含三项必备事实）的编辑。

**C14 · `GuardrailsService` 构造签名被 spec 冻结，且全树有 22 处 `new GuardrailsService(...)`（15 个文件，10 处在 guardrails 目录外）**
证据：`openspec/specs/guardrails/spec.md:670-673`（"#### Scenario: The bus is the trailing constructor parameter"，且"the preceding 10 parameters keep their existing order and types"）；`guardrails.service.ts:606-670`（11 参数，末位 `bus`）、`:660-664` 源码注释（"ELEVENTH and LAST on purpose: nine specs outside this directory construct this service positionally"）；`grep -rn 'new GuardrailsService(' apps/api/src | wc -l` → 22（guardrails×3、public-surface×2、task-admission×2、tasks×6、guardrails.module.ts 等）
意义：排除了随手插一个 runner-ledger 构造参数。可行形态：(a) 在 `bus` **之后**加第 12 个 `@Optional()` 尾参（22 处调用点全部照常编译，但这些上下文里 ledger 为 `undefined`，需要有记录的兜底）——⚠ 这与同一份 spec 的「bus 是尾参」场景**字面冲突**，需 MODIFY；(b) 在 `onModuleInit` 里用 `ModuleRef` 惰性解析，**仓内已有判例**（guardrails 正是这样解析 TasksService 来破同一个环，见 `guardrails.module.ts:62-66` 注释）。

### 2.5 公开面、词表与剩余两组

**C15 · `GET /metrics` 不在任何公开面上——无 /v1 控制器、无 MCP 工具、无 OpenAPI 注册**
证据：`grep -rn 'MetricsService|runnerMinutes|/metrics' apps/api/src/v1/ apps/api/src/mcp/ apps/api/src/openapi/` → 无命中；`metrics.controller.ts:17-23` 是裸 `@Controller()` + `@Get('metrics')`，在全局 APP_GUARD 之后；`ls apps/api/src/v1/` 无 metrics 控制器
意义：兑现 surface-impact.json 自带的复核指令，`publicV1: unchanged` **确认正确**，无需升 `derived`、无需转录 protocolDifferences。文件可原样保留。

**C16 · 词表缺口在活 spec 里逐字确认，而且比预扫报告的更宽**
判据 1 围绕「读返回值并分支」措辞（`openspec/specs/domain-event-bus/spec.md:419`）；判据 2 专门针对 **"the audit write"**（`:420`）；`batch` 档的定义（`:454`）字面上让 transcript 调用**具备**事件迁移资格。活的 transcript 调用点：`guardrails.service.ts:2110-2112` `await this.transcripts.capture(taskId)`，返回值从不读取，唯一要求是**完成先于 stop-only teardown**（文档注释 `:2096-2107`）。
意义：design 必须**要么**把判据 1 扩表述为「依赖返回值**或其完成时序**」，**要么**新增第四条判据（W6 主张后者）；**并且**注意判据 2 的 audit-scoped 措辞对 runner / transcript / diagnostics 三组**字面上都不覆盖**。两处都是 spec 修订，需在 design 显式裁定。

**C17 · diagnostics 组 8 处引用里有一半是注入面 + 透传进 legacy inline-admission 隔离适配器**〔⚠ 见顶部勘误 1：天花板不是 8→2；legacy 存活 8→4、退役后 8→2、8→0 不可达〕
活树行号与预扫完全一致：`:654/:657`（构造参数）、`:731/:732`（作为最后两参传入 `~:700-733` 构造的 inline-admission 适配器）、`:2949/:2950`（`tryBeginProvisioningDiagnostics` 的 gate+recorder 局部）、`:3017/:3018`（`tryResumeProvisioningDiagnostics`）。目标上下文：`docs/refactor/contexts-manifest.json:82-95` 把 `task-provisioning-diagnostics` 划给 `sandbox-provisioning`（注："名字带 task- 但通用语言是开通证据/诊断，归属 provisioning"）；guardrails 已在 `:142` import 其适配器。
意义：回答 range B ② 的 diagnostics 归属——目标上下文**已声明，无需改 manifest**。但 `:731/:732` 把该抽取与 **legacy 隔离区**绑定：搬走观察者的那一刀要么同时动正在退役的 legacy 适配器，要么留下这 2 处引用——**诚实天花板 8→2，除非 legacy 退役先落地**。这同时给 W10 的「8 次一次清零」打了折。

**C18 · guardrails 自阶段 4 目标写下以来是长了不是缩了：基线 3,806，现测 4,131**
证据：`docs/refactor-master-plan.md:147` "验收：guardrails 3,806 → <2,000 行；forwardRef 环归零"；`wc -l` → 4131
意义：研究问题 ③ 的关键背景。与 24 行 runner 足迹、~30 行 diagnostics/transcript 足迹合并算术：**五协作者燃尽路线自身到不了 <2,000**，剩下的 ~2,100 行是**编排体**而非协作者接线。这是用户在决定刀数前必须看到的事实。

### 2.6 闸门操作细节

**C19 · R11 在条目删除后仍会继续测量该协作者，所以部分燃尽（6→5）必须 shrink 条目、绝不删条目，且必须同 commit 落地**
证据：`r11-dependency-budget.mjs:24-29`（"ENDGAME: a collaborator burned to zero has its ENTRY deleted… This gate keeps MEASURING it afterwards"）、`:71-102`（`COLLABORATORS` 声明在闸门里而不在基线里）、`:229-236`（基线条目的 `symbol` 与闸门声明不一致即红）；`comparator.mjs:110`（"a zero-count entry is a stale shell, delete the entry"）、`:184-185`（"shrink count to ${found} in the same PR as the fix"）
意义：验收项「R11 基线同 PR 更新并留痕（shrink-only 双向 fail-closed）」的确切做法：把 `count` 设为 5、刷新 `samples`、把理由写进条目的 `change` 字段（照第二刀的写法）——**不删条目，也不动 `symbol`**，除非 design 已显式裁定改名。

**C20 · 必须逐字节不动的 CI 步骤显示名可枚举，本刀触到的两条是 `Context layout gate (v2, report)` 与 `Dependency budget ratchet (R11)`**
`.github/workflows/ci.yml:355-356` 自带注释（"# gates. Every `name:` above and below is byte-identical to its / # pre-change value."）；`:370-371` → `pnpm test:context-layout-v2`；`:380-381` → `pnpm test:dependency-budget`；`:338-339` `API module layout gate` → `pnpm test:module-layout`；`:115` `public-surface-parity` job；`:238` `typecheck + lint + test` job
意义：兑现「CI check 显示名逐字节不动」约束，并给出复现验收所需闸门的本地命令。

---

## 3. Archive 路线 — 归档判例

### 3.1 工件骨架与编排惯例

**A1 · 第二刀的工件骨架是 8 件套，本刀原样复用**
proposal / design（D# 编号的可执行判据）/ tasks.md（wave 分区 + disjoint 写集注释的 track 化）/ specs/&lt;capability&gt;/spec.md（多能力 delta）/ research-brief.md（W/C/A 三路溯源编号）/ surface-impact.json / verification-report.md（两轮 pass）+ 一份独立侧工件 adjudication.md。
证据：`openspec/changes/archive/2026-08-05-adjudicate-audit-event-migration/`（11 个文件）；其 research-brief.md 章节结构 §1 Web / §2 Codebase / §3 Archive / §4 Implications / §5 必须拍板
意义：直接给出 propose 阶段该产出哪些文件、各自担什么。**range B 的 `research-findings.md` 就是 adjudication.md 的同位工件**；调研工件放 change 目录（不是 `docs/`、更不是源码注释）已有判例。

**A2 · 「真抽一组」的最强结构范本是 `isolate-legacy-admission`：先落 baseline.md，再落 track-3-recut.md 的交付结果表**
baseline.md 记改动前活测（套件 122/122、逐文件覆盖率、关键方法执行次数、耦合集）；track-3-recut.md 记「测量 → 四个候选切法代价表 → 决定 → 交付结果表」（4539→3807 行 −732、port OUT 18 / entry IN 10、测试零改动、覆盖率 83.0%→83.5%）。
证据：`archive/2026-07-29-isolate-legacy-admission-behind-capability-policy/baseline.md`、`track-3-recut.md` §2/§5
意义：range B 要的「实测收益数据」就是这张交付结果表的形状——**行数差、R11 计数差、forwardRef 环受影响面应逐格量在同一张表里**，而不是散在正文。⚠ **baseline 必须在 track 1 之前采**，否则改后无从对比。

**A17 · tasks 编排惯例可直接复用**
文件头注释声明 wave 分区 + 每轨 disjoint 写集 + 修正说明；每条任务带 `requirements[]`/`surfaces[]`/`verify`；不适用的任务勾选后附「不适用（原因）」留痕而**不是删除**；共享写者集中进串行集成轨；verify 发现的缺陷开新 Track（`7. verify-reopened`）而非改历史。
证据：`archive/2026-08-05-…/tasks.md` 头部注释、4.2/4.3 的「不适用」注、track 6 "INTEGRATION TRACK"、track 7；`archive/2026-08-01-add-domain-event-bus/design.md` 风险条「并行 apply 时共享文件互相覆盖」
意义：本刀 range A（源码迁移）与 range B（调研工件）天然是两轨；`guardrails.service.ts` / `metrics.service.ts` / `r11.json` / r11 自测是**共享写者**，按判例收进集成轨。

### 3.2 抽取本身的血泪判例

**A3 · 最贵的教训：耦合集只向内扫导致结论中途翻转、被迫重切**
两个被判「legacy 独占、随块搬走」的字段都有块外读者，另有 3 个状态容器根本没被列出，12 个方法里 5 个有块外调用者。判据随之从「接口最小」改为**「退役日剩余成本最小」**。
证据：`isolate-legacy-admission/baseline.md` §"Correction to task 1.3, found at the start of Track 3"；`track-3-recut.md` §1/§3/§4；`design.md` D4a
意义：本刀抽 runner 账本**必须双向扫**：不仅问 guardrails 调了谁，还要问**谁依赖 `recordStart`/`recordEnd` 的时序与 `intervals()` 的返回**（metrics 只是已知的一个；完整清单见 C13）。只向内扫的抽取范围在这个仓里已经翻过一次车。

**A4 · 两处只有跑起来才暴露、静态分析看不出的耦合**
①**日志上下文是被断言的行为**——抽出单元自建 Logger 会换 context 直接打红，必须通过 port **延迟读取**编排器的 logger 字段（测试在构造后替换该字段，捕获式注入同样失效）；②有测试**扫源码文本**把「两条管线在同一个文件里」写死（`sandbox-host-harness-wiring.test.mjs`）。
证据：`isolate-legacy-admission/track-3-recut.md` §5 两条脚注
意义：新所有者若自建 Logger 或改变 guardrails 文件构成，会撞上同两类陷阱。**应在 tasks 里预置这两条检查**而不是等红了再查。

**A5 · `RunnerMinutesLedger` 的类已经不在 guardrails 里**（与 C2/W1 三路互证）
它在 `apps/api/src/runner-metrics/runner-minutes.ts`，`runner-metrics` 已是 manifest 里 platform-ops 的既有目录；留在 guardrails 的只是实例（`:593`）与读取面（`:3880`）。
证据：`apps/api/src/runner-metrics/{runner-minutes.ts,metrics-projection.ts}`；`contexts-manifest.json` `contexts.platform-ops.directories`；`guardrails.service.ts:108/:112` import 自 `@/runner-metrics/*`
意义：proposal 写的「归属由研究定，候选 platform-ops 的 runner-metrics」**树上已答一半**：大概率不需要新建顶层目录，「新目录不同 commit 进 manifest → layout-v2 exit 1」很可能不触发；真正的工作是**状态所有权 + 跨 context 的调用形态**。

**A11 · 抽取后留下的无调用点转发器/死代码是 opsx-verify 的历史抓手**
`add-repo-content-store` 的 `remove()`、`detach-workspace-clone` 的 parking 都被抓过；第二刀因此专门给「私有 helper 是否变死代码」写了任务与 scenario。
证据：`archive/2026-08-05-…/research-brief.md:404`；`tasks.md 4.4`；`specs/guardrails/spec.md` "No private helper is orphaned" scenario
意义：本刀「metrics 必须直连、不得再经 guardrails 中转」正好对应——`runnerMinuteIntervals()` 若留作空转发器就是 verify 会抓的死代码。**应写成 scenario 而不只是散文约束**（与 W2 同指）。

### 3.3 闸门与基线的操作判例

**A6 · 跨 context 调用只有三种合法形态，且文件命名先于第一行 import 决定闸门结果**
目标以 `.port.ts` 结尾 / 导入方是 DI 组合文件 / 目标是 shared kernel；裸 `.ts` 会被判 `unclassified-file` → r7 新键 → comparator 直接红。`runner-metrics` 现有两个裸 `.ts` 已作为 tolerated 条目躺在 `r7.json` 里。
证据：`archive/2026-08-01-add-domain-event-bus/design.md` D13/C10/C11；`archive/2026-08-05-…/design.md` D10；`scripts/ratchets/r7.json`
意义：guardrails（task-execution）调 runner-metrics（platform-ops）的新所有者**必须走 `.port.ts`**，新文件必须叫 `*.service.ts` / `*.port.ts`。**反向陷阱**：若本刀改名或删掉那两个裸 `.ts`，两条 r7 tolerated 条目立刻变陈旧 → shrink-only 双向 fail-closed 判红，**必须同 PR 删条目**。

**A7 · `metrics→guardrails` 的源码级耦合已在 r7 里被登记为待燃尽条目**
`cross-context-import:apps/api/src/metrics/metrics.service.ts` count=2，samples 第一条正是 `:8 imports '@/guardrails/guardrails.service'`，`change` 字段写着「阶段 4–6 燃尽（事件订阅 + 对方 `*.port.ts` 显式导出 + 阶段 6 归拢）」。
证据：`scripts/ratchets/r7.json`；`metrics.service.ts:74`；`metrics/metrics.module.ts` 仍 imports `GuardrailsModule`
意义：这是 range B ① 唯一可以逐字节量出来的「耦合边消失」证据的**候选**——但 **C8 用活测把它否掉了**：metrics 仍因 `semaphoreProjection()` import guardrails，该条目本期 **2→2 不动**。另注：`metrics.module.ts` 的模块级 `GuardrailsModule` 依赖是另一条边（r7 不计），**只降源码边不降模块边**要在调研里说清。

**A8 · `r11.json` 的 `this.runnerMinutes` samples 已过时一代**
记的是 1566/2038/2623/2949/2971/3555，活树是 1824/2319/2917/3264/3286/3880；与第二刀发现 `this.audit` samples 过时两代同一病灶。comparator 只比 `count`，samples 是文档，第二刀的处置是**无条件刷新**。
证据：`r11.json` vs `grep -n runnerMinutes apps/api/src/guardrails/guardrails.service.ts`；`archive/2026-08-05-…/tasks.md 5.2` 与 `design.md` D8
意义：本刀必须**无条件刷新** samples（哪怕 count 不变），并按 D8 在 `change` 字段记「差值精确等于迁走的引用数 + 符号串不变」的**反伪造对账口径**。

**A9 · 若燃到 0，纪律与第二刀相反：归零要删条目而不是写 0**
comparator 明写 "count must be a positive integer — a zero-count entry is a stale shell, delete the entry"；第二刀是**降数不删条目**，并特意在 brief 里提醒实现者别误用归零纪律。本刀**可能是第一个真正撞上归零分支的刀**。
证据：`comparator.mjs:40/:110/:184`；`archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/specs/ratchet-baselines/spec.md`；`archive/2026-08-05-…/research-brief.md:279` 与 `:405`
意义：tasks 必须**显式二分**（燃到 N>0 → 改 count；燃到 0 → 删条目），否则实现者按第二刀的「不删条目」照抄就红。⚠ 按 C5，本刀实际落在 N>0 分支（6→5），归零分支**不触发**——但二分仍要写进 tasks，因为它同时是给第 4/5 刀的模板。

**A10 · R11 还有第二处硬编码计数会同步炸，且判例把它指派给集成轨**
`scripts/ratchets/r11-dependency-budget.test.mjs` 断言活树 re-count 的完整映射（含 `this.runnerMinutes: 6`），并另断言 `COLLABORATORS.length === 6` 且基线键集等于 COLLABORATORS 键集。第二刀把这处修复**指派给集成轨**（6.2），刻意不让改 `r11.json` 的那条轨去动它，以保持单写者。
证据：`r11-dependency-budget.test.mjs:66-95`；`archive/2026-08-05-…/tasks.md` track 5 头部注释与 6.2
意义：改动 `this.runnerMinutes` 计数需要**同一 commit 改三处**：`r11.json`、`r11-dependency-budget.mjs` 的 COLLABORATORS 声明（若改 symbol）、该自测；并按判例把修复放**集成轨**，别放进写 `r11.json` 的并行轨。

**A12 · sidecar 的 unchanged×4 只在完全不碰 `packages/contracts/src/**` 时成立，且声明 unchanged 也必须真跑对抗脚本**
分类器映射表里只有 contracts 一条能映射到四公开面，`apps/api/src/**`、`scripts/ratchets/*.json` 全部落 internalOnly；`converge-contracts` 有 NOT-ARCHIVABLE 判例。
证据：`scripts/public-surface-adversarial.mjs:45-53` `CLASSIFIER_SURFACE_MAP`；`archive/2026-08-05-…/research-brief.md:335/:431`；`archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/tasks.md 8.14`
意义：预答本刀 sidecar 复核项——`runnerMinutes` 的形状确实在 `packages/contracts/src/metrics.ts:605`（`RunnerMinutesSchema`），但**只要不编辑该文件就仍是 unchanged**；且 `/metrics` 是非版本化路由（C15 已活测复证）。**「不碰 contracts」应写成本 change 的硬约束**。

### 3.4 行为等价、测试与词表

**A13 · 第二刀的 guardrails MODIFIED 需求已经把本刀的准入条件写死**
"An existing synchronous collaborator call (audit, **runner-minutes accounting**, transcripts, provisioning diagnostics, metrics projection) SHALL be removed only when the change removing it proves, **with an executable test**, that the same recorded semantics are still produced by another declared owner"，并配 scenario "A removed call's rows are still produced"。
证据：`archive/2026-08-05-adjudicate-audit-event-migration/specs/guardrails/spec.md:76` 与 `:95-98`
意义：本刀的行为等价**不能只靠散文**「metrics 派生结果逐字节不变」，必须落一条**可执行证明**；第二刀的同位物是 `apps/api/src/task-admission/provisioning-stage-ownership.spec.ts`——**落在新所有者旁边而非 guardrails 目录**。

**A14 · guardrails characterization 基线是 spec 级钉死的，且要求「在本 change 自己的树上活测，不得抄」**
135 `test()` / 6 个 `*.spec.ts` / 8 个 `.test.mjs`，三个 audit 热点必须零改动；往 `apps/api/src/guardrails/` 加测试文件即自伤基线，所以第二刀把证明 spec 放进 `task-admission/`。verify pass 2 实跑 dist 得 137 pass，与 src 的 135 `test()` **不是一个口径**。
证据：`archive/2026-08-05-…/specs/guardrails/spec.md:112-127`；`design.md` D6；`verification-report.md`
意义：本刀基线必须**在本树重测并写进 spec**（C11 已测得 135/8 仍准），新增测试放新所有者目录，且要**提前判定哪些测试钉死了「账本在 guardrails 里」这个实现事实**（C9/W18 已给出清单）。

**A15 · 改测试的合法通道是 assertion-rewrite ledger，且本刀会走得比 D5 判例更远，必须显式超越**
第二刀在 adjudication.md §3 留了空表 + 五列模板（(a) 实现细节 / (b) 真实需求、原断言钉的顺序、为何不再成立、替代断言钉的不变量），并写明 "A rewrite with no entry here is a re-baseline, not a rewrite"；而 `isolate-legacy-admission` 的 D5 判例是**「测试必须改就是改动错了」**，第二刀 proposal 第 36 条明确要求任何走得更远的刀必须显式超越并说明理由，否则 verify 判 re-baseline。
证据：`archive/2026-08-05-…/adjudication.md` §3；`specs/guardrails/spec.md` "Every rewritten assertion carries a classified ledger entry"；`isolate-legacy-admission/design.md` D5；`archive/2026-08-05-…/proposal.md` 第 36 条
意义：本刀预期有非零 ledger 条目（钉死账本位置的测试），模板直接抄；但必须在 design 显式写出**「为什么本刀允许改这几条而不构成 re-baseline」**。⚠ 若采纳 C9 逃生口 (a)（保留字段名），ledger 可能为**零条**——这是该方案被低估的一项收益。

**A16 · 词表缺口的处置指引与唯一定义处**
第二刀 §5.3 要求第 3–5 刀**要么扩判据 1 的表述、要么补第四条判据**；三条判据与两档持久性的规范定义「恰好一个文件定义」，定义处是 `openspec/specs/domain-event-bus/spec.md`，`apps/api/src/domain-events/README.md:49` 只放指针，verify 用 repo-wide grep 证过唯一性。
证据：`archive/2026-08-05-…/adjudication.md` §5.3/§5.4；`design.md` D3；`verification-report.md` 第 2 项 "Declared once"
意义：本刀若触及该表述，改的是 `openspec/specs/domain-event-bus/spec.md` **那一处**，README 保持指针形态；且这属 spec 修订，需在 design 显式裁定（proposal 已要求）。W6 主张**新增第四条**而非扩写。

**A18 · 裁定/调研结论绝不能写进 `guardrails.service.ts` 的注释**
`guardrails-domain-event-publishing.spec.ts` 用全文件正则对带引号的事件名做精确出现次数断言，注释里出现事件名即打红一条无关测试。第二刀因此把它写成 design D2 并留给后续刀继承。
证据：`archive/2026-08-05-…/design.md` D2；`adjudication.md` 头部第三段；`tasks.md 4.5`
意义：range B 的调研结论只能落 change 目录文件；迁移时在 guardrails 留的任何说明性注释也要过一遍这条正则面检查。

**A19 · 活树行号与记录基线不一致，需在 propose 阶段复测（已复测，见 C4/C5/C7）**
`guardrails.service.ts` 现 4,131 行；`this.runnerMinutes` 6 处为 `:593`(字段) / `:1824`/`:2917`/`:3286`(recordStart) / `:2319`/`:3264`(recordEnd) / `:3880`(intervals)；tasks↔guardrails 的 forwardRef 环只有两条边（`tasks.module.ts:57` 与 `guardrails.module.ts:59`），**与 runner 账本无关**。
意义：range B ① 应据此**如实记「零条消失，解环要靠哪几组」**，避免把收益写虚——第二刀的价值锚在规则不在数字，本刀继承同一诚实纪律。

---

## 4. Implications for the proposal

按本 change 的六个设计接缝组织。每条给出结论 + 溯源编号 + 需要在 design 里写死的形态。

### (A) 归属与落地形态 —— 已可定稿

1. **归属选 platform-ops / `apps/api/src/runner-metrics/`**（W3/W4/W20/C2/A5）。理由是可量化的：该选择让 metrics 的跨上下文违规读边**消失**、只新增一条写边；选 task-execution 则读边违规仍在、还多一条写边，且要新建目录声明。
2. **不新建目录**，因此「新目录必须同 commit 进 manifest，否则 layout-v2 exit 1」这条风险**本刀不触发**（W4/C2/A5）。该风险留给后两刀。
3. **落地形态是 `runner-metrics/runner-minutes-ledger.port.ts` + DI token**，照抄第一刀 `audit/audit-recorder.port.ts` 的 recorder 模板（W3/W4/C8/A6）。guardrails **不得** import 具体 service——否则 r7 的 `cross-context-import` finding 只换行号、一分不降。
4. **新文件命名必须受分类**（`.port.ts` / `.service.ts` / `.module.ts`），裸 `.ts` 会新增 `unclassified-file` 键、r7 only-down 直接红（C3/A6）。若需要 DI home，新建 `runner-metrics/runner-minutes.module.ts`（composition，安全）。
5. **反向陷阱**：不要改名或删除 `runner-metrics/` 现有两个裸 `.ts`——它们的 r7 tolerated 条目会变陈旧而判红，除非同 PR 删条目（A6）。
6. **新所有者对外只暴露一个读方法**（`intervals()` 等价物），不整体 re-export `RunnerMinutesLedger`；接口语汇限定在 `RunningInterval` / `taskId`，不得引入 admission/fence 等 task-execution 词汇（W13/W20）。
7. **metrics 的直连形态**：默认 import port + DI token；若某方向又触发跨上下文规则，备选是让新所有者注册 collect/read 回调由 metrics 组装（W12）——**任何一种都不得再经 guardrails 中转**。
8. **本刀在 Fowler 目录里的名字是 Move Field + Remove Middle Man**，design 直接这样命名（W1/W2）。

### (B) 字段名 / R11 口径 / 热点零改动 —— 这是同一个决定（**最关键的一处拍板**）

三条约束互相咬合：

| 约束 | 出处 | 内容 |
|---|---|---|
| 热点零 diff | C9/W18 | `guardrails.service.spec.ts` 被 spec 场景要求 zero diff lines，却持有 14 处 `runnerMinutes` 反射断言 |
| 「in place and unchanged」 | C10 | spec 正文逐字点名接收者 `runnerMinutes.`，并要求两处 `recordEnd` 保持不变 |
| 假燃尽禁令 | C6/A8 | 改符号名让 `\b` 正则归零已被第二刀 branded 为假燃尽 |

**综合结论**：把 guardrails 的字段名**保留为 `runnerMinutes`**、类型换成注入的 port，**一个决定同时化解三处**——热点文件零 diff（ledger 可能为零条，A15）、spec 的「unchanged」字面成立、假燃尽不触发。**代价是 R11 只能 6→5**。

因此：
1. **R11 目标写死 6→5，不写「燃尽」**（C5/W14）。真正消失的只有 `:3880` 的 `intervals()`；5 处写引用在「guardrails 仍调协作者」的任何形态下必然存活。
2. **`count: 5` + 刷新 samples + `change` 字段写反伪造对账**（「差值精确等于摘掉的 1 处读引用（`:3880`）；符号串未变」），**不删条目、不动 `symbol`**（C19/A8/A9）。
3. **tasks 里仍要写「归零删条目 vs 降数改 count」的显式二分**（A9）——本刀落在后者，但这是给第 4/5 刀的模板。
4. **同 commit 改 `r11-dependency-budget.test.mjs` 的硬编码映射，且放集成轨**（A10）。若最终裁定改 symbol，还要同步 `r11-dependency-budget.mjs:78-81` 的 COLLABORATORS 声明。
5. **说明双向 fail-closed 是有意选择**（W14）：生态工具自动重生成基线，本仓不是；第一个撞上「我修好了 CI 反而红了」的人不该去「修」comparator。
6. 若用户偏好追求更低的 R11 数字，唯一诚实路径是**让 guardrails 完全不再点名协作者**（观察者/装饰器形态），那已超出「最小验证刀」范围——见 §5 Q1。

### (C) guardrails 如何拿到新所有者 —— 构造签名被冻结

1. **不能随手加构造参数**：`GuardrailsService` 有 22 处 `new GuardrailsService(...)`（15 文件，10 处在 guardrails 目录外），且 spec 场景要求 `bus` 是尾参、"the preceding 10 parameters keep their existing order and types"（C14）。
2. **候选 (a)**：在 `bus` 之后加第 12 个 `@Optional()` 尾参。22 处调用点照常编译，但那些上下文里 ledger 为 `undefined`，需要有记录的兜底；⚠ **它与「bus 是尾参」场景字面冲突，必须 MODIFY 该需求**（C14 自身两半的张力，design 必须正面处理）。
3. **候选 (b)**：`onModuleInit` 里用 `ModuleRef` 惰性解析。**仓内已有判例**——guardrails 正是这样解析 TasksService 来破同一个环（`guardrails.module.ts:62-66`）。不动构造签名 = 不碰 22 个调用点、不碰冻结场景。**倾向 (b)**，但需 design 拍板并说明 `undefined` 窗口的处置。
4. 无论哪种，**字段名保持 `runnerMinutes`**（见 (B)）。

### (D) 收益测量与 range B 的产出形态

1. **baseline.md 必须在 track 1 之前采**（A2），并照 `isolate-legacy-admission` 的**交付结果表**逐格量：行数差、R11 计数差、r7 计数差、forwardRef 环受影响面、测试改动条数、覆盖率。
2. **已可预填的实数**（全部本树活测）：
   - guardrails 行数 **4,131**；最大可摘 **24 行（0.58%）**，「仍调用」形态净减 **~12 行**（C4）
   - R11 `this.runnerMinutes` **6 → 5**（C5）
   - r7 `cross-context-import`：`guardrails.service.ts` **9 → 8**；`metrics.service.ts` **2 → 2 不动**（C8，推翻了 A7 的乐观预期）
   - forwardRef 环：**0 条边消失**（C7/A19）
3. **forwardRef 结论是确定的，不需要工具证明**：环的两条边分别是 transcript（guardrails→tasks）与 `GUARDRAILS_SERVICE_TOKEN`（tasks→guardrails），runner 一条都不贡献（C7）。W15 的 dependency-cruiser 前后 diff 可作**佐证**（能查间接环，madge 不能），但**不应作为阻塞前置**。
4. **必须双向扫**：不仅问 guardrails 调了谁，还问谁依赖 `recordStart`/`recordEnd` 时序与 `intervals()` 返回（A3）。完整清单已由 C13 给出：`metrics.service.ts:74` + 4 处测试 stub。
5. **range B 的 `research-findings.md` 产出格式用 Mikado 的前置条件图**（W16）：把剩余两组画成「谁必须先于谁」，而不是只给一个刀数列表。
6. **算术要摆在用户面前**（C4/C18）：目标 <2,000 行、基线 3,806、现测 4,131（+325），需甩 ~2,131 行；runner 24 行、diagnostics/transcript 各约 30 行 —— **五协作者燃尽路线自身到不了**，剩下 ~2,100 行是编排体。这是 §5 Q7 的输入。

### (E) 剩余两组的归属与预估（range B ②）

**diagnostics 组（recorder 4 + WriteGate 4）**
1. **目标上下文 `sandbox-provisioning` / `task-provisioning-diagnostics` 已在 manifest 声明，无需改 manifest**（C17）。
2. **首选形态是「反转 gate」或 decorator**，而非抽 application service（W9/W10）：让调用方对开关一无所知（关闭时注入 no-op recorder），可一次性消灭 WriteGate 这个 collaborator。
3. **归属主判据是「open 与 settle 能否被同一 owner 完整包住」**（W11）：活句柄（Activity/Span、Unit of Work 同形）跨对象半开就无人负责；装饰器方案能包住，因此该组的阻塞点可随形态消解。
4. ⚠ **〔已勘误，见顶部勘误 1〕原写「诚实天花板是 8→2 而非 8→0」**：`:731/:732` 是透传进 legacy inline-admission 隔离适配器的两处引用，**除非 legacy 退役先落地**，否则动不了（C17）。W10 的「一次清零」估算据此下修。
5. **固定开销**：`v1-task-provisioning-diagnostics.controller.ts` 存在，该刀的 surface-impact 极可能要升 `derived` 并转录 protocolDifferences（W19）。

**transcript 组（`this.transcripts` 2）**
6. **它是 forwardRef 环的 guardrails→tasks 边**——**解环靠这一刀**（C7/A19）。这是剩余刀次序的最强论据：想兑现「forwardRef 环归零」就必须做 transcript 组。
7. **抽取不会自然消解时序阻塞**（W7）：NestJS 同 module 内 provider 生命周期钩子无拓扑顺序保证（issue #14773 仍开），与本仓 `onApplicationBootstrap` 跨 provider 无序导致活任务误判 failed 的生产事故同构。happens-before 仍须由 teardown 路径上的**显式 await** 承担。
8. **「先取数据再销毁」是通用危险动作**（W8）。验收用**顺序断言**（fake 记录调用序列，断言 capture 完成早于 teardown 调用），**不用超时/sleep**。
9. **固定开销**：`v1-transcript.controller.ts` 存在，同样可能要升 `derived`（W19）。

**词表（两组共用）**
10. **建议新增第四条判据**而非扩写判据 1（W6/C16/A16）：「调用方依赖协作者的**完成先于**某个后续的破坏性步骤（happens-before / flush-before-destroy）」。机理与判据 1（读返回值分支）不同，混写会让后续判定含糊。OTel 的 "Shutdown MUST include the effects of ForceFlush" 是现成措辞蓝本。
11. **另注判据 2 是 audit-scoped 的**（"no published payload carries a field **the audit write** consumes"），字面上不覆盖 runner/transcript/diagnostics 三组；`batch` 档的定义甚至让 transcript **具备**事件迁移资格（C16）。这两处都要在 design 显式裁定。
12. **改的是 `openspec/specs/domain-event-bus/spec.md` 那唯一一处**，`domain-events/README.md:49` 保持指针形态（A16）。
13. **拒绝理由可用通用语言**：commands in disguise / passive-aggressive event（W5）。

### (F) 测试、行为等价与 spec delta

1. **等价夹具必须是 `metrics/metrics.verify.test.mjs`（读 dist 真实实现），不是 `metrics/runner-minutes.test.mjs`**（C12）——后者是手写 inline 镜像，实现移走了它照样绿。这与第二刀在 `delivery-results-surfaced-and-audited.test.mjs` 上记录的失败模式完全相同。
2. **迁移之前先写 characterization 测试**（W17/A13）：固定 intervals 夹具 + 冻结 `now`，钉住 `deriveRunnerMinutes` 的**完整输出对象**；迁移后同测试**不改一字**通过。这同时兑现第二刀 MODIFIED 需求要求的「可执行证明」。
3. **新测试落在新所有者旁边（`runner-metrics/`），绝不落 `apps/api/src/guardrails/`**（C11/A14），否则自伤 135/8 characterization 基线；也不得把既有 guardrails 测试搬走。
4. **基线数字在本树重测后写进 spec**（A14）：C11 已活测 135 `test()` / 6 `*.spec.ts` / 8 `.test.mjs`，与记录一致，可直接引用；注意 src 的 `test()` 数与 verify 跑 dist 的 pass 数**不是一个口径**。
5. **guardrails 外必改的 5 处**（C13）：`metrics.service.ts:74`（生产读取方）+ `metrics.verify.test.mjs:468/:537` + `task-resource.test.mjs:137` + `terminal-diagnostics-metrics.service.spec.ts:71`。最后一条是 `*.spec.ts`，按 spec.md:834 需要一条 (a)/(b) 分类留痕条目。
6. **`runnerMinuteIntervals()` 必须删，不能留空转发器**（W2/A11）——写成 scenario（"No private helper is orphaned" 的同位物），不只写散文。
7. **assertion-rewrite ledger 模板照抄第二刀 adjudication.md §3 的五列**（A15）；若采纳 (B) 的保名方案，ledger 可能为零条，此时也要显式记「零条」而非省略。若确有改写，必须显式超越 D5 判例并逐条说明理由，否则 verify 判 re-baseline。
8. **spec delta 要处理的既有需求**：`specs/guardrails/spec.md:697/:726`（"SHALL NOT replace or move it" / "SHALL remain in place and unchanged"）——design 必须声明这管的是**接缝/位置**还是**字节文本**（C10）；`:836/:843-846`（三热点零 diff）——若改字段名则必须 MODIFY（C9）；`:670-673`（bus 尾参）——若走 (C) 候选 (a) 则必须 MODIFY（C14）。MODIFIED 块按判例**整段重述需求全文**。
9. **不得在 `guardrails.service.ts` 注释里写调研结论**，也不得出现带引号的事件名（A18）。
10. **预置两条运行时耦合探针任务**（A4）：新所有者**不得自建 Logger**（logger context 是被断言的行为，须经 port 延迟读取编排器的 logger 字段）；并跑一遍扫源码文本的结构断言（`sandbox-host-harness-wiring.test.mjs` 一类）确认文件构成变化没打红。

### (G) 公开面 / sidecar / 流程

1. **`publicV1: unchanged` 确认成立**（C15/W19）：`GET /metrics` 无 /v1 控制器、无 MCP 工具、无 OpenAPI 注册。surface-impact.json 自带的复核指令**已兑现，文件可原样保留**。
2. **「不碰 `packages/contracts/src/**`」是本 change 的硬约束**（A12）：`RunnerMinutesSchema` 在 `contracts/src/metrics.ts:605`，分类器映射表里只有 contracts 能映射到四公开面。碰了就要升 `derived` + 转录 protocolDifferences。
3. **声明 unchanged 也必须真跑 `public-surface-adversarial`**（A12，`converge-contracts` 有 NOT-ARCHIVABLE 判例）。当前五路在 `sidecar` 就红，因为缺 `tasks.md`（C1）——propose 补齐后重跑。
4. **当前工作在 `main` 上，提交前必须先开分支**（C1）。
5. **CI 步骤显示名逐字节不动**，本刀触到的两条是 `Context layout gate (v2, report)`（`pnpm test:context-layout-v2`）与 `Dependency budget ratchet (R11)`（`pnpm test:dependency-budget`）（C20）。
6. **工件骨架照抄第二刀 8 件套**（A1），range B 的 `research-findings.md` 对应 adjudication.md 的位置；tasks 用 wave 分区 + disjoint 写集注释，共享写者（`guardrails.service.ts` / `metrics.service.ts` / `r11.json` / r11 自测）收进**串行集成轨**（A17/A10）；verify 发现的缺陷开 Track 7 而非改历史。

---

## 5. 必须拍板 / 开放问题

- **Q1（决定 (B) 与整刀叙事）— R11 目标口径定 6→5，还是把本刀升级成「guardrails 完全不再点名 runner 协作者」？**（C5/C6/C9/C10/W2）
  - **(a) 6→5（推荐，与「最小验证刀」定位一致）**：guardrails 保留字段名 `runnerMinutes`、类型换成注入 port，5 处写引用留存，只摘 `intervals()`。热点文件零 diff、spec 「unchanged」字面成立、假燃尽不触发、assertion ledger 可能为零条。验收文案需从「燃尽」改成「首次下降」。
  - **(b) 追求更低数字**：把写点也反转（观察者/装饰器），guardrails 完全不点名协作者 → 可达 0，但要删 R11 条目（A9 归零纪律）、要动 5 处受 spec 保护的调用点（C10）、要改 14 处热点断言（C9）——**已超出「最小验证」范围**，且与本刀「量出真实收益」的目的相悖。
- **Q2（决定 (C)）— guardrails 怎么拿到新所有者？**（C14）
  (a) `bus` 之后加第 12 个 `@Optional()` 尾参 → 22 个调用点不动，但**与「bus 是尾参」spec 场景字面冲突，必须 MODIFY**，且 10 处目录外构造点里 ledger 为 `undefined` 需兜底；(b) `onModuleInit` + `ModuleRef` 惰性解析 → 不动构造签名、有仓内判例（`guardrails.module.ts:62-66`），但引入 `undefined` 窗口需说明。**倾向 (b)，需拍板。**
- **Q3（决定 (F) 8 与 spec delta 体量）— 既有 spec 里「in place and unchanged」/「SHALL NOT replace or move it」管的是接缝还是字节？**（C10）
  若管接缝（推荐）：接收者从 `this.runnerMinutes`（本地 ledger）变为 `this.runnerMinutes`（注入 port）不算违反，无需 MODIFY。若管字节：必须 MODIFY 两条需求。这条与 Q1 的答案联动。
- **Q4（决定 (E) 10–12）— 词表：新增第四条判据，还是扩写判据 1？本刀顺手改还是留给第 5 刀？**（W6/C16/A16）
  推荐**新增第四条**（happens-before / flush-before-destroy），机理与判据 1 不同。附带子问题：判据 2 的 audit-scoped 措辞是否同期修正（它字面上不覆盖本期三组）。改动落 `openspec/specs/domain-event-bus/spec.md` 唯一定义处。
- **Q5（决定 range B 的建议强度）— diagnostics 组是否把「反转 gate / decorator」写成首选形态，以及是否建议 legacy 退役先行？**（W9/W10/W11/C17）
  〔⚠ 见顶部勘误 2〕原写「反转 gate 能让 WriteGate 4→0」，但 `:731/:732` 的 legacy 透传使总天花板停在 8→2；若建议 legacy 退役先行，剩余刀次序就变成「legacy 退役 → diagnostics → transcript」。
- **Q6（决定剩余刀的成本口径）— 后两组的 surface-impact 固定开销是否写进 range B 的预估表？**（W19）
  `v1-task-provisioning-diagnostics.controller.ts` 与 `v1-transcript.controller.ts` 都存在，两刀极可能要升 `derived` + 转录 protocolDifferences（阶段 2 教训）。这是每刀一笔不可忽略的固定成本。
- **Q7（决定阶段 4 的验收本身）— 「guardrails <2,000 行」这个目标怎么办？**〔已拍板：改结构判据；见顶部勘误 3〕（C4/C18/W16）
  实数：目标基线 3,806、现测 4,131（+325）、需甩 ~2,131 行；runner 24 行、diagnostics/transcript 各约 30 行。**五协作者燃尽路线自身到不了**。候选：(a) 承认协作者燃尽只解决接线、另起一刀专拆编排体；(b) 修订 `docs/refactor-master-plan.md:147` 的数字目标，把验收改成「协作者引用归零 + forwardRef 环归零」这类结构判据；(c) 维持数字目标但把剩余刀数按 ~2,100 行编排体重新估。**这是本刀作为「最小验证」最该带给用户的结论，建议在 range B 的前置条件图里正面呈现。**
