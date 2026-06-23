# Tasks

> Implemented via an audit→fix→adversarial-review Workflow (verdict: SHIP — 35+ specs green, blocker/major suspicions refuted). Tasks recorded as done.

## 1. Track: principal (relies on prior fix)

- [x] 1.1 Confirm `SessionUser.id` (from [[fix-local-account-settings-scope]]) is carried by the session/api-key/mcp principals so every gate can scope by `user.id`.

## 2. Track: api-keys + mcp-tokens 403 gate

- [x] 2.1 `api-keys.controller.ts` + `api-keys.service.ts` — KEEP the first session gate; DROP the buggy `githubId === null` `github_identity_required` branch; service takes `user.id`, delete the `findUnique({where:{githubId}})` reverse lookup. Tests: local mint/list/revoke, GitHub no-regression, per-account isolation, identity-less rejected.
- [x] 2.2 `mcp-tokens.controller.ts` + `mcp-tokens.service.ts` — same shape; `session_operator_required` for machine/legacy. Tests likewise.

## 3. Track: codex attribution chain

- [x] 3.1 `tasks.controller.ts` / `tasks.service.ts` / `v1/v1-tasks.controller.ts` — attribute task owner by `user.id` (no githubId collapse to undefined).
- [x] 3.2 `audit/audit.service.ts` / `audit/audit-recorder.port.ts` — store `AuditEvent.userId` directly as `user.id` (drop the githubId reverse lookup); read path unchanged.
- [x] 3.3 `sandbox/prisma-codex-auth-source.ts` — `resolveTaskOwnerId` by `user.id` so a local account's saved Codex credential is injected at run time. `main.ts` / `auth-session.service.ts` / `mcp` owner attribution carry `userId` (JSDoc updated).

## 4. Track: github-import

- [x] 4.1 `repos/github-import.controller.ts` + `service.ts` — `requireAccountId` (user.id), resolve the account's own GitHub token by `userId`; identity-less rejected at the boundary, missing token → `github_auth_required`. New `github-import.local-account.spec.ts`.

## 5. Track: verify-build

- [x] 5.1 `prisma generate` + api/web typecheck clean + full test suites green (api 426 / web 232); adversarial 4-lens review verdict SHIP (no real blocker; the v1 idempotency scope + rate-limit tracker key are PRE-EXISTING and routed to a separate follow-up change).
