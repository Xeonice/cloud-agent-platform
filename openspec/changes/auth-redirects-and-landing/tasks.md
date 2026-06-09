<!-- Track-annotated tasks. Within a track tasks run serially; independent tracks
     run in parallel. Frontend-heavy + one backend redirect change. -->

## 1. Track: backend-redirect (depends: none)

- [x] 1.1 `github-oauth.controller.ts`: `POST_LOGIN_PATH` `/repositories` → `/dashboard`.
- [x] 1.2 New `apps/api/src/auth/redirect-target.ts` — pure `safeRedirectPath(raw)`: same-origin relative only (single `/`, not `//`/`/\`, no `\`, no `://`, path-safe charset, ≤512); else `null`.
- [x] 1.3 `/auth/github/login`: accepts `?redirect`, and when it passes the guard sets a one-shot httpOnly Lax `cap_oauth_redirect` cookie (`OAUTH_REDIRECT_COOKIE_NAME`) ALONGSIDE the CSRF state cookie — never touches/weakens the signed state.
- [x] 1.4 `/auth/github/callback`: reads + re-validates the redirect cookie (defensive decode), target = `safeRedirectPath(carried) ?? '/dashboard'`, redirects to `${webOrigin}<target>`; clears the one-shot redirect cookie on every exit path. CSRF/allowlist/token exchange unchanged.
- [x] 1.5 `redirect-target.test.mjs` (drives REAL compiled guard) 5/5: accepts relative paths; rejects protocol-relative/absolute/backslash/scheme/empty/whitespace/over-length. `oauth-callback.test.mjs` updated (T6a2/T9a → `/dashboard`) + added T6d (safe deep-link honored + cookie cleared), T6e (unsafe → `/dashboard`); 34/34. api tsc 0, eslint 0.
- [x] 1.6 (cookie-shadow fix, found in 5.2 live) `github-oauth.controller.ts`: a stale HOST-ONLY `cap_session` (from an earlier cookie-domain config) was shadowing the canonical `Domain=.douglasdong.com` cookie on browser→api requests — the server reads the FIRST same-name cookie → 401 on EVERY logged-in client call (while SSR, seeing only the single domain-scoped cookie on the web host, still authed → shell renders but all client data + session-aware UI break). Fix: `clearedSessionCookie(req, domain)` helper; the callback now ALSO emits a host-only clear when setting the domain-scoped cookie; `logout` clears BOTH the host-only and the parent-domain variant (sign-out is now complete + self-heals the shadow on next login). `oauth-callback.test.mjs` +T12a/T12b (callback domain-scoped set + host-only purge) +T13a/T13b (logout clears both scopes) → 38/38. Root cause confirmed live by reproduction: only-`.domain` cookie → 200; only-stale-host-only → 401; both in browser order → 401; reversed → 200.

## 2. Track: web-auth-flow (depends: none)

- [x] 2.1 `_app.tsx`: gate `throw redirect({ to: '/login', search: { redirect: location.href } })` (carries the attempted in-app path).
- [x] 2.2 `login.tsx`: `redirect` added to `validateSearch`/`LoginSearch`/`useSearch`; `handleLogin` passes it to `login(redirect)`; mock-mode navigate → `safeClientRedirect(redirect)` (= `/dashboard` default); success-state Link `/repositories`→`/dashboard` ("进入控制台") + copy + ConfigList "下一步" updated to the console.
- [x] 2.3 `mock-session.ts` `login(redirect?)`: real mode appends a `safeRelativePath`-guarded `?redirect=` to the login URL; mock mode the caller navigates.
- [x] 2.4 `account-menu.tsx`: logout `navigate({ to: '/login' })` → `navigate({ to: '/' })`; `logout()` unchanged.
- [x] (factored) `lib/safe-redirect.ts` `safeRelativePath` — shared client guard mirroring the backend, used by 2.2/2.3; unit-tested (`safe-redirect.test.ts`).
- [x] 2.5 (gate-direct-load fix, found in 5.2 live) `_app.tsx` gate: when `auth` capable, resolve the session on the SERVER too (drop the `typeof document` short-circuit for the real path; keep it only for the mock path) so a DIRECT load / refresh / deep-link is gated — `beforeLoad` does not re-run on the client during hydration, so a client-only check let an unauthenticated visitor land on a directly-opened console URL (broken shell on `ssr:false /tasks/X`; raw 401 error page on SSR routes).
- [x] 2.6 `real.getAuthSession()`: map the backend's `401` (unauthenticated, per `multi-user-oauth`'s "every endpoint → 401" model) to `null` instead of throwing, so the server-side gate redirects cleanly rather than rejecting into the route error boundary; genuine failures (5xx/network) still propagate. New `real-auth-session.test.ts` pins 401→null / 200→user / 5xx→throw (3). Corrected the misleading `AuthSessionResponse` docstring in `@cap/contracts` (it claimed "200 with user:null", contradicting the 401 spec+backend).

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

- [x] 5.1 Static gates GREEN: api `tsc` 0 / eslint 0 / nest build; `redirect-target.test.mjs` 5/5 + `oauth-callback.test.mjs` 38/38 (incl. deep-link T6d/T6e + cookie-shadow T12a/T12b/T13a/T13b) + auth suite; web `tsc` 0 / eslint 0 / vitest 60 (incl. `safe-redirect` 3 + `real-auth-session` 3); `@cap/contracts` tsc 0. No `debugger`. (Landing session-aware RENDER + the server-side gate redirect are verified live in 5.2 — the vitest suite is node-env/pure, so the guard + 401→null logic are unit-tested and the SSR redirect is live-checked rather than DOM/SSR-rendered.)
- [ ] 5.2 Live (POST-DEPLOY). Round 1 (commit `4ed76a9`, gate fix): ✅ **direct-load gate** — logged out, `/dashboard` + `/tasks/X` → server-side **307 → `/login?redirect=…`** (both SSR + ssr:false; NOT a broken shell / 401 page); ✅ **deep-link return** — login from `/login?redirect=/tasks/deeplink-return-check` landed exactly on `/tasks/deeplink-return-check`; ✅ anon `/` shows GitHub login + visual items (footer, chips, headline breaks, single primary CTA). Round 1 then surfaced the **cookie-shadow defect** (a stale host-only `cap_session` 401'd every logged-in browser→api call) → fixed in task 1.6; root cause confirmed by live curl reproduction. Round 2 (this commit, cookie fix) — STILL PENDING re-deploy: authed `/` shows "进入控制台"; logged-in dashboard/tasks data loads (no 401s); logout → landing `/` + sign-out leaves no shadow cookie. Requires deploy.
