# Design

## Context

`fix-local-account-settings-scope` re-keyed the settings module from `githubId` to `user.id`, but a
4-lens audit found three more per-account surfaces still keyed on `githubId`, blocking local accounts
(`github_id = null`): api-keys, mcp-tokens (hard 403), the codex run-time credential attribution
chain (silent degrade), and github-import (wrongly refused a local account with a connected GitHub
identity). The owner tables are all already FK on `User.id`; only the gates / attribution chain read
`githubId`.

## Goals / Non-goals

- **Goal:** every authenticated, allowed account — local OR GitHub — can use ALL per-account features
  (API keys, MCP tokens, its run-time Codex credential, GitHub import when it has a connected GitHub
  identity), scoped by `user.id`, with cross-account isolation intact.
- **Non-goal:** no data migration; no change to the allowlist / GitHub login provisioning / the
  numeric `githubId` legitimate uses (self-update admin set, allowlist key).

## Decisions

**D1 — Scope key is `user.id` across the chain.** `githubId` stays ONLY for its legitimate GitHub
roles (allowlist key, self-update admin env set). Everywhere it was used as a per-account scope key
or task-owner attribution key, it becomes `user.id`.

**D2 — api-keys / mcp-tokens: keep gate 1, drop the buggy gate 2.** The first gate (reject a
non-`session` / identity-less principal with `session_required` / `session_operator_required`) is
CORRECT and stays. Only the second `githubId === null` branch (which fail-closed local accounts with
`github_identity_required`) is removed. Services take `operator.id` and drop the
`findUnique({where:{githubId}})` reverse lookup (the tables are `userId` FK).

**D3 — Codex attribution by `user.id`.** Task ownership is attributed via `AuditEvent.userId` stored
directly as `user.id` (previously a githubId→id reverse lookup that collapsed local accounts); the
codex auth source's `resolveTaskOwnerId` reads it as `user.id`. Result: a local account's stored
Codex credential (already saved under `userId` by the settings fix) is genuinely resolved and
injected at run time instead of silently degrading to env/official. GitHub accounts are unchanged
(their `AuditEvent.userId` was already the account PK after the old reverse lookup).

**D4 — Zero data migration.** `ApiKey.userId`, `McpToken.userId`, `AuditEvent.userId`,
`CodexCredential.userId` are all already FK `User.id`. Switching the read key reads the same rows.

**D5 — github-import resolves by `user.id`.** The boundary gate now requires an authenticated account
(not a GitHub identity); the account's own GitHub token is resolved by `user.id` from its `github`
`IdentityLink`, so a password/OTP account that connected GitHub can import. A genuinely
missing/expired token still yields `github_auth_required` downstream; an identity-less principal is
still rejected at the boundary.

**D6 — Deliberately out of scope (known, pre-existing, NOT introduced here).**
- The audit numeric WIRE projection (`AuditEvent.userId` as a numeric `githubId`, sentinel 0 for
  local) is unchanged pre-existing code with no `apps/web` consumer; the load-bearing DB FK is now
  correctly populated for local accounts. A console-visible numeric local attribution would need a
  coupled contracts change — out of scope here.
- The v1 idempotency scope key and the rate-limit principal-tracker key still collapse local accounts
  to a shared namespace (the idempotency one is a real cross-account collision surface). Both are
  PRE-EXISTING (unchanged by this diff) and the same `githubId-as-identity-key` anti-pattern; the
  review routed them to a SEPARATE follow-up change with a regression test, not this one.

## Risks / Trade-offs

- Broadest blast radius is the attribution chain (tasks/audit/v1/mcp). Mitigated: an adversarial
  4-lens review chased every blocker/major suspicion (codex degrade, GitHub attribution regression)
  to evidence and refuted them; 35+ specs green; no legitimate `githubId` use was converted.

## Migration

None.
