# Proposal: retire-legacy-inline-admission

> 阶段 4 第五刀，range B 前置条件图的根节点。
> 上一刀的 range B 是本刀的输入，但**它对本刀的两条关键预测在本树复测后被推翻**，见 §预测重测。
> 本刀的四条产品决策由用户于 2026-08-06 拍板，逐条记在 §决策 —— 它们不是测量结论，工件里不得混同。

## Why

`apps/api/src/inline-admission/` 是同步、在请求内完成的准入管线，阶段 4 早已判定它退役。真正的问题是**它今天不是遗留路径，是生产主路**：

- 两份 env 样板都把 durable 开关设为 `false` —— 默认部署 **100% 走 legacy**
- attestation 只在**进程构造时读一次**，全树**零续期代码**，runbook 自己的例子是 15 分钟且注明「刻意很短」、没有续期步骤

所以照 runbook 完成 cutover 的部署，attestation 到期后**每个任务都静默回落 legacy**。退役它首先打破的是 happy path，不是坏部署 —— 这是本刀最大的风险来源，不是那 1,340 行代码。

用户据此拍板：**准入无条件走 durable**（不是拒绝），并**已确认生产不再有 legacy 流量**（见 §决策 D4，这是用户提供的前提，不是本仓实测）。

## 决策（用户 2026-08-06 拍板，非测量）

- **D1 —— 能力未证明时无条件走 durable。** attestation 缺失/过期/版本不齐/闸门 provider 缺席，全部解析为 durable，与开闸完全一致。**不存在拒绝路径、不返 503、`AdmissionMode` 联合不加成员** —— mode 分支是被移除而不是被加宽。
- **D2 —— 删除已发布枚举成员 `'legacy'`，并同刀迁移数据。** 枚举在 `packages/contracts/src/task-provisioning-diagnostics.ts:37-39`（`['legacy','durable']`），被诊断响应 `:258`/`:411` 与 `domain-event.ts:159-162` 消费。⚠ **该列是持久化的**（`schema.prisma:517`/`:566`，两张表），且**读取路径用该枚举校验**（`task-provisioning-diagnostics.service.ts:62/:69/:115`、`task-provisioning-diagnostic-observer.adapter.ts:96/:103/:118`）—— 只删枚举会让服务读不了自己的历史行。迁移方式经拍板为**删除** `admission_mode='legacy'` 的历史诊断行，而不是改写成 `'durable'`（改写等于篡改取证记录）。
- **D3 —— 调度 occurrence 碰拒绝的语义：在 D1 之下无对象。** 不存在拒绝，本刀**不写**相关需求。
- **D4 —— 「生产不再有 legacy 流量」是用户提供的前提。** **本仓答不了这个问题**：诊断写闸门 default-closed，查不到 `admission_mode='legacy'` 的行**不等于**没有 legacy 流量。任何工件复述这条前提时必须**逐字归属给用户**，不得写成实测结论。

## 预测重测（上一刀 range B 对本刀的两条预测）

| range B 预测 | 本树实测 | 判定 |
|---|---|---|
| 退役后 diagnostics 地板 8→2 | **8→4，Δ=0** | ❌ **推翻** |
| legacy 退役是 diagnostics 的结构前置 | 仅剩产品判断，无量化支撑 | ❌ **推翻** |

**机理**：`guardrails.service.ts:744-745` 的诊断别名有**两个消费者** —— 喂 legacy 适配器，也喂 durable 诊断属主。退役只带走一个消费者，别名本身活着。SIMULATE-THEN-MEASURE：删掉适配器字面量后跑闸门自己的 `measureSource`，recorder 2 / writeGate 2，**组合仍是 4**。

⚠ 这条假声称**已经在活 spec 里**（`openspec/specs/guardrails/spec.md` 约 `:1291`）和 **r11.json 两条条目**中，是上一刀归档带进去的。**本刀必须订正它** —— 不订正，下一位作者会据此把两条条目按「归零」删掉，而那正是本 epic 已经犯过一次的伪造燃尽。

## What Changes

本刀是**四重身份**，风险来源不同，工件里分开表述：

1. **退役（代码删除）** —— 删 `apps/api/src/inline-admission/` 五个文件 **1,585 行**〔口径：`wc -l` 物理行，含 245 行测试；纯生产 1,340 行〕；删编排器侧正向耦合（2 处 import、1 个字段、`:748-803` 的 20 键适配器字面量、11 处调用点）；删反向回调端口（**20 成员 / 59 调用点**，全部在 pipeline.ts 内）；删随之成为死代码的两个私有方法与 legacy 准入链三跳（166 行）。
2. **准入行为变更（D1）** —— mode 分支移除。**准入能力闸门**不引入拒绝：能力未证明时解析为 durable，不返 503，`AdmissionMode` 联合不加成员。
   ⚠ **订正（CI 实测，verify 四轮均未覆盖）**：「`POST /tasks` 仍返 201」这句**无条件写法是错的**。移除 mode 分支的同时也移除了 `if (admissionMode === 'durable-v2')` 这个守卫（`tasks.service.ts` main :1253 → 现 :1179），于是 **durable 准备（含沙箱环境解析）在创建时变成无条件**。沙箱 provider 不可解析时，创建从「201 接受、延迟失败」变为 **400 `sandbox_environment_resource_unsupported`**——这是真实的可观察行为变更，由 `boot-smoke` 与 `scheduled tasks browser e2e` 两个 CI job 在 PR #207 上实证（`AIO_SANDBOX_IMAGE` 未设 → `available:false` → 解析抛错 → 包成 400）。语义上这与本刀的 fail-closed 取向一致（早失败、可见失败），但**它必须被声明而不是被说成「不变」**。见 repo-and-task-management 的「Acceptance resolves the sandbox environment before it writes」需求。
3. **契约收窄（D2）** —— 删 `'legacy'` 枚举成员，同时收窄诊断响应与领域事件两处已发布枚举。**必碰 `packages/contracts/`** → surface-impact 至少 `derived` 并转录 protocolDifference。
4. **不可逆数据迁移（D2）** —— migration 删除两张表上 `admission_mode='legacy'` 的行。该列是 `String` 而非 DB 枚举，所以这是**数据改写而非 schema 变更，跑完不可逆**。

**ratchet 三种形态必须分列**（混为一谈正是伪造燃尽的成因）：
- **R7 八个条目归零并删除** —— 键以 `apps/api/src/inline-admission/` 路径开头，**文件本身消失**，这是删除路径键条目的**唯一合法理由**。
- **R11 一个条目降数不删** —— `this.runnerMinutes` **5→4**（`:3027` 的 `recordStart` 随 legacy 方法整体消失）。真删除、非改名：被测符号串未变、协作者仍被点名四次。
- **R11 两个条目一动不动** —— diagnostics 两条**仍是 2+2=4**。见上。

## Non-Goals

1. **attestation 续期自动化**（归档列的退役前置 #3）—— 本刀不做。⚠ 后果已量化并接受：续期未修时退役 legacy，意味着部署在 attestation 过期后不再有降级路径。D1 选择无条件 durable 使这一点不致失去准入能力，但混版本部署的行为一致性由此放弃（policy 自己写下的降级理由随之作废）。
2. **Tier2 / Tier3 需求**（条目活着但具名 scenario 无生产者 / 仅代码分支空转）—— 另刀。
3. **反向回调面收窄** —— 实测不存在这条路：20 个反向成员与 10 个正向成员**全部有活调用**，最小出现数是 1 不是 0。
4. **改 harness/工具链** —— 新流程明令领域刀不得碰。
