# Fix: per-account settings scope must use account id, not GitHub identity

## Why

A local account (created in account-administration, logging in by password or OTP, with
`github_id = null`) can authenticate, enter the console, and receive OTP — but the moment it opens
**any per-account setting** (Codex credential, forge credential, account preferences, Codex device
login) the backend rejects it:

```
{"error":"account_scope_required",
 "message":"Account settings are per-account and require a GitHub-identity operator session."}
```

Production-confirmed: `users` holds `ad546971975@gmail.com` (github_id 13403586, GitHub account —
works) and `construenct@outlook.com` (github_id null, local account — rejected).

**Root cause** (not a missing feature — an implementation deviation): per-account settings key their
scope on the GitHub numeric id (`githubId`). `settings.service.ts` `requireUserId(operator)` throws
`account_scope_required` when `typeof operator.githubId !== 'number'`, then reverse-looks-up the row
via `prisma.user.findUnique({ where: { githubId } })`. `forge-credential.service` and
`codex-device-login.service` follow the same pattern. A local account has no `githubId`, so it is
hard-blocked. This contradicts the existing specs, which already say per-account settings are
"scoped to the owning account" / "owner-scoped" — never "GitHub-only". It is a leftover assumption
from the GitHub-only era ([[add-private-account-identity-shipped]] made local accounts first-class
*logins* but did not re-key per-account settings).

## What Changes

- **Scope key: `githubId` → `user.id`.** The per-account scope key becomes the user primary key
  (`user.id`, a string UUID that BOTH local and GitHub accounts have). The credential tables
  (`CodexCredential.userId`, `ForgeCredential.userId`, `AccountSettings.userId`) are ALREADY FK
  `User.id` — the gate merely did a redundant "reverse-lookup user.id from githubId". Switching to
  `operator.id` directly is **zero data migration**: existing GitHub-account credentials (whose
  `user.id` is unchanged) keep resolving, and local accounts become usable.
- **Expose `user.id` on the session principal.** `SessionUser` currently carries `githubId` but no
  internal account id; add `id` so the settings gates can scope without the reverse lookup.
- **Three scope gates switch to `operator.id`**: settings service, forge-credential service, and
  codex-device-login (its in-memory session map re-keys from `number` githubId to `string` user.id).
- **No UI, no DB migration, no design.** Pure backend (`@cap/contracts` + `apps/api`).

## Impact

- Affected specs: `account-settings` (ADD an account-id-scope requirement), `forge-credentials`
  (ADD the same for forge PATs/registry).
- Affected code: `packages/contracts/src/session.ts`; `apps/api/src/auth/auth-session.service.ts`,
  `apps/api/src/auth-password/password.service.ts`, `apps/api/src/auth-otp/email-otp.service.ts`
  (SessionUser construction sites); `apps/api/src/settings/{settings.service,forge-credential.service,codex-device-login.service,settings.controller}.ts`.
- Behavior: local (non-GitHub) accounts can now read/write Codex + forge credentials, account
  preferences, and run Codex device login. GitHub accounts are unaffected (same `user.id`). Per-account
  isolation is preserved (scope is still one account's id).
