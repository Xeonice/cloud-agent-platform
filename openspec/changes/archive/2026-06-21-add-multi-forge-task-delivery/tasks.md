# Tasks — add-multi-forge-task-delivery

> Depends on `add-forge-credentials` (change B) for `ForgeCredential` + `ForgeConnection`.

## 1. Contracts + schema

- [x] 1.1 Contracts: add `deliver: 'none'|'branch'|'pr'` (default `none`) to the create body, and
  `deliver`, `deliver_status`, `branch_pushed`, `commit_sha`, `change_request_url`, `change_request_number`
  to `TaskResponse`. Add a nullable `forge` to `RepoSchema`; generalize the import contracts to
  forge-neutral `AvailableRepo{forge,fullPath,gitSource,visibility,defaultBranch,gitlabProjectId?}` +
  `ImportRepoRequest{forge,gitSource,...}` (`packages/contracts/src/task.ts`).
- [x] 1.2 Schema: add `Repo.forge` (nullable), `Repo.gitlabProjectId` (nullable numeric cache), and the 6
  nullable Task delivery columns; one additive migration; `prisma generate`.

## 2. Forge port + 3 impls (each with a golden test)

- [x] 2.1 `apps/api/src/forge/forge.port.ts`: `Forge` interface — `cloneAuthHeader` (sync, for the
  in-sandbox git clone/push) + the HTTP methods `resolveBaseBranch`, `findExistingChangeRequest`,
  `openChangeRequest`, `listRepos` (ordinary platform-process `fetch`, the `github-repos.client.ts`
  precedent) — plus `ForgeTarget`, `ForgeRepoId` discriminated union, `ChangeRequestRef`, `AvailableRepo`,
  `FORGE` token. NO git-push method.
- [x] 2.2 `GithubForge` + golden test: `cloneAuthHeader` `Basic x-access-token`; `/repos/{o}/{r}`
  default_branch; `pulls?state=open&head={o}:{b}`; `POST .../pulls {head,base,title,body}`;
  `Bearer`+Accept+X-GitHub-Api-Version; `listRepos` via existing import flow; map `number`/`html_url`.
- [x] 2.3 `GiteeForge` + golden test: SAME header + SAME `/pulls` path+body; list has NO head filter →
  client-side `head.ref` filter; `Bearer`; `/api/v5` base; `listRepos` `GET /v5/user/repos`; map `number`/`html_url`.
- [x] 2.4 `GitlabForge` + golden test: `Basic oauth2`; `/projects/{enc(idOrPath)}` default_branch;
  `merge_requests?state=opened&source_branch={b}`; `POST .../merge_requests {source_branch,target_branch,title,description}`;
  `PRIVATE-TOKEN`; `/api/v4` base; `listRepos` `GET /projects?membership=true`; map `iid`/`web_url`.
  Golden tests assert the exact host + the exact Authorization bytes per forge + the 204/422 parse branches.

## 3. ForgeRegistry detection

- [x] 3.1 `ForgeRegistry.resolve(repo) → ForgeTarget | null`: layered (explicit `Repo.forge` → public-host
  inference → change B `ForgeConnection` → null); per-kind apiBaseUrl build (`/api/v3|v4|v5`); prefer
  cached `gitlabProjectId`. New `ForgeModule` binds `FORGE` + registry. Forge HTTP is a trusted call to
  the operator's connected forge — NOT routed through `assertSafeProviderUrl` (unchanged). Unit-test the
  detection ladder + the unresolved→null skip.

## 4. Credential resolution + multi-forge clone

- [x] 4.1 `ProvisionLookup.getForgeTarget(taskId)`: `repo.gitSource` → `ForgeRegistry` → owner-scoped
  `ForgeCredential` decrypt (`resolveTaskOwnerId` via `task.created` audit, the `PrismaCodexAuthSource`
  pattern); github public-host falls back to (encrypted) `User.githubAccessToken`; null on the same skip
  conditions as `getCloneSpec`.
- [x] 4.2 Generalize the existing github-only clone auth header to route through `forge.cloneAuthHeader`
  (clone becomes multi-forge). State explicitly: the clone-token READ also becomes owner-scoped (intentional
  behavior change; single-operator identities coincide), with the existing global allowed-user fallback
  kept ONLY for an unattributed/system task's clone-read (push-back still skips when unattributed).

## 5. Push mechanics (git in-sandbox; forge HTTP platform-side)

- [x] 5.1 `SandboxProvider.deliverWorkspaceChanges(taskId, target, branch, baseBranch)` on
  `sandbox-provider.port.ts` + `aio-sandbox.provider.ts`: IN-SANDBOX over `/v1/shell/exec` —
  `status --porcelain` (empty → no_changes), `add -A`, commit (deterministic `cap-bot` identity; message
  via base64 file + `$(cat)`, injection-safe), `checkout -B cap/task-<id>`,
  `git -c http.extraHeader='<forge.cloneAuthHeader>' push --force-with-lease`; reuse
  `parseExecResult`/`scrubSecrets`; token rides the command args transiently (clone discipline), never
  persisted; return `{hadChanges, commitSha}`. The forge HTTP (resolveBaseBranch/findExisting/openCR) is
  NOT here — it runs platform-side via the Forge port (token never enters the sandbox for those).

## 6. Orchestration hook

- [x] 6.1 In `guardrails.onTerminal` (module `apps/api/src/guardrails/guardrails.service.ts`), BETWEEN
  `captureTranscript` and `teardownSandbox`: gate on re-read final status `==='completed'` &&
  `deliver!='none'`; resolve `ForgeTarget`; `forge.resolveBaseBranch` (or create-body `branch`);
  `deliverWorkspaceChanges` (in-sandbox push); for `deliver:'pr'` → `forge.findExistingChangeRequest` then
  `forge.openChangeRequest` (idempotent on existing/422); persist result columns; time-boxed
  (`AbortSignal.timeout`) + fully swallowed (the `captureTranscript` discipline; never blocks teardown/slot).

## 7. Audit + read-path + UI

- [x] 7.1 Audit: add `task.change_request_opened` (201) AND `task.change_request_reused` (200) kinds —
  one resultCode each (the one-kind-one-code invariant) — emit url+number.
- [x] 7.2 TasksService persist/echo the deliver result fields through the single `TaskResponse` (MCP / `/v1` / console).
- [x] 7.3 (UI) repo import/list shows source forge + linked credential; task-detail shows CR link /
  branch / deliver_status; import dialog has a source switcher (GitHub/GitLab/Gitee) + a universal
  paste-URL path — DESIGN MOCKUP handled in OpenDesign.

## 7.5 Multi-forge repo import (picker + by-URL)

- [x] 7.5.1 `listRepos` per forge (platform native-fetch, paginated; trusted forge call, NOT SSRF-gated):
  GitHub (existing import flow), GitLab `GET /projects?membership=true`, Gitee `GET /v5/user/repos` →
  `AvailableRepo`. Each per-forge listing pinned by a golden test.
- [x] 7.5.2 Import-write (picker or paste-URL): set `Repo.forge` + a forge-correct `gitSource` (derived
  from forge + host, NOT hardcoded github.com); paste-URL detects forge from host (or explicit selection)
  without enumeration; wire `RepoSchema.forge` through `ReposService.create`/`toResponse`.

## 8. Tests

- [x] 8.1 Per-forge golden tests (2.2-2.4 + 7.5.1) pin exact endpoint/body/Authorization-bytes/response + host + 204/422 parse.
- [x] 8.2 Detection ladder + unresolved skip; owner-scope (two-operator); deliver='none' byte-identical;
  gate-on-completed-only; no-diff→no_changes; force-with-lease re-run idempotency; existing-CR reuse;
  fail-open on missing credential; picker import lands `forge`+gitSource (not github.com/null).

## Track: verify-reopened (depends: none)

- [x] R.1 (multi-forge-repo-import — "Import records the forge and a forge-correct git source") RE-TRACED
  (2026-06-21): the BACKEND contract + write paths are now present —
  `ImportRepoRequestSchema` (`packages/contracts/src/github-import.ts`) DOES carry a forge-neutral
  `forge: z.enum(['github','gitlab','gitee']).optional()`; `AvailableForgeRepoSchema`
  (`packages/contracts/src/settings.ts:551`) carries `forge/fullPath/gitSource/visibility/defaultBranch/
  gitlabProjectId?`; `github-import.service.ts` repo.create now hardcodes `forge: 'github'` and
  `toResponse` echoes it (sub-claim A MET, GitHub import no longer lands `forge=null`); the generic
  `POST /repos` (`repos.service.ts:18`) sets `forge` explicit-or-inferred. The REMAINING gap is the WEB
  FRONTEND import-write path for GitLab/Gitee: `apps/web/src/components/repositories/import-dialog.tsx`
  is GitHub-only (no forge-source switcher), the web api layer (`apps/web/src/lib/api/`) has ZERO
  forge code (grep returns nothing), and `importRepoMutation` posts ONLY to `POST /repos/github/import`
  — there is NO `POST /repos {name, gitSource, forge:'gitlab'|'gitee'}` call anywhere in
  `apps/web/src/`. So the scenario "A GitLab picker import lands with the right forge + source" still
  has no traceable end-to-end (UI→write) path. FIX (frontend only — backend done): add the
  GitLab/Gitee import-write call (`POST /repos` with `forge` + forge-correct `gitSource`) to the web
  import dialog so a picker/by-URL import lands `forge='gitlab'`/`'gitee'`.
- [x] R.2 (multi-forge-repo-import — "Importable repos are listed per connected forge for the picker")
  The BACKEND per-forge listing is fully met and wired: `GET /settings/forges/repos?kind=…`
  (`settings.controller.ts:105`) → `ForgeCredentialService.listAvailableRepos`
  (`forge-credential.service.ts:76`) → per-forge `listRepos` (`gitlab-forge.ts` `GET /projects?membership=true`,
  `gitee-forge.ts` `GET /v5/user/repos`, `github-forge.ts` `GET /user/repos`), with golden tests. But the
  requirement's scenarios ("operator selects the GitLab source IN THE IMPORT DIALOG", "operator selects
  the Gitee source") name the import-dialog picker UI as the trigger, and that UI does not exist:
  `apps/web/src/components/repositories/import-dialog.tsx` reads ONLY `githubReposQuery` (GitHub-only),
  has no GitHub/GitLab/Gitee source switcher, and the web api layer has no `listAvailableForgeRepos`
  query or `GET /settings/forges/repos` call (grep over `apps/web/src/lib/api/` for forge returns
  nothing). The picker scenarios are untraceable end-to-end. FIX (frontend only — backend done): add a
  forge-source switcher to the import dialog plus a `listAvailableForgeRepos` query calling
  `GET /settings/forges/repos?kind=…` so the operator can list+pick GitLab/Gitee repos.
- [x] R.3 (task-result-delivery — "Delivery is opt-in and defaults to no-op") RE-TRACED (2026-06-21): the
  requirement says "The system SHALL accept an optional `deliver` parameter on task creation". The `/v1`
  create (`V1CreateTaskRequestSchema` extends `CreateTaskRequestSchema` which carries
  `deliver: DeliverSchema.optional()` — `packages/contracts/src/task.ts:308`; pipe at
  `v1-tasks.controller.ts:100`) and the console create (`createTaskBodySchema` pipe at
  `tasks.controller.ts:62`) BOTH accept `deliver` — MET. The READ-path echo is MET on all three surfaces
  (MCP `get_task`/`/v1`/console all return `TaskResponse` via the single `toTaskResponse`,
  `tasks.service.ts:840`). The GAP is the MCP `create_task` tool: its `inputSchema`
  (`apps/api/src/mcp/mcp-tools.ts:174-180`) lists only `repoId/prompt/branch/strategy/runtime` and OMITS
  `deliver`. The MCP SDK validates args against the `z.object` built from `inputSchema` and a plain
  `z.object` STRIPS unknown keys (`@modelcontextprotocol/sdk` `mcp.js:177` `safeParseAsync`), so a `deliver`
  value sent by an MCP client is dropped before the handler's `body as CreateTaskBody`
  (`mcp-tools.ts:183-194`) — the underlying `createTask` path supports it, it is simply not surfaced. So an
  MCP client cannot create a `deliver:'branch'|'pr'` task, which the empirical gate 9.2 ("create a
  `deliver:'pr'` task per forge ... via MCP") requires. FIX (one line + describe): add
  `deliver: DeliverSchema.optional().describe(...)` to the `create_task` `inputSchema` so the MCP create
  surface accepts `deliver` and it flows through to `createTask`.

## 9. Verify

- [x] 9.1 `pnpm --filter @cap/api typecheck` + full `test` green.
- [ ] 9.2 **Empirical MCP smoke (the real gate)**: with change B credentials connected for each forge,
  create a `deliver:'pr'` task per forge (GitHub + Gitee + GitLab) → each reaches `completed`, pushes
  `cap/task-<id>`, opens a PR/MR, and `get_transcript`/`get_task` return the `change_request_url`; a second
  run reuses the CR (idempotent).
