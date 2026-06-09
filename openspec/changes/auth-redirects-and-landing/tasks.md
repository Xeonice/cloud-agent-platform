<!-- Track-annotated tasks. Within a track tasks run serially; independent tracks
     run in parallel. Frontend-heavy + one backend redirect change. -->

## 1. Track: backend-redirect (depends: none)

- [x] 1.1 `github-oauth.controller.ts`: `POST_LOGIN_PATH` `/repositories` → `/dashboard`.
- [x] 1.2 New `apps/api/src/auth/redirect-target.ts` — pure `safeRedirectPath(raw)`: same-origin relative only (single `/`, not `//`/`/\`, no `\`, no `://`, path-safe charset, ≤512); else `null`.
- [x] 1.3 `/auth/github/login`: accepts `?redirect`, and when it passes the guard sets a one-shot httpOnly Lax `cap_oauth_redirect` cookie (`OAUTH_REDIRECT_COOKIE_NAME`) ALONGSIDE the CSRF state cookie — never touches/weakens the signed state.
- [x] 1.4 `/auth/github/callback`: reads + re-validates the redirect cookie (defensive decode), target = `safeRedirectPath(carried) ?? '/dashboard'`, redirects to `${webOrigin}<target>`; clears the one-shot redirect cookie on every exit path. CSRF/allowlist/token exchange unchanged.
- [x] 1.5 `redirect-target.test.mjs` (drives REAL compiled guard) 5/5: accepts relative paths; rejects protocol-relative/absolute/backslash/scheme/empty/whitespace/over-length. `oauth-callback.test.mjs` updated (T6a2/T9a → `/dashboard`) + added T6d (safe deep-link honored + cookie cleared), T6e (unsafe → `/dashboard`); 34/34. api tsc 0, eslint 0.

## 2. Track: web-auth-flow (depends: none)

- [x] 2.1 `_app.tsx`: gate `throw redirect({ to: '/login', search: { redirect: location.href } })` (carries the attempted in-app path).
- [x] 2.2 `login.tsx`: `redirect` added to `validateSearch`/`LoginSearch`/`useSearch`; `handleLogin` passes it to `login(redirect)`; mock-mode navigate → `safeClientRedirect(redirect)` (= `/dashboard` default); success-state Link `/repositories`→`/dashboard` ("进入控制台") + copy + ConfigList "下一步" updated to the console.
- [x] 2.3 `mock-session.ts` `login(redirect?)`: real mode appends a `safeRelativePath`-guarded `?redirect=` to the login URL; mock mode the caller navigates.
- [x] 2.4 `account-menu.tsx`: logout `navigate({ to: '/login' })` → `navigate({ to: '/' })`; `logout()` unchanged.
- [x] (factored) `lib/safe-redirect.ts` `safeRelativePath` — shared client guard mirroring the backend, used by 2.2/2.3; unit-tested (`safe-redirect.test.ts`).

## 3. Track: landing-session-aware (depends: none)

- [x] 3.1 `index.tsx`: SSR-safe session awareness — `mounted` flag + `useQuery(authSessionQuery())`, `authed = mounted && session != null` (anon on SSR/first paint, reconcile after mount → no hydration mismatch). Authed → nav CTA "进入控制台"→`/dashboard` + hero single primary "进入控制台"; anon → "GitHub 登录"→`/login`. (`landing-nav.tsx` stays a pure presentational component fed via props — unchanged, so reuse routes are unaffected.)
- [x] 3.2 Anonymous console entries de-fanged: nav "控制台" → `consoleTarget` (`/login` anon, `/dashboard` authed); hero secondary for anon is a non-bouncing `#preview` anchor ("查看演示") instead of `/dashboard`.

## 4. Track: landing-visual (depends: landing-session-aware)

- [x] 4.1 `components/landing/landing-footer.tsx` (new) below `#security`: brand + GitHub 仓库 / 安全模型 (#security) / 登录 links + © line. Wired into `index.tsx`.
- [x] 4.2 Hero h1 + both section h2 get `[word-break:keep-all]` + `<wbr/>` at phrase boundaries → no mid-token CJK splits (replaces the awkward `text-balance` break); clamp scale kept.
- [x] 4.3 `trust-strip.tsx`: pills get a `ring-1 ring-inset ring-[#cfe4fb]` border (+ slightly larger min-h/px) so they read as discrete chips, not bare blue links.
- [x] 4.4 Hero CTA hierarchy: single primary (authed "进入控制台" / anon "使用 GitHub 登录"); anon secondary repurposed to a non-bouncing `#preview` jump ("查看演示").
- [x] 4.5 `#workflow`/`#security` `py clamp(56,8vw,96)` → `clamp(40,5vw,72)` (tightens the desktop dead band); `workflow-step` `min-h 220→180` (less sparse); subtle hero scroll cue (`↓ 向下了解操作者流程` → `#workflow`).

## 5. Track: verify (depends: backend-redirect, web-auth-flow, landing-session-aware, landing-visual)

- [x] 5.1 Static gates GREEN: api `tsc` 0 / eslint 0 / nest build; `redirect-target.test.mjs` 5/5 + `oauth-callback.test.mjs` 34/34 (incl. deep-link T6d/T6e) + auth suite; web `tsc` 0 / eslint 0 / vitest 57 (incl. `safe-redirect` 3). No `debugger`. (Landing session-aware RENDER is verified live in 5.2 — the vitest suite is node-env/pure, so the guard logic is unit-tested and the render is live-checked rather than DOM-rendered.)
- [ ] 5.2 Live (POST-DEPLOY, pending): login no-deep-link → `/dashboard`; gate-bounced deep-link (open `/tasks/X` logged out → login) → returns to `/tasks/X`; unsafe `redirect` → `/dashboard`; logout → landing `/`; authed `/` shows "进入控制台" / anon `/` shows login; visual items render (footer, chips, headline breaks, single primary CTA). Requires deploy; not committed/deployed per the standing no-push rule.
