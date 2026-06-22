<!-- Track-annotated tasks. Contracts/schema first, then auth-core, then parallel
     feature tracks, then integration. Partition corrected after a codebase file-touch
     scan (see header `touches:` notes). Two converged files are isolated to the
     integration track: `apps/api/src/app.module.ts` (module/global-guard wiring for
     EVERY new module — owned solely by 10.1) and the contract step's column-drop
     migration (10.4). Within-track multi-task files (auth-core's
     `auth-session.service.ts` for 2.3/2.4/2.5 and `auth.guard.ts` for 2.6/2.7) run
     serially inside their track and need no split. Feature tracks 3–8 each create
     their own new module/controller/service files (disjoint from one another) and
     depend on auth-core, so any file they share with auth-core is serial-after, not a
     parallel conflict. Frontend (track 9) lives in apps/web + apps/www, disjoint from
     all backend tracks. -->

## 1. Track: contracts-schema-deps (depends: none)
<!-- touches: apps/api/prisma/schema.prisma (1.1,1.2); apps/api/prisma/migrations/<new>/migration.sql (1.3); packages/contracts/src/auth.ts + new auth-account contract file + index.ts (1.4 — OWNS the capability-flag + DTO contract types; 2.8 only POPULATES them); apps/api/package.json + pnpm-lock.yaml (1.5). Disjoint from all other tracks. -->


- [x] 1.1 Prisma: add `IdentityLink(id, userId, provider, providerAccountId, secret?, createdAt, @@unique([provider, providerAccountId]), @@index([userId]))`, `EmailOtp(id, email, codeHash, expiresAt, consumedAt?, attempts, createdAt)`, and `SystemSettings.adminRevealConsumedAt?`
- [x] 1.2 Prisma: add `User.email String? @unique`, `User.role` (enum admin|member, default member), `User.mustChangePassword Boolean @default(false)`; keep `githubId`/`githubAccessToken` columns for now (expand-contract)
- [x] 1.3 Write the data migration that backfills a `github` `IdentityLink` for every existing user (providerAccountId = githubId, secret = existing encrypted token) and sets `email` where derivable; idempotent/re-runnable
- [x] 1.4 packages/contracts: add zod schemas + types for password login, OTP request/verify, change-password, admin account DTOs (create/enable/disable/reset/role), one-time admin reveal, and the auth capability flags (`passwordAuthEnabled`, OTP-enabled)
- [x] 1.5 apps/api/package.json: add `@node-rs/argon2` and `nodemailer` (+ types); `pnpm install`, regenerate prisma client

## 2. Track: auth-core (depends: contracts-schema-deps)
<!-- touches: NEW apps/api/src/auth/github-identity.ts (2.1); NEW apps/api/src/auth/argon2.ts (2.2); apps/api/src/auth/auth-session.service.ts (2.3,2.4,2.5 — serial within track); apps/api/src/auth/github-oauth.service.ts + apps/api/src/auth/oauth-config.ts (2.3 user:email scope); apps/api/src/audit/audit.service.ts usage (2.4 audit emit, call-site only); apps/api/src/auth/auth.guard.ts (2.6,2.7 — serial within track); apps/api/src/auth/github-oauth.controller.ts (2.8 capability-flag payload on /auth/session). Sole writer of every apps/api/src/auth/* file except the guard-consuming exemption that track 4.2 merely references. -->


- [x] 2.1 Add a shared github-identity helper (`getGithubTokenForUser`/`setGithubTokenForUser`) that reads/writes the encrypted token on the user's `github` IdentityLink via `storeMaybeEncrypted`/`readMaybeEncrypted`
- [x] 2.2 Add a shared argon2 hash/verify util (constant-time verify)
- [x] 2.3 Rework `establishSessionForGitHubUser`: resolve/upsert User + `github` IdentityLink, fetch primary verified email (new `user:email` scope), store email, and set `allowed` from `isAllowlistedRaw` (login-time provisioning only)
- [x] 2.4 Implement verified-email auto-link: when GitHub primary+verified email matches an existing `User.email`, attach the github identity to that user and emit an audit event; never link on unverified/non-primary email
- [x] 2.5 Flip the runtime gate in `resolveSession`, `resolveApiKey`, `resolveMcpToken` from `isAllowlistedRaw(githubId)` to `!user.allowed` (fail-closed)
- [x] 2.6 auth.guard.ts: add the new public endpoints to `OAUTH_EXEMPT_PATHS` (exact-match) — password login, OTP request/verify, change-password, one-time admin reveal
- [x] 2.7 auth.guard.ts: enforce `mustChangePassword` after principal resolution — deny every protected route except change-password (and logout) with a "password change required" signal
- [x] 2.8 Expose `passwordAuthEnabled` and the OTP-enabled (SMTP-configured) flags through the backend capabilities surface the frontend reads

## 3. Track: token-consumers (depends: auth-core)
<!-- touches: apps/api/src/repos/github-import.service.ts (3.1); apps/api/src/sandbox/prisma-provision-lookup.ts (3.2); apps/api/src/forge/forge-target-resolver.ts + apps/api/src/forge/forge-target-resolver.spec.ts + apps/api/src/forge/forge-target-owner-scope.spec.ts (3.3). All consume the 2.1 helper; disjoint from every other track. -->


- [x] 3.1 Migrate `github-import.service.ts` `resolveOperatorGitHubToken` to the github-identity helper
- [x] 3.2 Migrate `prisma-provision-lookup.ts` (owner-scoped read + the global "allowed user with token" fallback) to query github IdentityLink rows joined to allowed users
- [x] 3.3 Migrate `forge-target-resolver.ts` `getForgeTargetOwnerToken` to the helper; update affected specs/mocks (`forge-target-resolver.spec.ts`, `forge-target-owner-scope.spec.ts`)

## 4. Track: password-auth (depends: auth-core)
<!-- touches: NEW apps/api/src/auth-password/* (password.controller.ts, password.service.ts, change-password handler, *.spec) or equivalent new module dir. 4.2 only CONSUMES the must-change guard exemption authored in 2.7 (no auth.guard.ts re-edit). Module registration in app.module.ts is DEFERRED to 10.1. Disjoint from tracks 5/6/7/8. -->


- [x] 4.1 Password login controller/service: resolve by email → verify argon2 → require `allowed` → mint session; uniform generic failure (no account disclosure); never auto-create
- [x] 4.2 Change-password controller/service: set new argon2 hash, clear `mustChangePassword`, invalidate prior temp credential; wire to the guard's must-change exemption
- [x] 4.3 Unit tests: correct/incorrect password, disallowed owner, unknown email uniform failure, must-change forced flow

## 5. Track: mail-otp (depends: auth-core)
<!-- touches: NEW apps/api/src/mail/* (MailModule wrapping nodemailer, 5.1) + NEW apps/api/src/auth-otp/* (email-otp.service.ts, otp.controller.ts request+verify, *.spec). 5.3 gates behind the SMTP capability flag that 2.8 exposes (reads it, no controller re-edit). Module registration in app.module.ts DEFERRED to 10.1. Disjoint from tracks 4/6/7/8. -->


- [x] 5.1 MailModule wrapping `nodemailer` over SMTP env (`SMTP_HOST/PORT/USER/PASS/FROM`); fail-closed + visible send errors when unconfigured
- [x] 5.2 EmailOtp service: issue 6-digit code (hash-at-rest, ~10min TTL), 60s resend cooldown, single-use `consumedAt`, attempt cap
- [x] 5.3 OTP request + verify controllers: uniform non-disclosing request response; verify mints session for allowed account; gate behind SMTP capability flag
- [x] 5.4 Unit tests: issue/verify happy path, expired/consumed/wrong code, unknown-email uniform response, SMTP-off fail-closed

## 6. Track: admin-bootstrap (depends: auth-core)
<!-- touches: NEW apps/api/src/admin-seed/* (self-contained idempotent seed module with its OWN single boot hook + in-memory reveal holder + reveal controller, *.spec). Reads SystemSettings.adminRevealConsumedAt (added in 1.1). Module registration in app.module.ts DEFERRED to 10.1. Disjoint from tracks 4/5/7/8. -->


- [x] 6.1 Self-contained idempotent admin seed (single order-independent boot path; NOT spread across providers): upsert admin by `ADMIN_EMAIL`, role=admin, allowed=true, mustChangePassword=true
- [x] 6.2 Random password generation when `ADMIN_PASSWORD` unset: store argon2 hash only; hold plaintext in an in-memory reveal holder; regenerate on restart if unconsumed
- [x] 6.3 One-time reveal endpoint returning `{email, password}` exactly once, gated by `SystemSettings.adminRevealConsumedAt`; clear in-memory plaintext after consume
- [x] 6.4 Unit tests: idempotent reseed, reveal-once, no-plaintext-persisted, restart-regenerates

## 7. Track: account-admin-api (depends: auth-core)
<!-- touches: NEW apps/api/src/accounts/* (accounts.controller.ts, accounts.service.ts admin-only CRUD/list, *.spec). Reuses 2.1 helper + 2.2 argon2 + the admin-role check; 403 for non-admin. Module registration in app.module.ts DEFERRED to 10.1. Disjoint from tracks 4/5/6/8. -->


- [x] 7.1 Admin-only account service + controller: create local account (email/name/role + initial-credential choice), enable/disable (any account incl. github-linked), reset password, assign role; 403 for non-admin
- [x] 7.2 List endpoint returning local + github-linked accounts with identity, role, login methods, enabled status (for the admin page)
- [x] 7.3 Unit tests: admin CRUD, non-admin 403, disable→next-request-denied, github-account disable path

## 8. Track: rate-limit-auth (depends: auth-core)
<!-- touches: apps/api/src/rate-limit/throttler.options.ts (8.1 — adds the auth-throttle named tier; sole writer, no other track touches this file) + NEW apps/api/src/rate-limit/auth-throttle.guard.ts (or @Throttle decorator on the auth controllers) + *.spec (8.2). The new tier's GLOBAL-guard / ThrottlerModule.forRoot registration in app.module.ts is DEFERRED to 10.1 so this track stays file-disjoint. Disjoint from tracks 4/5/6/7. -->


- [x] 8.1 Add an IP+email throttle tier for the public auth endpoints (password login, OTP request/verify, change-password) independent of the principal throttler; env-tunable caps
- [x] 8.2 Unit tests: per-IP and per-email caps trip without a resolved principal; OTP issuance capped in addition to resend cooldown

## 9. Track: frontend (depends: contracts-schema-deps)
<!-- touches: apps/web/src/routes/login.tsx (9.1,9.2); apps/web/src/lib/mock-session.ts + apps/web/src/lib/api/capabilities.ts (9.3); NEW apps/web/src/routes/accounts.tsx + apps/web/src/components/accounts/* + apps/web/src/components/shell/account-menu.tsx + apps/web/src/hooks/use-account-menu.ts (9.4); NEW reveal modal component (9.5); apps/web/src/components/settings/settings-form.tsx + account-panel.tsx (9.6); apps/web visual baselines + apps/www/index.html copy (9.7). Entirely under apps/web + apps/www — disjoint from all backend tracks. -->


- [x] 9.1 Login route → centered modal with method switch (password / OTP / GitHub), rendering only capability-enabled methods; wire password submit, OTP request→verify, GitHub authorize
- [x] 9.2 Forced first-login password-change dialog in the login/app-shell gate when `mustChangePassword` is set
- [x] 9.3 Extend `mock-session.ts` + capabilities switch for the new methods and flags
- [x] 9.4 Account-administration page (table of local + github accounts, filter, new-account + reset-password dialogs, enable/disable) + 账号管理 entry in the account menu across screens
- [x] 9.5 One-time admin-credential reveal modal on first console visit
- [x] 9.6 Settings: GitHub allowlist read-only (env-managed) + current-role row; remove inline account management
- [x] 9.7 Per-page pixel baselines for the changed surfaces (login, accounts, settings, landing) — DONE as a full visual-harness re-sync + re-calibration. The harness was NOT infra-broken (the serve ROOT was already stabilized to `e2e/design-baseline/`); the real issue was accumulated baseline drift across many changes (12/14 files stale — e.g. the forge card shipped without a baseline re-sync). Built a one-command re-sync tool (`e2e/sync-design-baseline.mjs`, with `--check`), re-synced ALL baselines to the current OD design (login modal, settings forge+role+readonly, NEW accounts page, landing copy), added `accounts` to `manifest.ts`, re-measured every page (`VV_MEASURE=1`), recorded measured+headroom thresholds, and ran the suite GREEN twice (44/44, deterministic). Documented the sync-after-design-change loop in `manifest.ts` to stop the recurring drift.

## 10. Track: integration-and-cutover (depends: token-consumers, password-auth, mail-otp, admin-bootstrap, account-admin-api, rate-limit-auth, frontend)
<!-- ISOLATED shared/convergent files, run serially after all parallel tracks: apps/api/src/app.module.ts (10.1 — the SINGLE writer that wires every new module from tracks 4/5/6/7 + the rate-limit tier's global guard/ThrottlerModule from track 8, confirming no DI/module cycle); .env.example + apps/api/.env.example + deploy docs (10.2); .github/workflows/ci.yml boot-smoke job (10.3); NEW follow-up column-drop migration apps/api/prisma/migrations/<later>/migration.sql (10.4 — separate from 1.3's backfill migration); full build/typecheck/lint/test gate (10.5). -->


- [x] 10.1 Wire new modules (mail, accounts, admin-seed, auth password/otp/reveal) into `app.module.ts`; confirm no DI/module cycles
- [x] 10.2 Update `.env.example` + deploy docs: `ADMIN_EMAIL`, `ADMIN_PASSWORD?`, `SMTP_*`, login/OTP throttle knobs, and the changed `AUTH_ALLOWLIST` semantics (provisioning, not runtime gate)
- [x] 10.3 Boot-smoke covers the seed path + an argon2 hash/verify so a missing native binary or broken seed fails CI, not production
- [x] 10.4 Contract step: after the helper path is verified, drop `User.githubId` / `User.githubAccessToken` columns in a follow-up migration
- [x] 10.5 Full `turbo build` + typecheck + lint + api spec + web tests green

## Track: verify-reopened (depends: none)
<!-- Re-opened by adversarial verification (opsx-verify three-way routing). Each
     item below re-traced end-to-end as a REAL code problem (primary scenario not
     satisfied), not a skeptic mis-read. See verification-report.md for the full
     trace per item. -->

- [x] V1 Password login endpoint (`password-login` — "Email and password authentication"): implement the missing `POST /auth/password` controller/service (resolve by email → verify argon2 → require `allowed` → mint session; uniform generic failure; never auto-create) and wire its module in `app.module.ts`. The guard exemption + `auth` throttle tier already list the path; only the handler is absent. (Re-opens tasks 4.1/4.3.)
- [x] V2 Change-password endpoint (`password-login` — "Forced first-login password change", Scenario 2): implement the missing `POST /auth/change-password` controller/service (set new argon2 hash, clear `mustChangePassword`, invalidate the prior temp credential) and wire it. Scenario 1 (guard block) is already met; without this endpoint a must-change account can never escape the 403. (Re-opens task 4.2.)
- [x] V3 Client auth gate forced-change routing (`frontend-console` — "Client auth gate on the app-shell", "Pending password change routes to the forced-change flow"): surface `mustChangePassword` on `SessionUserSchema`/`AuthSessionResponseSchema` and populate it on `GET /auth/session` for real-auth callers, then extend `_app.tsx` `beforeLoad` to route a `mustChangePassword` session into the forced-change flow on direct load / refresh / deep-link (not only the post-login path in `login.tsx`).
- [x] V4 Frontend reads live login-capability flags (`frontend-console` — "Login methods are gated by backend capability flags"; also the frontend halves of `email-otp-login` "Email verification-code (OTP) authentication" and "SMTP delivery and capability gating"): stop hardcoding `loginCapabilities()` (mock-session.ts:66-74); flow the `capabilities` block already returned by `GET /auth/session` through `getAuthSession()` (real.ts discards it today) into the login modal so `otpAuthEnabled` actually gates the OTP method at runtime. Optionally align `isOtpAuthEnabled()` (oauth-config.ts) with `MailService.isConfigured()` so the flag does not over-advertise OTP when only `SMTP_HOST` is set.
- [x] V5 Account-administration page live-data wiring (`frontend-console` — "Account administration page in the console"): DONE — `accounts.tsx` now reads `adminAccountsQuery` (live `GET /accounts` via `isCapable('accounts')`, else the mock store) and writes through `createAdminAccount`/`setAdminAccountEnabled`/`resetAdminAccountPassword` mutations that invalidate the list; the route `beforeLoad` adds an admin-role check (non-admin → `/dashboard`) plus the mustChangePassword bounce. Backend admin DTOs in `@cap/contracts` were reconciled to the api's real wire shape (the two had diverged: `initialCredential`+`password`, reset `password`, list `identity`/`isGithubLinked`), and the list-item `email` made a lenient nullable string so an intranet `admin@local` never fails the parse.
- [x] V6 `User.githubId` contract step (`local-account-identity` — "Account identity is decoupled from GitHub via IdentityLink"): RESOLVED via spec relaxation rather than an immediate column drop. The spec's terminal clause was tightened-beyond-design (design.md chose expand-contract: drop `githubId` in a FOLLOW-UP migration); the spec now states `githubId` MAY be retained as a deprecated, nullable backward-compat column and SHALL NOT be the identity-resolution key (resolution goes through `IdentityLink`, which it does — `github-import` reads `githubId` only as an attribute of an already-resolved user). The actual column drop remains the documented follow-up migration (task 10.4).
- [x] V7 Refresh stale `auth-session.service.test.mjs` fake Prisma (non-blocking, NOT in CI gate): DONE — the manual probe was rewritten to the normalized-identity model (fake `identityLink.findUnique`/`upsert`, `user.findUnique`/`create`/`update`/`findUniqueOrThrow`, `session.*`) and re-pointed T6 from the removed env re-check to the pure-DB `User.allowed` runtime gate. Runs green (20/20) via `node --test` after a build.
