# 工件 08 — DDD 目标架构设计

阶段 4/5/6 三刀的图纸。§A 上下文详表的机器可读版是 `contexts-manifest.json`。

基调（用户裁定贯穿）：不为 DDD 而 DDD。战术模式只投核心域；支撑/通用域保持
事务脚本；值对象克制（决策 11）；充血按判据（决策 10）。

## §A 上下文详表

见工件 01。7 上下文 = 4 核心（task-execution / sandbox-provisioning /
agent-runtime / delivery）+ 2 支撑（identity-access / interface）+ 1 通用
（platform-ops，豁免战术 DDD）。

## §B 核心域聚合设计（阶段 5 实施）

### B.1 Task 聚合（task-execution）

**现状**：Task 是 Prisma 行类型；状态机不变量散落在 `tasks.service.ts` 的 CAS
代码与 `guardrails.service.ts`（3,806 行内）。
〔**历史基线**：3,806 是评审时点的实测值，本文档的规模判断以它成文，故保留不删；
2026-08-05 活测为 **4,131 行**。行数不是阶段 4 的验收判据，见文末「三刀与本图纸的对应」。〕

**目标**：纯领域对象 `Task`（零 Nest 装饰器、零 Prisma import），收拢的不变量：

1. **状态转换合法性**——合法转换表单一声明（现散在 CAS 调用点各处）；
2. **admission fence 语义**——fenced token 的单调性与 reclaim 条件（现在
   task-admission store 与 worker 各持一半）；
3. **superseded 语义**——何时一个任务被取代、取代后允许的终态集合；
4. **并发闸门交互**——slot 占用与状态的耦合规则（"仅停止补位"等既定拍板）。

CAS 执行（乐观锁 `$queryRaw`）留在 store 层；聚合只回答"这次转换是否合法、
产生哪些事件"。

### B.2 SandboxRun / SandboxEnvironment（sandbox-provisioning）

- `SandboxRun`：归属权与 cleanup ownership fence（现 `sandbox-run-owner.service`
  1,525 行的不变量部分）、readoption 的合法前态。
- `SandboxEnvironment`：状态机 `draft→validating→ready→failed→stale→disabled`
  （contracts 已有词表），"只有 ready 可选"等选择规则已在
  `packages/sandbox-environment` 有纯函数实现——**该包已是准领域模型**，聚合化
  = 收编而非新写。

### B.3 Repo（delivery）与 User（identity-access）

- `Repo`：副本状态（ready/复制中）与任务引用计数的删除保护。
- `User`：allowed 闸、身份链接（IdentityLink）唯一性。仅建仓储不建全套；
  identity 是支撑域。

## §C 领域事件目录 v1（阶段 4 实施）

机制：进程内同步 emitter（决策 5）。payload 用 contracts zod schema 声明
（规则 R12），不落库、零 migration、无跨版本兼容负担。

### 事件表

| 事件 | 发布者 | payload 要点 | 订阅者（五关注点） |
|---|---|---|---|
| TaskAdmitted | admission（worker/inline） | taskId, fencedToken, provider family | audit, metrics, diagnostics |
| SandboxProvisioned | provisioning 编排 | taskId, sandboxRef, environment 快照 | audit, metrics, diagnostics |
| TaskRunStarted | guardrails 残余编排 | taskId, runtimeId | 计费(runnerMinutes.recordStart), metrics |
| TaskSettled | 终态转移点 | taskId, 终态, failure? | audit, 计费(recordEnd), metrics, transcript 收尾, diagnostics |
| TaskSuperseded | tasks | taskId, 取代者 | audit, metrics |

订阅端全部 best-effort（与现状保证等级持平——audit port 自述 BEST-EFFORT、
runnerMinutes 本就是进程内 ledger、diagnostics/transcript 自带持久化）。

### 非事件清单（同等重要）

| 交互 | 为何是调用不是事件 |
|---|---|
| terminal provisioning audit detail | 需返回 durability acknowledgement（admission work 的 reclaim 依赖确认），违反"要回执的是调用"判据 |
| admission work 状态转移 | 聚合自身职责，不外发 |
| provisioning 诊断的 write-gate 路径 | 带背压/确认语义的写通道 |

### cutover 纪律

每个"关注点改订阅"的 change 自带开关（env，默认新路径，逃生口回旧路径），
沿用产品 staged cutover 模式（TASK_ADMISSION_V2_CUTOVER 为模板）；开关在下一
个收口发版验证后的 change 里移除。

## §D 仓储规范（阶段 5 实施）

- **每聚合一个 store**：`TaskStore` / `SandboxRunStore` / `SandboxEnvironmentStore`
  / `RepoStore`（收编现 repo-store）/ `UserStore`。
- **接口模板** = `prisma-task-admission.store.ts`：抽象类 + Prisma 实现 DI 绑定、
  CAS/fenced 写法保留在实现内。
- **事务边界**：application service 开事务并传递；store 不隐式开事务。
- **引入既定不变量**：harden-scheduled-task-dispatch 裁定的调度事务边界与
  lease 语义（该 change 归档后其 spec delta 为准）。
- **跨聚合写禁止**（contexts manifest crossContextRules）：settings 写 repo 表、
  repos 写 task 表、terminal 写 repo 表等现状违规进 R7 ratchet，阶段 5 燃尽。
- Prisma 唯一栖息地 = `*.store.ts`（260 处存量 ratchet 燃尽；5 个 controller
  直查立修）。

## §E 上下文内部分层（layout v2 的生成依据）

```
interface/    controller · gateway · resolver     协议翻译；禁止 Prisma；禁止业务分支
application/  service                             编排、开事务、发事件
domain/       纯对象（聚合、状态机、值函数）        零框架、零 IO
store/        *.store.ts                          Prisma 唯一栖息地
```

**不引入**：use-case 类、CQRS 总线、command/query 对象。controller → service
直调保持。这是刻意的仪式下限（基调声明）。

## §F 充血判据（决策 10，规则登记制 E 节引用）

只有满足以下之一的逻辑进 domain：
1. 同一不变量在 ≥2 处被重复检查（如状态转换合法性——CAS 点与 guardrails 各查一遍）；
2. 不变量的违反曾产生过真实缺陷（有 change/issue 佐证）。

单点使用的校验留在 application service。迁移 PR 必须在描述中标注命中判据的
哪一条——防止"搬家式充血"。

## §G 与 NestJS 的融合

- domain 对象零装饰器、零 DI、零 async（纯函数/纯对象，可在 node --test 直测）；
- Nest 只组装 interface/application/store 三层；
- 事件 emitter 以窄 port 注入（`DomainEventBus` token），domain 不持有 emitter
  ——聚合方法**返回**事件，application 层负责 publish（保持 domain 零 IO）；
- 测试策略：domain 层不变量测试新增（快、无 fake）；application 层沿用现有
  spec（阶段 4 验收的分类处理见主计划）。

## 三刀与本图纸的对应

| 阶段 | 实施本文档 | 验收锚 |
|---|---|---|
| 4 | §C 事件目录 + cutover | 四条结构判据（见下表），**行数只作趋势数据** |
| 5 | §B 聚合 + §D 仓储 + §F 判据 | 状态转换单点声明；R7 Prisma ratchet 趋零 |
| 6 | §A 物理归拢 + §E 转 required | 51→7–10 目录；layout v2 空豁免通过 |

阶段 4 的验收锚在 2026-08-05 由用户拍板替换：原「guardrails <2,000 行；R11 ratchet 归零」
两条**都不成立**——前者按最激进的计数规则也差一千余行，后者与「编排器还活着」互斥
（编排器合法地继续点名它仍在调用的协作者）。替换后每条判据自带闸门与状态：

| # | 判据 | 判定命令 / 闸门 | 状态 |
|---|---|---|---|
| a | 每个 R11 协作者条目停在裁定**地板**（非 0） | `pnpm test:dependency-budget` | 今天即可测 |
| b | 编排器不再自己 `new` 出横切子系统 | 同一闸门，往 `COLLABORATORS` 加类名符号 | 需一次数据改动 |
| c | `guardrails.service.ts` r7 `cross-context-import` 降到裁定值 | `pnpm test:context-layout-v2` | 今天即可测 |
| d | `guardrails.module.ts` 与 `tasks.module.ts` 间 `forwardRef` 归零 | **今天无闸门**：须新增只读这两个文件的窄检查 | 需自带闸门 |

判据 d 特意表述为两个具名文件之间的 forwardRef 数，而不是「无环」——目录级环检测豁免
「只由 `*.module.ts` 组成的环」，而今天这个环整体落在豁免里，写成「无环」等于写一条不会红的判据。
完整测量与推导见 `openspec/changes/extract-runner-minutes-ledger/research-findings.md`。
