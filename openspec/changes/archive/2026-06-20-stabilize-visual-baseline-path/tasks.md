## 1. Track: relocate-baseline (depends: none)

- [x] 1.1 把 `openspec/changes/archive/2026-06-19-pixel-restore-console-to-od/design-baseline/` 整树复制到稳定位置 `apps/web/e2e/design-baseline/`(保持 `index.html` / `login.html` / `screens/`(8 页)/ `css` / `js` / `components` 结构);archive 保持不动
- [x] 1.2 把 `openspec/changes/archive/2026-06-15-session-sandbox-retention/design-baseline/history-replay-preview.html` 复制进 `apps/web/e2e/design-baseline/`(`verify-replay.mjs` 依赖)
- [x] 1.3 `git add apps/web/e2e/design-baseline/` 确认全部静态资产纳入版本控制(不被 `__screenshots__`/gitignore 误伤)

## 2. Track: repoint-refs (depends: relocate-baseline)

- [x] 2.1 `apps/web/e2e/serve-design-baseline.mjs`:ROOT 从 `../../../openspec/changes/pixel-restore-console-to-od/design-baseline` 改为 `../design-baseline`(相对 `apps/web/e2e/`);更新文件头注释说明基线现住稳定位置、不再随 change 归档移动
- [x] 2.2 `apps/web/e2e/visual/verify-replay.mjs`:BASELINE 从 `../../../../openspec/changes/session-sandbox-retention/design-baseline/history-replay-preview.html` 改为 `../design-baseline/history-replay-preview.html`(相对 `apps/web/e2e/visual/`)
- [x] 2.3 清理 `apps/web/e2e/visual/baseline.capture.ts` 与 `apps/web/e2e/visual/manifest.ts` 注释里的过期 change 路径(`archive/2026-06-11-…` / `pixel-restore-console-to-od/design-baseline`),改为指向稳定位置 `apps/web/e2e/design-baseline/`;`manifest.ts` 的 `designPath`(相对 serve root,如 `/screens/session.html`)不变

## 3. Track: verify (depends: repoint-refs)

- [x] 3.1 跑 `pnpm --filter @cap/web test:visual`(playwright chromium 已装),确认门禁恢复可运行:webServer 的 `serve-design-baseline.mjs` 起得来、`design-baseline` capture project 成功截图、`console` project 能执行比对(不再因路径缺失而崩)
- [x] 3.2 记录 session 页结果:因 [[fix-session-runtime-tag]] 已删 app 侧 `linux/amd64` chip 而稳定基线仍含该 chip,观察 session 页 diff 是否仍在 manifest 阈值(0.085/0.06)内;若超阈值,按 design Open Questions 归入后续(同步基线 chip 或重算阈值),不在本 change 放宽阈值掩盖
