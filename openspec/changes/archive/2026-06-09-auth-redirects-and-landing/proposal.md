## Why

The console's logged-in/logged-out "home" routing is off, confirmed by live
verification this session: after a successful login the operator lands on
`/repositories` (not the console/dashboard); after logout they land on `/login`
(not the public landing); and the landing `/` is fully session-unaware — an
already-logged-in operator still sees a "GitHub 登录" CTA, and the anonymous
"控制台/查看控制台" entries silently bounce to login. The result is a disjointed
entry/exit flow around the host-root console. This change makes the entry flow
coherent: login → the console (returning to a deep-linked destination when there
was one), logout → the public landing, and a session-aware landing.

## What Changes

- **Login lands on the console with safe deep-link return.** The post-login
  redirect target becomes `/dashboard` instead of `/repositories`. When the auth
  gate bounced the visitor from a specific app route (e.g. `/tasks/X`), that
  destination is remembered and returned to after login; otherwise `/dashboard`.
  The destination is threaded frontend-gate → `/login?redirect=<path>` →
  `/auth/github/login?redirect=<path>` → carried in the OAuth `state` round trip →
  validated at the callback and redirected to. **Open-redirect is guarded**: only a
  same-origin relative app path is honored (never an attacker-supplied absolute
  URL); anything else falls back to `/dashboard`. The anti-CSRF `state` is
  unchanged in strength — the redirect rides alongside it.
- **Logout lands on the public landing.** The `AccountMenu` sign-out navigates to
  `/` (the landing) instead of `/login`, after clearing the session.
- **Landing becomes session-aware.** `/` reads the auth session (SSR-safe,
  client-resolved): an authenticated operator sees an "进入控制台" primary CTA (→
  `/dashboard`) and an account affordance instead of the login CTA; an
  unauthenticated visitor sees the "GitHub 登录" CTA. The anonymous
  "控制台/查看控制台" entries no longer dead-bounce (they route to login or scroll to
  the in-page preview rather than silently hitting the gate).
- **Landing visual polish** (keeping the existing design language — no new visual
  system): add a minimal footer; control CJK display-headline line breaks so
  "操作者"/section titles don't split mid-word; render the trust pills as real chips
  rather than stray blue links; resolve the dual-CTA hierarchy; tighten
  inter-section whitespace and sparse card density; add a subtle scroll cue.
- **Login page copy + post-login nav** updated to match the dashboard target (the
  "登录成功后进入仓库导入页" copy and the mock-mode navigate to `/repositories`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `multi-user-oauth`: ADD the post-login redirect-target behavior — default
  `/dashboard`, an optional same-origin relative `redirect` carried through the
  OAuth `state` round trip and validated against open-redirect at the callback,
  falling back to `/dashboard` when absent/unsafe.
- `frontend-console`: the app-shell auth gate redirects to `/login` CARRYING the
  attempted path for deep-link return, and sign-out navigates to the landing `/`
  (not `/login`); the landing `/` is session-aware (authed → console CTA) with the
  anonymous console entries no longer dead-bouncing, plus the visual polish; the
  login page routes to the console (or the deep-link target) on success.

## Impact

- **Backend** (`apps/api/src/auth/github-oauth.controller.ts`, `oauth-config.ts`):
  `POST_LOGIN_PATH` → `/dashboard`; accept + carry a validated `redirect` on
  `/auth/github/login` through the `state` round trip; an open-redirect-safe
  resolver at the callback. No change to token exchange / allowlist / session.
- **Web** (`routes/_app.tsx` gate redirect search param; `routes/login.tsx`
  post-login nav + copy + honor `redirect`; `lib/mock-session.ts` `login()` passes
  `redirect`; `components/shell/account-menu.tsx` logout → `/`; `routes/index.tsx`
  + `components/shell/landing-nav.tsx` + `components/landing/*` session-awareness +
  footer + headline-break + trust chips + CTA + spacing).
- **No change** to task lifecycle, guardrails, DB schema, or the session/allowlist
  security model. The open-redirect guard is a NEW security-relevant control (login
  == host-root, so a reflected redirect must be same-origin-only).
- **Tests:** open-redirect resolver (pure, unit) — same-origin relative accepted,
  absolute/`//`/backslash rejected → dashboard; landing session-aware CTA (authed
  vs anon) without hydration mismatch; gate carries the redirect param; logout
  navigates to `/`. Plus a post-deploy live re-verify of login→dashboard/deep-link
  and logout→landing.
