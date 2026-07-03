## Problem

Internal Gitee deployments can issue Personal Access Tokens that are valid for git clone/push but cannot call repository listing APIs such as `GET /api/v5/user/repos`. The current import dialog makes GitLab/Gitee import depend on listing first, so such tokens cannot import a known repository URL even though runtime git operations could work.

## Current Code Facts

- `POST /repos` already accepts `CreateRepoRequest { name, gitSource, forge? }` and persists a `Repo` without listing the forge. Public hosts infer `github|gitlab|gitee`; self-hosted hosts need an explicit forge.
- The web import dialog uses `availableForgeReposQuery(source)` for non-GitHub sources and enables it through `GET /settings/forges/repos?kind=...`. The only non-GitHub import button is attached to a listed `AvailableForgeRepo`.
- `GiteeForge.listRepos()` calls `{apiBase}/user/repos`; `ForgeCredentialService.listAvailableRepos()` calls that through the connected forge credential.
- `ForgeCredentialService.connect()` currently validates every submitted forge token by calling `{apiBase}/user` before storing it. A git-only token that cannot call the user API is rejected before the URL-import path can use it.
- Runtime clone and delivery do not depend on the import picker. `PrismaProvisionLookup.getCloneSpec()` resolves the task repo, asks `ForgeTargetResolver` for the task owner's `(kind, host)` token, and passes `forge.cloneAuthHeader(target)` as `git -c http.extraHeader` for clone. Delivery uses the same header for push.
- Existing specs already state that by-URL import should use `POST /repos` and that clone/push auth rides `http.extraHeader`; the missing behavior is productizing the URL path and allowing git-only credentials to be stored.

## Existing Spec Context

- `multi-forge-repo-import` already covers per-forge listing and says by-URL imports register the repo without enumeration.
- `forge-credentials` currently requires live API validation before persisting a forge token.
- `frontend-console` owns the repository import dialog behavior and needs a visible URL import path.
- `task-result-delivery` already covers owner-scoped clone/push credentials and best-effort PR/MR failure handling; this change should not alter delivery semantics.

## Decision Direction

- Keep list-based import for tokens with API listing rights.
- Add a URL-import mode for GitLab/Gitee/GitHub/self-hosted repos that calls `POST /repos` directly.
- Let operators store a forge credential in a degraded "git operations only" state when the API validation probe fails, so clone/push can still be attempted by git at runtime.
- Make the UI honest: list unavailable means "use URL import" rather than "not connected"; PR/MR API operations may still fail or require broader token scopes.
