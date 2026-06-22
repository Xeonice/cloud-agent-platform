## Context

The console's only entry today is GitHub OAuth gated by `AUTH_ALLOWLIST` (numeric
GitHub IDs), re-confirmed on every request. Because the backend executes as
host-root over `docker.sock`, the login boundary is a load-bearing, fail-closed
security control. `User` is keyed on `githubId Int @unique`, with the encrypted
GitHub access token stored directly on `User` and read in five downstream places
(import/clone/forge). There is no email/password, no mailer, no password-hash
library, no seed script, and the frontend login is GitHub-redirect (real) or a
sessionStorage gate (mock).

This change adds a self-hostable private identity layer (email+password and email
verification code) alongside GitHub, provisions a default admin at deploy, and
preserves the fail-closed posture. It is the "identity layer (A)" deferred from
the multi-forge-delivery epic. See `research-brief.md` for the verified code facts
and the full set of locked decisions.

## Goals / Non-Goals

**Goals:**
- Three login methods resolving to one account model: email+password, email OTP,
  and GitHub OAuth — all converging on a single `User` via `IdentityLink`.
- A pure-DB runtime gate (`User.allowed`) that governs local and GitHub accounts
  uniformly, keeping fail-closed semantics (no account / not allowed → denied).
- A default admin usable on a fresh, no-GitHub deploy, without a weak fixed
  password.
- Admin-managed account lifecycle (no public registration), including the ability
  to disable GitHub-linked accounts.
- Per-attacker brute-force protection on the new pre-auth endpoints.

**Non-Goals:**
- Public self-service registration / password reset by end users (admin-driven only).
- Role-based *execution* isolation — `role` only gates the admin panel; every
  `allowed` account is host-root. This is stated explicitly so the UI never implies
  sandboxing by role.
- Replacing the legacy `AUTH_TOKEN` break-glass path (kept unchanged, default off).
- Multi-provider OAuth beyond GitHub (GitLab/Gitee OAuth) — IdentityLink leaves
  room for it, but it is out of scope here.
- SSO/SAML/OIDC, TOTP 2FA, WebAuthn.

## Decisions

### D1 — Normalized identity via `IdentityLink` (not a fat `User`)
`User` holds account-level facts (`id`, `email? @unique`, `name`, `avatarUrl`,
`role`, `allowed`, `mustChangePassword`, `createdAt`). A new
`IdentityLink(id, userId, provider, providerAccountId, secret?, createdAt,
@@unique([provider, providerAccountId]))` holds each login identity:
- `provider="github"`, `providerAccountId=<numeric github id>`, `secret=<encrypted access token>`
- `provider="password"`, `providerAccountId=<email>`, `secret=<argon2 hash>`

OTP is **not** an identity row — it is a login method keyed on `User.email`; codes
live in a separate `EmailOtp` table. *Why:* the user picked the normalized model so
future providers add a row, not a column; it cleanly separates "who you are" from
"how you prove it." *Alternative considered:* fat `User` with `passwordHash` +
nullable `githubId` columns — smaller blast radius but doesn't generalize and was
explicitly rejected.

### D2 — Runtime gate = `User.allowed` (pure DB)
`resolveSession` / `resolveApiKey` / `resolveMcpToken` stop calling
`isAllowlistedRaw(githubId, env)` and check `if (!user.allowed) return null`.
`AUTH_ALLOWLIST` is consulted **only at GitHub login** to set `allowed` on
first/again login (provisioning). *Why:* a single uniform gate for all identity
types; local accounts have no githubId to check. *Trade-off (accepted):* editing
`AUTH_ALLOWLIST` no longer kicks a GitHub user at runtime — revocation is a DB/admin
action. *Consequence (load-bearing):* GitHub accounts MUST be disable-able in the
account-administration UI (see D7), otherwise there is no revocation path.

### D3 — `githubAccessToken` moves into `IdentityLink(github).secret`
All 8 read/write points migrate behind one helper, e.g.
`getGithubTokenForUser(userId)` / `setGithubTokenForUser(userId, token)`, reusing
`storeMaybeEncrypted`/`readMaybeEncrypted`. The global fallback query in
`prisma-provision-lookup.ts` (`where: { allowed: true, githubAccessToken: { not:
null } }`) becomes a query over `IdentityLink` github rows joined to `allowed`
users. *Why:* the user chose full normalization; the token is the github identity's
secret. *Alternative considered:* keep token on `User` (minimal ripple) — rejected
in favor of consistency.

### D4 — Email is canonical for local accounts; GitHub email fetched + verified
OAuth scope adds `user:email`; we read the **primary verified** email and store it
on `User`. `email` is `@unique` but nullable (a GitHub user without a verified
email simply has none and can only use GitHub). *Why:* enables password/OTP for
GitHub users (decision 4) and gives every local account a stable handle.

### D5 — Password hashing with `@node-rs/argon2`; OTP over `nodemailer` SMTP
argon2id with sane params; constant-time verify. OTP: 6-digit numeric, 10-minute
TTL, **hashed at rest** (SHA-256, same discipline as session tokens), single-use
(`consumedAt`), 60-second resend cooldown, attempt cap. Email sent via a thin
`MailModule` wrapping `nodemailer` over raw SMTP. *Why:* native argon2 is fast and
strong; raw SMTP avoids cloud-provider lock-in for self-hosters. *Docker note:*
`@node-rs/argon2` ships prebuilt binaries; verify it resolves in the api image at
build time (boot-smoke covers it).

### D6 — Default admin: idempotent seed + one-time reveal
A self-contained seed (run from a single, order-independent boot path — NOT
spread across providers, per the prior cross-bootstrap outage) upserts the admin
identified by `ADMIN_EMAIL`. If `ADMIN_PASSWORD` is unset, generate a random
password; store only its argon2 hash; hold the **plaintext in process memory** in a
small reveal-state holder. A one-time reveal endpoint returns `{email, password}`
exactly once (guarded by an unviewed flag persisted in `SystemSettings`, e.g.
`adminRevealConsumedAt`), then clears the in-memory plaintext. `mustChangePassword
= true` on the seeded admin. If the process restarts before reveal is consumed,
regenerate (DB never holds plaintext). *Why:* fresh deploys must be usable without
a weak fixed password; the operator sees the credential once. *Alternative
considered:* fail-fast when nothing is configured — rejected by the user in favor
of always-seed + reveal.

### D7 — Account administration covers GitHub accounts too
The admin page lists local and GitHub-linked accounts. Local accounts:
create/enable/disable/reset-password/role. GitHub accounts: role read-only,
enable/disable available (the D2 revocation path), no password reset. No public
registration anywhere. *Why:* pure-DB gate (D2) requires a UI path to revoke
GitHub users.

### D8 — Verified-email auto-linking (audited)
When a GitHub login returns a **primary + verified** email matching an existing
`User.email`, attach the github `IdentityLink` to that user and write an audit
event. If the email is unverified or not primary, do not auto-link. *Why:* the
`@unique` email constraint forces link-or-reject; the user chose auto-link; the
verified-only + audit constraints contain the hijack→host-root risk.

### D9 — `mustChangePassword` enforced at the AuthGuard chokepoint
After the guard resolves a principal, if `user.mustChangePassword` is true and the
request path is not the change-password endpoint (or logout), deny with a signal
the frontend turns into the forced-change dialog. Single enforcement point.

### D10 — New public endpoints + anonymous rate limiting
New pre-auth endpoints (`/auth/password`, `/auth/otp/request`, `/auth/otp/verify`,
the change-password and admin-reveal endpoints) are added to `OAUTH_EXEMPT_PATHS`
(exact-match). Because `PrincipalThrottlerGuard` keys on an authenticated principal
(absent pre-auth), add a dedicated **IP + per-email** throttle tier for these
endpoints so one attacker can't brute-force or exhaust a shared bucket.

### D11 — Frontend capability flags + modal
Backend `capabilities` exposes `passwordAuthEnabled` and `otpAuthEnabled`
(= SMTP configured). The login route renders a centered modal with a 3-method
segmented switch; methods whose flag is false are not rendered. A first-login
change dialog and a one-time admin-reveal modal complete the flow. The mock seam in
`mock-session.ts` extends to the new methods.

## Risks / Trade-offs

- **Auto-link email hijack (login==host-root)** → only link on GitHub
  primary+verified email; record an audit event; never link on unverified email.
- **Data migration of live GitHub users** (encrypted tokens + allowed flags) →
  expand-contract: (1) add `IdentityLink`, `EmailOtp`, new `User` columns; (2)
  backfill github rows from existing `User` (id→providerAccountId, token→secret,
  set email if known); (3) switch all reads to the helper; (4) drop
  `githubId`/`githubAccessToken` columns in a later migration after verification.
  Keeps a rollback window.
- **Cross-provider bootstrap ordering** (prior 6h prod outage) → the admin seed is
  self-contained and idempotent, not dependent on another provider's bootstrap;
  guarded so a partial run is safe to repeat.
- **One-time reveal exposure** → reveal endpoint is unauthenticated but single-use
  (consumed flag in DB) and only serves while plaintext is in memory; restart
  before consume regenerates; plaintext never persisted.
- **Weak admin password** → random generation + `mustChangePassword` + argon2.
- **`prisma-provision-lookup` global fallback** depends on "some allowed user has a
  github token" → after D3 the query targets github `IdentityLink` rows; preserve
  the owner-scoped-then-fallback behavior.
- **SMTP misconfig silently breaking OTP** → capability flag hides OTP when SMTP is
  unset; surface send failures to the operator rather than failing closed silently.
- **argon2 native binary in Docker** → boot-smoke must exercise a hash/verify and
  the seed path so a missing/incompatible binary fails CI, not production.

## Migration Plan

1. Ship additive schema (new table/columns) + backfill migration; deploy with reads
   still tolerant of both shapes where feasible.
2. Switch all token reads/writes to the github-identity helper; flip the three
   re-confirmation gates to `User.allowed`.
3. Land password/OTP/seed/admin endpoints + mail module + rate-limit tier (OTP/
   password shipped inert where prerequisites unset).
4. Deploy with `ADMIN_EMAIL` (+ optional `ADMIN_PASSWORD`) and `SMTP_*`; verify
   reveal + first-login change on a staging deploy.
5. Drop `githubId`/`githubAccessToken` columns in a follow-up migration once the
   helper path is verified in production.
- **Rollback:** until step 5, the old columns still exist; reverting the API image
  restores the previous gate. After step 5, rollback requires re-adding columns +
  re-backfill from `IdentityLink`.

## Open Questions

- None blocking. `role` carries no execution privilege today (admin-panel gate
  only); if future work wants per-role task scoping it is a separate change.
- OTP availability for a GitHub user depends on a stored verified email; users
  without one keep GitHub-only access (acceptable).

## Post-apply addendum — apply outcome + visual-harness re-sync

**Apply outcome.** Implemented via the parallel-track apply, then proven by the
adversarial verify (`opsx-verify`): **pass:true, 26 requirements, 0 unmet** (20
direct + 6 re-traced after the verify-reopened tasks V1–V7 landed — the password
login + change-password endpoints, the frontend live-capability + forced-change
wiring, and the spec relaxation for the deprecated `githubId` column). Gates green:
`turbo build/typecheck/lint`, 344 api + 189 web unit tests. Two reconciliations the
parallel apply surfaced: (a) the `@cap/contracts` admin DTOs had diverged from the
backend's real wire shape (`initialCredential`+`password`, reset `password`, list
`identity`/`isGithubLinked`) — the contract was aligned to the backend (it had no
other consumers); (b) the admin-list `email` was loosened from a strict `.email()`
to a nullable string so an intranet `ADMIN_EMAIL=admin@local` can never fail the
list parse (strict email validation stays on the create *request*).

**Visual harness (task 9.7) — done as a full re-sync, not deferred.** The pixel
gate was NOT infra-broken (the serve ROOT is already stabilized to
`apps/web/e2e/design-baseline/`); the real problem was an accumulated baseline
drift — the in-repo `design-baseline/` is a hand-curated snapshot of the OD
prototype project, and several prior changes (e.g. the forge-credentials card)
shipped app UI without re-syncing it, so `--check` reported 12/14 files stale.
Fixes:
- New one-command re-sync tool `apps/web/e2e/sync-design-baseline.mjs`
  (`--check` reports drift, CI-friendly; no-arg copies OD → `design-baseline`),
  with the "after a design change" loop documented in `e2e/visual/manifest.ts`.
- Re-synced ALL baselines to the current OD design (login modal, settings forge
  card + read-only allowlist + role row, the NEW accounts page, refreshed landing
  copy); added `accounts` to the manifest; re-measured every page (`VV_MEASURE=1`,
  computing exact ratios from pixel counts ÷ viewport) and recorded
  measured+headroom thresholds. No page diffed abnormally (max tasks-new desktop
  0.105, the known density delta — no app/OD structural divergence).
- Suite runs **green twice (44/44, deterministic)**.
