# Verification Report — add-multi-forge-task-delivery

Adjudication of the verify pass's raw-unmet findings, re-traced end-to-end against the actual code. The
re-trace covers the multi-forge-repo-import frontend shortfalls (R.1 import-write, R.2 picker UI), the
task-result-delivery "surfaced and audited" requirement (MET on its two primary guarantees; one secondary
clause routed to design.md Open Questions as a SPEC-DEFECT), the "owner-scoped credential" requirement
(MET with a minor test-coverage gap), and the "Delivery is opt-in" requirement — MET for the `/v1`+console
create paths and all read paths, with the MCP `create_task` create-acceptance clause reopened as R.3. Net:
three real code gaps reopened (R.1, R.2, R.3), one spec defect in design.md Open Questions, the rest folded
here as MET.

## MET (re-traced as satisfied)

### task-result-delivery — "Delivery results are surfaced and audited; push-back never blocks settling"

The two PRIMARY guarantees of this requirement re-trace as fully MET; the only shortfall is a secondary
scenario clause ("the audit records it" for a `failed` outcome) that the requirement body itself
contradicts — that contradiction is routed to design.md Open Questions as a SPEC-DEFECT, not a code task.

- **Surfacing — fully MET.** All six delivery columns (`deliver`, `deliverStatus`, `branchPushed`,
  `commitSha`, `changeRequestUrl`, `changeRequestNumber`) are in `TaskSchema`/`TaskResponse`
  (`packages/contracts/src/task.ts:204-214`) and echoed on every read path via the single
  `toTaskResponse` (`apps/api/src/tasks/tasks.service.ts:840-845`) — create 201, list, find-by-id,
  transition, mark — so MCP `get_task`, `/v1`, and the console all see the same fields.

- **CR auditing — fully MET (for the two kinds the requirement defines).** `task.change_request_opened`
  (201/info) and `task.change_request_reused` (200/info) are registered with one resultCode each in
  `AUDIT_KIND_DESCRIPTORS` (`apps/api/src/audit/audit-mapping.ts:191-200`), honoring the one-kind-one-code
  invariant. `AuditService.recordChangeRequest` (`audit.service.ts:97-110`) persists url+number and
  selects the kind by `opts.reused`. The `deliver:'pr'` branch calls it via the swallowing
  `recordAudit(() => this.audit?.recordChangeRequest(...))` (`guardrails.service.ts:741-747`).

- **Push-back never blocks settling — fully MET, robustly.** `deliverResult`
  (`guardrails.service.ts:675-756`) is wrapped in a single top-level `try/catch`; the catch persists
  `deliver_status='failed'` with its own `.catch(() => undefined)` and re-throws nothing, so the method
  NEVER throws. `persistDeliver` (line 770) and `recordAudit` (line 968) each swallow their own errors.
  Time-boxing: each in-sandbox git step uses `AbortSignal.timeout(TRIM_TIMEOUT_MS = 10_000)`
  (`aio-sandbox.provider.ts:210,477`); each forge HTTP call uses
  `AbortSignal.timeout(FORGE_HTTP_TIMEOUT_MS = 15_000)` (`forge.port.ts:101,137`) — both throw on timeout
  and are caught by the outer try/catch. `await this.deliverResult(taskId)` is awaited at
  `guardrails.service.ts:647`, BEFORE `teardownSandbox` (654) and `semaphore.release` (665); because it
  never throws, teardown and slot release run unconditionally regardless of delivery outcome. The
  scenario "A wedged forge call does not hold a slot" therefore holds: a hung/timed-out call is abandoned
  with `deliver_status='failed'` and the task still tears down and releases its slot.

- **Why risk=high but still MET:** `deliverResult` sits in the `onTerminal` hot path cross-cutting four
  concerns (sandbox git exec, forge HTTP, DB writes, audit) at the settling chokepoint. The settling
  guarantee rests entirely on the single outer `try/catch` at line 679. This was traced: the success-path
  `persistDeliver` calls (lines 691/706/710/714/734) lack their own `.catch`, so a DB failure there would
  propagate to the outer catch (which swallows it and persists `failed` — correct), NOT escape the method.
  No path was found that throws BEFORE the outer try (`forgeResolver`/`forgeRegistry`/`sandbox`/`prisma`
  null-guards at line 678 return early). The guarantee holds.

- **Secondary clause routed to SPEC-DEFECT (not a code task):** the scenario phrase "the audit records it"
  for a `failed` outcome, and the requirement's "one audit event per attempt", are contradicted by the
  requirement's own enumeration of only two CR audit kinds plus the one-kind-one-code invariant (task 7.1
  / D7). The non-CR branches (`skipped`/`no_changes`/`pushed`/`failed`) persist `deliver_status` but emit
  no `AuditEvent`. Inventing a third "delivery_failed" audit kind to "pass" the scenario would violate the
  spec's own invariant. Resolution is a wording decision (is the surfaced `deliver_status` column the
  "audit record"? — likely the intent), recorded in design.md Open Questions.

### task-result-delivery — "The push-back credential is owner-scoped and write-capable" — MET (minor test-coverage gap)

Re-traced 2026-06-21 against `apps/api/src/forge/forge-target-resolver.ts` (the actual path; the raw
finding cited a non-existent `apps/api/src/sandbox/forge-target-resolver.ts`).

- **Owner-scoping — fully MET, structurally guaranteed.** `getForgeTarget`
  (`forge-target-resolver.ts:26-63`) resolves the owner via `resolveTaskOwnerId` (the `task.created`
  audit-event userId, lines 91-98 — the `PrismaCodexAuthSource` discipline) and fetches the credential
  with `prisma.forgeCredential.findUnique({ where: { userId_kind_host: { userId: ownerId, kind, host } } })`
  (lines 72-74). The schema backs this with `@@unique([userId, kind, host])`
  (`apps/api/prisma/schema.prisma:575`), so the lookup is exact-keyed on the RESOLVED owner — there is no
  code path by which one operator's token can be returned for another operator's task. "One operator's
  token SHALL NEVER be used for another's push-back" is therefore a structural invariant, not a runtime
  check that could regress.
- **Unattributed → skip — MET.** An unattributed task (no `task.created` owner) returns null at lines
  47-48 (tested: `forge-target-resolver.spec.ts:54-57`). A non-github task with no `ForgeCredential`
  returns null (lines 59-61; tested at spec.ts:64-67). The github public-host fallback to the owner's
  encrypted `User.githubAccessToken` is itself owner-keyed (lines 56-58, 79-88; tested at spec.ts:69-85).
- **Write-capability — MET-as-written (by PAT-scope convention, the spec intent).** The required write
  scopes (github `repo`, gitlab `api`, gitee `projects`+`pull_requests`) are operator-granted PAT scopes,
  documented in the sibling `add-forge-credentials` design; connect-time validation
  (`forge-credential.service.ts`) probes `/user` for 2xx liveness and does not assert write scopes —
  matching the spec's framing that write-capability is a scope the operator grants, surfaced in the UI,
  not a runtime assertion this change owns.
- **Minor gap (does NOT block the primary scenario):** `tasks.md:8.2` lists an explicit "owner-scope
  (two-operator)" test, and `forge-target-resolver.spec.ts` does not contain one asserting that operator
  A's task never yields operator B's token. This is a test-coverage shortfall only: the `@@unique`
  constraint + the owner-keyed `findUnique` provide the isolation the missing test would have asserted, so
  the behavioral guarantee holds end-to-end without it. Recorded here, not reopened as a code task.

### task-result-delivery — "Delivery is opt-in and defaults to no-op" — MET on /v1 + console + read paths; MCP create-path gap reopened (R.3)

Re-traced 2026-06-21 against the create surfaces and the MCP tool schema. The raw finding framed this as a
possible "MCP `create_task` doesn't expose `deliver`" omission; re-tracing splits it cleanly.

- **`/v1` create accepts `deliver` — MET.** `V1CreateTaskRequestSchema` `.extend`s
  `CreateTaskRequestSchema` (`packages/contracts/src/v1.ts:33`), which carries
  `deliver: DeliverSchema.optional()` (`packages/contracts/src/task.ts:308`); the controller validates with
  `ZodValidationPipe(V1CreateTaskRequestSchema)` (`v1-tasks.controller.ts:100`). A `/v1` machine caller can
  create a `deliver:'branch'|'pr'` task.
- **Console create accepts `deliver` — MET.** `POST /repos/:repoId/tasks` validates with
  `ZodValidationPipe(createTaskBodySchema)` (`tasks.controller.ts:62`), and `createTaskBodySchema` IS
  `CreateTaskRequestSchema` (`task.ts:317`) — `deliver` flows through.
- **Read-path echo on all three surfaces — MET.** MCP `get_task`/`list_tasks`/`get_transcript`, `/v1`
  reads, and the console all return `TaskResponse` through the single `toTaskResponse`
  (`tasks.service.ts:840` echoes `deliver`/`deliverStatus`/`branchPushed`/`commitSha`/`changeRequestUrl`/
  `changeRequestNumber`). The requirement's literal "echo it on every task read path (MCP, `/v1`, console)"
  is satisfied.
- **Default-no-op via MCP — MET.** Omitting `deliver` (the only value an MCP client can currently produce)
  yields `deliver=null -> 'none'` and the byte-identical pre-change lifecycle, so the "Default delivery is a
  no-op" scenario holds for the MCP surface too.
- **MCP create-path gap — REOPENED (R.3).** The requirement's "The system SHALL accept an optional
  `deliver` parameter on task creation" is NOT met for the MCP `create_task` tool: its `inputSchema`
  (`apps/api/src/mcp/mcp-tools.ts:174-180`) omits `deliver`, and the MCP SDK validates args against the
  `z.object` derived from `inputSchema` (`@modelcontextprotocol/sdk` `mcp.js:177` `safeParseAsync`), which
  STRIPS unknown keys before the handler's `body as CreateTaskBody`. So an MCP client cannot create a
  `deliver:'pr'` task — and gate 9.2 explicitly exercises a `deliver:'pr'` task via MCP. The underlying
  `createTask` path supports it; only the tool schema fails to surface it. This is a real, one-line code
  gap (add `deliver` to `create_task`'s `inputSchema`), routed to `Track: verify-reopened` task R.3 — NOT
  a spec defect (the requirement is unambiguous) and NOT met-as-written (the MCP creation surface genuinely
  rejects the field).

### Second-pass re-trace (2026-06-21) — "Delivery results are surfaced and audited" gap argument → MET (with a minor display gap)

A follow-up gap-finding pass re-raised the SAME requirement ("Delivery results are surfaced and audited;
push-back never blocks settling") on two new sub-arguments. Both were re-traced end-to-end against the
actual code and confirmed as MET-as-written; neither reopens a code task, neither is a new spec defect.

- **No outer aggregate time-box on `deliverResult` — MET via per-step time-boxing.** The argument is that
  `guardrails.onTerminal` awaits `deliverResult(taskId)` (line 647) with no single `Promise.race`/
  `AbortSignal` wrapping the WHOLE call — only per-step budgets (each in-sandbox git exec
  `TRIM_TIMEOUT_MS=10s`, `aio-sandbox.provider.ts:210`; each forge HTTP `FORGE_HTTP_TIMEOUT_MS=15s`,
  `forge.port.ts:101`). Re-trace: the spec's time-box clause requires that "any failure or timeout SHALL
  be recorded (`deliver_status='failed'`) and SHALL NOT block the terminal transition, sandbox teardown,
  or concurrency-slot release," and its scenario ("A wedged forge call does not hold a slot") asserts that
  a call hanging "past the delivery timeout" is abandoned with `failed` and the slot still releases. Every
  I/O step that can hang has a hard `AbortSignal.timeout` that THROWS on expiry; the throw is caught by the
  single outer `try/catch` (`guardrails.service.ts:679-755`) which records `failed` and returns normally —
  so `deliverResult` never throws and teardown/`semaphore.release` (lines 654-665) run unconditionally. A
  wedged forge call or push therefore cannot hold a slot — the scenario's literal guarantee holds. The
  spec text says "time-boxed," not "bounded by ONE aggregate deadline"; the finite sum of bounded steps
  still cannot hang indefinitely, and no scenario asserts a single aggregate budget. The gap author's own
  conclusion ("the step can't hang indefinitely, so this may be considered implemented via per-step
  timeouts") concurs. Met-as-written; the absence of a separate outer race is a thin structural nicety,
  not a behavioral gap — not reopened.
- **Console does not RENDER the delivery fields — MET (read-path "present"); display-only gap.** Confirmed:
  `grep` over `apps/web/src/` for `deliverStatus`/`changeRequestUrl`/`branchPushed`/`commitSha` returns
  nothing — the web console reads/renders none of them. Re-trace against the binding spec: the requirement
  says "echo them on every read path" and its scenario ("The change request URL is returned through every
  surface") asserts the fields are "**present**" WHEN a client reads the task "via MCP `get_task`, `/v1`,
  or the console." "Read path" + "present" = returned in the response the surface consumes — all six fields
  flow through the single `toTaskResponse` (`tasks.service.ts:840`), so the console's API responses DO
  carry them; the fields ARE present on the console read path. No spec.md requirement scenario asserts a
  VISIBLE UI rendering — task 7.3's task-detail UI is a "DESIGN MOCKUP handled in OpenDesign" item, not a
  spec requirement, and the proposal's "console task-detail UI (design mockup in OpenDesign)" Impact note
  is a code-touch hint, not a binding scenario. So the requirement re-traces as MET-as-written with a minor
  display gap (the console does not yet render the already-present fields) that does NOT block the primary
  scenario — the `change_request_url`/`branch_pushed`/`deliver_status` ARE returned through every surface
  including the console's API. Consistent with this report's "Gap-finding conclusion" (display gap, not a
  missing implementation, not a spec-required UI scenario). Not reopened; not a spec defect.

## REOPENED (real code gaps — see Track: verify-reopened R.1 + R.2 + R.3)

### multi-forge-repo-import — "Import records the forge and a forge-correct git source" — UNMET (frontend write path only)

Re-traced 2026-06-21. The earlier verdict (the contract + write paths "do not exist") is now PARTLY
superseded by the working tree — the BACKEND has since landed; only the WEB FRONTEND write path remains.

- Sub-claim A (GitHub import records `forge='github'`) — MET. `github-import.service.ts` repo.create now
  hardcodes `forge: 'github'` and `toResponse` echoes it, so a GitHub picker import no longer lands
  `forge=null`.
- Contract — MET. `ImportRepoRequestSchema` (`packages/contracts/src/github-import.ts`) now carries
  `forge: z.enum(['github','gitlab','gitee']).optional()`; `AvailableForgeRepoSchema`
  (`packages/contracts/src/settings.ts:551`) carries `forge/fullPath/gitSource/visibility/defaultBranch/
  gitlabProjectId?`. The forge-neutral import contract the spec mandates exists.
- Backend write — MET. The generic `POST /repos` (`repos.service.ts:15-27`) sets `forge` explicit-or-
  inferred (`inferForge` from the public host).
- Sub-claim B (GitLab/Gitee picker import-WRITE end-to-end) — UNMET. The web import dialog
  (`apps/web/src/components/repositories/import-dialog.tsx`) is GitHub-only; `importRepoMutation` posts
  ONLY to `POST /repos/github/import`; there is NO `POST /repos {…, forge:'gitlab'|'gitee'}` call anywhere
  in `apps/web/src/`, and the web api layer has zero forge code (grep returns nothing). So the scenario
  "A GitLab picker import lands with the right forge + source" still has no traceable UI→write path.

Routed to `Track: verify-reopened` task R.1 (re-scoped to the frontend write path; backend is done).

### multi-forge-repo-import — "Importable repos are listed per connected forge for the picker" — UNMET (picker UI only)

Re-traced 2026-06-21. The BACKEND listing is fully met: `GET /settings/forges/repos?kind=…`
(`settings.controller.ts:105-119`) → `ForgeCredentialService.listAvailableRepos`
(`forge-credential.service.ts:76-103`) → per-forge `listRepos` (gitlab `GET /projects?membership=true`,
gitee `GET /v5/user/repos`, github `GET /user/repos`), each pinned by a golden test
(`forge-impls.spec.ts`), returning `AvailableForgeRepo{forge,fullPath,gitSource,visibility,defaultBranch}`.

But the requirement's two scenarios ("operator selects the GitLab source IN THE IMPORT DIALOG", "operator
selects the Gitee source") name the import-dialog picker as the trigger, and that UI does not exist: the
import dialog reads ONLY `githubReposQuery` (GitHub-only), has no source switcher, and the web api layer
has no `listAvailableForgeRepos`/`GET /settings/forges/repos` call. The picker scenarios are untraceable
end-to-end (the trigger UI is absent). Routed to `Track: verify-reopened` task R.2 (frontend picker UI).

## Scope observations (recorded, NOT code tasks)

The dependency `add-forge-credentials` (this change's declared dependency — tasks.md header) supplies the
forge-credential surface this change builds on. Behaviors specified by THAT change's specs (not this
change's specs) were observed in the working tree and are in-scope-for-the-epic, NOT scope creep within
add-multi-forge-task-delivery:

- ForgeCredential CRUD REST (`GET/PUT/DELETE /settings/forges`) — `forge-credential.service.ts:115` /
  `settings.controller.ts:99`.
- Token validation probe on connect (live API call before persisting the PAT) — `forge-credential.service.ts:241`.
- ForgeConnection register/list REST (`POST/GET /settings/forge-connections`) —
  `forge-credential.service.ts:192` / `settings.controller.ts:150`.
- `User.githubAccessToken` encrypted at rest on OAuth login — `auth-session.service.ts:123`.
- `secret-storage.ts` module (`encryptToStored`/`storeMaybeEncrypted`/`readMaybeEncrypted`/
  `assertEncryptionKeyValidIfConfigured`).
- `assertEncryptionKeyValidIfConfigured` boot fail-fast in `ForgeCredentialService.onModuleInit` —
  `forge-credential.service.ts:110`.

Two are genuine extra-but-harmless additions worth noting:

- `ChangeRequestRef.state` and `.headBranch` fields (`forge.port.ts:41`). NOTE: these ARE backed by this
  change's own design.md D1 (`ChangeRequestRef = { number, url, state, headBranch }`, design.md line 22),
  so not unbacked — the spec.md requirement text only names `number`/`html_url`/`iid`/`web_url`, while the
  design carries the richer shape. Harmless; consistent with design.
- GitLab `openChangeRequest` treating HTTP 409 as idempotent reuse alongside 422 (`gitlab-forge.ts:86`).
  The spec names only a 422 "already exists" as idempotent; 409 is an extra defensive status code handled
  the same way. Harmless hardening, no behavioral conflict with the requirement.
- `AioSandboxProvider.deliverWorkspaceChanges` applies `scrubSecrets` to the git commit/push exec output
  before recording an error (`aio-sandbox.provider.ts:440-455`). No delivery-spec requirement names this,
  but design.md D5 explicitly prescribes "`scrubSecrets` on output" for the in-sandbox push — so it is
  backed by this change's own design, not unbacked. Harmless defense-in-depth (the token rides the command
  args transiently); consistent with the clone discipline.

Four further scope observations from the 2026-06-21 re-trace (recorded, none reopened, none a spec
defect — each is a benign deviation or is in fact spec-backed):

- `parseGitSource` accepts `http:` alongside `https:` (`forge-registry.ts:119`). The proposal lists
  "non-https/ssh remotes" as out of scope, so accepting `http:` is a minor over-acceptance. It affects only
  the detection ladder's host parse (step 2 public-host inference); it does not relax any clone/push or
  forge-HTTP transport (those use the resolved `apiBaseUrl`/`cloneUrl`, not the raw gitSource scheme), and
  no requirement scenario asserts an `http:` gitSource is rejected. Harmless; eases self-hosted/dev hosts.
  No behavioral conflict — recorded, not reopened.
- `deliverResult` uses `task.branch ?? forge.resolveBaseBranch(target)` as the PR base branch
  (`guardrails.service.ts:723`). This is NOT scope creep: it is spec-backed by THIS change's own tasks.md
  6.1 ("`forge.resolveBaseBranch` (or create-body `branch`)"). Consistent with the design's hook
  description. Recorded for completeness; not a deviation.
- `GithubForge.listRepos` issues `GET /user/repos` inline via `forgeFetch` (`github-forge.ts:93-115`)
  rather than reusing `GithubReposClient`. The spec says "GitHub via its existing import flow"; the impl
  hits the SAME endpoint (`/user/repos`, paginated) with the same semantics, just routed through the Forge
  port's own fetch helper instead of the standalone client — a structural choice that keeps all three forge
  impls uniform under the `Forge` port. Same endpoint + same `AvailableRepo` mapping ⇒ no behavioral
  divergence from "existing import flow"; golden-tested (`forge-impls.spec.ts`). Recorded, not reopened.
- `GET /settings/forges/repos` accepts an optional `host` query param (`settings.controller.ts:109`,
  forwarded to `listAvailableRepos`). The spec text names only `kind`-based listing on this endpoint. But
  the design's detection ladder (D3) and the `ForgeConnection` self-hosted registry it builds on are
  host-keyed, so a `host` param to select WHICH connected self-hosted forge to list is a benign in-scope
  hardening consistent with the design, not a conflict with any requirement scenario. Recorded, not reopened.

## Gap-finding conclusion (no zero-implementation requirement)

The gap-finding pass searched both spec files for any requirement with NO traceable implementation at all
and found none: every requirement has at least backend implementation (Forge port + 3 impls, registry +
layered detection, owner-scoped credential resolution, in-sandbox push, platform-side CR open/reuse, audit
kinds, repo-import forge fields + per-forge listing). Three genuine end-to-end shortfalls were reopened:
two are FRONTEND only — the import-dialog picker UI (listing) and the GitLab/Gitee import-write call —
routed to `Track: verify-reopened` (R.2 and R.1); the third is the MCP `create_task` tool's `inputSchema`
omitting `deliver` (R.3), a one-line server-side gap on the "Delivery is opt-in" requirement's
create-acceptance clause (the `/v1`+console create paths and all read paths already accept/echo it). The
"console surfaces delivery results" clause is satisfied at the data/API layer (all six delivery columns
flow through the single `toTaskResponse`); the console merely does not render them, a display gap not a
missing implementation, and not a spec-required UI scenario.
