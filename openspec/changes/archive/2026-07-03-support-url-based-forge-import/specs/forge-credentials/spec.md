## MODIFIED Requirements

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
