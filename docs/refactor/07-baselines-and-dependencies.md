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
| Prisma 出 store 层（R7） | ~~260 处 / 45 文件~~ → **60 处 / 53 文件**（活测，见下） | 阶段 5 燃尽 |
| 跨上下文具体 .service import（R7） | ~~112 处~~ → **136 处 / 61 文件**（活测，见下） | 阶段 4–6 燃尽 |
| 层方向逆行（R7） | 2 处 / 1 文件（terminal application → interface） | 阶段 4 |
| 判不出层的文件（R7 unclassified） | 132 文件 / 共 278 个受管文件 | 阶段 6 归拢 |
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

### E.1 R7 活测回写（enforce-boundaries-from-manifest，2026-08-01）

上表 R7 四行由 `node scripts/context-layout-check-v2.mjs` 实测得出，落库基线
`scripts/ratchets/r7.json`：**247 条目 / 330 处**，条目键为
`<检查类>:<文件路径>`（按文件按类，不按类汇总——汇总会让 A 文件的修复替 B
文件的新违规买单，且 comparator 只能说「数字涨了」而点不出文件），经共享
comparator `scripts/ratchets/comparator.mjs` 比对。与盘点快照差异及其原因：

| 类别 | 快照 | 活测 | 差异来源 |
|---|---|---|---|
| Prisma 出 store 层 | 260 处 / 45 文件 | 60 处 / 53 文件 | 快照数的是**符号出现次数**（含构造注入、类型标注、每次 `this.prisma.*` 调用），活测数的是**触达点**（import `@prisma/client` 或 `PrismaService` 的 import 语句），一处触达带出多次使用；文件数反而更多（53 > 45），即触达面比快照更广 |
| 跨上下文具体实现 import | 112 处 | 136 处 / 61 文件 | 快照只数 `.service` 具体实现；活测按工件01 `crossContextRules` 判全部非法形态（非 `*.port.ts`、非 DI 组装、非共享内核），把 pipe/gateway/types 等一并计入 |
| 层方向逆行 | 无快照 | 2 处 / 1 文件 | 首次测量 |
| 判不出层 | 无快照 | 132 / 278 文件 | 首次测量；工件01 `layers.fileClassification` 只声明既有命名约定，未命中者一律报 unclassified（不静默跳过） |

判定规则的唯一声明在 `docs/refactor/contexts-manifest.json`
（`layers.fileClassification` / `layers.allowedImports` /
`crossContextRules.machineReadable` / `prismaPlacement`），脚本是纯解释器。
重测 = 重跑该脚本；基线增减必须与修复同 PR（comparator 的 fail-on-stale 语义）。
