# Proposal: collapse-three-collaborator-groups

> 阶段 4 第四刀。上一刀（`extract-runner-minutes-ledger`）的 range B 工件是本刀的输入；
> 本刀**不重做研究**，只把它的预测逐条重测——按新流程的规矩，进入工件的每个数字都带产出它的命令。
> 三条预测里**两条成立、一条被推翻**，见 §预测重测。

## Why

上一刀交付 R11 Δ1、r7 Δ1，却花了 342 agents / 33.4M token / 6.4h，工件 3,263 行换生产源码 200 行。
四个归档 change 的实测显示成本与范围**反相关**（33 需求/31 任务→1 轮零返工；14 需求/73 任务→3 轮 2 返工），
真正的驱动是每刀用**散文任务**为上一刀的失败加防御，任务/需求 1.9→3.3→5.2。

所以本刀同时是两件事：**把三组协作者一次摘完**，以及**当新流程的第一个样本**——
≤2.5 任务/需求的预算、确定性断言取代散文防御、数字必须带命令。目标是拿到同类改动在新旧流程下的对比数据。

三组能一刀做完的实测依据：写集三重交集只有 3 个文件（`guardrails.service.ts`、`scripts/ratchets/r11.json`、
`scripts/ratchets/r11-dependency-budget.test.mjs`），而 `r11-dependency-budget.test.mjs:71-81` 是**一整块**
`assert.deepEqual`、`:85` 是 `COLLABORATORS.length === 6`——拆成三刀就要对同一个常量做三次顺序编辑、
对同一块断言做三次 rebase。合并 = 一次 6→4。

## 预测重测（上一刀 range B 的三条预测）

⚠ **行号全部漂移**：上一刀让 `guardrails.service.ts` 长了 42 行，range B 记的行号（`:654`/`:731`/`:2110`/`:3861` 等）
今天**全部无效**。下表是本树重测，命令 = `measureSource` from `scripts/ratchets/r11-dependency-budget.mjs`。

| 组 | range B 预测 | 本树实测 | 判定 |
|---|---|---|---|
| N2 diagnostics | 8→4（legacy 存活） | **8→4** | ✅ 成立 |
| N4 metrics-projection | 2→0，删条目 | **2→0** | ✅ 成立 |
| N3 transcript | 2→0，删条目 | **2→1** | ❌ **推翻** |

**N3 为什么到不了 0**（与 runner 组 6→0 同一失败模式）：`guardrails.service.ts:2414` 的
`await this.captureTranscript(taskId)` 必须**先于** `:2437` 的 `await sandbox.teardownSandbox(...)` 完成，
这条 happens-before 写在源码注释里（"invoked at BOTH terminal chokepoints BEFORE the stop-only
`teardownSandbox`, while the container is still present … it is **awaited** so the archive write ordering
before the stop holds"）。guardrails 必须保留一个被 await 的同步调用来承担它，
所以 `:2159` 的 `await this.transcripts.capture(taskId);` **不可移除**；能消失的只有 `:2157` 的可选性守卫。

**第二条硬约束（本刀据此不碰构造器）**：删第 8 参 `transcripts` 会波及**19 个构造点、15 个在 `apps/api/src/guardrails/` 之外**，
且名单里有 `guardrails.service.spec.ts:94`——那个被既有 spec 冻结为**零 diff** 的文件。
本刀因此**不动构造签名**，三组的构造参数原样保留（N2 的第 9/10 参本来就被 `:768`/`:769` 的 legacy 透传钉住）。

## What Changes

模拟验证（`measureSource` 跑在模拟源码上，非断言）：删掉 `:108`/`:2157`/`:2159`/`:2996`/`:2997`/`:3064`/`:3065`/`:3908`
八行后，四个计数变为 `recorder=2 gate=2 transcripts=0 proj=0`——注意 transcripts 模拟为 0 是因为模拟同时删了 `:2159`，
而本刀**保留**该行，故真实落点是 **2→1**。

- **N2 diagnostics（8→4）**：把 `tryBeginProvisioningDiagnostics`（`:2993`）与 `tryResumeProvisioningDiagnostics`（`:3061`）
  整体迁进 `task-provisioning-diagnostics` 上下文，经 `*.port.ts` + DI token 暴露。
  写闸门**反转**：关闭态由所有者内部返回 undefined，调用方对开关一无所知——
  两处 `const gate = this.provisioningDiagnosticWriteGate;` 与两处 `const recorder = …` 随方法离开。
  构造参数 `:691`/`:694` **保留**（`:768`/`:769` 仍要把它们透传进 legacy 管线）。
- **N3 transcript（2→1）**：`SessionTranscriptService` 迁出 `apps/api/src/tasks/`，切断
  `guardrails.module.ts` → `TasksModule` 那条 forwardRef 边；guardrails 侧改为注入**非可选**的 port
  （关闭/未装配时是 no-op 实现而不是 `undefined`），`:2157` 的守卫随之消失，`:2159` 的被 await 调用**原样保留**。
- **N4 metrics-projection（2→0，删条目）**：`semaphoreProjection()`（`:3908`）的投影所有权迁进 `runner-metrics`，
  `:108` 的 `import type { SemaphoreProjectionSource }` 随之消失。这是上一刀的直接同位物——上一刀摘 `:109`，本刀摘 `:108`。
- **顺带订正一处我上一刀留下的陈旧数字**：活 spec `guardrails/spec.md:1067`/`:1081` 写「22 positional sites across
  15 files」，实测已是 **23 / 16**（上一刀的集成测试 `:92` 新增了一个真实构造点）。同刀 MODIFY 订正。

## Capabilities

### Modified Capabilities

- `guardrails`：①三组引用的移除边界与各自地板（8→4 / 2→1 / 2→0）；②订正构造点计数 22/15 → 23/16。
- `domain-event-bus`：R11 三个条目的结果——两个降数（recorder 4→2、writeGate 4→2、transcripts 2→1）、
  一个归零删条目（metrics-projection）。归零删条目与降数改 count 的二分在本刀**同时出现**，是给后续刀的模板。
- `task-provisioning-diagnostics`：诊断写入的**开关反转**形态——关闭态是注入的 no-op，不是调用方的分支。
- `session-transcript-persistence`：转录捕获的所有权迁移**不得**改变 happens-before；验收用顺序断言而非 sleep。
- `resource-metrics`：容量投影的所有权归 platform-ops，消费方直连、编排器不留转发器。

## Impact

**代码**：`guardrails.service.ts`（三组共 8 行区域，不碰构造签名）、
`task-provisioning-diagnostics/`（新所有者 + port）、transcript 服务新目录 + manifest 同 commit 声明、
`runner-metrics/`（投影所有者）、`metrics.service.ts`（直连投影 port）、
`scripts/ratchets/r11.json` + `r11-dependency-budget.mjs`（`COLLABORATORS` 6→5）+ `r11-dependency-budget.test.mjs`、
`scripts/ratchets/r7.json`（路径键换键，见下）。

**不触碰**：`packages/contracts/**`、`GuardrailsService` 构造签名与 23 个构造点、
`apps/api/src/guardrails/*.spec.ts` 与 `*.test.mjs`（135/6/8 基线）、**harness 与工具链**（新流程硬规矩，
上一刀在这上面栽了两轮 verify）。

**N3 的四个实测陷阱**（迁目录必踩，写进 tasks 而非散文）：
① `AGENT_RUNTIME_REGISTRY_TOKEN` 在 `tasks.module.ts` provide 但未 export，被迁服务是**非** `@Optional()` 注入 →
漏了是**启动期 DI 解析失败**；② `session-cast.controller.ts` 的反向 import 会把该文件 r7 计数**升**上去，而 ratchet 双向 fail-closed；
③ r7 是路径键，搬家是**换键**不是缩数，旧键须同 commit 删除（留陈旧条目与留零条目都判红）；
④ 新顶层目录未同 commit 进 `contexts-manifest.json` 是 `context-layout-check-v2.mjs` 的 **exit 1 硬闸**，不是 finding。

## Non-Goals

1. **legacy inline-admission 退役**——它把 diagnostics 的地板从 4 压到 2，但本刀按「legacy 尚存 = 8→4」立基线。
2. **删构造参数**（第 8/9/10 参）——被 `guardrails.service.spec.ts` 的零 diff 冻结挡死，需另一刀连同 spec MODIFY 一起做。
3. **编排体拆分**——阶段 4 数字目标已于上一刀改为结构判据，编排体是另一条线。
4. **改 harness/工具链**——新流程明令领域刀不得碰。
