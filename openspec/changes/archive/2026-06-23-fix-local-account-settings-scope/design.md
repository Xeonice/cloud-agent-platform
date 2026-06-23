# Design

## Context

Per-account settings (Codex credential, forge credential, account preferences, Codex device login)
are scoped per operator. The scope was implemented against the GitHub numeric id (`githubId`), which
predates local (password/OTP) accounts. The credential rows are already FK `User.id`; only the
*gate* reads `githubId` and reverse-looks-up `user.id`. A local account (`githubId = null`) is hard-
rejected with `account_scope_required`. Fix: scope by `user.id` directly.

## Goals / Non-goals

- **Goal:** every authenticated, allowed account — local OR GitHub — can use its own per-account
  settings, scoped by `user.id`, with cross-account isolation intact.
- **Non-goal:** no data migration (rows already keyed by `user.id`), no UI change, no schema change,
  no change to the allowlist / login provisioning.

## Decisions

**D1 — Scope key is `user.id`, not `githubId`.** The single per-account scope key becomes the user
primary key (`user.id`). Rationale: it is the actual FK on every credential/settings table, it is
non-null for BOTH account kinds, and it removes the redundant `findUnique({where:{githubId}})`
reverse lookup. `githubId` stays only as the GitHub *login-provisioning / allowlist* key (e.g.
self-update admin list), which is a separate concern and is NOT touched.

**D2 — Expose `user.id` on `SessionUser` as a required field.** `SessionUser`
(`packages/contracts/src/session.ts`) gains `id: z.string()` (the DB account id; present for local
and GitHub accounts alike). Making it **required** is deliberate: TypeScript then forces every
SessionUser construction site to supply it, so no path can mint an id-less principal. The five
construction sites:
- `auth-session.service.ts`: `establishSessionForGitHubUser`, `resolveSession` (its Prisma `select`
  must add `id: true`), `resolveApiKey`
- `auth-password/password.service.ts`: `toSessionUser`
- `auth-otp/email-otp.service.ts`: `verifyCode`'s returned user

`user.id` is an internal opaque UUID; exposing it on the session payload is low-risk (it is not a
secret and the frontend already trusts the session). The frontend need not consume it.

**D3 — Gates use `operator.id` directly; delete the reverse lookup.** `requireUserId(operator)` in
`settings.service.ts` and `forge-credential.service.ts` becomes: take `operator.id` (a string);
reject only if it is somehow absent (defensive — the controller's `requireOperator` already ensures
a non-null user). No `githubId` check, no `findUnique`. The `account_scope_required` error class is
retained ONLY as the defensive "no authenticated account at all" case, not as a "no GitHub identity"
case.

**D4 — Codex device-login map re-keys to `string`.** `codex-device-login.service.ts` holds an in-
memory `Map<number, LoginSession>` keyed by `githubId`; it becomes `Map<string, LoginSession>` keyed
by `user.id`, and `requireKey`/all `get/set/delete` sites use `operator.id`. This makes device login
work for local accounts and keeps per-account isolation of in-flight device-login sessions.

**D5 — Controller gate stays, semantics widen.** `settings.controller.ts` `requireOperator` still
rejects a principal with no `user` (an identity-less machine/legacy token has no per-account
settings). With `SessionUser.id` present, a local account's `user` is non-null and passes; only the
comment is updated to say "any authenticated account (local or GitHub)", not "GitHub-identity".

## Risks / Trade-offs

- **GitHub-account regression:** none expected — `user.id` for an existing GitHub account is
  unchanged, and credential rows are already keyed by it; the gate just stops the githubId detour.
  Verified by a test that an existing GitHub-account credential still resolves.
- **Identity-less principals (api-key / mcp / legacy-token):** these have no per-account settings by
  design. The controller's `requireOperator` (D5) still rejects them; confirm a test covers it so the
  widening doesn't accidentally admit a machine principal.
- **Isolation:** scope is still exactly one account's id, so cross-account leakage cannot occur; a
  test asserts account A cannot read account B's credential.

## Migration

None. The credential/settings tables already store `userId = User.id`; switching the scope key from
"githubId→(lookup)→user.id" to "user.id" reads the same rows. No SQL, no backfill.
