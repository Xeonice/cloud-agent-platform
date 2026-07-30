# Track 3 — 边界重切：测量、决定与结果

Track 3 按原计划（tasks.md 3.1–3.7）执行时，在 3.2 之前就撞上 design D4 与风险册
自己写的停止条件。这份文档记录重新测量的结果、四个候选方案的实测代价，以及最终采纳的切法。

所有数字由 `apps/api/src/guardrails/guardrails.service.ts`（4539 行）在
brace-balance 计算的真实范围上统计得出，不是估计。

---

## 1. 为什么停

`baseline.md` 的 task 1.3 耦合集是**只向内扫**的：只问了「这个块碰了谁」，
没问「谁还碰着这个块碰的东西」。补上反向扫描后结论翻转：

- task 1.3 标为「legacy 独占、随块搬走」的**两个字段都有块外读者**
  （`legacyProviderBoundariesCrossed` 在 2286 被 `settleTask` 读；
  `legacyDiagnosticPositions` 在 3103 被 `tryBeginProvisioningDiagnostics` 写）。
- task 1.3 **完全没列出另外 3 个 legacy 状态容器**，它们同样跨界。
- 12 个 `*Legacy*` 方法里 **5 个有块外调用者**，含调用点最多的
  `settleLegacyProvisioningSupersession`（18 处，其中 2 处在块外）。
- 两个**共享**辅助方法内部带 `admissionMode === 'legacy'` 分支
  （`tryBeginProvisioningDiagnostics` 3095/3119、`settleProvisioningDiagnostics` 3224）。

也就是说：**legacy 管线的身份不是那 347 行块，而是一套跨越「准入 → 终结算」的
诊断簿记状态**，而终结算（`settleTask` / `fenceTerminal`）是 durable 管线也走的
共享基础设施。原计划想切的那一刀，正好从这套簿记的中间穿过去。

---

## 2. 四个候选切法的实测代价

`port OUT` = 抽出单元回调 guardrails 的成员数；
`entry IN` = guardrails 反过来调用抽出单元的成员数。两者相加是**真实跨界面数**。

| 方案 | 搬走行数 | port OUT | entry IN | 合计跨界 | 可整目录删除 |
|---|---|---|---|---|---|
| **A** 12 方法 + 347 行块 | 696 | 21（折叠后 ~15） | 9（折叠后 ~6） | **~21** | ✅ |
| **D** 12 方法，块留下 | 336 | 11（折叠后 ~7） | 16 | **~23** | ❌ 块仍在 guardrails |
| **E** 仅 347 行块（= 原计划） | 360 | 22（折叠后 ~20） | 6 | **~26** | ❌ 6 个状态容器全留下 |
| **F** 只把 6 个状态容器收敛成一个具名对象 | 0（不搬逻辑） | 0 | 0 | **0** | ✅ 单文件 |

折叠规则：`terminalTasks.has` ×3 / `terminalTaskStatuses.get` ×5 全是只读判等，
合成 2 个访问器；`logger`/`sandbox`/`prisma`/`recorder`/`writeGate` 是构造注入依赖，
不算 port；5 个状态容器在 `settleTask` 里的 5 次 delete 合成 1 个 `forget(taskId)`。

**核心事实：A / D / E 三种切法的跨界面数都落在 21–26 之间。**
design D4 的重切阈值是「明显超过 9」，风险册是「超过 ~12 就说明边界切错了」。
没有一种切法过关 —— 不是边界选错了，是**这个簇本身不存在低耦合切口**。

---

## 3. 这说明什么

原设计假设「停下来重切」之后存在一个更好的切口。测量说没有。

原因是结构性的：legacy 的存在形式是**共享代码里的模式条件 + 跨阶段状态**，
不是一段可以整块拎走的代码。要么接受 ~21 个显式跨界面，要么不切。

而这件事发生在一个**已经决定要退役**的管线上（本轮 explore 选项 (a)）。
为一个计划删除的单元建 21 成员的接口，是在给拆除工作搭脚手架 —— 脚手架本身
之后也要拆。

---

## 4. 已做的决定：方案 A（整簇抽取）

评审时确认了这项工作的判据是**"对后续清理成本最小"**——这是在清理一个已判定退役的
功能，不是在长期维护它。按该判据，A 是唯一正确解：三种真抽取里只有它让退役日变成
`rm -rf` 一个目录，其余两种都会在 `guardrails` 里留下孤儿状态或孤儿代码。

第 2 节表里"跨界面数最小"这条判据随之作废——它优化的是**本次改动**的成本，
而不是**删除动作**的成本。F（只收敛状态）因此被否决：它零代价，但退役日仍要从
`startRunningAfterCapacity` 里读出 696 行代码在哪。F 的内容作为 A 的第一步保留，
即 `inline-admission-state.ts`。

决定与实测数据记在 design 的 **D4a**；本文档只保留导出该决定的测量过程。

## 5. 交付结果

| | 值 |
|---|---|
| `guardrails.service.ts` | 4539 → 3807 行（**−732**） |
| 新目录 | `apps/api/src/inline-admission/`（state 98 / port 155 / pipeline 830） |
| port（单元 → 编排器） | 18 成员 |
| 入口（编排器 → 单元） | 10 成员 |
| guardrails 套件 | 122/122，`*.spec.ts` 零改动 |
| 覆盖率 | 行 83.0% → 83.5%，分支 81.7% → 82.3% |
| 抽出块执行次数 | 50 = 基线 |
| 布局闸门 | 通过，`ALLOWED_CYCLES` 仍为空 |

两处只有跑起来才暴露、分析没看出来的耦合：

1. **日志上下文是被断言的行为。** pipeline 自建 `Logger` 会让消息换 context，
   测试直接红。改为通过 port 的 `logger()` 延迟读取编排器的字段
   （测试在构造后替换该字段，捕获式注入同样会失效）。
2. **一个扫源码文本的测试把"两条管线在同一个文件里"写死了。**
   `sandbox-host-harness-wiring.test.mjs` 现在读两个路径文件，断言强度不变。
