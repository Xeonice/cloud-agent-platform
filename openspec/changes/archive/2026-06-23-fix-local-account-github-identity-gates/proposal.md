# Fix: local accounts blocked from per-account features by leftover GitHub-identity gates

## Why

[[fix-local-account-settings-scope]] (last release) switched the SETTINGS module's scope from
`githubId` to `user.id` — but ONLY that module. An exhaustive 4-lens audit found local accounts
(`github_id = null`) still blocked from other per-account features:

- **API-key management** + **MCP-token management** — hard 403 `github_identity_required`: the
  controller has a CORRECT first gate (an authenticated session is required) plus a BUGGY second
  `githubId === null` branch that fail-closes local accounts.
- **Codex credential at run time** (silent — the worse bug): a local account's saved Codex provider
  is NEVER injected. The task owner is resolved through a `githubId` attribution chain that collapses
  a local account's null `githubId`, so the run silently degrades to env/official credentials.
- **GitHub repo import**: a local account that has SEPARATELY connected a GitHub `IdentityLink` was
  wrongly refused — the gate conflated "logged in without GitHub" with "has no GitHub token".

Root cause is identical to last time — `githubId` used as a per-account scope key instead of
`user.id`. The earlier fix's spec didn't cover these modules, so `opsx-verify` didn't catch them.
This change additionally adds the missing spec coverage so future verification CAN catch them.

## What Changes

Scope key `githubId → user.id` across the whole attribution/scope chain (the FK already on every
owner table — **zero data migration**; `SessionUser.id` already exists from the prior fix):

- **api-keys / mcp-tokens**: drop the buggy `githubId === null` 403 branch (KEEP the first session
  gate); services take `user.id` directly (delete the githubId reverse lookup).
- **codex attribution**: task ownership attributes to `user.id` (`AuditEvent.userId` stored directly;
  the codex auth source resolves the owner by `user.id`), so a local account's stored Codex
  credential is genuinely injected at run time instead of silently degrading.
- **github-import**: resolve the account's OWN GitHub token by `user.id`, so a local account with a
  connected GitHub `IdentityLink` can list/import; a truly missing token still yields the distinct
  `github_auth_required`.
- **mcp**: owner attribution carries `userId`.
- **Defensive identity-less branch kept**: a machine / legacy principal with no account is still
  rejected.

## Impact

- Affected specs: `api-key-auth`, `mcp-server`, `account-settings` (Codex), `github-repository-import`
  — each ADDS a local-account requirement so verification covers it.
- Affected code: api-keys, mcp-tokens, audit, tasks, v1-tasks, mcp, sandbox/prisma-codex-auth-source,
  repos/github-import, main.ts, auth-session.service.ts. **Zero data migration.**
- Known follow-ups (PRE-EXISTING, same root cause, NOT introduced here — flagged by the review for a
  separate change): the v1 idempotency scope key and the rate-limit principal-tracker key still
  collapse local accounts to a shared namespace.
