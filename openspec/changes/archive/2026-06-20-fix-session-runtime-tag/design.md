## Context

Session 详情页(`/tasks/$taskId`)经由 `taskContextQuery`(`apps/web/src/lib/api/
queries.ts:390-417`)拼出头部上下文。在 `isCapable("tasks")` 真实分支里,`agent` 被
写死为字面量 `"Codex"`(第 412 行),完全忽略 `getTask()` 已返回的 `task.runtime`
字段(`packages/contracts/src/task.ts:173`)。`history.tsx:64` 的 `agentLabel(runtime)`
早已正确把 runtime 映射为人类可读标签,但 session 详情页没有复用它——两处实现漂移,
正是本 bug 的成因。

同一头部的 tag rail(`session-header.tsx:132-155`)还渲染一个 `arch` chip,默认值
`"linux/amd64"`(第 62 行),`$taskId.tsx` 从未向其传入 `arch`,且后端无任何对应字段
——纯写死死代码,违反本仓库既有的"绝不渲染未发送字段"(D5.5)原则。

`frontend-console` 规范 `Session page design-revision layout` requirement 在描述与
scenario 中把 tag rail 明文钉成 `分支 / Codex / AIO Sandbox / linux-amd64 / 守护栏`
——代码若修复而规范不动,二者将冲突。

## Goals / Non-Goals

**Goals:**
- session 详情页 agent 标签(tag rail chip 与终端头部 `{agent}·{repo}#{branch}`)如实
  反映任务持久化 runtime(Codex / Claude Code)。
- agent 标签映射逻辑单一来源,history 与 session 共用,杜绝再次漂移。
- 移除无后端字段支撑的 `linux/amd64` chip。
- 规范与代码同步收口。

**Non-Goals:**
- 不改后端任何代码(runtime 已正确持久化与读回)。
- 不动 `AIO Sandbox`(如实沙箱常量)与 `守护栏`(真实计算)两个标签。
- 不动 `$taskId_.transcript.tsx:264` 的 `<SessionTag>Codex</SessionTag>`(mock 演示数据)。
- 不引入新的后端"agent display name"字段——纯前端从既有 `runtime` 派生。

## Decisions

### D1：抽取单一共享 runtime-label 工具
新建 `apps/web/src/lib/runtime-label.ts`,导出 `agentLabel(runtime: Runtime | null
| undefined): string`(`claude-code` → `"Claude Code"`,其余/缺省 → `"Codex"`),逐字
搬运 `history.tsx:64` 现有实现。`history.tsx` 与 `queries.ts` 均改为 import 之。
- **为何**:漂移是本 bug 根因;单一来源从机制上消除复发。纯函数、零依赖,放 `lib/`
  最轻。
- **备选**:把映射放进 `@cap/contracts`(后端也能用)——否决,当前只有前端两处需要,
  跨包提升属过度设计;后端如将来需要再上提。

### D2：彻底删除 `arch` chip 与 prop(而非传空字符串)
从 `session-header.tsx` 删除 `arch` prop、第 153 行 `<SessionTag mono>{arch}</SessionTag>`,
并更新组件头 JSDoc 的 tag rail 描述。`$taskId.tsx` 本就未传 `arch`,无调用方改动。
- **为何**:它是从未被赋真值的默认死代码,删干净比保留一个永远为占位的 prop 更诚实、
  更少误导后续维护者。
- **备选**:保留 prop、传真实平台值——否决,后端无该字段,造真实值即是 fabrication。

### D3：只修真实路径,mock 路径保持原状
仅改 `queries.ts` 真实分支:`agent: agentLabel(task.runtime)`(`runtime` chip 仍为
如实常量 `"AIO Sandbox"`)。`isCapable("tasks")` 为假时的 `mockTaskContext` 路径
(`mock.ts` 的 `agent: "Codex (gpt-5-codex)"`)不动——它是设计基线的占位演示数据。
- **为何**:最小变更面;mock 是脱机演示语义,不代表真实任务。

### D4：终端头部 label 与 tag chip 同源
`$taskId.tsx` 的 `headLabel = ${agent}·${repo}#${branch}` 与 SessionHeader 的 agent
chip 使用同一个 `agent` 值(均来自 `context.agent`,经 D1/D3 后已是真实 runtime label),
天然一致,无需额外改动——仅需确保 `context.agent` 正确即可两处同时修正。

## Risks / Trade-offs

- [视觉回归:tag rail 少一个 chip,session 页像素基线可能失配] → 若仓库存在 session 页
  视觉基线(`test:visual`),在 apply 时重算/更新该基线;chip 减少是预期变化,非缺陷。
- [`runtime` 为 `null` 的历史任务] → `agentLabel` 已对 `null/undefined` 兜底为 `Codex`
  (与后端 `DEFAULT_TASK_RUNTIME='codex'` 语义一致),不会出现空白或异常标签。
- [mock 路径与真实路径标签文案不同(`Codex (gpt-5-codex)` vs `Codex`)] → 可接受:
  capability 开关一旦翻真,即走真实路径;mock 仅脱机演示,二者本就允许不同保真度。

## Migration Plan

纯前端展示层修复,无数据迁移、无 API 变更、无后端部署。随前端常规构建/部署上线即可;
回滚 = 还原前端提交。

## Open Questions

- **视觉门禁(`test:visual`)在 main 上已断链,独立于本 change**:apply 期发现
  `apps/web/e2e/serve-design-baseline.mjs` 的基线 ROOT 指向
  `openspec/changes/pixel-restore-console-to-od/design-baseline`,但该 change 已于
  2026-06-19 归档(`git ls-files` tracked = 0,实体移到 `archive/2026-06-19-…`),
  故视觉套件当前无法在本地跑通——这是 pixel-restore 归档时遗留的断链,先于本 change。
  本 change 的视觉影响已离线分析:视觉测试以 `VITE_FORCE_MOCK=1` 运行、session 走
  `mockTaskContext`,故 `queries.ts` real 分支改动不触及视觉测试;唯一变化是组件层删
  1 个 arch chip,粗估 diff 增量在 session 页现有阈值 headroom 内(desktop
  0.07→~0.073 vs 0.085;mobile 0.04→~0.043 vs 0.06)。归档的冻结设计稿 `session.html`
  仍含 `linux/amd64` 与写死 `Codex` chip;严格一致性需在门禁断链修复后,于设计基线侧
  同步删除 arch chip(或经 `VV_MEASURE` 重算阈值)。**是否在本 change 顺带修复 serve
  路径断链、是否同步设计基线,留待操作者决定**——二者均触碰本 change scope 之外的资产。
- **活环境验证(task 4.3)需 live backend**:用 `claude-code` runtime 建任务确认
  详情页显示 `Claude Code`、无 `linux/amd64` chip,属部署期活验,在操作者环境执行。
