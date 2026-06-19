## Context

The marketing landing (`apps/web/src/routes/index.tsx`) currently renders the richer "console-design-pixel-merge Track 5" layout: hero + live `runner-capsule` demo, a 3-tile proof grid, a `#workflow` `process-rail` (4 numbered steps), and a `#security` `boundary-ledger` aside. The OpenDesign "OpenSpec Agent System" revision (project `680d21c4`, `index.html`) simplifies the page to **nav → hero → footer**. This change lands that simplification. It is a contained, frontend-only change to one standalone route plus its landing-only components and the `/` pixel baseline; it does not touch the authenticated console, the backend, or the other landing-family pages (`/login`, `/workspace`, `/resume`).

## Goals / Non-Goals

**Goals:**
- Reduce `/` to nav → hero → footer faithfully to the OD revision, within the existing design language.
- Preserve the load-bearing cross-cutting behaviors: session-aware CTA swap, SSR-safe hydration, the SSR-safe reduced-motion-first runner-capsule demo.
- Leave no dead code (unused landing-only sections) and no dead anchors (`#workflow` / `#security`).
- Refresh the `/` pixel baseline and keep the per-page pixel comparison green.

**Non-Goals:**
- Any change to `/login`, `/workspace`, `/resume`, or any `_app` console route.
- A new visual system or design tokens — this stays within the ported design language.
- Backend / API / contracts changes.

## Decisions

### D1 — Remove the lower sections and their components, don't just hide them
Delete the `#workflow` `process-rail`, the `#security` `boundary-ledger`, and the hero proof-tile grid from `index.tsx`, and remove the now-unused landing-only components/markup so no dead code ships.

- **Why**: the design drops them entirely; conditionally hiding them would leave dead code and dead anchors. First confirm each removed component is landing-only (not imported by `/workspace` or other routes) before deleting; if a component is shared, stop rendering it on `/` but keep the component.
- **Anchors**: remove every nav/footer link to `#workflow` / `#security` so no anchor dead-ends.

### D2 — Hero CTA hierarchy: GitHub 登录 (primary) + 查看演示 (secondary → in-page preview)
The unauthenticated hero presents a single clear primary "GitHub 登录" and a secondary "查看演示" that scrolls to the `runner-capsule` preview (`#preview`). The authenticated swap presents "进入控制台" → `/dashboard`.

- **Why**: matches the OD revision and the existing session-aware requirement; the only retained in-page anchor is the preview, so "查看演示" is the sole anchor target.

### D3 — Preserve the SSR-safe + session-aware machinery unchanged
Keep the mounted-flag pattern (unauthenticated first paint reconciling after hydration) and the runner-capsule's reduced-motion-first upgrade exactly as today — only the surrounding sections change.

- **Why**: these are the hydration-correctness and accessibility invariants; the simplification must not regress them.

### D4 — Refresh the `/` pixel baseline
Replace the prior `/` baseline under `apps/web/e2e/visual/` with the simplified design and keep the per-page comparison passing.

- **Why**: the page changed; the baseline is the design-fidelity gate (`frontend-console` "Required per-page pixel comparison"). The pixel-comparison requirement itself is unchanged — only the `/` baseline artifact is refreshed.

## Risks / Trade-offs

- **Removing a component that is shared with another route** → breaks `/workspace` (which also uses the landing-nav/hero). → Mitigation: D1 — confirm landing-only before deleting; for shared components, drop the `/` usage only.
- **Dead `#workflow` / `#security` anchors left behind** → broken links. → Mitigation: explicit "no dead anchors" scenario + remove all such links.
- **Session-aware swap or SSR hydration regressing during the edit** → hydration warnings / dead-bounce. → Mitigation: D3 keeps the machinery; the existing hydration + session-aware scenarios stay green.
- **Stale pixel baseline** → the comparison fails or silently passes against the old design. → Mitigation: D4 refresh + re-run the `/` comparison.

## Open Questions

- Whether the simplified landing-nav keeps any utility link (e.g. GitHub repo) beyond the brand + authed account affordance, or is brand-only. Recommendation: brand-only nav (per the OD revision), with the GitHub repo link living in the footer.
