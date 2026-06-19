## Why

The marketing landing (`/`) is over-built: beyond the hero it carries a 3-tile proof grid, a `#workflow` `process-rail` (4 numbered steps), and a `#security` `boundary-ledger` aside. The OpenDesign "OpenSpec Agent System" revision (`index.html`) simplifies the page to **nav → hero → footer**, dropping those lower sections for a cleaner, faster first impression. This change lands that simplification faithfully against the existing design language, without touching the authenticated console.

## What Changes

- **Strip the lower landing sections**: remove the `#workflow` `process-rail` and the `#security` `boundary-ledger` from `/`, and the hero's 3-tile proof grid. The page becomes nav → hero → footer.
- **Simplify the nav**: the landing-nav renders the brand (and, for an authenticated operator, the account affordance) only — no in-page anchor links to the removed `#workflow` / `#security` sections.
- **Simplify the footer**: brand + a minimal link set (GitHub repo, 登录) + the copyright line — no `#security` / `#workflow` anchor links (their targets no longer exist).
- **Keep the hero** essentially as-is per the design: eyebrow, the CJK display title + subline, the lead copy, the dual CTA (GitHub 登录 + 查看演示 → in-page `#preview`), the trust pills, and the live `runner-capsule` demo (the SSR-safe reduced-motion-first React port stays).
- **Preserve cross-cutting invariants**: the landing stays SESSION-AWARE (authed → "进入控制台" → `/dashboard` + account affordance; anonymous → GitHub 登录 CTA, no dead-bounce through the gate) and SSR-safe (unauthenticated first paint reconciling after hydration, no nondeterministic render).
- **Refresh the `/` pixel baseline** to the simplified design and keep the per-page pixel comparison green.
- Out of scope: `/login`, `/workspace`, `/resume` (the other landing-family pages stay unchanged), and the entire authenticated console.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `frontend-console`: the "Landing-family standalone pages" requirement's `/` (Landing) clause is simplified to nav → hero → footer (removing the proof grid, `#workflow` process-rail, and `#security` boundary-ledger and their nav/footer anchors), while preserving the session-aware and SSR-safe behavior; the `/` pixel baseline under the per-page pixel-comparison requirement is refreshed.

## Impact

- **Code**: `apps/web/src/routes/index.tsx` (drop the lower sections + simplify nav/footer wiring); the landing-only `process-rail` / `boundary-ledger` / proof-tile components become unused and SHALL be removed (or their landing usage deleted) so no dead code ships; the `LandingNav` / landing footer link sets are trimmed.
- **Anchors**: the `#workflow` and `#security` in-page anchors are removed; any remaining link that targeted them is dropped or repointed so no dead anchor ships.
- **Design baseline**: a new `/` pixel baseline replaces the prior one under `apps/web/e2e/visual/`.
- **No backend/API change**; no change to `/login`, `/workspace`, `/resume`, or any `_app` console route.
