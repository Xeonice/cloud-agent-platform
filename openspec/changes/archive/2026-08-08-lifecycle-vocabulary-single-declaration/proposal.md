## Why

阶段 5 的两条验收之一是「状态转换合法性单点声明」。实测下来**这句话按字面读今天已经成立**——
`ALLOWED_TRANSITIONS` 在 `apps/api/src/task-lifecycle/task-lifecycle.ts:44` 只声明一次，零 Nest、
零 Prisma。所以它无法区分「做完了」和「没开始」。

真正的缺陷用「状态转换」这个词描述不到：**终态词表有两份 canonical**，`packages/contracts/src/task.ts:42`
的 `TERMINAL_TASK_STATUSES` 与 `apps/api/src/task-lifecycle/task-lifecycle.ts:18` 的 `TERMINAL_STATUSES`
成员逐字节相同、名字不同、两边都有活消费者。`grep 'ALLOWED_TRANSITIONS|assertTransition|canTransition'`
在原理上看不见它们——两个符号一个都不出现。

而守着这块的那个测试**结构上无法失败**：`apps/api/src/tasks/task-lifecycle.test.mjs` 的 import 只有
`node:test` 和 `node:assert`，它不 import 被测模块，自持一份邻接表副本。改真模块它照样全绿。

第三件事让本刀成为阶段 5 的技术前置而非可选项：`contexts-manifest.json` 的
`layers.fileClassification.rules` 今天**只把 `.port.ts` 映到 `domain` 层**，命中不了的文件报
`unclassified-file` 且「绝不静默跳过」。阶段 5 后续每一刀都要新建纯领域文件（刀 7 的 Task 聚合、
刀 2–6 的值对象），每一个都会产生**新 key 的 finding**，而无基线条目的实测违规被
`comparator.mjs:178` 直接判红。**不先加这条规则，后面每一刀第一次 commit 就撞墙。**

## What Changes

1. **终态词表收敛为一份 canonical** —— 保留 `packages/contracts` 版（用户 D1 拍板；反向不可行，
   `apps/web` 无法 import `apps/api`）。`apps/api` 侧的复述改为引用。
2. **admission 子集规则单点化** —— 「admission 只拥有 `pending→queued/running` 与 `queued→running`」
   现以一条散文注释（`tasks.service.ts:2440`）加两处类型复述（`tasks.service.ts:176`、
   `task-operations.port.ts:54`）存在，收敛为一个导出谓词；`task-admission.worker.ts:1131` 已是
   正确的消费方，**保持不动**。
3. **哑镜像测试退役或接线** —— `task-lifecycle.test.mjs` 不得再自持邻接表副本。二选一并在 spec 写明。
4. **manifest 增加 domain 后缀规则** —— `task-lifecycle` 迁入 domain 层。**已读解释器确认只支持后缀
   （`context-layout-check-v2.mjs:262-268` 的 `probe.endsWith(rule.suffix)`），目录形态写不出来**，
   故按 D-D 预写的退化执行：声明文件名后缀约定并给该文件改名。**simulate-then-measure 实测**
   （已改已跑已还原）：`unclassified-file` 129 → 128，其余三类逐个不变，另需同 commit 删 1 条陈旧基线。
5. **`prismaPlacement` 增加 composition 豁免**（用户 D4 拍板）—— 与 `crossContextRules` 已有的
   composition 豁免对称（复用它**已经算好的**同一个 `isComposition` 谓词，不新造第二个），消掉三条
   写代码消不掉的 DI 工厂 edge。**实测**：`prisma-outside-store` 59 → 56，恰好那三个 module 文件，
   另需同 commit 删 3 条陈旧基线。
6. **migration 纪律条款成文**（用户 D5 拍板，宽读法：DDL 必须 additive，DML 允许但须自陈不可逆）——
   登记进 `docs/refactor/04-rules-registry.md` E 节，该节已把执行器写死为「阶段 5 起的 change 模板条款」，
   **本刀补条款，不造闸门**。

## Capabilities

### New Capabilities
- `task-lifecycle-vocabulary`: 生命周期词表的单一声明纪律——终态集合、admission 子集规则各恰好声明一次，
  复述被按明确口径计数并燃尽，守它的测试必须能因它改变而失败。
- （`context-layout-report` 收一条新需求：Prisma 放置检查对 DI 组装伪层的具名豁免。见上。）

### Modified Capabilities
（无。下述两点经核对**不构成 MODIFIED**——记录判据，因为「该不该 MODIFY」在本 epic 里错过。）

- **文件→层新增 domain 规则不改任何需求。** `context-layout-report` 的
  「File-to-layer classification is declared once and fails closed」（`:36`）管的是**机制**——
  声明唯一、未命中必报。往规则表里加一条是**数据**，机制一字未动。
- ⚠ **原判「composition 豁免走 ADDED 而非 MODIFY」已被推翻，两者都做。** 原论证是：`:6` 把 Prisma 豁免
  写成「the manifest's declared shared-kernel exemptions」，而 MODIFIED 是整条替换、漏写 scenario 即从活
  spec 删除，所以新增独立需求更安全。**归档前扫活 spec 时发现这条推理漏了一步**：`:6` 的场景是
  「不是 `*.store.ts` 且不被 shared-kernel 豁免覆盖 → **必须被报告**」，而 `guardrails.module.ts` 正好
  满足前件却不再被报告——那条场景**已经假了**。只加不改的结果不是「更安全」，是**两条活需求互相矛盾**，
  比要规避的整块替换风险更糟：矛盾正是本 epic 反复付账的「一处为真、别处为假」。
  最终做法：**MODIFIED `:6`**（三条 scenario 逐字搬运，已实测 heading 逐字节一致、场景集合一致，只改第三条的
  豁免措辞）＋ **保留那条 ADDED**（它管的是豁免的**窄度、裁定与基线纪律**，`:6` 只说检查尊重 manifest 声明了什么）。
- ⚠ 早期草稿曾把 `monorepo-foundation` 列在这里，**核对后删除**：该 spec 里没有任何 Prisma/store
  放置需求（`grep '^### Requirement:' | grep -iE 'prisma|store'` 零命中），那条规则整个住在
  `context-layout-report`。

## Impact

- **代码**：`packages/contracts/src/task.ts`（保留为 canonical，**并新增一个由其派生的终态类型导出**——
  终态集合是 contracts 拥有的词表，派生类型应与它同处；声明在 apps/api 再 import 等于把该词表的第二个
  名字放进消费方，正是本刀要删掉的形状。⚠ 原写的理由「从 api 侧导出会跨 context 造出新 finding」
  **是错的**，apply 期读 manifest 时推翻——guardrails 与 task-lifecycle **同属 `task-execution`**，
  那个 import 不产生任何 finding，订正留档。这是本刀唯一主动扩大公开面之处，已在 surface-impact 记明）；
  `apps/api/src/task-lifecycle/task-lifecycle.ts`（删本地 canonical、改引用、随 domain 后缀改名）；
  **9 处真复述**——`guardrails.service.ts` 5 处（`:169` `:3256` 类型联合、`:981` `:3295` 等值链、
  `:3613` 本地重声明的 `isTerminalTaskStatus`）、`tasks.service.ts` 2 处（`:693` `:743` Prisma `in`）、
  `prisma-task-admission.store.ts` 2 处（`:95` `:127` 裸 SQL）；
  `task-operations.port.ts` 与 `tasks.service.ts` 的 admission 子集类型复述。
- **配置**：`docs/refactor/contexts-manifest.json` 两处（fileClassification 一条规则、prismaPlacement 一条豁免）
  及闸门 self-test 对应 case。
- **文档**：`docs/refactor/04-rules-registry.md` E 节的 migration 条款。
- **闸门**：`pnpm test:context-layout-v2`（r7 基线必须**同 PR 收缩**——comparator 严格等值，低于基线同样红）、
  `pnpm test:dependency-budget`（R11 对 guardrails 严格等值）、`node --test apps/api/src/tasks/task-lifecycle.test.mjs`。
- ⚠ **原写的「最大失败模式」已被读代码推翻，订正留档**：`scripts/ratchets/comparator.mjs:16` 与
  `:170-187` 只比 `count`，`samples[]` 明写是文档——**行号位移不会让 R11 判红**，真正会红的是增删
  `this.<协作者>` 引用，而本刀两者都不做。`openspec/specs/guardrails/spec.md:862` 的九个行号按其
  自身措辞限定在「该 change 之前的树」，是历史陈述，不因本刀位移而变假。**仍要做的**是改完编排器
  单跑 `pnpm test:dependency-budget` 确认 9/4/2/2/1/2 不动，并顺手刷新 `r11.json` 的 samples。
- **不碰**：构造签名与 20 个位置化构造点（`node scripts/guardrails-construction-sites.mjs` 应保持 `20 16 11 10 6 5`）。
