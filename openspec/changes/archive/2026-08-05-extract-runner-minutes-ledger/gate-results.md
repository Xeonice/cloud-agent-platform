# extract-runner-minutes-ledger — 集成轨闸门记录

集成轨（`gates-and-verification`）在**集成后的树**上跑出来的结果，逐条记录，
供评审复跑。测量日期 2026-08-05；分支 `refactor/extract-runner-minutes-ledger`，
基线 `main` = `e5d4e5a`。

---

## 任务 5.8 — 全闸门集

| 闸门 | 命令 | 结果 |
|---|---|---|
| R11 依赖预算 | `pnpm test:dependency-budget` | **exit 0**，12 tests / 12 pass。记录值 `this.runnerMinutes` = **5**，用 `measureSource` 对集成后源码的**活体复测**同样 = **5**（其余五个协作者 `this.audit` 9、`provisioningDiagnosticRecorder` 4、`provisioningDiagnosticWriteGate` 4、`this.transcripts` 2、`metrics-projection` 2，逐字未动） |
| 上下文布局 v2 | `pnpm test:context-layout-v2` | **exit 0**，29 tests / 29 pass。`node scripts/context-layout-check-v2.mjs` → `scanned 285 file(s)`，`cross-context-import: 135 / layer-direction: 2 / prisma-outside-store: 60 / unclassified-file: 132`，`every class within its committed baseline` |
| api 模块布局 | `pnpm test:module-layout` | **exit 0**，9 tests / 9 pass |
| 测试发现闸门 | `pnpm test:discovery` | **exit 0**，8 tests / 8 pass |
| 脚本套件 | `pnpm test:scripts` | **exit 0**，439 tests / 437 pass / 0 fail / 2 skipped |
| 仓库类型检查 | `pnpm typecheck` | **exit 0**，24/24 tasks successful |
| 仓库 lint | `pnpm lint` | **exit 0**，24/24 tasks successful |
| apps/api 源码套件 | `pnpm --filter @cap-console/api test:src` | **exit 0**，314 tests / 314 pass |

**新增测试文件确实被执行**（不是静默跳过）：在 `test:src` 的输出里逐条出现
`ok … characterization subject is the COMPILED runner-minutes module, not a local mirror`、
`ok … ledger semantics: …`（共 12 条，来自 `runner-minutes-derivation.test.mjs`）与
`ok … 1.4 the detached factory returns a ledger that really records: open then closed`
（来自 `runner-minutes-ledger.port.test.mjs`，3 条）。
集成轨自己的 `runner-minutes-ownership.integration.test.mjs` 单独跑 5 tests / 5 pass。

**CI 步骤显示名逐字未变**：`.github/workflows/ci.yml:370` = `Context layout gate (v2, report)`，
`.github/workflows/ci.yml:380` = `Dependency budget ratchet (R11)`。
`git status --porcelain .github/` 为空——本 change 根本没碰 workflow 文件。

### r7 比对（任务 5.7）

`scripts/ratchets/comparator.mjs` 的语义是**双向 fail-closed**（文件头原文：measured count
BELOW the baselined count → "equally red"）。因此 `node scripts/context-layout-check-v2.mjs`
退出 0 这件事，就把下列记录值钉成了**活体等值**，而不只是「不超过」：

| 键 | 值 |
|---|---|
| `cross-context-import:apps/api/src/guardrails/guardrails.service.ts` | **8**（本刀由 9 降下来） |
| `cross-context-import:apps/api/src/metrics/metrics.service.ts` | **2**（未动） |
| `unclassified-file:apps/api/src/runner-metrics/runner-minutes.ts` | **1**（仍在） |
| `unclassified-file:apps/api/src/runner-metrics/metrics-projection.ts` | **1**（仍在） |

无计数上升，无新键出现（新键会成为基线未覆盖的违规，闸门直接红）。

---

## 任务 5.12 — 公开面对抗式校验

命令（分支的 upstream 已本地设为 `origin/main`，脚本据此自解析基线，无需再给 env；
早期记录里的 `CAP_PUBLIC_SURFACE_BASE_SHA=$(git rev-parse main)` 前缀仍然有效，两者等价）：

```
node scripts/public-surface-adversarial.mjs verify extract-runner-minutes-ledger
```

**本段已按 task 6.2 的要求在当前 HEAD 上重跑重录**，不是 `cce2b2d` 时期的旧誊本。
中途曾有一次红：`ee0dc70` 给 `.claude/workflows/opsx-verify.js` 加了两个 `agent()` 调用
（`probe-hygiene:snapshot` / `probe-hygiene:sweep`），而 `scripts/public-surface-adversarial.test.mjs`
的假 agent 对未登记的 label 直接 `throw`，导致 `pnpm test:public-surface` exit 1、四条强制证据 lane
全部转 false。修的是**白名单**不是工作流（那个 throw 正是让「工作流新增了未建模步骤」可见的机制），
补完后重跑即下述输出。

输出：

```json
{
  "verdictVersion": 1,
  "changeName": "extract-runner-minutes-ledger",
  "phase": "verify",
  "requirementIds": [
    "runner-minutes-accounting/the-ownership-move-adds-no-runtime-behavior-and-no-observable-output-change"
  ],
  "passed": true,
  "command": { "argv": ["pnpm", "test:public-surface"], "shell": false, "ran": true, "exitCode": 0 },
  "sidecar":      { "passed": true, "evidence": "validate-change extract-runner-minutes-ledger --phase verify passed." },
  "registry":     { "passed": true, "evidence": "API focused collector read the executable canonical registry." },
  "restMetadata": { "passed": true, "evidence": "API focused collector reflected real Nest Public V1 handler metadata and parameter bindings." },
  "mcpSdkMetadata": { "passed": true, "evidence": "API focused collector observed official MCP Client.listTools metadata over InMemoryTransport." },
  "behavior":     { "passed": true, "evidence": "Focused conformance passed and the collector traced unique field sentinels through the executable MCP adapter map." },
  "findings": []
}
```

四个公开面全部 `unchanged`，`protocolDifferences` 为空，`findings` 为空。
`surface-impact.json` 在 5.13 改写 `internalOnly.scope` **之后**重跑，结论不变。

---

## 任务 5.11 — 响应体前后逐字节相等（跨编译产物实测）

本条不是推理，是**真的把移动前后的两份编译产物同时装进一个进程比对**：

1. `git checkout main -- <4 个生产文件 + 1 个 spec>`，`pnpm --filter @cap-console/api build`，
   把产出的 `dist/` 整份快照到 `.premove-dist/`（其 `metrics.service.js` 第 39 行是移动**前**的
   `deriveRunnerMinutes(this.guardrails.runnerMinuteIntervals(), now)`）；
2. 把 5 个文件还原回集成后的版本（逐个与 track 4 的工作树 `diff -q` 确认逐字节一致），重新 build
   （`metrics.service.js` 第 41 行变成移动**后**的 `deriveRunnerMinutes(this.runnerMinutes.intervals(), now)`）；
3. 同一个进程里 `require` 两份 `MetricsService`，喂**同一个区间 fixture** 与**同一个冻结 `now`**，
   `assert.deepEqual` 两个 `build(now)` 的完整响应体。

结果：

```
BEFORE runnerMinutes: {"available":true,"minutes":8}
AFTER  runnerMinutes: {"available":true,"minutes":8}
top-level keys BEFORE: capacity,occupancy,runnerMinutes,resources,provisioningDiagnostics
top-level keys AFTER : capacity,occupancy,runnerMinutes,resources,provisioningDiagnostics
FULL RESPONSE BODIES DEEP-EQUAL: PASS
```

跨编译产物的比对是**一次性证据**（`.premove-dist/` 已删除，不入库）。它的**常驻回归**留在
`apps/api/src/runner-metrics/runner-minutes-ownership.integration.test.mjs`：那里断言
`body.runnerMinutes` 等于**移动前那条读表达式**在同一 fixture 上的取值
（`deriveRunnerMinutes(fixture, NOW)`，走同一份编译出来的派生函数），并另行钉死顶层块集合
与字面量 `{ available: true, minutes: 8 }`，使「两边同时改坏」也过不去。

`packages/contracts/**` 在本 change 的 diff 里**零出现**。

---

## 任务 5.3 — 一个实例同时服务读写两侧（已启动上下文）

`runner-minutes-ownership.integration.test.mjs`，5 tests / 5 pass。它**真的启动了一个 Nest
application context**（`NestFactory.createApplicationContext`，装 `RunnerMinutesModule` 加
`onModuleInit` 唯一非可选解析的 `TASK_OPERATIONS` 桩），然后：

- `service.runnerMinutes` 与 `app.get(RUNNER_MINUTES_PORT)` **对象同一**（不是「看起来相等」），
  且该实例 `instanceof RunnerMinutesLedgerService`；
- 走编排体**自己的写路径** `armDurableRuntime()`（三处生产 `recordStart` 之一）记一次开跑，
  真实 `MetricsService` 从端口读出来 `available: true`、分钟数落在注入时钟的 ~5 分钟带内；
- 字段初始化器造出来的 detached 兜底实例，在应用已启动后 `intervals()` 为 **`[]`**——
  它是被**旁路**掉的，不是被就地替换；
- 反向对照：不装 `RunnerMinutesModule` 的上下文里，兜底仍**真实记账**（`intervals().length === 1`），
  所以冻结单测里那些「不存在未闭合区间」的否定断言不会被一个什么都不记的空壳**空洞地满足**。
