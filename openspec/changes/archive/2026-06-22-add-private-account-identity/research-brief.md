# Research Brief — add-private-account-identity

Side-car research notes grounding this change. Gathered during `/opsx:explore`
(read-only code investigation + locked product decisions). Not a tracked artifact.

## Problem framing

Today the only way into the console is **GitHub OAuth**, gated by the env
`AUTH_ALLOWLIST` (numeric GitHub IDs). Air-gapped / no-GitHub operators cannot
get in, and there is no self-hosted private account. Security weight: the backend
runs as host-root over `docker.sock`, so **"who can log in == who can run as root
on the host"** — the gate is a load-bearing, fail-closed boundary, not a cosmetic
allowlist.

This change is the "identity layer (A)" deferred from the multi-forge-delivery epic.

## Locked decisions (from explore Q&A; binding constraints)

1. **Data model = IdentityLink (normalized).** `User` gains `email? @unique`,
   `role`, `mustChangePassword`; loses `githubId`/`githubAccessToken` as direct
   columns. A new `IdentityLink(userId, provider, providerAccountId, secret?)`
   holds every login identity: `github` (secret = encrypted access token),
   `password` (secret = argon2 hash). OTP is **not** an IdentityLink row — it is a
   login *method* keyed on `User.email`.
2. **Runtime gate = pure `User.allowed`.** The three per-request re-confirmations
   stop calling `isAllowlistedRaw(githubId)` and check `User.allowed` instead.
   `AUTH_ALLOWLIST` is demoted to a **login-time provisioning input** for GitHub
   logins (sets `allowed` on first login); it no longer takes effect at runtime.
   Consequence: revoking a GitHub user requires toggling `allowed` in the DB/admin
   UI → GitHub users must be manageable in the account-administration page.
3. **`githubAccessToken` moves into `IdentityLink(github).secret`** (full
   normalization). All 8 read/write points migrate to a shared helper that reads
   the github identity row.
4. **Fetch GitHub email; all three methods usable by GitHub users.** OAuth scope
   adds `user:email`; store primary **verified** email on `User`.
5. **Default admin = random password + one-time reveal.** On boot, if no
   `ADMIN_PASSWORD` is set, generate a random password; the plaintext lives **only
   in process memory** (never persisted — DB stores only the argon2 hash). A
   one-time reveal endpoint shows "admin email + password" exactly once on first
   console visit, then clears it; `mustChangePassword = true`. If the server
   restarts before the reveal is consumed, regenerate.
6. **GitHub users are listed in the account-administration table** (role read-only,
   enable/disable available) — the revocation entry required by decision 2.
7. **Email collision = auto-link** to the same-email account, but **only when the
   GitHub email is primary + verified**, and the link is recorded as an audit
   event (mitigates the email-hijack → host-root risk inherent to auto-link).
8. **Defaults (accepted):** `@node-rs/argon2` for hashing; `nodemailer` over raw
   SMTP (no cloud-provider lock-in); `mustChangePassword` enforced at the single
   `AuthGuard` chokepoint (blocks every route except the change-password endpoint
   and logout); new public endpoints added to `OAUTH_EXEMPT_PATHS` (exact-match);
   OTP/password modes hidden in the UI when their prerequisite (SMTP / password
   set) is absent, via capability flags.

## Code facts (file:line, verified read-only)

- Per-request allowlist re-confirmation, all in
  `apps/api/src/auth/auth-session.service.ts`:
  - `resolveSession` → `isAllowlistedRaw(session.user.githubId, …)` at ~L195
  - `resolveApiKey` → `isAllowlistedRaw(key.user.githubId, …)` at ~L259
  - `resolveMcpToken` → `isAllowlistedRaw(record.user.githubId, …)` at ~L374
  Each returns `null` (fail-closed) when not allowed.
- `isAllowlistedRaw` in `apps/api/src/auth/allowlist.ts` (~L78). Fail-closed parse.
- `githubAccessToken` (schema `prisma/schema.prisma:192`) read/written at 8 points:
  - write ×3 in `auth-session.service.ts` (`establishSessionForGitHubUser`,
    `storeMaybeEncrypted`, upsert create/update ~L126/135/142)
  - read in `github-import.service.ts:221` (`resolveOperatorGitHubToken`)
  - read ×2 in `prisma-provision-lookup.ts:117/123` (`resolveGitHubToken`, queries
    `where: { allowed: true, githubAccessToken: { not: null } }` — a global fallback)
  - read ×2 in `forge-target-resolver.ts:85/87` (`getForgeTargetOwnerToken`)
  - plus mock objects in `forge-target-resolver.spec.ts` / `forge-target-owner-scope.spec.ts`
  - encrypt/decrypt helpers `storeMaybeEncrypted`/`readMaybeEncrypted` in
    `apps/api/src/settings/secret-storage.ts` (~L104/L117).
- `User` model `prisma/schema.prisma:172-216`: has `githubId Int @unique` (NOT
  null), `login`, `name`, `avatarUrl`, `allowed Boolean`, `githubAccessToken
  String?`, `createdAt`. **No `email`, no `role`, no `passwordHash`.** FK relations:
  Session, ApiKey, McpToken, AuditEvent (userId nullable), AccountSettings(@unique),
  CodexCredential(@unique), ClaudeCredential(@unique), ForgeCredential.
- `auth.guard.ts`: exempt lists are **exact-match** (lowercased, trailing-slash
  normalized). `OAUTH_EXEMPT_PATHS` (~L124) = `/auth/github/login`,
  `/auth/github/callback`, `/auth/session`, `/auth/logout`. Also PUBLIC_METADATA,
  SANDBOX (`/v1/approvals`), MCP (`/mcp`).
- Rate limiting EXISTS: `@nestjs/throttler` + `PrincipalThrottlerGuard` as
  APP_GUARD (`app.module.ts` ~L150). Keyed by **authenticated principal**
  (`principal.throttler-guard.ts:45`: api-key id > session githubId > legacy kind).
  **Gap:** anonymous (pre-auth) login/OTP requests have no principal → not
  per-attacker throttled. Need an IP+email tier for auth endpoints.
  Options live in `apps/api/src/rate-limit/throttler.options.ts` (default 120/60s,
  create 10/60s; env-overridable).
- Boot hooks: PrismaService(OnModuleInit), MetricsModule, ForgeCredentialService,
  GuardrailsService (OnModuleInit + OnApplicationBootstrap), TasksService
  (OnApplicationBootstrap), AioSandboxProvider (OnApplicationBootstrap). **No
  `prisma/seed.ts`, no `package.json` prisma.seed.** Cross-provider bootstrap
  ordering is NOT guaranteed (prior 6h prod outage from this — persist-session-
  transcripts). Admin seed must be self-contained / idempotent and not depend on
  another provider's bootstrap having run.
- No mailer/SMTP/nodemailer anywhere. No `argon2`/`bcrypt` in `apps/api/package.json`.
- Frontend: `apps/web/src/routes/login.tsx` + `lib/mock-session.ts` — only GitHub
  redirect (real) + sessionStorage gate (mock). No password/OTP form logic.

## Existing specs touched

- MODIFY `multi-user-oauth` (gate, OAuth email, identity decoupling, mustChange enforcement)
- MODIFY `api-key-auth` (re-confirm → User.allowed)
- MODIFY `mcp-server` (re-confirm → User.allowed)
- MODIFY `request-rate-limiting` (anonymous IP+email auth tier)
- MODIFY `frontend-console` (login modal, accounts page, account menu, flags, reveal)
- Untouched: `single-user-auth` (legacy AUTH_TOKEN kept as-is), `account-settings`.

## Design surfaces (OD project 680d21c4, already finalized)

`login.html` (3-method modal + first-login change), `screens/accounts.html` (admin
table incl. GitHub rows + filter + new/reset dialogs), `screens/settings.html`
(GitHub whitelist card env-readonly + identity role row), `index.html` (copy).
Account-menu "账号管理" entry added to all 8 screens.
