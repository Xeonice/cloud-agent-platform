# forge-credentials Specification

## Purpose
TBD - created by archiving change add-forge-credentials. Update Purpose after archive.
## Requirements
### Requirement: Operators connect a forge via a validated, encrypted Personal Access Token
The system SHALL let an operator connect a code-hosting forge (`github` | `gitlab` | `gitee`, including self-hosted) by submitting a Personal Access Token plus the forge `kind` and an optional `host`. The system SHALL attempt a live authenticated probe against the resolved forge API before persisting the token. When the probe succeeds, the system SHALL persist the token as an API-verified connected credential. When the probe fails because the token lacks user/list API permission, the forge API is unreachable, or the deployment intentionally provides a git-only token, the system SHALL still allow the operator to store the encrypted token as a connected but API-unverified git credential, clearly marking that state on the secret-free read shape.

The PAT-paste flow is the v1 connection mechanism (no OAuth-App registration); the connect input shape SHALL leave room for an OAuth authorization-code flow as a later enhancement without a schema change. The plaintext token SHALL never be returned. Runtime clone/push SHALL be allowed to attempt use of both API-verified and API-unverified connected credentials; API-backed list and PR/MR operations MAY fail for API-unverified credentials and SHALL surface those failures honestly.

#### Scenario: Connect with a valid token stores an encrypted API-verified credential
- **WHEN** an operator submits `{kind, host?, token}` and the token passes a live authenticated probe against the resolved API base
- **THEN** the system stores a `ForgeCredential` for that operator with the token AES-256-GCM encrypted, records `state='connected'`, records an API-verified status, records a masked `last4`, and returns the secret-free credential

#### Scenario: API probe failure can store a git-only credential
- **WHEN** an operator submits a token that cannot call the forge user/list API but may still be valid for git clone/push
- **THEN** the system stores the token encrypted as `state='connected'` with an API-unverified status instead of rejecting it outright
- **AND** the response and later credential list make the limited status visible without returning the token

#### Scenario: API-unverified credential can be used for runtime git operations
- **WHEN** a task owned by the operator targets a repo whose `(kind, host)` matches an API-unverified connected credential
- **THEN** clone and push resolution may use that credential through `git -c http.extraHeader`, with git itself determining whether the token is accepted

#### Scenario: API-unverified credential does not masquerade as list-capable
- **WHEN** the import picker attempts to list repos for a credential whose API access is unverified or denied
- **THEN** the list operation surfaces a list-unavailable state and does not show a fabricated empty repository list

### Requirement: Forge credentials are owner-scoped, encrypted at rest, and never returned in plaintext
The system SHALL persist forge credentials per-user, keyed uniquely by `(userId, kind, host)`, with the
token stored ONLY as an AES-256-GCM `ciphertext.iv.authTag` envelope (via the shared settings-crypto
primitive and `CODEX_CRED_ENC_KEY`), and SHALL cascade-delete them with the user. The plaintext token
SHALL be decrypted only at point of use and SHALL NEVER be returned on any read path; reads expose only
`kind`, `host`, `state`, and a masked `last4`.

#### Scenario: Reading a connected credential never exposes the token
- **WHEN** the settings credential read endpoint returns a connected forge credential
- **THEN** the response contains `kind`, `host`, `state`, and masked `last4` only — never the token or full ciphertext

#### Scenario: One operator may connect several forges/hosts
- **WHEN** an operator connects github.com, a self-hosted gitlab host, and gitee.com
- **THEN** three distinct `ForgeCredential` rows coexist (unique on userId+kind+host) with no collision

### Requirement: Self-hosted forges are resolved via an operator-configured connection registry
The system SHALL let an operator register a self-hosted forge as a `ForgeConnection` storing a `host` →
its `kind` and `apiBaseUrl` (suffix `/api/v3` GitHub Enterprise, `/api/v4` GitLab, `/api/v5` Gitee, plus a
cached gitlab project id). A forge call is a TRUSTED call to the operator's connected forge (not an
arbitrary URL) and SHALL NOT be routed through `assertSafeProviderUrl`; that guard SHALL remain unchanged
and scoped to the compatible-provider gateway. An internal self-hosted forge on a private host therefore
works by a plain native fetch; whether the platform can route to it is a deployer network concern. Public
hosts (github.com / gitlab.com / gitee.com) SHALL NOT require a connection row.

#### Scenario: A self-hosted host on a private network is stored and callable
- **WHEN** an operator registers `{host: git.corp.com, kind: gitlab}` (derived `https://git.corp.com/api/v4`, a private IP)
- **THEN** the connection is stored and that host resolves to the gitlab forge + API base, callable by a plain native fetch with no private-IP rejection

### Requirement: The operator GitHub login token is encrypted at rest
The system SHALL store `User.githubAccessToken` as an AES-256-GCM encrypted envelope (it is plaintext
today; this is orthogonal hygiene, the token is already `repo` read+write scoped). Decryption SHALL be
centralized in ONE helper used by ALL THREE readers — the OAuth login write, the clone-auth read, and the
repo-import token read — so no reader 401s after encryption. The system SHALL fail fast at boot when this
encryption is enabled but no valid encryption key is set (a github-token decrypt has no env fallback). The
migration MAY be a simple full re-encrypt sweep (no legacy data to preserve carefully).

#### Scenario: Login persists the token encrypted and all readers decrypt
- **WHEN** an operator completes GitHub OAuth login
- **THEN** `User.githubAccessToken` is written as ciphertext and is decrypted via the shared helper at each reader (clone, repo-import, push-back fallback) — never returned in plaintext

### Requirement: Forge credentials are scoped by account id, available to local accounts

Forge credentials (per-forge Personal Access Tokens and the self-hosted connection registry) SHALL
be owner-scoped by the operator's account id (the user primary key), available to every
authenticated, allowed account INCLUDING a local (non-GitHub) account with no GitHub identity. A
local account SHALL NOT be rejected with `account_scope_required` when connecting, listing, or
removing a forge credential. Owner isolation SHALL remain: one account SHALL NOT see or use another
account's forge credentials.

#### Scenario: Local account connects a forge credential

- **WHEN** a local (no GitHub id) authenticated, allowed account connects, lists, or removes a forge PAT or registry entry
- **THEN** the operation is scoped to that account's id and succeeds, never returning `account_scope_required`

#### Scenario: Forge owner isolation across accounts

- **WHEN** account A lists its forge credentials
- **THEN** account B's forge credentials are never returned
