## Why

视觉门禁(`pnpm --filter @cap/web test:visual`)在 main 上跑不通:测试基础设施把
design-baseline 的 source-of-truth 放在 **change 目录**
(`openspec/changes/pixel-restore-console-to-od/design-baseline`),而该 change 已于
2026-06-19 归档移走 → `serve-design-baseline.mjs` 的 ROOT、`verify-replay.mjs` 的
BASELINE、以及 `frontend-console` spec 钉死的路径全部指向不存在的目录。这是个**反复出现
的反模式**(2026-06-11 → 2026-06-19,每次 pixel change 归档都把门禁基线带走一次),且
有规范级根源:spec requirement 把基线位置写进了会被归档的 change 路径。

## What Changes

- 把 design-baseline 的 HTML source(2026-06-19 冻结快照:10 screens + `platform.css`/
  js + components)**提升到稳定位置 `apps/web/e2e/design-baseline/`**,不再随任何 change
  归档移动——确立"门禁基线的 source 不住在会被归档的 change 目录"。
- 一并纳入 `verify-replay.mjs` 依赖的 `history-replay-preview.html`(现断在
  `session-sandbox-retention` archive)到稳定位置,修第二处同类断链。
- 重指向全部引用:`serve-design-baseline.mjs` ROOT、`verify-replay.mjs` BASELINE,并
  清理 `baseline.capture.ts` / `manifest.ts` 注释里的过期 change 路径。
- 修改 `frontend-console` spec requirement "Console restored to the finalized design
  baseline",把基线位置从 change 目录改为稳定的 `apps/web/e2e/design-baseline/`(内容
  仍是 2026-06-19 冻结快照),并明确"基线 source 不放在会归档的 change 目录"这一约束。
- 不改基线**内容**、不改 manifest 阈值——本 change 只恢复门禁的可运行性。

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `frontend-console`: "Console restored to the finalized design baseline" requirement
  的基线位置(`openspec/changes/pixel-restore-console-to-od/design-baseline/` → 稳定的
  `apps/web/e2e/design-baseline/`),并加入"基线 source 不得住在会被归档的 change 目录"
  的规范约束。

## Impact

- 新增 `apps/web/e2e/design-baseline/`(从 `archive/2026-06-19-pixel-restore-console-to-od/
  design-baseline` 复制;archive 保持不动)。
- `apps/web/e2e/serve-design-baseline.mjs` — ROOT 路径。
- `apps/web/e2e/visual/verify-replay.mjs` — BASELINE 路径。
- `apps/web/e2e/visual/baseline.capture.ts` / `manifest.ts` — 注释里的过期 change 路径。
- `openspec/specs/frontend-console/spec.md` — requirement delta。
- 不触碰 `__screenshots__`(gitignored,运行时重新 capture)。
