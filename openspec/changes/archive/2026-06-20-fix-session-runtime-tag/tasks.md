## 1. Track: shared-runtime-label (depends: none)

- [x] 1.1 新建 `apps/web/src/lib/runtime-label.ts`,导出 `agentLabel(runtime: Runtime | null | undefined): string`(逐字搬运 `history.tsx:64` 现有实现:`claude-code` → `"Claude Code"`,其余/缺省 → `"Codex"`),带 JSDoc 说明它是 session 详情页与 history 页共用的单一来源
- [x] 1.2 为 `runtime-label.ts` 加最小单测:`claude-code`→`Claude Code`、`codex`→`Codex`、`null`/`undefined`→`Codex`

## 2. Track: consume-runtime-label (depends: shared-runtime-label)

- [x] 2.1 `apps/web/src/routes/_app/history.tsx`:删除本地 `agentLabel` 定义,改为从 `@/lib/runtime-label` import,保持 `agentLabel(task.runtime)` 两处调用不变
- [x] 2.2 `apps/web/src/lib/api/queries.ts` 的 `taskContextQuery`:把第 412 行写死的 `agent: "Codex"` 改为 `agent: agentLabel(task.runtime)`(import 共享工具);`runtime: "AIO Sandbox"` 常量保持不变;更新第 396-400 处过时注释(后端已有 runtime 字段)

## 3. Track: drop-arch-chip (depends: none)

- [x] 3.1 `apps/web/src/components/session/session-header.tsx`:删除 `arch` prop(接口、解构、默认值)与第 153 行 `<SessionTag mono>{arch}</SessionTag>` chip;更新组件头 JSDoc 中 tag rail 描述(去掉 `linux-amd64`),tag rail 余 分支 / agent / AIO Sandbox / 守护栏 四 chip
- [x] 3.2 `apps/web/src/routes/_app/tasks/$taskId.tsx`:核对不再向 `SessionHeader` 传 `arch`(本就未传),确认 `agent`/`runtime`/`guardrail` 传递不受影响;`headLabel` 的 `{agent}` 随 context.agent 自动修正,无需改动

## 4. Track: verify (depends: consume-runtime-label, drop-arch-chip)

- [x] 4.1 跑 `turbo build` + `turbo typecheck lint`(CI 闸门),确保删 `arch` prop 后无残留引用、import 路径正确
- [ ] 4.2 若存在 session 页视觉基线(`test:visual`),重算/更新该基线吸收 tag rail 少一个 chip 的预期变化;无基线则跳过并说明
- [ ] 4.3 活环境验证:用 `claude-code` runtime 建任务,确认详情页 tag rail 与终端头部均显示 `Claude Code`、不再出现 `linux/amd64` chip;`codex` 任务仍显示 `Codex`;history 页两类任务标签与详情页一致
