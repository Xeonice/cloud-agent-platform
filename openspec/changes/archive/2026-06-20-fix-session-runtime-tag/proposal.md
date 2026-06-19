## Why

Session 详情页(`/tasks/$taskId`)的 tag rail 与终端头部把 agent 标签**写死成
"Codex"**(`queries.ts:412`),即使任务以 `claude-code` runtime 启动也照样显示 Codex
——后端已正确持久化并返回 `task.runtime`、`history.tsx` 也已正确映射,唯独 session 详情
的展示层丢弃了它,误导操作者(实测:终端内是 Claude Code 登录界面,标签却写 Codex)。
同一 tag rail 还有一个 `linux/amd64` 标签,它是 `session-header.tsx` 的写死默认 prop,
无任何后端字段支撑,违反本仓库既有的"绝不渲染未发送字段"(D5.5)诚实显示原则。

## What Changes

- 把 session 详情页的 agent 标签(tag rail chip 与终端头部 `{agent}·{repo}#{branch}`
  label)从写死 `"Codex"` 改为映射任务真实 `runtime`:`codex`→`Codex`、
  `claude-code`→`Claude Code`、缺省→`Codex`。
- 把 `history.tsx` 已有且正确的 `agentLabel(runtime)` 映射抽成**单一共享工具**,history
  与 session 详情页共用,消除两处漂移(漂移正是本 bug 的成因)。
- **删除** tag rail 的 `linux/amd64`(arch)chip 及其 `arch` prop——无后端字段支撑的
  写死死代码。
- 保留 `AIO Sandbox`(如实的沙箱供应商常量)与 `守护栏`(从 `idleTimeoutMs/deadlineMs`
  真实计算)两个标签——二者均有真实依据。
- 同步更新 `frontend-console` 规范中 "Session page design-revision layout" requirement
  的 tag rail 定义,使其不再把 Codex / linux-amd64 写死。
- 不改后端,不改 transcript 样例页(`$taskId_.transcript.tsx:264` 的 `<SessionTag>`
  是 mock 演示数据)。

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `frontend-console`: "Session page design-revision layout" requirement 的 tag rail
  ——agent chip 反映任务真实 runtime 的人类可读标签(Codex / Claude Code),并移除无
  后端字段支撑的 `linux-amd64` chip;`AIO Sandbox` 与 `守护栏` chip 保留不变。

## Impact

- `apps/web/src/lib/api/queries.ts` — `taskContextQuery` 第 412 行写死的 agent。
- `apps/web/src/components/session/session-header.tsx` — 删除 `arch` prop 与第 153 行 chip;更新组件头注释。
- `apps/web/src/routes/_app/tasks/$taskId.tsx` — 传入 SessionHeader 的 agent 来源、不再依赖 arch 默认值。
- `apps/web/src/routes/_app/history.tsx` — `agentLabel` 提取为共享工具后改为 import。
- 新增共享映射工具(如 `apps/web/src/lib/runtime-label.ts`)。
- `openspec/specs/frontend-console/spec.md` — tag rail requirement/scenario delta。
- 视觉回归:session 页 tag rail 少一个 chip,若存在 session 页像素基线需重算/更新。
