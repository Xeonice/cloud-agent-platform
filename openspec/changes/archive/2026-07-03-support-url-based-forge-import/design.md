## Context

The current multi-forge flow has the runtime pieces needed for private Gitee/GitLab repositories: a task clones from `Repo.gitSource`, resolves the task owner's `(kind, host)` `ForgeCredential`, and injects the PAT through `git -c http.extraHeader`. Delivery reuses that same header for push. The import UI, however, still makes non-GitHub import depend on `GET /settings/forges/repos?kind=...`, which calls the forge repository-list API.

Internal Gitee deployments can issue tokens that are valid for git clone/push but cannot call `/user` or `/user/repos`. That means the token may be useful at runtime but unusable for the current import and connect probes.

## Goals / Non-Goals

**Goals:**

- Let an operator import a known forge repository URL without requiring repository-list API permission.
- Preserve the existing list-based picker when the token can list repositories.
- Let an operator store a forge PAT for git clone/push even when API validation cannot prove user/list access.
- Keep clone/push auth behavior unchanged: token in `http.extraHeader`, never embedded in the URL.
- Make UI states explicit: API listing unavailable is not the same as missing credentials.

**Non-Goals:**

- Add forge OAuth providers.
- Support SSH remotes or token-in-URL remotes.
- Guarantee PR/MR creation with git-only tokens; API-backed PR/MR operations remain best-effort and may fail if the token lacks API permissions.
- Add a platform-side git clone validation probe during import.

## Decisions

### D1 - URL import uses the existing `POST /repos` write path

The URL import form should submit `CreateRepoRequest { name, gitSource, forge }` to `POST /repos`. This avoids a new backend endpoint and matches the existing contract that by-URL import registers a forge-correct `Repo`.

The web client should derive a default name from the URL path's last segment, stripping `.git`, while allowing the backend to store the submitted display name as-is. The selected source tab supplies `forge` for self-hosted or ambiguous hosts; public `github.com`, `gitlab.com`, and `gitee.com` can still be inferred server-side.

Alternative considered: call the forge API to resolve metadata before import. Rejected because that repeats the permission problem and makes URL import unavailable for git-only tokens.

### D2 - Listing remains a convenience, not a prerequisite

`GET /settings/forges/repos` should continue to list repos when the connected token has API access. If it fails because the API denies listing, the console should keep the URL import form available and explain that listing is unavailable for this token.

The list endpoint can keep returning errors; the important behavior is that the frontend no longer treats that error as a terminal import blocker.

### D3 - Forge credential connection stores git-operation credentials with API validation status

`PUT /settings/forges` should still attempt the current authenticated API probe. A successful probe stores the credential as API-verified. A failed probe stores the encrypted token as a connected, unverified git credential rather than rejecting it, and returns a secret-free read shape that lets the UI display the limited status.

Recommended shape:

```ts
type ForgeCredential = {
  kind: 'github' | 'gitlab' | 'gitee';
  host: string;
  state: 'connected' | 'not_connected';
  last4?: string | null;
  apiAccess?: 'verified' | 'unverified';
};
```

`state='connected'` continues to mean "a token is stored for runtime use"; `apiAccess='verified'` means list/PR API calls are expected to work; `apiAccess='unverified'` means clone/push may still work but API-backed listing and PR/MR creation can fail.

Alternative considered: add a "skip validation" checkbox. Rejected for v1 because internal Gitee users should not have to discover a hidden bypass; the platform can attempt validation and still store a clearly marked limited credential.

### D4 - Host normalization is load-bearing

The credential host must match the host parsed from `Repo.gitSource`, because runtime credential lookup is by `(userId, kind, host)`. The connect flow should normalize host inputs that include a scheme, path, or trailing slash into the lower-case hostname. URL import should store a clone URL whose hostname matches that normalized host.

Examples:

```text
https://gitee.internal/         -> gitee.internal
gitee.internal                  -> gitee.internal
https://gitee.internal/o/r.git  -> repo host gitee.internal
```

### D5 - Runtime clone/push stays unchanged

This change should not alter `PrismaProvisionLookup`, `ForgeTargetResolver`, `cloneAuthHeader`, or delivery mechanics except for tests that prove URL-imported repos resolve the same way. A git-only token is validated by git when the sandbox actually clones or pushes; failures remain fail-closed for clone and best-effort for delivery.

## Risks / Trade-offs

- [Risk] A typo or revoked token may now be stored when the API probe fails. -> Mitigation: mark the credential `apiAccess='unverified'`, warn in the UI, and rely on runtime clone/push to fail with the actual git error.
- [Risk] Operators may expect PR/MR creation to work with a git-only token. -> Mitigation: copy should distinguish clone/push capability from API list/PR capability; `deliver='branch'` remains the safer option for git-only tokens.
- [Risk] Duplicate URL imports can create confusing repo rows. -> Mitigation: de-duplicate exact normalized `gitSource` imports or return a conflict/existing repo signal.
- [Risk] Host mismatch between credential and repo URL silently removes auth. -> Mitigation: normalize credential host and keep explicit forge selection for self-hosted URLs.

## Migration Plan

- Add any new optional credential-read field with a default for existing rows (`verified` if the previous row passed strict validation, or omit/derive as compatible).
- Existing forge credentials continue to decrypt and work for runtime clone/push.
- Existing imported repos are unchanged.
- Rollback is safe: older code ignores the new UI path and can still use existing rows; if a new `apiAccess` field/column exists, it is additive.

## Open Questions

- Should public GitHub also expose URL import in the same form, or should the first UI iteration emphasize GitLab/Gitee/self-hosted where listing failures are more likely?
- Should `apiAccess='unverified'` be persisted as a DB column, or derived from the last connection response only? Persisting is better for UI honesty after refresh.
