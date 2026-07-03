## Why

Internal Gitee tokens may be intentionally limited to git clone/push and lack repository-list API permission. Today that blocks repository import because the non-GitHub import UI depends on listing repos first, even though the platform already knows how to clone/push a repo by URL with the operator's forge credential.

## What Changes

- Add a first-class URL import path for forge repositories, so an operator can paste a git URL and register it without enumerating repositories through the forge API.
- Keep the existing list-based picker for GitHub/GitLab/Gitee credentials that can list repositories.
- Allow a forge credential to be stored for git operations even when the API validation probe cannot prove list/user access, surfacing the limited state honestly instead of rejecting the token outright.
- Normalize self-hosted forge hosts consistently so the stored credential host matches the pasted repo URL host used at clone/push time.
- Update the repository import dialog copy and states so a listing failure offers URL import instead of dead-ending at "未连接".
- No breaking API removals; existing list and import endpoints remain.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `multi-forge-repo-import`: URL import must be usable without repository enumeration and must persist forge-correct repo metadata for known URLs.
- `forge-credentials`: Forge token connection must support degraded git-operation credentials when API validation/listing is unavailable.
- `frontend-console`: The repository import dialog must expose the URL import path and distinguish list unavailable from missing credentials.

## Impact

- Backend: `apps/api/src/repos`, `apps/api/src/settings/forge-credential.service.ts`, contracts for forge credential state if needed, and tests around repo creation / credential connection.
- Frontend: `apps/web/src/components/repositories/import-dialog.tsx`, settings forge credential UI/copy, API mutation/query wiring, and focused component tests.
- Runtime: clone/push path should remain unchanged and continue using owner-scoped `ForgeCredential` via `http.extraHeader`.
- Specs: modify `multi-forge-repo-import`, `forge-credentials`, and `frontend-console`.
