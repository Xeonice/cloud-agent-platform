# Verification Report — fix-local-account-github-identity-gates

Verdict: **PASS** — every requirement across all four affected specs re-traces end-to-end as MET. No raw-unmet requirements were carried into this routing pass (the skeptic surfaced zero unmet items), and the gap re-check confirms full implementation.

## Three-way routing tally

- **Reopened (UNMET → code task):** 0
- **Spec-defects (→ design.md Open Questions):** 0
- **Reclassified MET (folded below):** 4 spec requirements (all four specs)

## MET requirements (re-traced)

### account-settings — "A local account's Codex credential resolves at run time"
Implemented in `apps/api/src/sandbox/prisma-codex-auth-source.ts` (`resolveTaskOwnerId` keyed by `AuditEvent.userId` = `user.id`) and `apps/api/src/tasks/tasks.controller.ts` (threads `user.id`). GitHub resolution path unchanged. Tests: `account-scope.spec.ts`, `route-integration.spec.ts`.

### api-key-auth — "Local accounts manage their own API keys"
Implemented in `apps/api/src/api-keys/api-keys.controller.ts` — session gate scopes by `user.id`; the buggy `github_identity_required` branch is removed; service drops the `findUnique({where:{githubId}})` reverse lookup. GitHub no-regression, identity-less rejected, per-account isolation all hold. Tests: `api-keys.service.spec.ts`.

### github-repository-import — "A local account with a connected GitHub identity can import repos"
Implemented in `apps/api/src/repos/github-import.controller.ts` + `github-import.service.ts` — boundary requires an authenticated account (`requireAccountId` = `user.id`); the account's own GitHub token resolves via its `github` `IdentityLink`; missing/expired token → `github_auth_required`; identity-less principal rejected at the boundary. Tests: `github-import.local-account.spec.ts`.

### mcp-server — "Local accounts manage their own MCP tokens"
Implemented in `apps/api/src/mcp-tokens/mcp-tokens.controller.ts` (`requireSessionOperator` using `user.id`); no `github_identity_required` branch remains; machine/legacy credential → `session_operator_required`; own-only per-account scope. Tests: `mcp-tokens.service.spec.ts`.

Every requirement in all four specs has traceable implementation and a covering test.

## Gap check

All four specs are fully implemented. No requirement lacks an implementation site or a covering test. No requirement re-traces as unmet under skeptical refutation.

## Scope findings (behaviors implemented with NO governing spec requirement)

These are mechanism/plumbing changes that are correct and intentional, but are NOT stated requirements in any of the four specs. They are recorded here for traceability; none is a code defect and none requires a new task.

1. **`McpAuthInfo.ownerId` field** — new `ownerId: string` property on the `McpAuthInfo` interface plus `extra: { userId, githubId }` threaded in `main.ts`. Internal mechanism for threading attribution through MCP. No spec states `McpAuthInfo` gains an `ownerId` field or that `extra` must carry `userId`.
   - `apps/api/src/auth/auth-session.service.ts` (`ownerId` field on `McpAuthInfo` interface, ~L76; JSDoc L60-75)

2. **Deletion of the "404 on missing operator account" guard in `McpTokensService.mint`** — the old `requireUserId` `NotFoundException` is dropped; `mint(userId, ...)` now creates directly with the supplied `userId`. No spec requirement covers what happens when a `userId` is provided but has no corresponding user row (old 404 behavior silently dropped).
   - `apps/api/src/mcp-tokens/mcp-tokens.service.ts` (removal of `requireUserId` / `NotFoundException` in `mint`, ~L68-90)

3. **`mcp.spec.ts` new test** "create_task/stop_task thread the token owner ACCOUNT id (local account attribution)" exercises the `userIdFromExtra` / `userIdOf` extractor reading `extra.authInfo.extra.userId` at the MCP tool layer. The specs require MCP task attribution for local accounts but none mandates testing the internal extractor mechanism.
   - `apps/api/src/mcp/mcp.spec.ts` (new `registerMcpTools` / `userIdOf` attribution test)

4. **`audit.verify.test.mjs` new test** "6.2 attribution resolves the account id DIRECTLY (no githubId reverse lookup)" pins the internal `where:{id}` query shape in `AuditService.resolveUserId`. A white-box mechanism test; specs require only that a local account's task is attributed, not the internal DB query strategy.
   - `apps/api/src/audit/audit.verify.test.mjs` (new "resolves the account id DIRECTLY" test)

## Notes

- `design.md` D6 already documents the deliberately out-of-scope, pre-existing items (audit numeric WIRE projection; v1 idempotency scope key; rate-limit principal-tracker key) routed to a separate follow-up change. Those are not re-opened here.
