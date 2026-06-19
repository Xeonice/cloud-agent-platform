## Why

The `/settings` page stacks four mutually inconsistent layout systems in one view — a 230px in-page anchor nav (duplicating the app sidebar), a decorative 3-card system strip (repeating the cards below it), and two side-by-side sections at two *different* column ratios (1:1 and .45:1) with the Codex controls nested tabs-in-card-in-card. The result reads as cluttered and forces the eye to re-align repeatedly. We are aligning the page to the Vercel settings backend pattern: a single, top-to-bottom column where each setting is one self-contained card.

## What Changes

- **Remove** the in-page `.settings-nav` secondary anchor navigation (account/github/codex/safety). Navigation stays with the outer app sidebar only.
- **Remove** the decorative 3-card system strip (ACCOUNT / CREDENTIAL / SAFETY stat tiles).
- **Re-layout** the page as a single vertical column (`max-width ≈ 640px`) of stacked cards — one setting per card — replacing the two side-by-side `grid-2` sections.
- **Split** the access-and-defaults form into discrete one-setting cards: allowed GitHub account (read-only), default repository, history retention, write-confirm gate, and the system task-slot ceiling — each carrying its own footer save action.
- **Add** a Vercel-style card footer action bar `.panel-foot` (top border + `--subtle` background, helper text left / primary button right) — no such footer/action-bar style exists today.
- **Flatten** the Codex credential section from tabs-nested-in-card to a single card with a segmented 官方 Codex / 兼容提供方 switch plus status row.
- **Vercel-ify the two Codex dialogs** (`#official-dialog`, `#api-key-dialog`): a scoped compact shell `.dialog-sm` (≈460px fixed width, no 820px sprawl), a smaller title with the marketing eyebrow removed, and a dedicated footer action bar `.dialog-foot` (top border + `--subtle` background) carrying a right-aligned `[取消] [primary]` pair instead of a body-embedded full-width button. Scoped so the shared `.dialog` (新建任务 / 导入仓库) is untouched.
- **Add a connection-verification step to the compatible-provider dialog**: Base URL + API Key → 测试连接 → on success surface "拉取到 N 个可用模型" and reveal a 默认模型 picker → 保存凭据 is gated (disabled until a successful test). This closes the prototype to the `测试 → fetch-available-models → 选默认模型 → 保存` loop the `account-settings`/`frontend-console` specs already describe.
- Keep the identity card as a read-only card (no footer action).
- **Preserve all existing behavior**: save mutation + reset-to-defaults, slot-ceiling integer 1–20 validation and metrics-query invalidation, the two Codex dialogs, masked saved API key, synchronized credential status across status card / tab subtitle / provider pill, and the GitHub-OAuth-vs-Codex-credential separation.
- Refresh the OD design baseline screenshot for `/settings` so the per-page pixel comparison runs against the new single-column layout.

This redesign is presentation-level: no API, data shape, or persistence behavior changes. The added connection-verification step is a UX flow over the **already-shipped** backend endpoint `POST /settings/codex/models` (candidate model discovery), so it introduces no new backend contract — the OD prototype simulates it with a small client-side script.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `frontend-console`: the "Settings page with account, GitHub, and Codex sections" requirement changes its layout/composition clause from "left secondary anchor navigation + 3-card system strip + two-column settings grid" to a single vertical column of one-setting-per-card panels with per-card footer action bars; all functional clauses (save/reset, slot-ceiling validation, Codex dialogs, masked key, synchronized status, OAuth/Codex separation) are retained.

## Impact

- **Design baseline**: OD project `680d21c4`, `screens/settings.html` (markup re-composed + both Codex dialogs rebuilt with `.dialog-sm`/`.dialog-foot` + a connection-verification block), `css/platform.css` (new `.panel-foot` + single-column stack styles + `.dialog-sm`/`.dialog-foot` + a `[data-conn-test][data-state="ok"]` success state; `.settings-nav` / stat-strip / two-column-grid styles become unused), `js/platform.js` (new `initConnectionTest()` simulating 测试连接 → 拉模型 → 解禁保存), and the refreshed `/settings` baseline screenshot.
- **Frontend app**: the TanStack `/settings` route composition and its page-level styles, to mirror the new baseline (same data/mutation wiring, re-arranged into the single-column card stack).
- **Unaffected**: `account-settings` backend (persistence + read/update API), contracts schema, and all settings data shapes.
