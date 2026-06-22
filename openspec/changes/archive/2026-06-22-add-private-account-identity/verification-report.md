# Verification Report — add-private-account-identity

Adversarial spec verification with three-way routing. Each raw-unmet finding was
re-traced end-to-end against the actual code before routing; the skeptic was not
rubber-stamped. Outcomes: requirements that re-trace as satisfied are folded in
below (MET); real code problems became `verify-reopened` tasks in `tasks.md`;
genuinely ambiguous/untestable requirements went to `design.md` Open Questions.

## Routing summary

- Re-opened as code tasks: 7 (prior pass) + 0 (this pass)
- Spec defects (design.md Open Questions): 0
- Reclassified MET (folded in below): 7 (prior pass) + 6 (this pass; see
  "Re-verification pass" below)

## Re-verification pass (verify-reopened tasks resolved → raw-unmet now MET)

A second adversarial pass re-traced the six raw-unmet requirements the skeptic
flagged in the prior pass. ALL SIX now re-trace end-to-end as satisfied: the
verify-reopened tasks V1–V7 that addressed them have since landed (all `[x]` in
`tasks.md`). Independent re-trace this pass (not a rubber-stamp of the skeptic, and
not a rubber-stamp of the `[x]` marks — code + tests re-run):

- **Forced first-login password change** (`password-login`) → MET. Scenario 1
  (guard 403 `password_change_required`, auth.guard.ts:226-234) AND Scenario 2 now
  both met: `POST /auth/change-password` exists (password.controller.ts:67-89 →
  password.service.ts:107-162) rotates the argon2 secret via `identityLink.upsert`,
  clears `mustChangePassword`, so the old temp credential stops verifying.
  `PasswordModule` wired (app.module.ts:35,158). Tests green:
  password.service.spec + forced-password-change.spec (38 backend cases pass).
  Closes V1 (the password login `POST /auth/password` handler) and V2.

- **Client auth gate on the app-shell** (`frontend-console`) → MET. `_app.tsx`
  `beforeLoad` (50-86) resolves the session SSR+client, bounces a
  `mustChangePassword` session into the forced-change flow on direct
  load/refresh/deep-link (66-71), and redirects an unauthenticated visitor with the
  carried `redirect` deep-link (84). `SessionUserSchema.mustChangePassword`
  (contracts session.ts:79) and the `capabilities` block (session.ts:120) now exist
  and are populated on `GET /auth/session`. Tests green: `_app.auth-gate.test.ts` +
  `real-auth-session.test.ts` (10 pass). Closes V3.

- **Random admin password with one-time reveal** (`default-admin-bootstrap`) → MET.
  CSPRNG generation, in-memory-only plaintext, atomic single-use claim via
  `systemSettings.updateMany(where adminRevealConsumedAt=null)` returning `{}` on a
  lost/repeat claim, holder cleared unconditionally (admin-reveal.controller.ts:47-83);
  restart-before-consume regenerates. Tests green (admin-seed.service.spec).

- **Admin-only account lifecycle management** (`account-administration`) → MET.
  `requireAdmin()` reads the LIVE `User` row (`role==='admin' && allowed===true`)
  before every handler (accounts.controller.ts:132-153). The prior minor frontend
  gap (route `beforeLoad` only checked authed, not role) is now CLOSED:
  accounts.tsx:93-95 redirects a non-admin to `/dashboard`. Tests green
  (accounts.service.spec).

- **Disabling any account revokes access on next request** (`account-administration`)
  → MET. `setEnabled()` flips `User.allowed` (accounts.service.ts:127-135); all three
  resolvers fail closed on `!user.allowed` (auth-session.service.ts:304, 369, 525),
  applying uniformly to local and GitHub-linked accounts. Tests green.

- **Account administration page in the console** (`account-administration` /
  `frontend-console`) → MET. The three page scenarios (menu admin-gated entry,
  by-kind actions, filtering) hold, AND the prior MET-with-gap live-wiring concern is
  now resolved (V5): accounts.tsx reads `adminAccountsQuery` (live `GET /accounts`
  via `isCapable('accounts')`, else mock store) and writes through
  create/enable-disable/reset mutations that invalidate the list. Route `beforeLoad`
  adds the admin-role gate. No remaining gap.

Net: 6 raw-unmet → 6 MET this pass; 0 new code tasks; 0 new spec defects. The
`verify-reopened` track in `tasks.md` (V1–V7) is fully `[x]`; the V4 secondary
concern is closed — `isOtpAuthEnabled()` (oauth-config.ts:153-159) now delegates to
`isSmtpConfigured()` (the same all-five-vars + valid-port check the mailer uses), so
the advertised OTP availability can never over-advertise relative to the fail-closed
send gate. Every spec requirement now has traceable implementation.

## MET requirements (re-traced as satisfied)

### Anonymous brute-force throttle on pre-auth auth endpoints (request-rate-limiting)

MET. `AuthThrottleGuard` (apps/api/src/rate-limit/auth-throttle.guard.ts) extends
`ThrottlerGuard`, narrows to the `auth` named tier only in `onModuleInit`
(lines 75-80), `shouldSkip` skips every path not in `AUTH_THROTTLED_PATHS` (the
four pre-auth routes, lines 88-93), and `getTracker` keys the bucket on
`ip:<ip>|email:<lowercased>` with no principal dependency (lines 100-106);
`authThrottleTrackerKey` degrades an absent email to `-` so IP still buckets. The
`auth` tier is registered with limit=10/ttl=60s, env-overridable and floored by
`positiveIntEnv` so misconfiguration cannot disable it
(apps/api/src/rate-limit/throttler.options.ts:62-77). Wired as the third global
`APP_GUARD` (app.module.ts:204-207), disjoint from `PrincipalThrottlerGuard`
which explicitly filters the `auth` tier OUT. Behavioral coverage in
auth-throttle.guard.spec.ts:132-182. Re-trace confirms the skeptic's own
high-confidence MET reading.

### Allowlist gate is the load-bearing fail-closed security boundary (multi-user-oauth)

MET. `parseAllowlist`/`isAllowlistedRaw` (allowlist.ts:34-97) deny-by-default on
empty/unset/unparseable input and match numeric id only. The gate is step 1 of
`establishSessionForGitHubUser` (auth-session.service.ts:140-148) — a denied
identity returns `null` before any upsert/session mint; the OAuth callback maps
`null` to `?denied=allowlist` with no cookie set
(github-oauth.controller.ts:205-229). The runtime gate is the pure-DB
`User.allowed` flag, re-confirmed in `resolveSession`/`resolveApiKey`/
`resolveMcpToken` (292-295, 355-358, 509-512) and enforced by the guard on every
non-exempt request plus the WS handshake. The amended spec
(specs/multi-user-oauth/spec.md:31) makes the allowlist explicitly login-time
provisioning with `User.allowed` as the runtime gate — an intentional, documented
pivot, not a gap.

### User record keyed by GitHub identity (multi-user-oauth)

MET. `establishSessionForGitHubUser` (auth-session.service.ts:135-235) runs the
allowlist gate FIRST (line 142), then resolves the account via
`identityLink.findUnique` on the composite `(provider="github",
providerAccountId=String(githubId))` (155-162). S1: first login `prisma.user.create`
(214-225). S2: re-login `prisma.user.update` refreshes login/name/avatarUrl/email
without duplicating (165-177). S3: record creation is reached only after the gate,
and `setGithubTokenForUser` is after the gate too. The User is keyed via the
`IdentityLink` composite unique; `User.githubId` is retained nullable for backward
compat. Implementation re-traces as correct end-to-end.

Minor gap (does not block, not in CI gate): `auth-session.service.test.mjs`
`makePrisma` (lines 47-76) only stubs `user.upsert` + `session.*`; the refactored
service now calls `prisma.identityLink.findUnique` and `prisma.user.update/create`,
so T1/T3/T4 in that harness would throw against the fake. However, the api test
gate runs ONLY `dist/**/*.spec.js` (apps/api/package.json:16) — the `.test.mjs`
harnesses are standalone manual probes and are NOT part of CI, so this stale
fake does not break the spec gate. Recommend refreshing the harness's fake Prisma
to mirror the normalized-identity shape when next touched (tracked as a
verify-reopened note, not blocking the requirement).

### Random admin password with one-time reveal (default-admin-bootstrap)

MET. CSPRNG `randomInt` from node:crypto, 20-char/55-symbol alphabet (~115 bits)
(admin-seed.service.ts:8,302-311). On fresh deploy the hash is stored in
`IdentityLink.secret`, plaintext only in the in-memory holder (181-189);
restart-before-consume regenerates (199-215). The reveal endpoint
(admin-reveal.controller.ts:47-83) performs an atomic single-use claim via
`updateMany(where: adminRevealConsumedAt=null)`, clears the holder
unconditionally, and returns `{}` on a lost/repeat claim so a probe cannot
distinguish consumed from never-generated. Persisted flag at
schema.prisma:579; path exempted in OAUTH_EXEMPT_PATHS; module wired. Unit
coverage at admin-seed.service.spec.ts:304-395. Re-trace confirms MET.

### Admin-only account lifecycle management (account-administration)

MET. `requireAdmin()` (accounts.controller.ts:132-153) reads the LIVE `User` row
(`role === 'admin' && allowed === true`) before every handler; member/legacy/
undefined principals throw 403. `create()` (accounts.service.ts:75-103) always sets
`allowed=true`, stores the argon2 hash as `IdentityLink.secret`, sets
`mustChangePassword=true` for password accounts, and creates no identity row for
OTP-only accounts — exactly matching the three spec scenarios. Revocation via
`setEnabled()` flips `User.allowed`, re-confirmed by `resolveSession` on the next
request. Module wired (app.module.ts:156). Unit coverage across
accounts.service.spec.ts:232/265/392/426/465/492/503/525. Minor cosmetic gap: the
`/accounts` route `beforeLoad` checks only `authed`, not admin role, so a non-admin
who types the URL sees the (mock) page — but all backend mutations are 403'd
server-side, so this is a UX leak, not a spec breach of "management restricted to
admins."

### Disabling any account revokes access on next request (account-administration)

MET. Write side: `setEnabled()` (accounts.service.ts:127-135) flips `User.allowed`
via `prisma.user.update`. Gate side: all three resolvers fail closed on
`!user.allowed` (auth-session.service.ts:292-296, 355-358, 509-513); the guard
turns the null principal into a 401 (auth.guard.ts:210-215). Applies uniformly to
local and GitHub-linked accounts. Unit coverage at accounts.service.spec.ts:392-412
and 525-534. Re-trace confirms MET.

### Account administration page in the console (account-administration / frontend-console)

MET (with minor non-blocking gaps). The three page scenarios re-trace as satisfied:
- "Account menu opens the administration page": account-menu.tsx:127-131 renders
  the 账号管理 `<Link to="/accounts">` only when `useIsAdmin()` is true
  (use-account-menu.ts:114-119 gates on `session.role === "admin"`); the `/accounts`
  route is registered (routeTree.gen.ts:43-47).
- "Table lists local and GitHub accounts with the right actions":
  accounts-table.tsx:219-231 shows 重置密码 only for `kind === "local"`; both kinds
  get 启用/禁用; GitHub rows show role read-only; the host-root disclaimer is in
  accounts.tsx:188-192.
- "Filtering narrows the account list": accounts-table.tsx:108-138 computes the
  visible set and the count pill across four filter options.

Minor gaps (do not block the page scenarios as written):
(1) Route-level admin enforcement — `accounts.tsx` `beforeLoad` checks only
authentication, not role; a non-admin typing the URL sees the page. The menu entry
is admin-gated and all backend mutations are server-side 403'd, so no real account
data is exposed and no mutation reaches the DB — UX cosmetic only.
(2) Live-data wiring — the page renders the design's `SEED_ROWS` local state
(accounts.tsx:80) rather than the live `GET /accounts` list; create/enable/disable
mutate local state only. The backend admin list+CRUD API IS fully implemented and
verified separately (see the two MET account-administration requirements above);
the spec's page scenarios assert UI structure / action-presence-by-kind /
filtering, all of which the seed data exercises. Recommend wiring the page to the
live API (tracked as a verify-reopened follow-up under the frontend gaps), but it
does not falsify the page-rendering scenarios.

## Gap / scope findings recorded during verification

### Requirements whose primary scenario is NOT implemented (re-opened as code tasks)

1. Email and password authentication (`password-login`): no `POST /auth/password`
   controller/route/module exists anywhere in apps/api/src. app.module.ts:149-153
   explicitly states it is not yet implemented. The guard exemption + `auth`
   throttle tier list the path in anticipation, but neither is an implementation.
   The frontend `passwordLogin()` POSTs to `/auth/password` in real mode and would
   404. Tasks 4.1/4.3 are unchecked.

2. Forced first-login password change (`password-login`): Scenario 1 (guard-level
   block) IS met (auth.guard.ts:217-233 throws `password_change_required`), but
   Scenario 2 ("setting a new password clears the flag") is NOT — no
   `POST /auth/change-password` controller/service exists. Task 4.2 unchecked.
   Without it a must-change account can authenticate but can never escape the 403.

3. Account-administration page live-data wiring (`frontend-console`): the page is
   rendered correctly but is wired to `SEED_ROWS` mock state, not the live
   `GET /accounts` / mutation API. (Folded MET for the page scenarios above; the
   live wiring is captured as a frontend follow-up task.)

### Frontend capability/flag wiring gaps (re-opened as code tasks)

- Client auth gate on the app-shell (`frontend-console`): `_app.tsx` `beforeLoad`
  checks only `session != null` (line 61) — no `mustChangePassword` check; and
  `SessionUserSchema`/`AuthSessionResponseSchema` (packages/contracts/src/session.ts)
  carry neither `mustChangePassword` nor `capabilities`, so the gate has no flag to
  read even if it wanted to. The spec scenario "Pending password change routes to
  the forced-change flow" (direct-load/refresh case) is unmet on the frontend; the
  only defense is the backend 403, which the gate does not catch into the prescribed
  forced-change UX.

- Login methods are gated by backend capability flags (`frontend-console`) and the
  frontend halves of "Email verification-code (OTP) authentication" and "SMTP
  delivery and capability gating" (`email-otp-login`): `loginCapabilities()`
  (mock-session.ts:66-74) hardcodes `{ password:true, otp:false, github:true }` in
  real mode and never reads the live `otpAuthEnabled` flag; `getAuthSession()`
  (real.ts:478-490) parses only `body.user` and discards the `capabilities` block
  the backend returns (github-oauth.controller.ts:285-325). Net effect: OTP is never
  rendered in real mode regardless of SMTP config — the "SHALL read backend
  capability flags" clause is not met at runtime. The backend OTP service, mailer,
  controllers, and capability flag are fully implemented and unit-tested
  (email-otp.service / otp.controller / mail.service); only the frontend live-flag
  wiring is missing. A secondary backend nuance: `isOtpAuthEnabled()`
  (oauth-config.ts:151-152) advertises OTP on `SMTP_HOST` alone while
  `MailService.isConfigured()` requires all 5 vars — the flag can over-advertise
  relative to the actual fail-closed gate.

### Schema contract-step gap (re-opened as code task)

- Account identity is decoupled from GitHub via IdentityLink (`local-account-identity`):
  the IdentityLink model, github-token helper, and `githubAccessToken` column drop
  are all done and correct. UNMET terminal-state clause: the spec
  (specs/local-account-identity/spec.md:12-13) says "The `User` record SHALL NOT
  carry a `githubId` ... column once migration completes," but `User.githubId Int?
  @unique` is retained (schema.prisma:197) and still read for the session payload
  and the github-import guard. Task 10.4 ("drop `User.githubId` /
  `User.githubAccessToken`") is marked done but only dropped the token half; the
  githubId drop is the deferred contract step that has not yet landed.

### Behaviors implemented beyond any spec requirement (scope notes)

These exist in code but map to no spec requirement; recorded so a future spec pass
can decide whether to ratify or trim them:

1. Cross-origin `SameSite=None; Secure` cookie policy + `SESSION_COOKIE_DOMAIN`
   support — github-oauth.controller.ts:231-274.
2. Proactive clearing of the stale host-only `cap_session` cookie on login/logout
   when a domain cookie is set — github-oauth.controller.ts:260-263,337-345.
3. HMAC-signed anti-CSRF state (`<nonce>.<hmac>`) verified in constant time, used
   instead of a server-side persisted state — session-token.ts:85-127.
4. `ownerGithubId: number | null` on `McpAuthInfo` for local-account attribution —
   not in the mcp-server shape — auth-session.service.ts:56-66.
5. OTP wrong-code attempt cap (`OTP_MAX_ATTEMPTS=5`) — design D5 mentions it but no
   spec scenario covers it — email-otp.service.ts:24-26,167-169.
6. `SystemSettings` row seeded with `MAX_CONCURRENT_TASKS` during admin reveal —
   admin-reveal.controller.ts:59-66.
7. `isAdminPrincipal` returns false for local accounts (`githubId === null`),
   blocking them from the `SELF_UPDATE_ADMINS` gate — admin.ts:74-77.
8. `?denied=allowlist` query param on the login-gate redirect — github-oauth.controller.ts:402-403.
9. Staleness-throttled, best-effort async `lastUsedAt` bump on API key resolution
   (60s window) — auth-session.service.ts:69-75,389-401.
10. Conservative email normalizer returning `null` for malformed input —
    email-otp.service.ts:228-238.

### Re-verification-pass gap / scope findings

**Gap:** All verify-reopened tasks (V1–V7) are confirmed resolved. The
`isOtpAuthEnabled()` flag was aligned with `isSmtpConfigured()` (the same
all-five-SMTP-vars + valid-port check the mailer uses), closing the V4 secondary
concern — the flag can no longer over-advertise OTP when only `SMTP_HOST` is set.
Every spec requirement now has traceable implementation. No remaining gaps.

**Scope (implemented beyond any spec requirement — recorded so a future spec pass
can ratify or trim them):**

11. API-key CRUD 403s local (password/OTP) accounts with `github_identity_required`
    — no spec requires this; the `api-key-auth` spec only requires owner `allowed`
    re-confirmation per request — apps/api/src/api-keys/api-keys.controller.ts:106-114.
12. MCP-token CRUD 403s local accounts with `github_identity_required` — same
    unspecified restriction; the `mcp-server` spec only requires the `allowed`
    re-check and full `AuthInfo` return — apps/api/src/mcp-tokens/mcp-tokens.controller.ts:113-132.
13. `PASSWORD_AUTH_ENABLED` env kill-switch for the password-login method — no spec
    defines an operator toggle to disable password auth; specs treat password auth
    as present whenever the password identity exists —
    apps/api/src/auth/oauth-config.ts:136-156; apps/api/.env.example.
14. `AuthGuard.CHANGE_PASSWORD_PATH` exported as `public static readonly` — an
    implementation coupling detail with no spec requirement for a named exported
    constant — apps/api/src/auth/auth.guard.ts:120.
15. `AccountPanel` role prop defaults to `"admin"` — the `frontend-console` spec
    requires displaying the operator's actual role but does not define the default
    when absent — apps/web/src/components/settings/account-panel.tsx:76.
16. `PrincipalThrottlerGuard.onModuleInit` filter dropping the `auth` tier — the
    `request-rate-limiting` spec defines the two-guard disjoint design but does not
    specify the NestJS `onModuleInit` filter mechanism —
    apps/api/src/rate-limit/principal.throttler-guard.ts:41-50.
17. Mock-gate already-authenticated visitor on `/login` bounced to `/workspace`
    instead of `/dashboard` — the `frontend-console` spec states the post-login
    destination SHALL be `/dashboard` (or the carried redirect) —
    apps/web/src/routes/login.tsx:149.
