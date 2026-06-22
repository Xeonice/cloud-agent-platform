# Research Brief — fix-login-redirect

Side-car notes (not a tracked artifact). All facts below were verified by reading source
during the explore that produced this change.

## The bug (frontend cache staleness — verified, not backend)

Trigger chain in REAL mode (auth capability ON):

1. Landing `/` (`apps/web/src/routes/index.tsx:61`) calls `useQuery(authSessionQuery())`,
   pre-warming the `authSession` cache to `null` while logged out (an active observer).
2. `authSessionQuery()` (`apps/web/src/lib/api/queries.ts:389`) has `staleTime: 0`.
3. `_app` gate `beforeLoad` (`apps/web/src/routes/_app.tsx:50`) decides auth via
   `context.queryClient.ensureQueryData(authSessionQuery())`. `ensureQueryData` returns a
   CACHED value when one exists and does NOT refetch on `staleTime: 0` alone.
4. `login.tsx afterLoginSuccess` (~`apps/web/src/routes/login.tsx:175`) does
   `navigate({ to: ... })` — a TanStack SPA soft navigation. The gate then reads the stale
   cached `null` → `throw redirect({ to: "/login" })`. Symptom: "click login, nothing happens
   / flashes back to login".
5. Forced-change path `afterForcedChange` (~`login.tsx:190`) is worse: the stale cache holds
   `{ mustChangePassword: true }`; after soft nav the gate hits `_app.tsx:66`
   `session?.mustChangePassword` → bounces to `/login?change=true` (forced-change dialog),
   risking a loop. Its existing `queryClient.invalidateQueries(...)` patch is INEFFECTIVE —
   on `/login` the `authSession` query has no active observer, so invalidate only marks stale
   (default `refetchType: 'active'`) and `ensureQueryData` still returns the old value.

Only REAL mode reproduces. Mock mode (`apps/web/src/lib/mock-session.ts`) gates on
`sessionStorage` read synchronously → unaffected. GitHub login uses
`window.location.href = .../auth/github/login` (`mock-session.ts:149`) → full page load →
unaffected. So the bug is exclusive to the password/OTP "frontend fetch then soft-nav" paths
introduced by add-private-account-identity.

## Cookie lifecycle (verified — no re-login needed)

- First login `POST /auth/password` mints the session AND sets the cookie:
  `verifyAndMint` (`apps/api/src/auth-password/password.service.ts:88-95`) →
  `prisma.session.create({ userId, tokenHash, expiresAt })`; controller sets `Set-Cookie`
  (`password.controller.ts:61`). Sessions are STATEFUL (DB `Session` rows, `tokenHash` lookup).
- `change-password` (`password.controller.ts:67-89`) reads the current cookie token and calls
  the service; it does NOT `Set-Cookie`. `changePassword`
  (`password.service.ts:107-162`) only rotates `IdentityLink.secret` and clears
  `mustChangePassword` — it NEVER touches the `Session` table.
- Therefore the first-login cookie stays valid across a password change. The fix's full-page
  navigation simply re-asks the backend with the already-valid cookie. No second login, no
  cookie re-issue on the success path.

## Security gap (Track 2 rationale)

Because `change-password` does not touch the `Session` table, all sessions that existed before
a password change keep living. Under "login == host-root" (multi-user-oauth D1) the harden is:
on successful change, invalidate the account's pre-change sessions, mint a fresh token for the
current request, and `Set-Cookie` it (current browser seamless; older sessions signed out).
Session mint/hash helpers: `apps/api/src/auth/session-token.ts`, `session-cookie.ts`.

## Capability mapping

- Track 1 → `frontend-console` (owns the `_app` auth gate requirement, line ~254, and the
  post-login redirect threading).
- Track 2 → `password-login` (owns the change-password endpoint + "Forced first-login password
  change" requirement, line ~37).
