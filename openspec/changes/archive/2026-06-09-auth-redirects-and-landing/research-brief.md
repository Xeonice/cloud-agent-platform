# Research Brief — auth-redirects-and-landing

Side-car research (not a tracked artifact). Grounded by LIVE verification on the
production stack this session + direct codebase reads. Every claim has a
`file:line` anchor or a live observation.

## The unifying frame

Three reported issues are three faces of one question — "where is "home" in the
logged-out vs logged-in state":

```
                current (live-verified)        intended
post-login  →   /repositories                 → /dashboard (deep-link return, else dashboard)   [Q1]
logout      →   /login                         → / (landing)                                    [Q2]
landing /   →   static, session-UNAWARE        → session-aware + visual polish                  [Q3]
```

## Q1 — post-login lands on /repositories (LIVE-CONFIRMED; NOT a session bug)

- Real OAuth is live (`apps/web/src/lib/api/capabilities.ts:75` `auth: true`).
- Backend callback redirect target: `apps/api/src/auth/github-oauth.controller.ts`
  `POST_LOGIN_PATH = '/repositories'` (:54), `res.redirect(postLoginUrl(webOrigin))`
  (:219), `postLoginUrl` → `${webOrigin}/repositories` (:279-281). The OAuth flow
  owns the redirect; the frontend `/login` does not navigate in real mode
  (`login.tsx:88` returns early when auth-capable).
- This was a DELIBERATE original choice (`login.tsx` copy: "登录成功后进入仓库导入页").
- **LIVE**: logged out → landing → "使用 GitHub 登录" → GitHub (active session,
  app pre-authorized → instant callback) → landed on `https://cap.douglasdong.com/repositories`,
  authed as `tanghehui`. Clean — NO cross-origin session failure. So "首页" was a
  loose label for `/repositories` (the first post-login page), not the landing.
- The OAuth flow requirement (`multi-user-oauth` "GitHub OAuth authorization-code
  flow") does NOT pin the redirect target in spec text — it's controller-level.

## Q2 — logout lands on /login (LIVE-CONFIRMED)

- `apps/web/src/components/shell/account-menu.tsx:73-74`:
  `await logout(); navigate({ to: "/login" })`. `logout()`
  (`lib/mock-session.ts:80-99`) real-mode `POST /auth/logout` (clears server
  session + cookie) + `resetState()`, then the menu navigates to `/login`.
- **LIVE**: dashboard → account menu "退出登录" → landed on
  `https://cap.douglasdong.com/login?denied=false` (the login page), NOT the
  landing. Pinned in spec: `frontend-console` "Client auth gate" — "Sign-out …
  navigate to `/login`".

## Q3 — landing is session-unaware + visual gaps (LIVE-CONFIRMED via screenshot)

`apps/web/src/routes/index.tsx` is a fully static SSR route (no `beforeLoad`, no
session read). Live screenshot taken while AUTHENTICATED showed the landing still
rendering "GitHub 登录" (nav) + "使用 GitHub 登录" + "查看控制台" — full anonymous
chrome, zero session awareness.

Concrete issues:
- **Session-unaware**: an authed user sees a login CTA, no "进入控制台" entry.
- **Anon "控制台"/"查看控制台" dead-bounce**: nav `控制台 → /dashboard`
  (`index.tsx:53`) + hero "查看控制台 → /dashboard" (:96); an anonymous click hits
  `_app beforeLoad` (`routes/_app.tsx:52` `throw redirect({to:'/login'})`) →
  silently bounced. Looks like it'll show the console; gates instead.
- **No footer** — page ends after the `#security` 3-card section (verified live).
- **CJK display-headline mid-word breaks** — the huge `text-balance` h1 splits
  "操作者" as "操|作者"; `#workflow`/`#security` h2 break awkwardly too.
- **Trust pills look like stray blue links** — bare blue text, no chip container
  (`TrustStrip`).
- **Dual hero CTA** competes; the secondary is the bounce trap.
- **Large inter-section whitespace** at desktop (adjacent `py clamp(56,8vw,96)`
  stack); workflow/security cards are sparse.

## Decisions (operator, this explore)

- Q1: redirect to `/dashboard` by default, BUT remember the original destination
  (deep-link) — if the gate bounced the visitor from `/tasks/X`, return to `/tasks/X`.
- Q2: logout → landing `/`.
- Q3: make the landing session-aware AND apply the visual fixes (footer, CJK-break
  control, trust chips, CTA hierarchy, section spacing, card density, scroll cue —
  "全部处理"). NOT a from-scratch visual redesign (no reference image) — structural
  + targeted visual polish keeping the existing design language.

## Implementation notes / risks (resolved in design.md)

- Deep-link is the involved part: the destination must thread frontend gate →
  `/login?redirect=<path>` → `login()` → `/auth/github/login?redirect=<path>` →
  carried in the OAuth `state` (or a signed cookie) → callback validates + redirects
  to `${webOrigin}<path>`, else `/dashboard`. MUST guard open-redirect: only accept
  a SAME-ORIGIN relative path (starts with single `/`, not `//`/`http`/backslash),
  ideally constrained to known `_app` routes; never reflect an attacker-supplied
  absolute URL (login == host-root, so an open redirect is a real phishing vector).
- Landing session-awareness must be SSR-safe: the cross-origin session is
  client-resolved, so the SSR/first paint renders the anonymous CTA and the authed
  swap happens after hydration via the same `authSessionQuery` — no hydration
  mismatch (mirror the `_app` gate's client-deferred pattern).
- `multi-user-oauth` "Authorization is initiated with anti-CSRF state" scenario
  must still hold — the `redirect` rides ALONGSIDE the CSRF state, never weakening it.
