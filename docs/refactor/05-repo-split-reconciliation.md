# 工件 05 — repo-split epic 对账表

本重构（8 阶段）与 `docs/repo-split-epic.md`（D1–D14 已锁定）的逐条对账。
消费者：总则 3；阶段 2/7 的 change 设计输入；repo-split 各 Phase 的 change
反向引用本表。

## A. 排序总裁定（决策 1）

**本重构阶段 0–6 整体在 repo-split Phase 3（物理拆分）之前完成；阶段 2 的
contracts 词表新增（RUNTIME_METADATA、source-kind 统一、SKILL_CATALOG 上移）
赶在 Phase 1c（contracts 首次公开发版）之前落地。**

依据（全部来自 epic 自身）：
1. D12 论证原文"现在是最便宜的时刻：1 个仓、1 份 lockfile"逐字适用于阶段 6
   归拢与阶段 7 抽包/plugin 化；拆完是 6 仓 6 lockfile。
2. D7/D11：拆仓后规划迁总仓、子仓只写代码，openspec 工作流变形为五步；
   重构拖到拆仓后每阶段全付这笔协调税。
3. Phase 3 边界图已把 `packages/ui` 划给 cap-web；terminal 抽包改变该提取
   边界，必须在 filter-repo 前定形。

反向约束：Phase 1c 前 contracts 侧改动自由；发版后走版本线。

## B. D1–D14 × 本重构逐条对账

| 决策 | 与本重构的关系 | 裁定 |
|---|---|---|
| D1 拓扑（总仓+子仓） | 阶段 6 归拢 api 内部目录不跨未来仓边界，filter-repo 可跟随目录内重命名 | 无冲突 |
| D2 contracts 发 npmjs | 阶段 2 词表新增须在首发前（§A）；工件 03 新增的表都满足"真正共享"（web/api 双端消费） | 已协调 |
| D3 版本偏移 attestation | 与总则 2（attestation 公开 API）同一机制，阶段 1 不得破坏 | 已协调 |
| D4 治理层+e2e 住总仓 | 本重构的 8 工件与规则登记制届时随治理层迁总仓 | 无冲突 |
| D5 版本号=总仓 tag | **open**：contracts 独立版本线与 D5 的关系，epic 自留在 Phase 1c 定；阶段 2 不依赖其结论 | open（epic 侧） |
| D6 api-only 契约回迁 | epic 已自我修正为"搬 3 个模块"；与阶段 2 无交集 | 无冲突 |
| D7 总仓只读铁律 | 拆仓后本重构若有残余工作，遵循五步工作流 | 无冲突 |
| D8 www/worker 独立仓 | 本重构不触及 | 无冲突 |
| D9 filter-repo 历史提取 | 阶段 6/7 的目录移动都在单仓内、不跨未来仓边界（terminal-core 例外见 D 节） | 注意项 |
| D10 总仓 CI 拉源码 | 阶段 1 的 e2e 进 CI 工作（terminal-stories/visual）将来平移总仓 | 无冲突 |
| D11 规划在总仓 | 同 D7 | 无冲突 |
| D12 scope 改名 | 已完成（epic Phase 0 已执行部分）；本重构所有新文件用 `@cap-console` | 已消化 |
| D13 config 包复制不发版 | 不影响本重构；sandbox-core 分发问题另见 C.2 | 无冲突 |
| D14 sandbox 词表两层 | **本重构原方案被其推翻并已改写**：操作员配置词表不派生、独立声明+覆盖闸门（工件 03 B.2）；类型层 import type 收敛与运行时层 parity 闸门照 D14 执行 | 已按 D14 改写 |

## C. epic 侧过期/悬空条目（对账发现，需 epic 维护方处置）

1. **Phase 1d"新增零 importer 闸门"已落地**：`contracts-shared-export-check.mjs`
   已存在且在 CI（其历史注释引用的正是 epic §2.4b 审计数字）。epic 文档
   "规划中尚未开工"的状态与现状漂移。
2. **sandbox-core / sandbox-conformance 的分发通道悬空**：D2 只发 contracts、
   D13 只复制 config 包；第三方实现 provider 需要 import sandbox-core（零依赖
   port 层）与 conformance（验收套件），拆仓后它们归 cap-api 仓则第三方扩展
   承诺无载体。**需要 epic 补决策**（候选：随 contracts 同仓发版 / 独立
   cap-sandbox-port 仓 / 承诺降级为 fork 级）。本重构工件 03 B.3 的双层信任
   声明是其输入。
3. **terminal-core 预留独立仓**（本重构决策 6）：Phase 3 边界图的
   "cap-web（113，含 packages/ui 9）"需相应改写——terminal-core 的 commits
   不并入 cap-web 提取，保留独立提取可能。

## D. 对账维护规则

- 本重构与 repo-split 的任一方新增/修改决策时，同一 change 内更新本表；
- 两 epic 的 change 在 proposal 的 Impact 段互引对方约束（阶段 2/7 的 change
  引 D14/D2/D9；repo-split Phase 1c/3 的 change 引本表 §A/C.3）。
