# Research Brief — redesign-settings-single-column

Lightweight serial research pass (Workflow deep-research not used; change is a contained UI-layout reorganization).

## Current state (design baseline)

OD project `680d21c4` ("OpenSpec Agent System"), file `screens/settings.html`, design system `vercel`. The settings screen currently stacks **four mutually inconsistent layout systems** in one page:

1. Outer `grid-2` split `230px sticky │ 1fr` — a left in-page `.settings-nav` secondary anchor navigation (账户身份 / 仓库默认值 / 模型凭据 / 安全边界) that duplicates the outer app sidebar.
2. A `grid-3` "system strip" of 3 `.stat-tile` cards (ACCOUNT / CREDENTIAL / SAFETY) — purely decorative summaries that repeat the cards below them.
3. `section#account` as `grid-2 equal` (1:1) — identity card beside the access-and-defaults form.
4. `section#codex` as `grid-2` with a different `.45fr│1fr` ratio — a credential-intro card beside an activation card that nests `[data-tabs]` → `.provider-card` (tabs-in-card-in-card, 3 levels deep).

The visual clutter is structural: two different two-column ratios force the eye to re-align twice, plus a redundant nav column and redundant stat strip.

## Target pattern (Vercel settings backend)

Vercel's settings content area is a **single centered column of stacked cards**. Each card = one concern, with a uniform anatomy: header (title + one-line description) → body (a single control) → a footer action bar (top border, `--subtle` gray background, helper text on the left, primary button on the right). No in-content secondary nav; no decorative stat strip; no side-by-side columns.

## Reuse vs. new (CSS, verified)

- **Design tokens already present** in `css/platform.css :root`: `--border #ebebeb`, `--subtle #fafafa`, `--secondary #f5f5f5`, `--radius 8px`, `--muted`, `--shadow-card`. No new tokens needed.
- **Reusable component classes**: `.panel` / `.panel.pad`, `.field`, `.config-row`, `.config-list`, `.split-line`, `.btn` / `.btn.primary`, `.status-pill`, `.identity-card`, `.identity-avatar-row`.
- **Must add**: `.panel-foot` (the Vercel gray footer action bar) — `grep footer css/*.css` returns **zero** matches, so no footer/action-bar style exists today.
- **Removed from page (CSS classes may remain unused)**: `.settings-nav` / `.settings-nav-title`, the `grid-3` stat strip usage, the `grid-2` two-column wrappers around the account and codex sections.
- The two dialogs (`#official-dialog`, `#api-key-dialog`) are kept as-is.

## Spec mapping

- Governing spec: `frontend-console`, Requirement **"Settings page with account, GitHub, and Codex sections"** (currently mandates "a left secondary anchor navigation grouping account/github/codex/safety, a system-strip of 3 cards, and a settings grid"). This is the clause being rewritten → **Modified Capability: `frontend-console`**.
- All *functional* clauses of that requirement (save mutation + reset, slot-ceiling 1–20 validation + metrics invalidation, two Codex dialogs, masked saved key, synchronized credential status, GitHub-OAuth-vs-Codex separation) are **preserved** — only the layout/composition clause changes.
- `account-settings` spec (backend persistence + API) is unaffected — no data shape or endpoint changes.
- The "Required per-page pixel comparison against the design baselines" requirement keeps its mechanism; only the settings baseline screenshot is refreshed (a task, not a requirement change).

## Prior art

Archived design changes on the same OD prototype establish the workflow: `2026-06-11-console-design-pixel-merge`, `2026-06-14-session-cockpit-redesign`, `2026-06-14-unify-dialog-fixed-size`. They modify `frontend-console` layout requirements and refresh OD baselines — same pattern this change follows.
