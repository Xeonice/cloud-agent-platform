## Why

On the remote deployment (auth capability ON / REAL mode), signing in with email+password
or email OTP succeeds but the console does not advance to `/dashboard` — the operator is
silently bounced back to `/login`. Root cause is a FRONTEND react-query cache staleness, not
the backend: the landing page pre-warms the `authSession` query (to `null` while logged out),
the `_app` auth gate reads that cached value via `ensureQueryData` (which returns a cached
value without refetching), and the post-login SPA soft navigation hits the gate which sees the
stale `null` and redirects back to `/login`. The forced first-login change path is worse — the
stale cached session still carries `mustChangePassword: true`, so completing the change bounces
the operator back into the forced-change dialog, risking a loop.

Separately, a review of the change-password path surfaced a security gap worth fixing in the
same pass: changing a password does NOT invalidate pre-existing sessions, so under the
"login == host-root" model a session established before a password change keeps living.

## What Changes

- **Frontend post-login navigation (the bug):** the two credential paths that today use a
  TanStack soft `navigate()` — successful password/OTP login, and forced-change completion —
  switch to a full-document navigation (`window.location.assign`), matching the GitHub OAuth
  path's already-proven full-page-load semantics. A full load discards the entire react-query
  cache and re-resolves the session server-side with the existing cookie, so the gate admits
  the operator instead of bouncing them. The ineffective `invalidateQueries` patch on the
  forced-change path is removed.
- **Backend session rotation on password change (the hardening):** a successful
  `change-password` invalidates the account's pre-change sessions and mints a fresh session
  token for the current request, returning it via `Set-Cookie` so the current browser continues
  seamlessly while other/older sessions are signed out.
- **No change to login-state semantics:** the session cookie is still minted at first login; this
  fix does NOT require "log in again after changing the password" and does NOT re-issue a cookie
  on the success-login path (the existing cookie is already valid).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `frontend-console`: post-login and forced-change-completion navigation into the console MUST be
  a full document load so the auth gate re-resolves the session from the existing session cookie
  and is not bounced by a pre-warmed, stale `authSession` cache.
- `password-login`: a successful change-password MUST rotate the session — invalidate the
  account's pre-change sessions and issue a fresh session cookie for the current request.

## Impact

- **Frontend:** `apps/web/src/routes/login.tsx` — `afterLoginSuccess` and `afterForcedChange`
  switch to `window.location.assign`; the stale `invalidateQueries` call is removed; an unused
  `useNavigate` import is cleaned up if it becomes dead.
- **Backend:** `apps/api/src/auth-password/password.service.ts` (`changePassword` gains session
  rotation) and `apps/api/src/auth-password/password.controller.ts` (the `change-password`
  response sets the new session cookie). Reuses `apps/api/src/auth/session-token.ts` and
  `session-cookie.ts`. Operates on the existing Prisma `Session` table.
- **Contracts:** `AuthSessionResponse` shape is unchanged; the change-password response gains a
  `Set-Cookie` header.
- **No database schema change** (the `Session` table already exists).
- Behavior change is scoped to REAL/auth-on mode; the local mock gate (sessionStorage) is
  unaffected, and the GitHub OAuth path is already full-page and untouched.
