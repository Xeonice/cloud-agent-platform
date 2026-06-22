<!-- Track-annotated tasks. Two disjoint tracks (frontend routes vs backend auth-password)
     run in parallel; tasks within a track are serial. -->

## 1. Track: frontend-redirect (depends: none)

- [x] 1.1 `apps/web/src/routes/login.tsx` — in `afterLoginSuccess`, replace the soft `navigate({ to: safeClientRedirect(redirect) })` with a full document load `window.location.assign(safeClientRedirect(redirect))` so the success path enters the console via a full page load.
- [x] 1.2 `apps/web/src/routes/login.tsx` — in `afterForcedChange`, replace the soft `navigate(...)` with `window.location.assign(safeClientRedirect(redirect))` AND remove the now-redundant `queryClient.invalidateQueries({ queryKey: authSessionQuery().queryKey })` (the full load discards the cache; the invalidate was ineffective on `/login`).
- [x] 1.3 `apps/web/src/routes/login.tsx` — remove the `useNavigate` import/usage if it becomes dead after 1.1/1.2, and drop the `useQueryClient`/`authSessionQuery` imports if they are no longer referenced; keep `safeClientRedirect`/`safeRelativePath`.
- [x] 1.4 Add/extend a frontend test asserting: (a) with `authSession` pre-warmed to `null` (landing) under REAL/auth-on, a successful password/OTP login triggers a full-document navigation to `/dashboard` (or the carried redirect) rather than a soft `navigate` that the gate could bounce; (b) forced-change completion triggers a full-document navigation and does not re-open the forced-change dialog. (Assert the full-load seam, e.g. by spying on `window.location.assign`.)

## 2. Track: backend-session-rotation (depends: none)

- [x] 2.1 `apps/api/src/auth-password/password.service.ts` — in `changePassword`, after rotating the `IdentityLink` secret and clearing `mustChangePassword`, rotate the session: invalidate the account's pre-change `Session` rows (delete the user's sessions, including the current one), mint a fresh session token via `mintSessionToken()` + `prisma.session.create({ userId, tokenHash, expiresAt: sessionExpiryFrom() })`, and return the new plaintext token alongside the refreshed `SessionUser` (extend the return shape, e.g. `{ token, user }`). Preserve all existing fail-closed return-`null` paths.
- [x] 2.2 `apps/api/src/auth-password/password.controller.ts` — in `changePassword`, on success set `res.setHeader('Set-Cookie', buildSessionCookies(req, result.token))` (mirroring the login route) before returning the `AuthSessionResponse` body, so the current client continues seamlessly with the rotated cookie. Keep the uniform 401 on the `null` path.
- [x] 2.3 Extend the backend tests (e.g. `apps/api/src/auth-password/password.service.spec.ts` and/or `apps/api/src/auth/forced-password-change.spec.ts`) to cover: a pre-change session token no longer authenticates after a change; the change-password response issues a fresh session cookie and that new token authenticates; and the forced first-login change clears `mustChangePassword` together with the rotation.
