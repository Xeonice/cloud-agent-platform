## Context

The `/settings` page (design baseline: OD project `680d21c4`, `screens/settings.html`; styles in `css/platform.css`) currently composes four inconsistent layout systems: a `230px sticky │ 1fr` outer grid with a left `.settings-nav` anchor list, a `grid-3` strip of `.stat-tile` summary cards, and two side-by-side sections at *different* ratios (`grid-2 equal` for account, `grid-2 .45fr│1fr` for codex) — the codex one nesting `[data-tabs]` → `.provider-card`. The design system is already `vercel`; the tokens we need (`--border`, `--subtle`, `--secondary`, `--radius`, `--muted`, `--shadow-card`) all exist. What's missing is a footer action-bar style — `grep footer css/*.css` returns nothing.

This is a presentation-only redesign. The functional contract of the settings page (save/reset mutation, slot-ceiling validation, Codex dialogs, masked key, synchronized credential status, OAuth-vs-Codex separation) is unchanged; only the markup composition and a small amount of CSS change.

## Goals / Non-Goals

**Goals:**
- Reorganize `/settings` into a single top-to-bottom column of cards, one setting per card, matching the Vercel settings backend pattern.
- Introduce a reusable `.panel-foot` footer action bar so every editable card has a consistent "helper text left / save button right" footer.
- Maximize reuse of existing tokens and component classes; add the minimum new CSS.
- Keep the design baseline (OD prototype) and the frontend app `/settings` route visually in sync, and refresh the per-page pixel baseline.

**Non-Goals:**
- No change to the settings API, persistence, contracts schema, or any data shape.
- No change to the two Codex dialogs' internal flows (`#official-dialog`, `#api-key-dialog`).
- No change to the outer app shell / sidebar / mobile nav.
- Not adding dark mode, new settings, or new validation rules.

## Decisions

### D1 — Single column, one setting per card (strict Vercel granularity)
Replace the outer `grid-2` and both inner two-column sections with a single `.settings-stack` wrapper: one vertical column, `max-width ≈ 640px`, `gap: 24px`. Each concern becomes its own `.panel` card.

Card inventory (top → bottom):
1. **当前身份** — read-only identity card (reuse `.identity-card` / `.identity-avatar-row` / `.config-list`); **no footer**.
2. **允许进入的 GitHub 账号** — read-only input + footer (helper "只有此账号可进入控制台").
3. **默认仓库** — `select` + footer.
4. **会话记录保留** — `select` + footer.
5. **写入前必须确认** — toggle/checkbox row + footer.
6. **任务并发上限 (slot ceiling)** — numeric control (integer 1–20, default 5) + footer; preserves the existing system-wide semantics and metrics-invalidation behavior.
7. **Agent 模型凭据** — single card: status row + segmented 官方 Codex / 兼容提供方 switch + the active provider's status/action; opens the two existing dialogs.

_Alternative considered_: group several settings into one "access & defaults" card with one shared save (the old form). Rejected — the user explicitly chose strict one-setting-per-card for maximum Vercel fidelity, and discrete footers make each save's scope obvious.

### D2 — New `.panel-foot` footer action bar
Add one CSS component:
- top `1px solid var(--border)`, `background: var(--subtle)`, horizontal padding matching `.panel.pad`, vertical padding ~`14px`;
- `display:flex; justify-content:space-between; align-items:center; gap:12px`;
- left slot = muted helper text (`color: var(--muted)`, 13px), right slot = `.btn.primary`.

To let the footer bleed edge-to-edge inside a padded card, cards with a footer use `.panel` (no `.pad`) with an inner `.panel-body` (carries the padding) followed by `.panel-foot`, rather than `.panel.pad`. Read-only cards keep `.panel.pad` and omit the footer.

_Alternative considered_: negative-margin a footer inside `.panel.pad`. Rejected — body/foot split is cleaner and less fragile across breakpoints.

### D3 — Flatten the Codex section to one card with a segmented switch
Collapse `grid-2 .45fr│1fr` (intro card + activation card) and the nested `[data-tabs]` → `.provider-card` into a single `.panel` card: a header with the credential status pill, a segmented control (官方 Codex 账号 / 兼容模型提供方) replacing the tab strip, and below it the selected mode's status line + configure button. The `data-tabs` toggle behavior in `js/platform.js` is reused (the segmented control is the same role="tablist" pattern restyled); the two dialogs are untouched. Credential status stays synchronized across the status pill, the segment subtitle, and the provider row.

### D4 — Remove, don't delete, the orphaned CSS
`.settings-nav*`, the stat-strip usage, and the two-column section wrappers stop being referenced by the markup. Leave the now-unused CSS rules in place (or prune in a follow-up) to keep this change's diff focused on the new layout; no other screen references `.settings-nav`.

### D5 — Mirror baseline → frontend, then re-baseline
Update the OD prototype `screens/settings.html` + `css/platform.css` first (the design source of truth), then port the same composition into the TanStack `/settings` route with identical data/mutation wiring. Finally refresh the `/settings` OD baseline screenshot so the existing per-page pixel-comparison requirement runs against the new layout.

### D6 — Compact, scoped dialog shell for the two Codex dialogs
The shared `.dialog` is a single 820px fixed-width shell (set by the archived unify-dialog-fixed-size change). At 820px the two Codex settings dialogs — a status confirm and a 2-field key form — read as empty and un-Vercel. Rather than shrink the global shell (which would also re-size 新建任务 / 导入仓库), add a **scoped modifier** `.dialog.dialog-sm` (≈460px) plus a `.dialog-foot` footer-action-bar component, and apply them only to `#official-dialog` / `#api-key-dialog`. Each dialog drops its mono "eyebrow" kicker, uses a 17px title, moves its actions into `.dialog-foot` (top border + `--subtle`, right-aligned `[取消] [primary]`), and the official dialog renders its status as a `provider-meta` info row.

_Compatibility with the fixed-size-dialog rule_: that requirement mandates "each dialog retains its **configured** width" (per-dialog fixed widths), not one global width, and explicitly names the Codex dialogs as panel dialogs that "keep their existing fixed widths". 460px is still a fixed width → compliant. `.dialog-sm` content still grows within the fixed width and the shell stays height-capped.

_Alternative considered_: shrink global `.dialog`. Rejected — it would regress the content-rich task/import dialogs that need the width.

### D7 — Connection-verification flow on the compatible-provider dialog
The compatible provider is only useful once codex can actually reach it, so the dialog must verify before it saves. Flow: `测试连接` → set status to 验证中 → on success show a green "已连接" pill + "拉取到 N 个可用模型", reveal a 默认模型 `<select>`, and enable the gated 保存凭据 button (disabled until then). In the OD prototype this is driven by a new `initConnectionTest()` in `js/platform.js` (a ~700ms simulated probe; the box gains `data-state="ok"` for a `--success-soft` tint). In the real app this maps 1:1 onto the **existing** `POST /settings/codex/models` candidate-discovery endpoint (validate auth + list models without persisting), so no new backend contract is implied — only the frontend wiring to call it, populate the picker, and gate save.

_Rationale for adding interactive JS to a "design" prototype_: the OD prototype already ships live interactions (segmented, reveal, dialogs, account menu) in `platform.js`; a simulated verification keeps the baseline demonstrable and matches the spec's `测试 → fetch-models → 选默认模型 → 保存` shape. A purely static "verified end-state" mock was considered and rejected as less faithful to the flow being specified.

## Risks / Trade-offs

- **More cards = more save buttons** → each footer's helper text names exactly what it saves; the identity card (read-only) has no footer to avoid implying an action. Net clarity is higher than one giant form.
- **`.panel-foot` body/foot split diverges from the `.panel.pad` cards used elsewhere** → scope `.panel-foot` + `.panel-body` to settings cards; do not refactor other screens. Visual result still uses the same border/radius/shadow tokens.
- **Segmented control reuses the tabs JS** → keep the `role="tablist"`/`aria-selected` structure so `[data-tabs]` keeps working; only the CSS skin changes. Verify keyboard + status-sync scenarios still pass.
- **Pixel baseline drift** → the redesign intentionally changes the baseline; refresh the `/settings` baseline screenshot as an explicit task so the comparison gate is meaningful rather than failing on the old image.
- **Frontend/baseline drift** → port the frontend `/settings` route in the same change so the spec's "matches design baseline" expectation holds.

## Migration Plan

Presentation-only; no data migration. Rollback = revert the markup/CSS commit and restore the previous `/settings` baseline screenshot. No flags, no API/version coupling.
