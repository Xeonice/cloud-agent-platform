## Context

See `research-brief.md` for the live-verified findings. In short: post-login →
`/repositories` (backend `POST_LOGIN_PATH`), logout → `/login` (account-menu),
landing `/` is static + session-unaware. Real OAuth is live (`auth: true`). The
three issues are one frame: logged-out home = landing `/`; logged-in home =
dashboard `/dashboard`. This change is frontend-heavy with one backend redirect
change; it does NOT touch token exchange, the allowlist, sessions, lifecycle, or
the DB.

## Goals / Non-Goals

**Goals:**
- Login → console (`/dashboard`), returning to a deep-linked destination when the
  gate bounced the visitor from one.
- Logout → public landing `/`.
- Landing is session-aware (authed → console CTA) and the anonymous console
  entries stop dead-bouncing.
- Landing visual polish within the existing design language (footer, CJK breaks,
  trust chips, CTA hierarchy, spacing/density, scroll cue).

**Non-Goals:**
- A from-scratch visual redesign / new design system (no reference image — keep the
  current language). High-fidelity restyle would need a target mock.
- Any change to the OAuth token exchange, allowlist gate, session model, or the
  `/auth/logout` endpoint behavior.
- Adding `/workspace`/`/resume` behavior changes (their spec text is preserved).

## Decisions

### D1 — Default post-login target → `/dashboard`
Backend `github-oauth.controller.ts` `POST_LOGIN_PATH` `/repositories` → `/dashboard`;
frontend `login.tsx` mock-mode navigate + the "进入仓库导入页" copy updated to the
console. The original "import repos first" intent is dropped per the operator.

### D2 — Deep-link return, threaded through OAuth `state`, open-redirect-guarded
The destination flows: `_app` gate `throw redirect({to:'/login', search:{redirect: location.pathname+search}})` → `/login` reads `redirect` → `login()` appends it to `${api}/auth/github/login?redirect=<enc>` → backend `/auth/github/login` stores it IN THE SIGNED STATE PAYLOAD (alongside the CSRF nonce, not replacing it) → callback verifies CSRF state as before, extracts `redirect`, runs the guard, redirects to `${webOrigin}${redirect}` else `${webOrigin}/dashboard`.
- **Open-redirect guard (load-bearing — login == host-root):** accept ONLY a
  same-origin relative path — must start with a single `/`, must NOT start with
  `//` or `/\`, must contain no scheme/authority/backslash; else treat as absent →
  `/dashboard`. Implement as a PURE function `safeRedirectPath(raw): string|null`
  (unit-tested) on the backend; the browser never leaves `webOrigin`.
- *Why state, not a separate cookie:* the CSRF state cookie already round-trips;
  folding `redirect` into the signed state payload avoids a second cookie and keeps
  the value integrity-protected. (A paired signed cookie is an acceptable alt if
  the state is opaque-random rather than a signed payload — settle at apply by
  reading the current state mechanism.)
- *Why guard server-side even though the gate only emits internal paths:* the
  `redirect` is attacker-controllable (anyone can craft `/login?redirect=…` →
  `/auth/github/login?redirect=…`); since login grants host-root, a reflected
  open redirect is a phishing vector. Guard at the trust boundary (callback).

### D3 — Logout → landing `/`
`account-menu.tsx`: `navigate({ to: "/login" })` → `navigate({ to: "/" })`. `logout()`
(server `POST /auth/logout` + `resetState`) is unchanged. The landing is the
logged-out home (and is session-aware, so it shows the login CTA there).

### D4 — Session-aware landing, SSR-safe
`/` reads the auth session via the same `authSessionQuery` the gate uses. The
cross-origin session is CLIENT-resolved, so SSR/first paint renders the
UNAUTHENTICATED state (login CTA) and the authed affordance ("进入控制台" → `/dashboard`
+ account) swaps in AFTER hydration — mirroring the gate's client-deferred pattern
(`typeof document === 'undefined'` guard) so there is NO hydration mismatch. The
anonymous "控制台"/"查看控制台" entries route to `/login` (or scroll to `HeroPreview`)
for an unauthenticated visitor instead of `/dashboard` (which would gate-bounce).

### D5 — Visual polish, existing language only
- **Footer**: a minimal footer component (repo link / security note / © ) below `#security`.
- **CJK headline breaks**: control line-breaking on the big `text-balance` h1/h2 so
  tokens like "操作者" don't split — via explicit break points (`<wbr>`/segmented
  spans) and/or a tuned max-width; keep the clamp scale.
- **Trust pills → chips**: `TrustStrip` items get a chip treatment (subtle
  bg + 1px border) so they don't read as stray links.
- **CTA hierarchy**: one clear primary in the hero (login when anon / 进入控制台 when
  authed); the secondary is de-emphasized or repurposed (scroll-to-preview), not a
  gate-bounce.
- **Spacing/density**: tighten the adjacent-section `py` stack so the desktop dead
  band shrinks; firm up the sparse workflow/security card height.
- **Scroll cue**: a subtle hero scroll affordance.

## Risks / Trade-offs

- **[Open redirect = phishing vector]** login grants host-root, so a reflected
  redirect is dangerous. → server-side same-origin-relative guard (D2), pure +
  unit-tested, default-deny to `/dashboard`.
- **[Hydration mismatch on session-aware landing]** → render anon state on
  SSR/first paint, reconcile after hydration (D4); no nondeterministic value in the
  server render.
- **[OAuth state mechanism coupling]** folding `redirect` into the state payload
  depends on whether the current state is a signed payload vs opaque-random. →
  design notes both; apply reads the actual mechanism and picks (payload field vs
  paired signed cookie) without weakening CSRF.
- **[Visual scope creep]** "全部处理" could balloon into a redesign. → scope is
  fixed to the enumerated items in the existing language; a full restyle is a
  separate change needing a reference mock.

## Migration Plan

1. Backend: `POST_LOGIN_PATH` → `/dashboard`; `safeRedirectPath` guard; carry
   `redirect` via state; callback resolves target. Unit-test the guard.
2. Web: gate emits `redirect`; `login()`/`login.tsx` thread + honor it + copy;
   `account-menu` logout → `/`; landing session-aware + visual items.
3. Deploy order: backend → web (web reads the new redirect contract; backend must
   accept it first). Both backward-compatible (absent `redirect` → dashboard).
4. Post-deploy live re-verify: login (no deep-link) → dashboard; gate-bounced
   deep-link → original route; logout → landing; authed landing shows 进入控制台.
- **Rollback:** revert the redirect target + the web changes; no schema/data impact.

## Open Questions

- The exact current OAuth `state` representation (signed payload vs opaque) — picks
  D2's redirect-carrier (state field vs paired signed cookie). Resolve at apply by
  reading `oauth-config.ts` / the controller's state handling.
- Whether the anonymous hero secondary CTA becomes "查看演示" (scroll to HeroPreview)
  or is removed entirely — UX detail, settle at apply.
- Footer content scope (just repo+©, or also links to /login, security section).
