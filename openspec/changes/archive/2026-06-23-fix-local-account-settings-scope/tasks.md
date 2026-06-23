# Tasks

## 1. Track: contracts (depends: none)

- [x] 1.1 `packages/contracts/src/session.ts` — add `id: z.string()` to `SessionUser` (the DB account primary key; present for BOTH local and GitHub accounts; the per-account scope key). Make it REQUIRED so TypeScript forces every construction site to supply it. Document that `githubId` stays only as the GitHub login-provisioning/allowlist key.

## 2. Track: auth-principal (depends: contracts)

- [x] 2.1 `apps/api/src/auth/auth-session.service.ts` — add `id` to all three SessionUser constructions: `establishSessionForGitHubUser`, `resolveSession` (also add `id: true` to its Prisma `select`), `resolveApiKey`.
- [x] 2.2 `apps/api/src/auth-password/password.service.ts` — `toSessionUser` adds `id` (its input User row already has `id`).
- [x] 2.3 `apps/api/src/auth-otp/email-otp.service.ts` — `verifyCode`'s returned SessionUser adds `id: user.id`.
- [x] 2.4 Update affected auth tests/fixtures (SessionUser shape now includes `id`); keep them green.

## 3. Track: settings-scope (depends: contracts)

- [x] 3.1 `apps/api/src/settings/settings.service.ts` (`requireUserId`, ~743) — use `operator.id` (string) directly; DELETE the `githubId` number-check and the `prisma.user.findUnique({where:{githubId}})` reverse lookup. Keep `account_scope_required` ONLY as the defensive "no account identity at all" case.
- [x] 3.2 `apps/api/src/settings/forge-credential.service.ts` (`requireUserId`, ~268) — same change as 3.1.
- [x] 3.3 `apps/api/src/settings/codex-device-login.service.ts` — re-key the in-memory `Map<number, LoginSession>` to `Map<string, LoginSession>`; `requireKey` and every get/set/delete use `operator.id` (user.id) instead of `githubId`.
- [x] 3.4 `apps/api/src/settings/settings.controller.ts` (`requireOperator`, ~311) — logic unchanged (reject only a null `user`); update the comment to say "any authenticated account (local or GitHub)", not "GitHub-identity".
- [x] 3.5 Tests: a local account (githubId=null) can read/write Codex credential, forge credentials, account preferences, and run Codex device login (no `account_scope_required`); an existing GitHub account still resolves its credential (no regression); per-account isolation (A cannot read B); an identity-less principal (machine/legacy token) is still rejected.

## 4. Track: verify-build (depends: auth-principal, settings-scope) — runs serially LAST

- [x] 4.1 `pnpm prisma generate` then typecheck both `@cap/contracts`/`apps/api`; run the full api test suite (auth, settings, forge-credential, codex-device-login, golden, capability) — all green; confirm `account_scope_required` no longer fires for a local account.
