<!-- Track-annotated tasks. Design baseline (OD prototype) first, then mirror into the
     frontend app, then refresh the pixel baseline. -->

## 1. Track: design-baseline (depends: none)  — DONE (applied directly to OD `680d21c4`, verified in-browser)

- [x] 1.1 In `css/platform.css` (OD `680d21c4`), add a `.settings-stack` single-column wrapper (`max-width ≈ 640px`, `gap: 24px`, vertical) and a `.panel-foot` footer action bar (top border via `inset 0 1px 0 var(--border)`, `background: var(--subtle)`, `display:flex; justify-content:space-between; align-items:center`), plus a `.settings-card-head` title/desc block — reuse existing tokens only, add no new tokens. (Reused the existing `.panel-body`; no `.segmented` needed since `.tabs` already is a 2-up segmented control.)
- [x] 1.2 In `screens/settings.html`, remove the outer `grid-2 230px│1fr` wrapper and the left `.settings-nav` anchor navigation, and remove the `grid-3` system strip of `.stat-tile` cards.
- [x] 1.3 In `screens/settings.html`, replace the two side-by-side sections with a `.settings-stack` column: a read-only identity card (no footer), then one-setting cards for allowed GitHub account, default repo, retention, write-confirm, and the task-slot ceiling — each with a `.panel-foot` save footer carrying helper text and a `.btn.primary`.
- [x] 1.4 In `screens/settings.html`, flatten the Codex section into a single `.panel` card: status pill + a `role="tablist"` control (官方 Codex / 兼容提供方) reusing the existing `[data-tabs]` JS, plus the selected mode's status row and configure button.
- [x] 1.5 Verify in the OD render that the page is a single vertical column, no in-page nav, no stat strip, each editable card saves via its own footer, the segmented control toggles modes, and the dialogs still open. (Confirmed via local render + screenshots.)
- [x] 1.6 Vercel-ify the two Codex dialogs in `screens/settings.html` + `css/platform.css`: add scoped `.dialog.dialog-sm` (≈460px) and `.dialog-foot` (top border + `--subtle`, right-aligned `[取消][primary]`); drop the eyebrow kicker, shrink the title, move actions into the footer; leave the shared `.dialog` (新建任务/导入仓库) untouched. Verified both dialogs render compact with footer actions.
- [x] 1.7 Add the connection-verification flow to the api-key dialog: a `[data-conn-test]` box (未验证 → 验证中 → 已连接 pill), a revealed `默认模型` picker, a gated (initially `disabled`) 保存凭据 button, and `initConnectionTest()` in `js/platform.js` (simulated 700ms probe; `data-state="ok"` → `--success-soft` tint). Verified the gated test → fetch-models → enable-save flow end-to-end in the render.

## 2. Track: frontend-app (depends: design-baseline)

- [ ] 2.1 In `apps/web/src/routes/_app/settings.tsx`, remove the `settings-side-nav` and `system-strip` from the layout and arrange the page as a single-column card stack mirroring the new baseline.
- [ ] 2.2 Split `apps/web/src/components/settings/settings-form.tsx` into discrete one-setting cards (allowed account read-only, default repo, retention, write-confirm, slot ceiling), each rendering a footer action bar via `panel.tsx`; keep `saveSettingsMutation` wiring, reset-to-defaults, and the slot-ceiling 1–20 validation + metrics-query invalidation intact.
- [ ] 2.3 Extend `apps/web/src/components/settings/panel.tsx` with a footer/action-bar slot (mapping to `.panel-foot`) and a body wrapper, so editable cards render helper text + save button and the read-only identity card renders no action.
- [ ] 2.4 Replace `apps/web/src/components/settings/codex-tabs.tsx` (and fold `codex-status-panel.tsx`) into a single Codex card with a segmented control; keep `codex-state.ts`, `codex-api-key-dialog.tsx`, and `codex-direct-dialog.tsx` behavior and the 未连接/未保存/已连接 status synchronization unchanged.
- [ ] 2.5 Delete or retire the now-unused `settings-side-nav.tsx` and `system-strip.tsx` and remove their imports.
- [ ] 2.6 Run the web app's typecheck/lint/build to confirm the `/settings` route compiles with the removed components gone.

## 3. Track: baseline-verify (depends: frontend-app)

- [ ] 3.1 Capture a fresh `/settings` screenshot from the OD prototype and replace the stored `/settings` design baseline used by the per-page pixel-comparison requirement.
- [ ] 3.2 Run the per-page pixel comparison for `/settings` against the refreshed baseline and confirm the frontend route matches the OD prototype within the established tolerance.
