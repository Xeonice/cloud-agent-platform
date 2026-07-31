# 工件 06 — 在途 change 清欠台账

`openspec/changes/` 下 10 个未归档 change 的逐个处置。消费者：阶段 0 前置
执行；阶段 1 的 change 引用本表接管项。

盘点时点：2026-07-31（`openspec list`）。

## 处置表

| change | 状态 | 处置 | 执行时机 |
|---|---|---|---|
| harden-scheduled-task-dispatch-and-local-e2e | 34/34 + verify PASS | **归档**；其事务边界/lease 语义作为不变量写入阶段 4/5 的 design（工件 08 §D 已引用） | 阶段 0 前置 |
| expand-recurring-task-time-controls | 25/25 | **归档** | 阶段 0 前置 |
| runtime-same-host-release-web | 17/17 | **归档** | 阶段 0 前置 |
| use-local-account-quick-deploy | 12/12 | **归档** | 阶段 0 前置 |
| simplify-sandbox-image-model | 30/30，无 verification-report | **先 opsx-verify 再归档**——阶段 2 轴 C 的前置；其 spec delta 合入后，轴 C 词表合并才有干净基线 | 阶段 0 前置（可与阶段 1 并行） |
| static-terminal-log | 12/13（余人工活验，功能已上线实证） | 补活验勾掉或以注记结案后**归档** | 阶段 0 前置 |
| scope-agent-context-and-document-layout | 14/15（余 task 3.4：CI paths 过滤真实 PR 双向观察） | **task 3.4 移交阶段 1 CI 卫生 change**（与 required-context 协调变更同一 PR），随后归档 | 阶段 1 |
| release-quarantined-installer-and-terminal-suites | 0/7 | **阶段 1 接管**：quarantine 清空（3 条目归零）是其验收；不重复立项 | 阶段 1 |
| redesign-settings-single-column | 7/15，已漂移（任务目标文件不复存在） | **废弃删除**（决策 4，总则 4 判据首个适用案例）；删除时快照其 OD 设计稿引用到 change 归档说明外的独立位置若仍需 | 阶段 0 前置 |
| session-approval-flow | 0/0 仅 proposal | **挂起不删**（决策 12：未启动但方向未被推翻）；proposal 加注记"接缝（approval-surface/session-terminal/$taskId）将被阶段 6/7 重排，propose tasks 前必须重读现状" | 注记即可 |

## 清欠执行序（阶段 0 前置批）

1. 四个纯归档（harden-scheduled / expand-recurring / runtime-same-host /
   use-local-account）；
2. static-terminal-log 结案归档；
3. simplify-sandbox-image-model：opsx-verify → 归档；
4. redesign-settings-single-column：废弃删除；
5. session-approval-flow：加注记。

完成判据：`openspec list` 仅剩 2 个在途（scope-agent-context 等 task 3.4 移交、
release-quarantined 等阶段 1 接管）+ 1 个挂起 proposal。

## 执行留痕（2026-07-31）

- 1–4 批：expand-recurring / runtime-same-host / use-local-account 正常归档
  （specs 已合入）；**harden-scheduled 以 `--skip-specs` 归档**——其 delta 基于
  旧术语基线（"period"），主 spec 已被后续 change 演化为 "occurrence" 版本
  （`(scheduleId, scheduledFor)` 唯一键 + retry metadata），语义已吸收且更新，
  重放旧 delta 会回退主 spec。
- **static-terminal-log 以 `--skip-specs` 归档**——delta 三个操作（REMOVE
  timing-replay / ADD static-log / MODIFY empty-state）的目标态经逐条核对已全部
  在主 spec 中，重放不必要且 REMOVE 目标缺失会报错。task 5.2 据实补记
  （2026-06-18 v0.6.0 生产实景验证）后结案。
- redesign-settings-single-column 已删除。session-approval-flow 的挂起注记**记录于本台账而非其 proposal.md**：touch 一个 pre-sidecar 时代的 legacy change 会触发 metadata 验证器的 sidecar/tasks backfill 要求（制度使然非 bug），故 proposal 保持 untouched；其接缝提醒见处置表该行，propose tasks 前必读（决策 12）。

## 台账维护规则

- 重构期间新开的 change 一律在 proposal Impact 段声明所属阶段与引用的工件；
- 不属于本重构的产品 change 正常并行，但触碰阶段 4–6 在改区域（guardrails/
  tasks/目录归拢范围）时，遵循阶段 6 的 change-freeze/rebase 政策（该政策在
  阶段 6 第一个 change 内成文）。
