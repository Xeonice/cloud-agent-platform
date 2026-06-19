## Context

`test:visual`(playwright pixel gate)的工作方式:`playwright.config.ts` 的 webServer[0]
跑 `serve-design-baseline.mjs` 静态托管 design-baseline 的 HTML,`baseline.capture.ts`
(`design-baseline` project)按 `manifest.ts` 的 `designPath` 截图设计稿生成 living
baseline 到 `__screenshots__/`(gitignored),`pixel.spec.ts`(`console` project,依赖前者)
再用 app 渲染 `toHaveScreenshot()` 比对。

断链根因:design-baseline 的 HTML source 住在 **change 目录**里。`serve-design-baseline.mjs`
的 ROOT 被 pixel-restore-console-to-od 改指向自己的 `openspec/changes/pixel-restore-console-to-od/
design-baseline`(注释自述 "Re-pointed at the FROZEN finalized baseline"),该 change 归档后
路径消失。`frontend-console` spec 的 "Console restored to the finalized design baseline"
requirement 把同一 change 路径写进了规范。`verify-replay.mjs`(one-off 手动脚本,非 suite)
同样断在 `session-sandbox-retention` archive。

archive 下内容完整(`archive/2026-06-19-pixel-restore-console-to-od/design-baseline/`:
`index.html`/`login.html` + `screens/`(8 页)+ `css`/`js`/`components`)。

## Goals / Non-Goals

**Goals:**
- 视觉门禁在 main 上可运行(serve 起得来、baseline capture 成功)。
- design-baseline source 住在不随 change 归档移动的稳定位置,根治反复断链。
- 两处断链(serve + verify-replay)一并修。

**Non-Goals:**
- 不改基线**内容**(HTML/CSS),不改 manifest 阈值/designPath 相对路径。
- 不处理 [[fix-session-runtime-tag]] 删 arch chip 与基线的一致性(留待门禁恢复后单独决定
  同步设计稿 vs 重算阈值)。
- 不动 archive(历史快照,不可变)。

## Decisions

### D1：稳定位置 = `apps/web/e2e/design-baseline/`
- **为何**:与 `serve-design-baseline.mjs`/`manifest.ts`/`baseline.capture.ts` 同在
  `apps/web/e2e` 树下,相对路径最短最稳;随 `@cap/web` 包走;**不在 `openspec/changes/` 下**,
  故任何 propose/archive 动作永不触及它。
- **备选**:仓库根 `design-baseline/`——否决,测试 fixture 离消费它的测试套件越近越清晰。
  保留在 change 目录并每次归档时重指向——否决,正是当前反模式。

### D2：复制 2026-06-19 冻结快照作为初始内容
- 从 `archive/2026-06-19-pixel-restore-console-to-od/design-baseline/` 整树复制到稳定位置。
  archive 保持不动:archive 是不可变历史快照,稳定位置是 living source,分工明确。
- `history-replay-preview.html` 从 `archive/2026-06-15-session-sandbox-retention/design-baseline/`
  一并复制进稳定位置(verify-replay 依赖)。

### D3：重指向引用,relative 路径
- `serve-design-baseline.mjs` ROOT:`../../../openspec/changes/…` → `../design-baseline`
  (相对 `apps/web/e2e/`)。
- `verify-replay.mjs` BASELINE:指向 `../design-baseline/history-replay-preview.html`。
- `baseline.capture.ts` / `manifest.ts` 注释里的过期 change 路径改为稳定位置描述。
- `manifest.ts` 的 `designPath`(如 `/screens/session.html`)是相对 serve root 的 URL,
  **不变**。

### D4：规范确立"基线 source 不住在 change 目录"
spec requirement 改为指向稳定位置,并加一句约束,防止未来 pixel change 再把 ROOT 指回
自己的 change 目录而重蹈覆辙。

## Risks / Trade-offs

- [复制产生两份 design-baseline(archive 冻结 + 稳定 living)] → 语义不同:archive 是
  某次归档的历史定格,稳定位置是当前 living 基线;后续 UI change 只更新稳定位置。
- [稳定位置基线仍含 `linux/amd64` + 写死 `Codex` chip] → 本 change 不改内容;与
  [[fix-session-runtime-tag]] 的一致性是已知后续(见 Open Questions)。
- [本地实跑 test:visual 需 playwright chromium + dev server] → chromium 已装;若本地跑
  完整 suite 过重,至少验证 serve 起得来 + `design-baseline` capture project 成功(门禁
  可运行性的最小证明),完整 per-page 对比可留 CI/部署期。

## Migration Plan

纯测试基础设施改动,无运行时/部署影响。回滚 = 还原引用路径与删除新增目录。

## Open Questions

- 门禁恢复可运行后,session 页基线(稳定位置的 `screens/session.html`)仍含
  `linux/amd64` 与写死 `Codex` chip,而 [[fix-session-runtime-tag]] 已在 app 侧删除/改真实
  runtime。需要在后续单独决定:同步删除基线该 chip(设计与实现一致),还是经 `VV_MEASURE`
  重算 session 页阈值吸收该差异。本 change 不在范围内。
