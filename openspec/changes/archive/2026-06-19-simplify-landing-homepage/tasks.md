<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a track run serially. -->

## 1. Track: landing-page (depends: none)

- [x] 1.1 In `apps/web/src/routes/index.tsx`, remove the `#workflow` `process-rail` section, the `#security` `boundary-ledger` aside, and the hero proof-tile grid, leaving nav → hero → footer.
- [x] 1.2 Simplify the landing-nav to brand (+ the authenticated account affordance) only — remove the `#workflow` / `#security` (and any other in-page) anchor links from the nav.
- [x] 1.3 Set the hero CTA hierarchy: primary "GitHub 登录" (anonymous) / "进入控制台" → `/dashboard` (authenticated), and secondary "查看演示" scrolling to the `#preview` runner-capsule; keep the trust-pill chips.
- [x] 1.4 Simplify the footer to brand + a minimal link set (GitHub repo, 登录) + the copyright line — remove any `#security` / `#workflow` anchor links so no anchor dead-ends.
- [x] 1.5 Confirm the session-aware swap (unauthenticated first paint → authenticated reconcile) and the SSR-safe reduced-motion-first runner-capsule are preserved unchanged.

## 2. Track: component-cleanup (depends: landing-page)

- [x] 2.1 Identify the landing-only components/markup that backed the removed sections (process-rail, boundary-ledger, proof-tiles); confirm each is not imported by `/workspace` or other routes.
- [x] 2.2 Delete the confirmed landing-only components so no dead code ships; for any component shared with another route, keep it but remove only its `/` usage.

## 3. Track: pixel-baseline (depends: landing-page)

- [x] 3.1 Refresh the `/` pixel baseline under `apps/web/e2e/visual/` to the simplified design and re-run the `/` per-page pixel comparison until green. DONE: replaced the living-baseline `/` design source (`archive/2026-06-14-session-cockpit-redesign/design-baseline/index.html`) with the simplified OD `index.html`; reconciled the React nav to brand-only (`LandingNav` cta now nullable; landing passes `cta={null}`). Measured `landing @ desktop = 0.005`, `landing @ mobile = 0.008` (both well under the recorded `0.025` threshold; tighter than the old rich pair's 0.012/0.012). `landing @ {desktop,mobile}` PASS the gate. NOTE: the full suite also surfaced 4 PRE-EXISTING failures on UNRELATED pages — `dashboard`/`tasks-new`/`session` (ratios 0.06–0.14) — caused by merged console changes after the 2026-06-14 baseline calibration (#18 runtime selector → tasks-new; #15 static-terminal-log + #9 replay → session) whose design baselines were never recalibrated; those pages are NOT touched by this change and are out of scope (a separate baseline-recalibration concern).
- [x] 3.2 Verify no hydration warning on `/` (SSR + client) and that the "查看演示" anchor smooth-scrolls to the preview with the fixed-nav offset. DONE: the landing rendered + hydrated cleanly in the SSR'd playwright capture at both breakpoints (no hydration error, `networkidle` settled, screenshot captured); the session-aware mount-gated swap + reduced-motion-first runner-capsule are preserved unchanged; the `查看演示` → `#preview` anchor + `scroll-mt-20` offset are in place. (The only retained in-page anchor is `#preview`.)
