# Multi-forge task delivery: land sandbox edits as a PR/MR (GitHub, Gitee, GitLab)

## Why

Tasks edit a sandbox clone but the platform has no commit/push-back path, so the agent's work is
discarded when the container is cleaned (verified in prod). This change lands those edits to the user's
forge as a pushed branch and/or a change request — for GitHub, Gitee, AND GitLab in one iteration,
behind a single Forge port. It builds on `add-forge-credentials` (change B) for the write-scoped,
encrypted, owner-scoped forge credential.

An empirical multi-agent study of the three forge APIs settled the abstraction: commit/branch/push are
SHARED git mechanics; only the change-request API + the repo identifier + the auth header vary per
forge. The single correct lifecycle window is `guardrails.onTerminal` — after transcript capture, before
teardown — the one moment the container is live, the working tree holds the diff, and credentials are
not yet trimmed.

## What Changes

- **Opt-in `deliver` selector (default OFF).** Add `deliver: 'none' | 'branch' | 'pr'` to task creation
  (default `'none'`, echoed on every read path). `'none'` is byte-identical to today.
- **A single `Forge` port + 3 implementations.** `apps/api/src/forge/forge.port.ts`: `FORGE` token +
  `ForgeRegistry` + `Forge { cloneAuthHeader(t):string (sync) , resolveBaseBranch, findExistingChangeRequest,
  openChangeRequest, listRepos }` — the HTTP methods are ordinary platform-process `fetch` calls (the
  `github-repos.client.ts` precedent); NO git-push method (git push is a sandbox concern).
  `GithubForge` / `GiteeForge` / `GitlabForge`, each with a golden test pinning its exact endpoint, body
  field names, auth header bytes, and response mapping (GitHub/Gitee `/pulls` head/base number/html_url;
  GitLab `/merge_requests` source_branch/target_branch iid/web_url).
- **Forge detection.** `ForgeRegistry.resolve(repo)`: explicit `Repo.forge` column → public-host
  inference from `gitSource` → change B's `ForgeConnection` (self-hosted) → unresolved ⇒ skip. Forge HTTP
  is a TRUSTED call to the operator's connected forge — NOT routed through `assertSafeProviderUrl` (that
  guard stays unchanged + scoped to the compatible-provider gateway).
- **Platform-orchestrated push-back.** In `guardrails.onTerminal`, gated on final status `completed` AND
  `deliver != 'none'`: the platform commits the working-tree diff and pushes branch `cap/task-<taskId>`
  INSIDE the sandbox (the `.git` is there) with `git -c http.extraHeader` (the SAME auth the clone uses,
  value from `forge.cloneAuthHeader`), and for `deliver:'pr'` opens (or reuses) the PR/MR via a
  platform-side native fetch (token never enters the sandbox for the CR call). No diff ⇒ `no_changes`;
  idempotent re-runs (`--force-with-lease` + existing-CR reuse); best-effort + time-boxed (never blocks
  teardown/slot).
- **Result surfacing.** Persist `deliver`, `deliver_status`, `branch_pushed`, `commit_sha`,
  `change_request_url`, `change_request_number` (nullable) echoed via the single `TaskResponse` to MCP /
  `/v1` / console; one audit event per attempt. The repo import/list shows the source forge + which
  credential it links to.
- **Multi-forge repo import.** A per-forge picker lists the repos the connected credential can access —
  GitHub (existing), GitLab `GET /projects?membership=true`, Gitee `GET /v5/user/repos` — each a simple
  paginated native fetch to the operator's connected forge (no SSRF gate; same for self-hosted). Imports
  (picker or paste-URL) record `Repo.forge` + a forge-correct `gitSource` (forge-neutral
  `AvailableRepo`/`ImportRepoRequest`; `RepoSchema` gains `forge`).

## Impact

- **Code:** new `apps/api/src/forge/*` (port + registry + 3 impls), `apps/api/prisma/schema.prisma`
  (`Repo.forge`, `Repo.gitlabProjectId`, 6 nullable Task delivery columns), `packages/contracts/src/task.ts`
  (deliver + result fields), `apps/api/src/sandbox/provision-lookup.ts` (`getForgeTarget`, generalize
  clone-auth to multi-forge), `apps/api/src/sandbox/aio-sandbox.provider.ts` (`deliverWorkspaceChanges`),
  `apps/api/src/guardrails/guardrails.service.ts` (the onTerminal hook; adds FORGE/getForgeTarget/
  deliverWorkspaceChanges deps into the guardrails module), audit + tasks read paths, console
  repo-import + task-detail UI (design mockup in OpenDesign).
- **Specs (ADDED):** new capabilities `task-result-delivery` + `multi-forge-repo-import`.
- **Depends on:** `add-forge-credentials` (change B) for the credential + self-hosted registry.
- **Out of scope:** fork-and-PR when the operator lacks push access (fail-open skip + audit, follow-up);
  push on failed/cancelled; agent-driven git; webhooks; non-https/ssh remotes; OAuth login providers (change A).
- **Decisions baked (ratify):** `branch`+`pr` both in v1; per-user owner-scoped credential (github
  public-host falls back to the login token); deterministic injection-safe `cap-bot` commit identity;
  forge HTTP is a trusted platform native-fetch to the operator's connected forge (NOT SSRF-gated;
  `assertSafeProviderUrl` unchanged); git push runs in-sandbox, CR creation platform-side; cross-network
  platform→forge reachability is the self-deployer's responsibility (no fallback designed around it).
