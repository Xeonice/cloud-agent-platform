# Verification Report — fix-login-redirect

Three-way routing adjudication of verify findings. The raw-unmet input was empty (`[]`);
re-tracing every requirement in both spec deltas against the actual code confirms all are MET.

## Tally

- Reopened (verify-reopened code tasks): 0
- Spec defects (design.md Open Questions): 0
- Reclassified MET: 6 scenarios across 2 requirements

## Requirements re-traced as MET

### frontend-console — "Post-login navigation performs a full document load"

Traced to `apps/web/src/routes/login.tsx`:

- `enterConsole(redirect)` (lines 106–108) calls
  `window.location.assign(safeClientRedirect(redirect))` — a full document load, exported as the
  single test seam.
- `afterLoginSuccess` (line 191) routes the password/OTP success path through `enterConsole`.
- `afterForcedChange` (line 204) routes forced-change completion through `enterConsole`; the prior
  ineffective `queryClient.invalidateQueries({ queryKey: authSessionQuery().queryKey })` is removed.
- `safeClientRedirect` (lines 94–96) keeps the destination open-redirect-guarded
  (`safeRelativePath(redirect) ?? "/dashboard"`).
- The local mock-gate already-authenticated bounce (line 174, `navigate({ to: "/workspace" })`) and
  the GitHub OAuth full-page path are untouched, exactly as the spec scopes ("the local mock gate
  path … is unaffected"; "The GitHub OAuth method … is unchanged").
- Gate side (`apps/web/src/routes/_app.tsx:66-71`): the `mustChangePassword` bounce to
  `/login` with `change=true` is the enforcement the full-load path satisfies cleanly.

Scenarios MET:
1. Password/OTP login from a landing-prewarmed session reaches the dashboard — full load discards
   the stale `null` cache; gate re-resolves from the cookie.
2. Forced-change completion reaches the console without looping — full load discards the cached
   `mustChangePassword: true` so the gate admits the operator.
3. Post-login navigation does not depend on react-query cache freshness — uses
   `window.location.assign`, not a soft `navigate`.

Test evidence: `apps/web/src/routes/login.post-auth.test.ts` — 4/4 passing (spies
`window.location.assign`: `/dashboard`, deep-link `/tasks/abc`, `undefined` → `/dashboard`,
off-site → `/dashboard`).

### password-login — "Changing a password rotates the session"

Traced to `apps/api/src/auth-password/password.service.ts` `changePassword` (lines 109–176) and
`apps/api/src/auth-password/password.controller.ts` `changePassword` (lines 70–93):

- After rotating the `IdentityLink` secret and clearing `mustChangePassword` (lines 142–162), the
  service invalidates pre-change sessions via `prisma.session.deleteMany({ where: { userId } })`
  (line 166), mints a fresh token via `mintSessionToken()` + `session.create(...)` (lines 167–174),
  and returns `{ token, user }` (line 175).
- The controller sets `res.setHeader('Set-Cookie', buildSessionCookies(req, result.token))`
  (line 90) on success — mirroring the login route — so the current client continues seamlessly.
- All fail-closed `null` paths (invalid/expired/disallowed session, no email, bad currentPassword)
  are preserved (lines 114–140); the controller keeps the uniform 401 (lines 81–85).

Scenarios MET:
1. Pre-change session tokens stop working after a password change — `deleteMany` removes the
   pre-change row; a request with the old token fails the `tokenHash` lookup.
2. The current client continues seamlessly — the same response issues a fresh credential via
   `Set-Cookie`; no re-login.
3. Forced first-login change clears the flag and rotates together — `mustChangePassword: false`
   plus rotation happen in one operation.

Test evidence: `apps/api/src/auth-password/password.service.spec.ts` and
`apps/api/src/auth/forced-password-change.spec.ts` — 15/15 passing (compiled `dist` path),
including "rotates the hash + session, clears mustChangePassword, and the old password stops
working", "the pre-change session token no longer authenticates", and the change-password
EXEMPT-from-must-change guard checks.

## Gap analysis

All requirements have traceable implementations. Every scenario in both specs maps to existing code:

- `enterConsole` / `window.location.assign` covers all frontend-console scenarios
- `PasswordAuthService.changePassword` with `deleteMany` + fresh `session.create` + `Set-Cookie`
  rotation covers all password-login scenarios
- The `_app.tsx` `mustChangePassword` bounce with `change=true` covers the gate-side enforcement

No gaps identified.

## Scope analysis (no scope creep)

Comparing implementation to spec requirements:

**Spec requirements (summarized):**
1. `frontend-console` spec: post-login and forced-change-completion use `window.location.assign`
   (full document load), not soft navigate. Mock gate / GitHub OAuth unchanged.
2. `password-login` spec: `changePassword` rotates the session (delete pre-change sessions, mint
   fresh token, return in same response via `Set-Cookie`). Applies to both forced first-login
   change and self-service.

**Implementation analysis:**

- `login.tsx`: `enterConsole` is extracted and exported. The spec is silent on exporting, but this
  is solely for testability (task 1.4 asks to spy on `window.location.assign`, and the test imports
  `enterConsole`). It supports the test requirement, not new behavior.
- `login.tsx` line 128 / 174: `useNavigate` is still imported and used for the MOCK-gate
  already-authenticated bounce, which the spec explicitly says "is unaffected." Correct existing
  behavior retained (task 1.3 only removes `useNavigate` "if it becomes dead" — it did not).
- `password.service.spec.ts`: extended to cover session rotation — directly required by task 2.3.
- `login.post-auth.test.ts`: four cases — `enterConsole("/dashboard")`, a relative deep-link
  (`/tasks/abc`), `undefined` (fallback to `/dashboard`), and an off-site redirect (open-redirect
  guard fallback). The deep-link and off-site cases verify the spec clause "The destination SHALL
  remain the open-redirect-guarded relative `redirect` deep-link when present" — in-spec, not extra
  behavior. The seam-test strategy (testing `enterConsole` directly rather than mounting React) is
  an implementation choice satisfying task 1.4.

None of the four test cases are out-of-spec. All changes map cleanly to spec requirements; there
are no implemented behaviors lacking a corresponding spec requirement.

## Open Questions deferred (not defects)

design.md "Open Questions" already records the only deferred item — a future per-device
"keep other trusted devices" rotation refinement — as explicitly out of scope (D3). This is a
known, decided non-goal, not a spec defect or code task.
