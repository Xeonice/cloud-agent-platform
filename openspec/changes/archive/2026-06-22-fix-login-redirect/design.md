## Context

In REAL mode (auth capability ON) the password/OTP login success path and the forced
first-login change path use a TanStack soft `navigate()` into the `_app` auth gate. The gate
decides via `ensureQueryData(authSessionQuery())`, which returns the cached value without
refetching. The public landing pre-warms that cache (to `null` logged-out), so the post-login
soft navigation reads a stale value and the gate bounces the operator back to `/login`. The
forced-change path additionally caches `mustChangePassword: true`, so completing the change can
loop back into the forced-change dialog. Sessions are stateful (DB `Session` rows). See
`research-brief.md` for exact source coordinates and the cookie-lifecycle verification.

This change carries two decoupled tracks: a frontend navigation fix (the bug) and a backend
session-rotation hardening on password change (surfaced during the same review).

## Goals / Non-Goals

**Goals:**
- Password/OTP login and forced-change completion reliably reach the console in REAL mode,
  without being bounced by a stale `authSession` cache.
- A password change invalidates pre-change sessions and re-establishes the current client with a
  fresh session credential.

**Non-Goals:**
- No change to the login-state model: the session cookie is still minted at first login; this
  fix does NOT require a second login after a password change and does NOT re-issue a cookie on
  the success-login path.
- No change to the GitHub OAuth path (already full-page) or the local mock gate (sessionStorage).
- No database schema change; no change to `AuthSessionResponse` shape.

## Decisions

**D1 — Full document load over SPA cache surgery (the bug fix).**
The post-login and forced-change navigations switch from `navigate()` to
`window.location.assign(safeClientRedirect(redirect))`. A full load discards the entire
react-query cache and re-resolves the session server-side using the existing cookie, exactly
matching the GitHub OAuth path that is already proven to work. The destination stays the
open-redirect-guarded relative `redirect` or `/dashboard`.
- *Alternative considered (rejected):* keep SPA soft nav but `queryClient.removeQueries` the
  `authSession` before navigating. It is more fragile (depends on the cache key not drifting,
  fixes only the auth query, and leaves every other domain's cache holding logged-out data that
  should be re-fetched under the new identity). A full load also matches an already-shipped path.

**D2 — Do not re-issue a cookie on the success-login path.**
Verified: the cookie is minted at first login (`POST /auth/password`) and stays valid across a
password change (`change-password` does not touch the `Session` table). The full-page navigation
merely re-asks the backend with the already-valid cookie. So Track 1 is purely frontend with zero
backend dependency.

**D3 — Rotate by invalidating pre-change sessions and minting a fresh one (the hardening).**
On a successful `change-password`, the service invalidates the account's pre-change `Session`
rows (including the current one) and mints a new session token; the controller returns it via
`Set-Cookie`. This fully rotates the current credential (defends against a current token that may
already be compromised at change time) while keeping the current client signed in via the new
cookie.
- *Alternative considered (rejected):* keep the current session row and only delete the others.
  Rejected because it leaves the pre-change token (the very credential that might be compromised)
  alive for the current device.

**D4 — Track ordering and coupling.**
The two tracks are independent: Track 1 fixes the redirect even if the backend never rotates, and
Track 2 is correct regardless of how the client navigates. When both ship, the sequence composes
cleanly: `change-password` returns `Set-Cookie` (new token) → the frontend full-page
`window.location.assign` carries the new cookie → SSR gate resolves a clean, must-change-cleared
session.

## Risks / Trade-offs

- **Track 2 mis-implemented so the current request is left unauthenticated (would 401 right after
  change).** → The new credential MUST be issued in the SAME change-password response; a scenario
  explicitly covers "current client continues seamlessly with the new cookie".
- **Full-page load loses SPA snappiness.** → Login and password change are low-frequency; the
  trade is acceptable and matches the existing GitHub path's UX.
- **SSR of the destination must carry the cookie.** → Already proven by the GitHub OAuth path,
  which lands on `/dashboard` via a full load; cookie scope is canonical per `multi-user-oauth`.
- **Open-redirect.** → Destination still flows through `safeClientRedirect` / `safeRelativePath`;
  the full-page navigation only ever targets a same-origin relative path or `/dashboard`.

## Migration Plan

- Pure code change, no DB migration. Frontend and backend deploy independently; the tracks are
  decoupled so either can ship first (Track 1 alone already fixes the visible bug).
- Rollback: revert `login.tsx` (Track 1) and/or `password.service.ts` + `password.controller.ts`
  (Track 2). No data to undo.

## Open Questions

- None blocking. Rotation scope is decided as "all of the account's pre-change sessions" (D3);
  a future per-device "keep other trusted devices" refinement, if ever wanted, is out of scope.
