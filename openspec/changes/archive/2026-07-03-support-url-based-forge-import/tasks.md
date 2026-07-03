<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-and-data-shape (depends: none)

- [x] 1.1 Extend forge credential read contracts with an optional API validation/access status (`verified` / `unverified`) while preserving existing `state='connected'` behavior.
- [x] 1.2 Add the corresponding Prisma schema/migration support if the API validation status is persisted server-side.
- [x] 1.3 Add contract/unit coverage proving existing credential responses remain valid and the new limited-status response parses.

## 2. Track: backend-forge-credentials (depends: contracts-and-data-shape)

- [x] 2.1 Normalize forge credential host inputs that include scheme/trailing slash/path into the lower-case hostname before storing or looking up credentials.
- [x] 2.2 Change forge token connection so API probe success stores an API-verified credential and API probe failure stores an encrypted API-unverified connected credential instead of rejecting by default.
- [x] 2.3 Keep plaintext token and ciphertext out of all read responses while returning the new secret-free validation/access status.
- [x] 2.4 Update forge listing errors so missing credentials, API-unverified/list-denied credentials, and transient forge failures surface distinguishable list-unavailable signals.
- [x] 2.5 Add focused service/controller tests for verified connect, API-unverified connect, host normalization, and list-unavailable behavior.

## 3. Track: backend-url-repo-import (depends: contracts-and-data-shape)

- [x] 3.1 Add URL validation/normalization for create-repo requests: accept HTTP(S) git URLs, reject credential-bearing URLs, strip obvious duplicate formatting, and preserve the safe clone URL.
- [x] 3.2 Ensure URL imports persist the explicit or inferred `forge` and remain immediately visible through repo list/task creation reads.
- [x] 3.3 Add duplicate handling for normalized `gitSource` so re-importing the same URL does not create indistinguishable repo rows.
- [x] 3.4 Add backend tests for public Gitee inference, self-hosted explicit forge, credential-bearing URL rejection, duplicate URL import reconciliation, and runtime forge detection for URL-imported repos.

## 4. Track: frontend-url-import-ui (depends: contracts-and-data-shape)

- [x] 4.1 Add URL import controls to `ImportDialog` for GitHub/GitLab/Gitee/self-hosted sources without requiring the list query to be armed.
- [x] 4.2 Derive a default repo name from the pasted URL path, submit `createRepoMutation({ name, gitSource, forge })`, and invalidate repo queries on success.
- [x] 4.3 Render list-unavailable states as recoverable and keep URL import visible; keep successful list-based import behavior unchanged.
- [x] 4.4 Reject credential-bearing URLs in the browser with copy that directs operators to code-hosting settings.
- [x] 4.5 Surface API-unverified forge credentials in settings/import copy as "clone/push may work; listing and PR/MR may require broader API permissions".
- [x] 4.6 Add focused web tests for URL import without syncing, list failure fallback, URL validation, and API-unverified credential messaging.

## 5. Track: docs-and-help-copy (depends: contracts-and-data-shape)

- [x] 5.1 Update forge token help docs to distinguish git clone/push permission from repository-list and PR/MR API permissions, especially for internal Gitee.
- [x] 5.2 Update settings/import dialog copy so operators understand when to choose URL import versus list sync.

## 6. Track: verification (depends: backend-forge-credentials, backend-url-repo-import, frontend-url-import-ui, docs-and-help-copy)

- [x] 6.1 Run targeted API tests for repos, forge credentials, forge registry, and provision lookup.
- [x] 6.2 Run targeted web tests for repository import/settings components.
- [x] 6.3 Run typecheck/lint/build commands required by the changed packages.
- [x] 6.4 Manually verify a local URL-import flow: connect/save a simulated API-unverified Gitee credential, import a known URL without listing, create a task from that repo, and confirm clone uses owner-scoped `http.extraHeader`.
