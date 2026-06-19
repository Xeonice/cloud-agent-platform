## Context

`apps/web` (TanStack Start + shadcn/ui, shared primitives in `packages/ui`) implements all the console screens but was last visually aligned to the design prototype on 2026-06-11. The Open Design prototype `680d21c4` has since been finalized through many revisions and is the signed-off visual contract; its state is frozen in `design-baseline/` (10 screens + `platform.css` + `platform.js`).

Crucially, the **design-token layer is already a faithful port**: `apps/web/src/styles/app.css` is documented as "the SINGLE design-token contract" mirroring `platform.css` (same hexes, dark ink buttons, 1px `shadow-ring` borders, dark terminal scope), and `@cap/ui` re-imports it. So this is a component/layout re-sync plus two new views — not a theme rebuild.

This change is large but mechanical-per-screen: each screen has a frozen reference to match. The risk is drift (subjective "close enough") and collision with in-flight changes, so the design centers on a **verifiable diff loop** and **clear absorption boundaries**.

## Goals / Non-Goals

**Goals:**
- `apps/web` console visually matches the frozen `design-baseline/` for every screen, verified per-screen with Playwright.
- The two designed-but-unbuilt views (会话记录 transcript, API 调试) exist as real routes.
- Residual token deltas (Geist fonts, flatter shadows) adopted once, centrally.
- Approval/write-gate UI fully removed; settings credentials reorganized by runtime incl. Claude Code.
- Shared visual primitives live in `@cap/ui`, not duplicated per page.

**Non-Goals:**
- No backend behavior change (consumes existing `public-v1-api` and `session-transcript-persistence` contracts).
- No change to the marketing site `apps/www` (the OD `index.html` maps to the console landing `apps/web/routes/index.tsx`).
- Not rebuilding the terminal-record mechanism from `static-terminal-log` — only restyling its surface.
- Not re-deriving color tokens (already matched).

## Decisions

**D1 — Single change, screen-by-screen tasks, global layer first.**
One change (per decision), but sequenced: (1) global tokens/fonts/shared primitives → (2) existing screens re-sync → (3) two new views. Rationale: Geist + flatter shadows touch every screen, so landing them first avoids re-touching. New views go last (API debug depends on `public-v1-api`). Alternative (per-screen changes) rejected — the user wants one coordinated restoration and the global layer is shared.

**D2 — Faithful diff loop as the definition of done.**
Serve the frozen `design-baseline/<screen>.html` via a static server and render the matching `apps/web` route; screenshot both at a fixed viewport with Playwright; compare. A screen is "done" when it matches the baseline. Rationale: "忠实逐帧" needs an objective check, and the baseline is frozen so the target can't move. The baseline HTML/CSS is the oracle, not a live OD daemon.

**D3 — Fonts/shadows centralized in `app.css` + `@cap/ui`.**
Adopt Geist Sans/Mono by editing the `--font-sans`/`--font-mono` token in `app.css` (self-hosted or bundled, not a runtime Google Fonts import in the app shell — the prototype's `@import` is fine for a static proto but the product should bundle to avoid a render-blocking external fetch). Flatten card surfaces by pointing the card shadow utility at the ring. Rationale: one edit re-themes all screens; matches the existing "single token contract" intent.

**D4 — New views as nested/sibling routes; reuse the app shell.**
- 会话记录 → `_app/tasks/$taskId/transcript` (or `_app/transcript/$taskId`) — it is the read-only replay of a task's session, reached from history's 「查看会话」.
- API 调试 → `_app/api`.
Both reuse `components/shell`. Rationale: keeps the sidebar/account chrome consistent and routing predictable.

**D5 — New visual primitives go in `@cap/ui`.**
Transcript event rows (user/reasoning/tool/answer/system) and the API request/response shells become shared components/styles in `packages/ui`, consuming the same tokens. Rationale: avoids per-page CSS drift and keeps them token-matched (the same reason `app.css` is shared).

**D6 — Absorb settings redesign; reuse terminal log.**
This change owns the remaining frontend-visual work of `redesign-settings-single-column` (single-column + by-runtime credentials incl. Claude Code) and supersedes its open tasks. It does NOT touch the `static-terminal-log` record mechanism (`components/session/cast-log*`, `session-replay`) beyond restyling. Rationale: avoids double-building and merge collisions; the log engine is already shipped logic.

**D7 — API debug view targets the real `public-v1-api` contract.**
Endpoint rail and request/response shapes come from `@cap/contracts` (the v1 API). If `public-v1-api` (22/23) hasn't fully landed when this view is built, render against the contract types with representative sample responses; wire live calls when available. Rationale: keeps the view honest to the real API and sequenceable.

## Risks / Trade-offs

- **Subjective "close enough" drift** → D2 Playwright diff against the frozen baseline; baseline frozen in-repo so it can't move.
- **Collision with in-flight `redesign-settings-single-column` / `static-terminal-log`** → D6 explicit ownership: absorb settings frontend, reuse (not rebuild) terminal log; note in those changes that their remaining FE work moved here.
- **API view gated on `public-v1-api`** → D7 build against the contract with sample data; live-wire is a thin follow-up, not a blocker for visual restoration.
- **Geist licensing/bundling** → bundle the OFL Geist fonts as app assets rather than a render-blocking external import (D3); fall back to `system-ui` if a face fails to load.
- **`@cap/ui` churn affects all consumers** → primitives are additive (transcript rows, api shells); existing Button/Card/StatusPill APIs unchanged.
- **Large surface, long-running branch** → screen-by-screen tasks keep each step independently verifiable and reviewable; global layer (D1) lands first so later screens don't get re-touched.

## Migration Plan

1. Land the global token/font/shadow layer (`app.css` + `@cap/ui`) — verify no regression on already-close screens.
2. Re-sync existing screens in baseline order: landing → dashboard → repositories → 高级派发 → session (remove approval) → history (rewrite) → settings (by-runtime credentials).
3. Build new views: transcript, then API 调试.
4. Add sidebar/mobile "API 调试" entry.
5. Per screen: Playwright diff vs `design-baseline/`; only mark done on match.
6. Rollback: change is FE-only and additive at the token layer; revert per-screen commits independently. No data/migrations.

## Open Questions

- Exact transcript route shape (`$taskId/transcript` vs top-level) — resolve when wiring history's 「查看会话」 target.
- Whether the API debug view ships with live calls in this change or as an immediate follow-up, depending on `public-v1-api` landing.
