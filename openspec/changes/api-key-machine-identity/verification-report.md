# Verification Report — api-key-machine-identity

Adversarial spec verification with three-way routing. Each raw-unmet finding was
re-traced end-to-end against the actual code before adjudication; the skeptic's
refutation was not rubber-stamped.

## Adjudication summary

- **verify-reopened (real code/config problem):** 1
  - "CI boots the built application and probes liveness" — the `boot-smoke` SHALL be a
    required status check for merging.
- **spec-defect (routed to design.md Open Questions):** 0
- **reclassified MET (re-traces as satisfied despite refutation):** 1
  - "Task actions attribute to the resolved principal's owner".

## Reclassified MET

### Task actions attribute to the resolved principal's owner (multi-user-oauth)

Re-traced END-TO-END against the live code; every line the skeptic cited is accurate
and the chain holds. The skeptic supplied only confirmatory evidence with no actual
refutation — this requirement is MET as written.

Spec: `specs/multi-user-oauth/spec.md:49-62` — the controller SHALL read the resolved
principal and pass its owner's GitHub identity to the task service so the audit record
attributes to that user; api-key/session → owner, no-user (legacy/system) → system
sentinel.

Traced chain:

- **Principal resolution** — `apps/api/src/auth/operator-principal.ts:197-202` (api-key
  branch sets `user: resolved.user`), `:214-216` (session branch sets `user: sessionUser`),
  `:231` (legacy-token sets `user: null`). The owner identity is set at resolution time,
  per kind, exactly as the spec requires.
- **Guard attachment** — `apps/api/src/auth/auth.guard.ts:148` attaches
  `request.operatorPrincipal = principal` on every admitted request.
- **Controller extraction** — `apps/api/src/tasks/tasks.controller.ts:104-106`
  (`githubId()` reads `req.operatorPrincipal?.user?.githubId`); threaded at `:69` into
  `tasksService.create` and `:95` into `tasksService.stop`. The id is taken ONLY from the
  guard-attached principal, never trusted from the client.
- **Service attribution** — `apps/api/src/tasks/tasks.service.ts:520`
  (`recordTaskCreated(task.id, githubId)`) and `:594` (`recordTransition(id, next, githubId)`).
- **Audit persistence** — `apps/api/src/audit/audit.service.ts:140-143`:
  `resolveUserId(githubId)` maps the GitHub numeric id to the `users.id` FK; `githubId ===
  undefined` (legacy/system) is stored as `userId: null` (system sentinel), and an
  unmatched id also degrades to `null` rather than a dangling FK.
- **Unit test coverage** — `apps/api/src/tasks/route-integration.spec.ts:141-188`: five
  tests assert api-key → `KEY_OWNER_GITHUB_ID`, session → `SESSION_GITHUB_ID`, and
  legacy-token → `undefined`, across BOTH the create and stop paths.

Verdict: MET. The owner-attribution behaviour the spec mandates is implemented and tested
across both task-changing operations and all three principal kinds.

## Gap / scope findings

### Gap (the one unsatisfied requirement)

The tasks.md confirms task 1.2 is explicitly marked as incomplete (`[ ]`) — it is a manual
post-PR step. The boot-smoke CI job exists and runs, but it has not been registered as a
required status check in GitHub branch protection.

Summary of findings:

- All requirements in `api-key-auth/spec.md` have traceable implementation (minting,
  hash-only storage, listing, revocation, resolution with allowlist re-check, session-only
  CRUD gate, scope vocabulary and gating).
- All requirements in `multi-user-oauth/spec.md` have traceable implementation (prefix
  dispatch, `api-key`/`mcp` kinds, reserved MCP slot denies, `AUTH_TOKEN` collision boot
  refusal, task attribution).
- In `monorepo-foundation/spec.md`: the CI job (`boot-smoke`) exists and probes `/health`,
  but the requirement **"this check SHALL be a required status check for merging"** has NO
  traceable implementation — the GitHub branch protection for `main` lists only
  `typecheck + lint`; `boot-smoke` is absent from required checks (task 1.2 is explicitly
  unchecked in tasks.md). Confirmed live via
  `gh api repos/Xeonice/cloud-agent-platform/branches/main/protection/required_status_checks`
  → `contexts: ["typecheck + lint"]`. Routed to the verify-reopened track (task V.1).

Reopened: `["CI boots the built application and probes liveness — boot-smoke SHALL be a required status check for merging"]`

### Scope (implemented behaviours mapping to NO spec requirement)

- **Client-side mock mint/revoke in settings.tsx**: frontend generates raw keys locally
  with Web Crypto and manages list state entirely in `useState` — the specs require a real
  `POST /api-keys` backend call; Task 7.1 says "mint (show-once dialog displaying the raw
  key once)" but the implementation is a non-blocking mock with no API call wired.
  `apps/web/src/routes/_app/settings.tsx:69-164`
- **`startsWithReservedPrefix` exported helper** in `credential-prefix.ts` — specs only
  require the prefix constants and boot-assertion logic; no spec requirement for a
  standalone exported predicate function.
  `packages/contracts/src/credential-prefix.ts:56-58`
- **`LAST_USED_STALENESS_MS=60_000` throttle window** on the `lastUsedAt` bump — Task 4.1
  says "staleness-throttled" but none of the three spec files define the throttle window
  value or the specific 60-second constant.
  `apps/api/src/auth/auth-session.service.ts:33`
- **`GET /tasks/:id` has NO scope gate at all** — Task 6.2 says "task create/stop/list and
  repo list routes" but the implementation silently skips `GET /tasks/:id`, making it
  accessible to any api-key principal regardless of scopes.
  `apps/api/src/tasks/tasks.controller.ts:78-81`
- **legacy-token and mcp principals explicitly 403'd on API-key CRUD** (in test and
  controller guard) — the spec says "session-authenticated only" / "an api-key principal
  SHALL NOT mint/list/revoke" but does not mention legacy-token or mcp being explicitly
  blocked (they would be 403'd anyway via the same `requireSessionUser` check, but this is
  tested explicitly beyond spec text).
  `apps/api/src/api-keys/api-keys.service.spec.ts:264-278`
- **empty-scope api-key (`scopes=[]`) treated as deny-all** — distinct from `undefined`
  which is allow-all. The specs only require "carry NO scopes (a GitHub session or the
  legacy operator token) SHALL be treated as allow-all"; there is no spec requirement
  governing the empty-array vs `undefined` distinction.
  `apps/api/src/auth/machine-kinds-and-scopes.test.mjs:222-232`
- **`ApiKeysModule` exports `ApiKeysService`** — no spec requirement for the service to be
  exported from the module; it is exported but nothing outside the module imports it.
  `apps/api/src/api-keys/api-keys.module.ts:25`
- **Namespaced `CREDENTIAL_PREFIX` object (`{API_KEY, MCP}`)** added alongside the array
  constants — specs only require the string constants `cap_sk_` and `mcp_` and the list
  `RESERVED_CREDENTIAL_PREFIXES`; the namespaced object view is an implementation
  convenience not required by any spec scenario.
  `packages/contracts/src/credential-prefix.ts:33-36`
- **`ReservedCredentialPrefix` type exported from contracts** — no spec requirement for a
  TypeScript type alias of the prefix union; it is an implementation artifact.
  `packages/contracts/src/credential-prefix.ts:48-49`
- **`apps/www` marketing site workspace added** (pnpm-workspace.yaml) and README/docs
  updated to reference `install.sh` from a marketing site — no spec in
  api-key-machine-identity covers a marketing www site or installer script.
  `pnpm-workspace.yaml:4`
- **`legacy-token-prefix-collision.test.mjs` placed at repo root** (outside apps/api)
  exercises `startsWithReservedPrefix` — the spec requires the boot assertion behaviour but
  not a standalone repo-root integration test for the helper function.
  `legacy-token-prefix-collision.test.mjs:1`
- **T14 bound-MCP-resolver test** asserts that a bound `mcp_` resolver IS honoured — the
  spec only requires "denies until bound" (the unbound deny scenario); proving an injected
  resolver works when bound is beyond the spec's stated scenario.
  `apps/api/src/auth/operator-principal.test.mjs:211-220`
