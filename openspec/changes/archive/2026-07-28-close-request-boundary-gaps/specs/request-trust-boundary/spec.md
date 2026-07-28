## ADDED Requirements

### Requirement: An operation that demands an interactive operator SHALL reject machine credentials

An administrative operation SHALL admit only a principal that authenticated as an
interactive session. A machine credential — an API key or an MCP token — SHALL be
rejected regardless of the role its owning account holds and regardless of the
scopes it was granted, because its owner's privileges are not its own. A legacy
shared-token principal SHALL likewise be rejected. Re-reading the owning account's
`role` and `allowed` columns SHALL NOT by itself satisfy this requirement: the
credential kind is a separate fact and SHALL be checked separately.

#### Scenario: A scoped machine credential owned by an admin is refused

- **WHEN** a request presents an API key or MCP token whose owning account is
  `allowed` with `role = admin`
- **THEN** every administrative endpoint rejects it
- **AND** the rejection does not depend on which scopes the credential carries

#### Scenario: An interactive admin session is admitted

- **WHEN** the same operation is requested by a session principal whose account is
  `allowed` with `role = admin`
- **THEN** the operation proceeds

#### Scenario: A single judgement decides admin-ness

- **WHEN** any administrative route decides whether a caller is an admin
- **THEN** it reaches that decision through one shared predicate
- **AND** no route reimplements the check from the account columns alone

### Requirement: A cookie-authenticated state change SHALL come from a trusted origin

A request that changes state and authenticates by session cookie SHALL be admitted
only when its declared origin is one the deployment trusts. A request whose origin
is absent, unparseable, or outside the trusted set SHALL be rejected before the
handler runs. The trusted set SHALL be the same one that governs cross-origin
response sharing, so a deployment configures its console origin once and cannot
have the two lists disagree.

A request that authenticates by a bearer credential SHALL NOT be subject to this
check: a browser cannot attach such a credential to a forged cross-site request,
so the check would only break legitimate programmatic callers.

#### Scenario: A forged cross-site state change is rejected

- **WHEN** a state-changing request arrives with a valid session cookie and an
  `Origin` outside the trusted set
- **THEN** the request is rejected before any state changes
- **AND** the response does not reveal whether the session cookie was valid

#### Scenario: The console's own requests are admitted

- **WHEN** the same request arrives with the deployment's configured console origin
- **THEN** it proceeds normally

#### Scenario: A bearer-authenticated caller is unaffected

- **WHEN** a state-changing request authenticates by API key or MCP token and
  declares no origin
- **THEN** it proceeds normally

#### Scenario: Safe methods are unaffected

- **WHEN** a read-only request arrives from an untrusted origin
- **THEN** the origin check does not reject it, and existing response-sharing
  rules continue to govern what the caller may read

### Requirement: A WebSocket handshake SHALL be origin-checked before it is accepted

The WebSocket upgrade SHALL validate the handshake's origin against the same
trusted set before the connection is established and before any gateway
authentication runs. Browsers do not apply the same-origin policy to WebSocket
connections and cross-origin response-sharing rules do not cover them, so a
cookie-authenticated socket is otherwise reachable from any page.

#### Scenario: A cross-origin socket is refused at the handshake

- **WHEN** a WebSocket upgrade arrives carrying a valid session cookie and an
  origin outside the trusted set
- **THEN** the handshake is refused
- **AND** no terminal session is created or attached

#### Scenario: The console's socket connects

- **WHEN** the upgrade declares the deployment's configured console origin
- **THEN** the handshake succeeds and the gateway proceeds with its own
  authentication

### Requirement: A served page SHALL NOT execute unverifiable third-party code

HTML the orchestrator serves SHALL NOT load executable third-party assets from a
floating remote reference. Any such asset SHALL be pinned to an exact version and
carry an integrity hash, or SHALL be served from the orchestrator itself. This
holds with particular force for pages reachable without authentication, which sit
on the same origin as the authenticated API.

#### Scenario: The API documentation page pins and verifies its assets

- **WHEN** the documentation page is rendered
- **THEN** every third-party script and stylesheet it references is pinned to an
  exact version and carries an integrity hash, or is served from this origin
- **AND** no referenced URL resolves to a moving target such as a version-less
  package path
