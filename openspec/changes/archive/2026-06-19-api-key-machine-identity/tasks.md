<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a track run serially. -->
<!--
  Partition verified against the codebase (file-touch scan). No file is written by
  more than one PARALLEL track, so the integration track carries no shared-file
  tasks — it only runs the cross-cutting build/boot verification after the parallel
  tracks merge. Intra-track shared files (all serial within their own track):
    - packages/contracts/src/index.ts        — Track 2 only (2.1, 2.2, 2.3)
    - apps/api/src/auth/operator-principal.ts — Track 4 only (4.2, 4.3, 4.5)
    - apps/api/src/tasks/tasks.controller.ts  — Track 6 only (6.1, 6.2)
  Producer→consumer edges keep contracts/data-model/auth-core ahead of their
  importers, so no consumer track races a producer track on the same file.
-->

## 1. Track: ci-boot-smoke (depends: none)
<!-- files: .github/workflows/ci.yml (+ boot-smoke helper script) — isolated -->
<!-- land first: this gate must be required BEFORE Track 5 adds a new module -->


- [x] 1.1 Add a CI job/step in `.github/workflows/ci.yml` that boots the BUILT app against a throwaway Postgres and probes `/health`, failing the pipeline on a bootstrap/DI error (run before/independent of typecheck+lint).
- [ ] 1.2 Make the boot-smoke check a required status check for merging into `main`. <!-- MANUAL post-PR step: GitHub only allows a check context to be marked required after it has reported once on a PR. CI job + exact `gh api` command are in place in ci.yml; toggle pending. -->

- [x] 1.3 Verify it FAILS on an intentionally broken DI graph and PASSES on a clean boot (smoke the smoke).

## 2. Track: contracts (depends: none)
<!-- files: packages/contracts/src/{scope,credential-prefix,api-key}.ts (new) + packages/contracts/src/index.ts (shared INTRA-track only: 2.1/2.2/2.3 run serially) -->

- [x] 2.1 Add `ScopeSchema = z.enum(['tasks:read','tasks:write','repos:read'])` + `Scope` type to `@cap/contracts`, exported from the index.
- [x] 2.2 Add reserved credential-prefix constants (`cap_sk_`, `mcp_`) as the single source of truth shared by dispatch, minting, and the boot assertion.
- [x] 2.3 Add API-key DTO schemas: mint request (name, scopes, optional expiry), mint response (show-once raw key + metadata), list-item (id, name, scopes, prefix, last4, lastUsedAt, expiresAt, revokedAt — NO raw/hash), revoke.

## 3. Track: data-model (depends: none)
<!-- files: apps/api/prisma/schema.prisma + apps/api/prisma/migrations/<new>/ — isolated -->

- [x] 3.1 Add the `ApiKey` Prisma model mirroring `Session` (hash-only): `userId` FK cascade, `tokenHash` unique-indexed, `prefix`, `last4`, `name`, `scopes String[]`, `lastUsedAt?`, `expiresAt?`, `revokedAt?`; add `User.apiKeys` relation.
- [x] 3.2 Generate the migration; verify it applies cleanly, FKs into `users.id`, and leaves existing tables unchanged.

## 4. Track: auth-core (depends: contracts, data-model)
<!-- files: apps/api/src/auth/auth-session.service.ts (4.1), apps/api/src/auth/operator-principal.ts (4.2/4.3/4.5 serial), apps/api/src/auth/auth.guard.ts + apps/api/src/terminal/terminal.gateway.ts (4.4), apps/api/src/main.ts (4.6), new *.spec/*.test (4.7) -->
<!-- consumes Track 2 (ScopeSchema, credential-prefix consts, principal DTOs) + Track 3 (ApiKey model); writes none of their files -->

- [x] 4.1 Add `resolveApiKey(raw)` (hash → `findFirst({tokenHash})` → reject revoked/expired → `isAllowlistedRaw(owner.githubId)` re-check → `{user, scopes, keyId}`); bump `lastUsedAt` best-effort/async/staleness-throttled, never blocking the auth path.
- [x] 4.2 Extend `OperatorPrincipal` (`kind` adds `'api-key'` + reserved `'mcp'`; add `scopes?`, `keyId?`) and `OperatorCredentials` (single `bearerToken` slot; inject an MCP resolver that defaults to DENY when unbound).
- [x] 4.3 Add token-prefix dispatch as the FIRST statement of `resolveOperatorPrincipal`: `cap_sk_` → `resolveApiKey` only, `mcp_` → reserved resolver (deny) only, any other bearer → existing session-then-legacy flow unchanged.
- [x] 4.4 Update `auth.guard.ts` (REST) and `terminal.gateway.ts` (WS single channel) to feed the presented bearer through the new dispatch, attaching the resolved principal as today.
- [x] 4.5 Add a `hasScope(principal, required)` helper where `principal.scopes === undefined` returns `true` (allow-all for session/legacy).
- [x] 4.6 Add the `AUTH_TOKEN` reserved-prefix boot assertion in `main.ts` (beside the legacy-token boot check): refuse to boot with a clear error when a configured `AUTH_TOKEN` starts with a reserved prefix.
- [x] 4.7 Tests: `cap_sk_…`/`mcp_…` on the REST `Authorization` header AND the WS channel never produce a `Session` lookup (resolve to api-key/mcp/null); unprefixed credentials behave exactly as before; constant-time preserved; de-allowlisted owner's key denied on next request; boot refused on a colliding `AUTH_TOKEN`.

## 5. Track: api-key-crud (depends: auth-core, contracts, ci-boot-smoke)
<!-- files: apps/api/src/api-keys/{api-keys.controller,api-keys.module,api-keys.service}.ts (new) + new tests; apps/api/src/app.module.ts (5.2 — Track 5 is the ONLY track that edits app.module.ts) -->
<!-- depends on ci-boot-smoke: this is the first NEW module; 5.2 re-runs the boot-smoke gate that Track 1 must have made required first -->

- [x] 5.1 Add `ApiKeysController` + module: mint (`randomBytes(32).base64url` body, returns raw ONCE), list (prefix + last4 only), revoke (idempotent, sets `revokedAt`); all session-authenticated only.
- [x] 5.2 Wire the new module into `AppModule` and confirm the CI boot-smoke (Track 1) still passes with it loaded.
- [x] 5.3 Tests: an `api-key` principal cannot mint/list/revoke (no escalation chain); list responses never leak the raw key or the stored hash; mint returns the raw key exactly once.

## 6. Track: route-integration (depends: auth-core)
<!-- files: apps/api/src/tasks/tasks.controller.ts (6.1 + 6.2 serial), apps/api/src/repos/repos.controller.ts (6.2), new tests (6.3) -->
<!-- consumes Track 4's hasScope helper + extended principal; disjoint files from Track 5 (api-keys/*) and Track 4 (auth/*, terminal/*, main.ts) -->

- [x] 6.1 Thread `(req).operatorPrincipal?.user?.githubId` from `tasks.controller.ts` into `TasksService.create/stop` so task actions attribute to the owner (the service already accepts the optional `githubId`).
- [x] 6.2 Enforce scopes on the task create/stop/list and repo list routes via `hasScope` (403 on missing scope; a scopeless session principal passes).
- [x] 6.3 Tests: an api-key-created task attributes to the key owner; a session-created task attributes to the session user; a `tasks:read`-only key is 403'd on a `tasks:write` route; a session principal passes every scope gate.

## 7. Track: web-settings (depends: contracts)
<!-- files: apps/web/src/components/settings/* (new API-keys card/dialog) + apps/web/src/routes/_app/settings.tsx — isolated from all apps/api work -->

- [x] 7.1 Add an "API Keys" card to the `apps/web` settings page: mint (show-once dialog displaying the raw key once), list (prefix + last4, lastUsed/expiry/revoked state), revoke.

## Track: verify-reopened (depends: none)

- [ ] V.1 Register the `boot-smoke` job as a REQUIRED status check on the `main` branch-protection rule (monorepo-foundation spec: "This check SHALL be a required status check for merging"). Verified UNMET: `gh api repos/Xeonice/cloud-agent-platform/branches/main/protection/required_status_checks` returns `contexts=["typecheck + lint"]` only — `boot-smoke` is absent. The job exists and probes `/health` (ci.yml boot-smoke job + scripts/boot-smoke.sh), but the SHALL is not satisfied: the ci.yml change is still an uncommitted local diff (so the check has never reported to GitHub) and tasks.md 1.2 is still `[ ]`. Land/commit the ci.yml change so the check reports once on a PR, then run the `gh api -X PATCH ... -f 'contexts[]=typecheck + lint' -f 'contexts[]=boot-smoke'` command already documented in ci.yml, and confirm via the API that `boot-smoke` appears in `required_status_checks.contexts` — required BEFORE Track 5 adds the new ApiKeysModule.

- [x] V.2 Wire the settings "API Keys" card to the REAL backend (Track 7 functional gap surfaced by verify). DONE: added `apiKeys` capability flag + `real.{mintApiKey,listApiKeys,revokeApiKey}` (zod-validated `POST/GET/DELETE /api-keys`) + typed `mock.{mockMintApiKey,mockListApiKeys,mockRevokeApiKey}` in-memory seam + `apiKeysQuery`/`mintApiKeyMutation`/`revokeApiKeyMutation`; rewired `settings.tsx` to `useQuery`/`useMutation` (deleted the client-side `generateRawKey` crypto mock) so the show-once raw key is the server's one-time response. Verified: @cap/web typecheck + lint clean, 110/110 web tests pass, full `turbo build typecheck lint` 18/18 green. Currently `apps/web/src/routes/_app/settings.tsx` mints `cap_sk_` keys CLIENT-SIDE with Web Crypto and holds the list in `useState` — no `POST/GET/DELETE /api-keys` call. The card component (`api-keys-card.tsx`) is already a correct props-driven view. Fix: add `mintApiKey`/`listApiKeys`/`revokeApiKey` to the web api capability layer (`lib/api/real.ts` + `mock.ts` + the capability seam + `mutations.ts`/`queries.ts`), then rewire the page to a `useQuery` list + `useMutation` mint/revoke against those, so the show-once raw key is the SERVER's one-time response (not a fabricated client key). Backend endpoints already exist and are verified MET — this is frontend wiring only.

## Integration (serial, after all parallel tracks merge)
<!--
  No shared-file tasks to isolate (the parallel tracks touch disjoint files; the
  only multi-touch files — contracts/index.ts, operator-principal.ts,
  tasks.controller.ts — are each confined to a single track). This phase only
  re-verifies the assembled whole after the worktrees merge:
    - build + typecheck + lint the merged tree (turbo);
    - run prisma generate against the merged schema (Track 3) so the new ApiKey
      delegate is available to auth-core (Track 4) and api-key-crud (Track 5);
    - run the CI boot-smoke (Track 1) against the merged app with the new
      ApiKeysModule loaded (the assertion 5.2 makes against the live module);
    - run the full api + web test suites (4.7, 5.3, 6.3) on the merged tree.
-->

