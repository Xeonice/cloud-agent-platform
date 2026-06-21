# Design — add-multi-forge-task-delivery

## Context

Ship GitHub + Gitee + GitLab PR/MR push-back behind ONE Forge port. The guiding simplification: a forge
API call is a TRUSTED call to the operator's OWN connected forge (they pasted its PAT) — it is a plain
platform-process `fetch` (the `github-repos.client.ts` precedent), NOT an arbitrary URL, so it does NOT
go through `assertSafeProviderUrl` (that guard stays scoped to the compatible-provider model gateway).
The ONLY in-sandbox step is the git push, because the working tree + `.git` live there. Whether the
platform process can ROUTE to a self-hosted forge (cross-network/VPN) is the SELF-DEPLOYER's
responsibility — we do NOT design fallbacks around it. Builds on change B (forge credentials).

## D1 — The Forge port (cloneAuthHeader + 3 native-fetch HTTP methods)

`apps/api/src/forge/forge.port.ts` — a `FORGE` Symbol token + `ForgeRegistry` resolver, mirroring
`ProvisionLookup`/`CodexAuthSource`.

```
ForgeTarget   = { kind:'github'|'gitee'|'gitlab'; apiBaseUrl:string; cloneUrl:string; repoId:ForgeRepoId; token:string }
ForgeRepoId   = { style:'owner-repo'; owner:string; repo:string }   // github, gitee
              | { style:'project'; idOrPath:string }                // gitlab (numeric id OR url-encoded path)
ChangeRequestRef = { number:number; url:string; state:'open'|'merged'|'closed'; headBranch:string }
AvailableRepo    = { forge; fullPath:string; gitSource:string; visibility:string; defaultBranch:string; gitlabProjectId?:string }

interface Forge {
  readonly kind: ForgeTarget['kind'];
  cloneAuthHeader(t): string;                  // http.extraHeader value for the IN-SANDBOX git clone AND push
  resolveBaseBranch(t): Promise<string>;       // platform native-fetch
  findExistingChangeRequest(t, headBranch): Promise<ChangeRequestRef|null>;  // platform native-fetch
  openChangeRequest(t, {headBranch,baseBranch,title,body}): Promise<ChangeRequestRef>;  // platform native-fetch
  listRepos(t): Promise<AvailableRepo[]>;      // the import picker — platform native-fetch, paginated
}
```
The 4 HTTP methods are ORDINARY platform-process `fetch` calls with the decrypted PAT (clean response
parsing + golden-testable, like `github-repos.client.ts`). They are NOT SSRF-gated — they call the
operator's own connected forge, not an arbitrary URL. `cloneAuthHeader` is SYNC+pure and is the SAME
header the in-sandbox clone uses, reused for the in-sandbox push. There is NO `push` method on the port:
git push is a `SandboxProvider` concern (the `.git` is in the sandbox). `ForgeRepoId` is a discriminated
union so GitLab's project id can never leak into a github/gitee path.

## D2 — Per-forge mapping (GitLab is the outlier on every axis)

| | cloneAuthHeader (in-sandbox git) | resolveBaseBranch | findExisting | openChangeRequest | listRepos | response | API auth |
|---|---|---|---|---|---|---|---|
| github | `Basic b64(x-access-token:t)` | `GET /repos/{o}/{r}` .default_branch | `GET /pulls?state=open&head={o}:{b}` | `POST /pulls {head,base,title,body}` | `GET /user/repos` (existing import) | `number`/`html_url` | `Bearer`+Accept+X-GitHub-Api-Version |
| gitee | `Basic b64(x-access-token:t)` | `GET /repos/{o}/{r}` .default_branch | `GET /pulls?state=open` then client-side `head.ref===b` | `POST /pulls {head,base,title,body}` | `GET /v5/user/repos` | `number`/`html_url` | `Bearer` |
| gitlab | `Basic b64(oauth2:t)` | `GET /projects/{enc(id)}` .default_branch | `GET /merge_requests?state=opened&source_branch={b}` | `POST /merge_requests {source_branch,target_branch,title,description}` | `GET /projects?membership=true` | `iid`/`web_url` | `PRIVATE-TOKEN` (PAT) |

All paginated. Github/Gitee share endpoint+field names (only apiBaseUrl differs) → each impl pinned by a
golden test asserting the exact host + the exact Authorization bytes.

## D3 — Forge detection (ForgeRegistry.resolve(repo) → ForgeTarget | null)

1. Explicit `Repo.forge` column (set at import) — authoritative.
2. Public-host inference from `gitSource` hostname (github.com / gitee.com / gitlab.com → kind + apiBase).
3. Self-hosted: `ForgeConnection` row (host → kind + apiBaseUrl + cached `gitlabProjectId`).
4. Unresolved ⇒ null ⇒ push-back SKIPPED (logged), as `getCloneSpec` returns null. Fail-open.

`apiBaseUrl` for self-hosted = `https://{host}/api/v{3|4|5}` by kind. Forge calls against it are native-fetch
and NOT `assertSafeProviderUrl`-gated (trusted operator forge). If the platform can't route to a
self-hosted host, that is a deployer network concern — push-back simply errors and fails-open (audited).

## D4 — Credential resolution (owner-scoped, on change B)

`ProvisionLookup.getForgeTarget(taskId)`: `repo.gitSource` → `ForgeRegistry` detection → owner-scoped
`ForgeCredential` (the task owner via the `task.created` audit event, exactly
`PrismaCodexAuthSource.resolveTaskOwnerId`) → decrypt token. The github public-host case falls back to
`User.githubAccessToken` (encrypted by change B). Gitee/GitLab REQUIRE a `ForgeCredential` ⇒ absent ⇒
skip. The same generalization routes the clone auth header through `forge.cloneAuthHeader` (clone becomes
multi-forge); the clone-token read also becomes owner-scoped (an intentional behavior change — in the
single-operator model the identities coincide; an unattributed/system task keeps the existing global
allowed-user fallback for the clone-READ, but push-back still skips when unattributed).

## D5 — Push mechanics (git in-sandbox; forge HTTP platform-side) + the onTerminal hook

- **git push — IN SANDBOX** over the SAME `/v1/shell/exec` as clone (the working tree + `.git` are there):
  `status --porcelain` (empty ⇒ `no_changes`) → `add -A` → commit (deterministic `cap-bot` identity;
  message via base64 file + `$(cat)`, injection-safe) → `checkout -B cap/task-<taskId>` →
  `git -c http.extraHeader='<forge.cloneAuthHeader>' push --force-with-lease`. Token rides the command
  args only (clone discipline), never persisted; `scrubSecrets` on output.
- **forge HTTP — PLATFORM SIDE** (native fetch, token never enters the sandbox for these):
  `resolveBaseBranch` (or the create-body `branch`), then for `deliver:'pr'` `findExistingChangeRequest`
  then `openChangeRequest` (treat existing-open / 422 as idempotent reuse).

HOOK: in `guardrails.onTerminal` (the module is `apps/api/src/guardrails/guardrails.service.ts`), BETWEEN
`captureTranscript` (the working tree is intact + container live) and `teardownSandbox`. Gate: re-read
final status `==='completed'` (onTerminal fires for ALL terminals) AND `deliver != 'none'`. Persist the
result columns; emit audit. Best-effort + time-boxed (`AbortSignal.timeout`, the `captureTranscript`
discipline) — a failure or hung call NEVER blocks the terminal transition, teardown, or slot release.
The hook adds cross-module deps (FORGE registry, `getForgeTarget`, `deliverWorkspaceChanges`) into the
guardrails module.

## D6 — Repo import (picker + by-URL)

- **Picker** (`listRepos`, platform native-fetch, paginated): GitHub (existing import flow), GitLab
  `GET /projects?membership=true`, Gitee `GET /v5/user/repos` → `AvailableRepo`. Import-write sets
  `Repo.forge` + a forge-correct `gitSource` (derived from forge + host, NOT hardcoded github.com).
- **By-URL**: paste a git URL → detect forge from host (or explicit source) → register `Repo.forge` +
  `gitSource` without enumeration (quick single-repo import / operator preference).
- Contracts generalize from github-shaped to forge-neutral: `AvailableRepo` (above) +
  `ImportRepoRequest{forge, gitSource, ...}`; `RepoSchema` gains a nullable `forge` echoed by `ReposService`.

## D7 — Result surfacing + gotchas

Nullable Task columns `deliver`, `deliver_status` (`skipped|no_changes|pushed|pr_opened|failed`),
`branch_pushed`, `commit_sha`, `change_request_url`, `change_request_number`, echoed via `TaskResponse`.
Audit: `task.change_request_opened` (201 new) / `task.change_request_reused` (200) — two kinds, one code
each (matches the audit-mapping one-kind-one-code invariant).

Gotchas (designed-for): onTerminal fires for ALL terminals → re-read `completed`. Gitee no head filter →
client-side `head.ref` + 422-as-reuse. GitLab `%2F` proxy-decode → prefer cached numeric project id.
Re-run → `--force-with-lease` + existing-CR reuse. Unattributed task (no `task.created` owner) → no
credential → audited skip (no env fallback for gitee/gitlab).

## Open Questions

- **`task-result-delivery` — "Delivery results are surfaced and audited" — the requirement is
  self-contradictory about auditing NON-CR delivery outcomes (`failed`/`skipped`/`no_changes`/`pushed`).**
  The requirement body states "emit ONE audit event per attempt" but then enumerates the audit kinds as
  EXACTLY two CR-specific kinds: `task.change_request_opened` (201) / `task.change_request_reused` (200).
  The scenario "A wedged forge call does not hold a slot" further asserts that on a `failed` outcome "the
  audit records it." Yet no audit kind/resultCode is defined for a `failed` (or `skipped`/`no_changes`/
  `pushed`) delivery, and task 7.1 + D7 explicitly impose the audit-mapping ONE-KIND-ONE-CODE invariant —
  so emitting a third "delivery_failed" audit kind would require inventing an unspecified kind/code that
  the spec itself forbids without amendment. The implementation faithfully follows the requirement BODY:
  it emits the two CR audit events (`audit.service.ts:97` `recordChangeRequest` →
  `guardrails.service.ts:741`) and persists `deliver_status='failed'` on the task — surfaced on every read
  path via `toTaskResponse` (`tasks.service.ts:841`) — but emits NO `AuditEvent` row for non-CR outcomes
  (`guardrails.service.ts:691,706,710,714,754` call only `persistDeliver`, never `recordAudit`). This is a
  spec defect, not a code gap: the requirement must decide whether "the audit records it" is satisfied by
  the surfaced `deliver_status` column (current behavior — likely the intent, since that IS the durable,
  read-path-visible record), or whether a NEW non-CR delivery audit kind is required (which then needs a
  kind+resultCode defined that does not collide with the one-kind-one-code invariant). Resolve the wording
  before any code change; do NOT invent an audit kind to "pass" the scenario.

## Decisions (settled)
- **Forge API calls = trusted platform native-fetch, NOT SSRF-gated** (operator's own connected forge);
  `assertSafeProviderUrl` is UNCHANGED + untouched (scoped to the compatible-provider gateway). Cross-network
  platform→forge reachability is the self-deployer's responsibility — no fallback designed around it.
- git push in-sandbox (data location), token via `http.extraHeader` like clone; CR creation + reads are
  platform-side native-fetch (token never enters the sandbox for those).
- `deliver` none|branch|pr default none (opt-in); per-user owner-scoped credential + github login-token
  fallback; deterministic injection-safe `cap-bot` commit identity; picker for all 3 forges + by-URL.
