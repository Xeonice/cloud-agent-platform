# Research Brief — fix-session-runtime-tag

> Side-car research notes for this change. Not a tracked artifact.

## Symptom
启动了 `claude-code` runtime 的任务(终端内是 Claude Code 登录界面,tmux session
名 `taskdfa9e0:claude`),但任务卡片 tag rail 与终端头部仍显示 **Codex**。

## Data-flow trace (end-to-end)
| 环节 | 文件 | 结论 |
|------|------|------|
| 建任务发送 runtime | `apps/web/src/routes/_app/tasks/new.tsx:239` | ✅ 非默认 runtime 会发送 `runtime:"claude-code"` |
| 后端默认与持久化 | `apps/api/src/tasks/tasks.service.ts:475,513`;`packages/contracts/src/task.ts:65` | ✅ `DEFAULT_TASK_RUNTIME='codex'`,持久化到 `Task.runtime` 列 |
| 后端读回 | `packages/contracts/src/task.ts:173` `TaskView.runtime` | ✅ `getTask()` 返回对象**带** `runtime` 字段 |
| history 显示 | `apps/web/src/routes/_app/history.tsx:64,113,240` | ✅ `agentLabel(task.runtime)` 正确映射 Codex / Claude Code |
| **session 详情显示** | `apps/web/src/lib/api/queries.ts:412` | ❌ **`agent: "Codex"` 写死**,完全忽略 `task.runtime` |

## Root cause
`taskContextQuery`(`queries.ts:390-417`)在 `isCapable("tasks")` 分支里把
`agent` 硬编码为字面量 `"Codex"`。注释(396-400)写"agent/runtime 还没有后端字段,
故降级为诚实占位"——这条注释**已过时**:`add-claude-code-runtime` track 之后后端已有
`Task.runtime` 列,`history.tsx` 已跟进,唯独此处没改,占位符变成了说谎的硬编码。

终端头部 `{agent}·{repo}#{branch}`(`$taskId.tsx:114` `headLabel`)用同一 `agent`
变量,故卡片 chip 与终端头部一起错,同根。

## Tag rail truth table(截图 5 个 chip)
| Chip | 来源 | 真实性 | 处置 |
|------|------|--------|------|
| `feat/init`(分支) | `task.branch` | 真 | 保留 |
| `Codex`(agent) | `queries.ts:412` 写死 | **假** | 修:映射 `task.runtime` |
| `AIO Sandbox`(runtime) | `queries.ts:413` 写死;全平台唯一沙箱供应商 | 如实常量 | 保留(用户拍板) |
| `linux/amd64`(arch) | `session-header.tsx:62` 默认 prop,**无后端字段**,`$taskId.tsx` 从未传入 | **写死死代码** | 删除(无字段支撑,违反"绝不渲染未发送字段") |
| `默认守护栏`(guardrail) | `$taskId.tsx:136-143` 从 `task.idleTimeoutMs/deadlineMs` 真实计算 | 真 | 保留(用户拍板) |

## Spec-level root
`openspec/specs/frontend-console/spec.md` 的 `Session page design-revision layout`
requirement 把 tag rail **明文写死**为 `分支 / Codex / AIO Sandbox / linux-amd64 /
守护栏`(描述行 461、scenario 行 485-487)。修复需同步改这条规范,否则代码与规范冲突。

## Cleanest approach
`history.tsx:64` 已有正确的 `agentLabel(runtime)`。把它抽成单一共享工具,history 与
session 详情页共用——消除漂移(这正是漂移导致一处对一处错的 bug)。`linux/amd64` 整条
chip 与其 `arch` prop 一并删除(纯死代码,删比留更诚实)。后端、transcript 样例页不动。
