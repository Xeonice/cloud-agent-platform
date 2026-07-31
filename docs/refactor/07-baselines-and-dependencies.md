# 工件 07 — 量化基线与依赖图

各阶段规模校准、ratchet 基线清单、依赖图定稿。消费者：全阶段 change 拆分
粒度校准；阶段 1 ratchet 落库。

数字来源：52-agent 交叉验证的实测（2026-07-31 时点），执行期以重测为准。

## A. 依赖图（定稿版）

```
阶段0(设计) ──┬─→ 阶段2(扩展轴) ──→ 阶段7a(provider plugin化)
              ├─→ 阶段3(边界前移) ─→ 阶段7b(terminal抽包/lib-api归拢)
              └─→ 阶段4(事件) ─→ 阶段5(仓储+聚合) ─→ 阶段6(归拢)
阶段1(补洞+CI卫生) ── 与阶段0并行，立即可开工
```

硬依赖（不可绕）：
- **0 → 2**（工件 03 接口定稿是输入）、**0 → 3**（工件 01/02 是输入）、
  **4 → 5 → 6**（DDD 三刀按序）。
- 阶段 1 的 stateful boot-smoke → 阶段 4 开工前置。
- 阶段 1 的 terminal-stories 进 CI → 阶段 7b 前置。
- 阶段 2 词表统一 → 阶段 7a。
- 外部：阶段 2 contracts 词表新增 → repo-split Phase 1c 之前（工件 05 §A）。

## B. 各阶段量化基线（规模比）

| 阶段 | 主要触及 | 关键数字 | 相对规模 |
|---|---|---|---|
| 1 | scripts/ 闸门 + ci.yml + 卫生 | ~10 个脚本、4 个 workflow 文件、6 个死文件 | 1× |
| 2 | contracts + 4 处词表点 + conformance 骨架 | 13 文件（轴 B 清单）+ 5 词表 + 新套件 | ~2× |
| 3 | 生成器 + lint 接线 | 14 个 eslint.config + manifest 消费器 | ~1.5× |
| 4 | guardrails 3,806 行 / 81 方法 / 10 注入 + 122 内部测试 + 9 外部 spec + 4 inline 镜像测试 | api 456 文件 / 153k 行的核心区 | **~15×** |
| 5 | 260 处 Prisma / 45 文件 + 5 controller + Task 状态机 | 四核心域 store | **~12×** |
| 6 | 51 → 7–10 目录物理移动 + 路径锚定面 | 17 scripts + 13 test.mjs + 4 spec 的路径引用 | ~4×（比 V1 预估便宜：814 处相对导入已清零、layout v1 已在跑） |
| 7a | host-harness 三段 if + deployment-environment 6 分支 + validator | packages/sandbox 12,945 行核心区 | ~6× |
| 7b | packages/ui 994 行 + lib/api 5,475 行 | 指纹不变迁移 | ~4× |

结论：**阶段 4/5 是鲸鱼**，各自必须拆成 5–6 个 change（一个关注点/一个聚合域
一个 change）；阶段 1/2/3 是快赢。

## C. ratchet 基线清单（阶段 1 落库 `scripts/ratchets/`）

| 规则 | 基线值（盘点时点） | 归零责任 |
|---|---|---|
| dockerode/Docker 越界（R3） | 5 处生产文件（metrics/settings/runtime-models/sandbox-environments/self-update） | validator+probe 两路 → 阶段 7a；其余逐个评估 |
| Prisma 出 store 层（R7） | 260 处 / 45 文件 | 阶段 5 燃尽 |
| 跨上下文具体 .service import（R7） | 112 处（跨模块具体实现导入） | 阶段 4–6 燃尽 |
| guardrails→五关注点直接 import（R11） | 阶段 4 开工时实测 | 阶段 4 |
| mock/real seam 旁路（S2） | ≥2 组件（api-stream-panel、session-cast-log） | 阶段 3 起 |
| `as never` cast（代码质量随行） | ~11 处（task-response / sandbox-environments.service 集中） | 阶段 5 顺带 |
| controller 直查 Prisma | 5 处 | 阶段 5 立修（量小直接清零） |

## D. 路径锚定面清点（阶段 6 前置的输入）

写死 `apps/api/src` 字面路径的自动化资产（搬目录连环红或静默 no-op 风险）：

- **17 个 `scripts/*.mjs`**（grep 精确计数）；
- **13 个自扫源码的 `*.test.mjs`**（readFileSync 源码文本断言类，含
  `sandbox-host-harness-wiring.test.mjs` 的 exact-count 锚定——该文件在阶段 4
  动 guardrails 时提前解除）；
- **4 个 openspec spec** 写死路径；
- `sandbox-package-boundary.test.mjs` 的 sourceBoundaryRoots（阶段 1 扩域时
  一并改为 manifest 驱动）。

阶段 6 第一个 change 先机械产出逐文件引用清单；搬迁 change 验收 = 每个引用点
已更新 + 每条规则扫描文件数 > 0（工件 04 A.3）。

## E. 重测约定

本文件数字是**盘点快照**不是活数据。各阶段开工 change 的第一个 task 为重测
本阶段相关基线并更新本文件（同 change 留痕），防止拿过期数字做拆分决策。
