# research-brief — lifecycle-vocabulary-single-declaration

> 本简报**不是**新跑一轮 `opsx-propose-deep` 的产物。阶段 5 的探索（31 agents / 2.4M token /
> 25 条结论过对抗核查驳掉 10 条）已经覆盖了同一片地面，其中每一条被本刀依赖的结论，作者都在
> `e4c1d6d` 的干净工作树上**亲自复跑过命令**。重跑一次扇出只会花掉同样的钱去买同一批数字。
> 下面每个数字都带产生它的命令。

## 1. 阶段 5 母文档的前提已过期（本刀不修，刀 1 只记录受影响的那条）

| 母文档 | 实测 | 命令 |
|---|---|---|
| 「『Prisma 只在 `*.store.ts`』**进** layout v2 规则」 | **阶段 3 已落地**：`prisma-outside-store` 52 条目 / 59 计数，每条 `change` 字段已写「阶段 5 燃尽（四核心域 store 化」 | `python3 -c "import json;d=json.load(open('scripts/ratchets/r7.json'));…"` |
| 验收「状态转换合法性单点声明」 | **今天字面上已成立** | `grep -rn ALLOWED_TRANSITIONS` → 唯一声明在 `apps/api/src/task-lifecycle/task-lifecycle.ts:44` |

## 2. 真实缺陷：终态词表两份 canonical

两处声明，**成员逐字节相同**：

- `packages/contracts/src/task.ts:42` `TERMINAL_TASK_STATUSES`
- `apps/api/src/task-lifecycle/task-lifecycle.ts:18` `TERMINAL_STATUSES`

两边都有活消费者。contracts 版被 `domain-event.ts` / `session-history.ts` / `apps/web` 两处消费，
**并且 `guardrails.service.ts:22` 已经 import 了它**；api 版被 `task-admission.worker.ts:8` 经
`isTerminal` 消费。

### 复述面的计数口径（这个数必须带口径，否则会像母文档那样一处为真一处为假）

口径 = **四个终态字面量（`completed` / `failed` / `cancelled` / `agent_failed_to_start`）以单引号形式
在同一个 8 行窗口内共现**，每文件只记首处，扫 `apps/` `packages/` `scripts/`，排除 `*.spec.ts` /
`*.test.ts` / `*.test.mjs`。按此口径全仓 **7 个文件**；把排除列表清空则为 **18**。

⚠ **订正：本节原写 12，是错的。** 按它自己声明的排除项重数得 **13**，而且那份排除项本身自相矛盾
——排掉了两个测试后缀却漏了 `.test.mjs`，于是一边声称排除测试一边把 `*.test.mjs` 数了进来。错误
留档不覆盖：一个没有审计痕迹就变了的数字，正是本 epic「一处为真、别处为假」的来路。

7 处里 **2 处是 canonical 本身**，**2 处是口径的假阳性**（`audit-mapping.ts:282` 与
`v1-events.controller.ts:324` 是对**整个**状态枚举的穷尽映射，四个终态字面量只是相邻 case 恰好
落进同一窗口——它们必须继续逐个列举，改成消费终态集合反而会**去掉编译器强制的穷尽性**），
真正的复述是 **3 处**：`guardrails.service.ts:169` 的类型联合、
`prisma-task-admission.store.ts:95` 的裸 SQL 列表、`tasks.service.ts:693` 的 Prisma `in` 数组。

⚠ 单看 `grep agent_failed_to_start` 会得到 **45 行**，但绝大多数是**单状态引用**
（`circuit-breaker.ts` 的 `FailureKind`、`task-transcript-reader.ts:68` 的单个判断、
`v1-events.controller.ts:331` 的 switch case），与终态集合无关。**不带口径的 45 是个误导数。**

## 3. 一个在主体改变时不会失败的测试

`apps/api/src/tasks/task-lifecycle.test.mjs` 的 import 只有两行：

```
11: import test from 'node:test';
12: import assert from 'node:assert/strict';
```

它**不 import 被测模块**，自持一份邻接表副本（4 处引用）。改 `task-lifecycle.ts:44` 的合法转换表，
它照样全绿。这不是「测试没覆盖」，是「测试结构上无法失败」。

## 4. 分层规则：本刀是所有后续刀的技术前置

`docs/refactor/contexts-manifest.json` 的 `layers.fileClassification.rules` 是一张**有序后缀表**，
今天映到 `domain` 的**只有 `.port.ts`**。命中不了的文件报 `unclassified-file` 且
**「绝不静默跳过」**（脚本头注释原话）。

后果：阶段 5 后续任何一刀新建纯领域文件（刀 7 的 Task 聚合、刀 2–6 的值对象），都会产生一条
**新 key 的 `unclassified-file` finding**，而 `comparator.mjs:178` 对「无基线条目的实测违规」直接判红。
**不先加这条规则，后面每一刀第一次 commit 就撞墙。**

顺带：`unclassified-file:apps/api/src/task-lifecycle/task-lifecycle.ts` **今天就在 r7 里挂着**
（unclassified 类共 129 条），所以把它判为 domain 是一次**与 shrink-only ratchet 同向的收缩**，
不是对抗。

## 5. 用户拍板（2026-08-07），非测量结论

- **D1 终态 canonical 保留 `packages/contracts` 版。** 理由是可行性：反向（保留 api 版）要求
  `apps/web` import `apps/api`，**结构上不可行**。选 contracts 版则 web 2 处与 contracts 2 处零改动。
- **D5 additive-only 取宽读法**：DDL 必须 additive，DML 允许但须在文件头自陈不可逆。与既有实践一致——
  阶段 4 那条 DELETE 迁移已经自愿这么做了。
- **D4 给 `prismaPlacement` 加 composition 豁免**，与 `crossContextRules` 已有的 composition 豁免对称。
- （D2 三个无名 store 各建独立 → 决定阶段 5 是 7 刀，与本刀无关。）

## 6. 本刀唯一会失败的地方

**R11 对 guardrails 的符号引用计数是严格等值**（`scripts/ratchets/comparator.mjs:181-187`：低于基线
同样判红），且 `openspec/specs/guardrails/spec.md:862` 按 file:line 钉死了九个 `this.audit` 行号。
本刀要改 `guardrails.service.ts` 里的终态复述，**必须做到只改谓词体、不移动任何协作者引用行**——
哪怕只是重排，闸门立刻红。

`node scripts/guardrails-construction-sites.mjs` → `20 16 11 10 6 5`（20 个位置化构造点 / 16 文件 /
11 个在目录外）。本刀不碰构造签名，故该组数字应逐位不变。
