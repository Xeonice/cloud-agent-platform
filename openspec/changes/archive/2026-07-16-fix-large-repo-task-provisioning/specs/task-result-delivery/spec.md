## MODIFIED Requirements

### Requirement: cloneAuthHeader supplies one token-bearing header for the in-sandbox clone and push

The system SHALL use `forge.cloneAuthHeader(target)` to derive the one
token-bearing authorization header required for both in-sandbox clone and
in-sandbox push, but SHALL carry that value only inside a typed, redacted,
exact-host workspace credential descriptor. The selected provider SHALL write
the header through its secret-write primitive to a mode-0600 temporary Git
configuration scoped to the normalized repository scheme and host. Git command
text, argv, ordinary exec request fields, environment values, clone/push URLs,
logs, audit events, run metadata, and retained configuration SHALL contain only
the temporary configuration path and SHALL NOT contain the header or token.

For GitHub and Gitee the header SHALL remain `Authorization: Basic
base64('x-access-token:'+token)`; for a GitLab PAT it SHALL remain
`Authorization: Basic base64('oauth2:'+token)`. A different-host submodule
SHALL NOT inherit the parent repository header. Clone and push SHALL remove the
temporary configuration in all success, failure, timeout, cancellation, and
retry paths and SHALL prove it absent before sandbox retention.

#### Scenario: Push reuses the clone auth discipline

- **WHEN** the platform pushes the task branch from inside the sandbox
- **THEN** it uses the same exact-host temporary credential mechanism as clone and never places the token in URL, environment, command, argv, ordinary exec fields, or retained configuration
- **AND** the temporary credential is removed before the sandbox is retained

#### Scenario: Different-host submodule is isolated

- **WHEN** a cloned repository references a submodule on a host different from the parent forge
- **THEN** the parent `cloneAuthHeader` is not sent to the submodule host
- **AND** that submodule uses its own resolved credential or fails without receiving the parent secret
