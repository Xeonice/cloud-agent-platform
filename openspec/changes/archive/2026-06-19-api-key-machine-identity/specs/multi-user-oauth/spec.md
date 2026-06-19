## ADDED Requirements

### Requirement: Bearer credentials are routed by token prefix before session resolution

Operator-principal resolution SHALL dispatch a presented `Authorization: Bearer` (or, on the WebSocket channel, the single presented) credential by its token PREFIX as the FIRST step, before any session lookup. A `cap_sk_`-prefixed credential SHALL be tried ONLY against API-key resolution; an `mcp_`-prefixed credential SHALL be tried ONLY against the reserved MCP resolver; any other credential SHALL fall through to the existing session-then-legacy paths unchanged. Each domain SHALL be reachable by exactly one prefix, so a credential of one domain is NEVER tried against another domain's resolver. The prefix is a non-secret routing decision and SHALL NOT weaken the constant-time comparisons each domain performs. This ordering SHALL hold identically on the REST `Authorization` header and on the WebSocket channel (where the same presented token is supplied to both the session and legacy candidates today).

#### Scenario: Prefixed credential never reaches the session lookup

- **WHEN** a `cap_sk_…` or `mcp_…` credential is presented on either the REST `Authorization` header or the WebSocket channel
- **THEN** it is routed to its own resolver and is NEVER tried as a session token (no `Session` table lookup) nor compared against the legacy operator token

#### Scenario: Unprefixed credentials keep existing behavior

- **WHEN** a credential without a reserved prefix is presented
- **THEN** resolution proceeds with the existing session-first, then gated legacy-token, behavior unchanged

### Requirement: Operator principal supports machine kinds and authorization scopes

The operator principal SHALL support an `api-key` kind in addition to `session` and `legacy-token`, and SHALL reserve an `mcp` kind. The principal SHALL be able to carry an optional set of authorization scopes and an optional key identifier. A principal that carries no scopes SHALL be treated as allow-all by scope-gated operations, preserving the behavior of session and legacy principals.

#### Scenario: API-key principal carries owner and scopes

- **WHEN** an API key resolves successfully
- **THEN** the resulting principal has kind `api-key`, a user equal to the key owner, and the key's granted scopes

### Requirement: Reserved MCP credential slot denies until bound

The `mcp_` prefix SHALL be reserved for the MCP machine-identity track. Until that track binds an MCP resolver, an `mcp_`-prefixed credential SHALL resolve to no principal (fail closed). Reserving the slot SHALL NOT create any dependency on the MCP track being present.

#### Scenario: MCP credential denied while resolver is unbound

- **WHEN** an `mcp_…` credential is presented and no MCP resolver is bound
- **THEN** resolution returns no principal and the request is rejected, with no state change

### Requirement: The legacy operator token must not collide with a reserved prefix

Because the legacy `AUTH_TOKEN` is an operator-chosen free-form value, the orchestrator SHALL refuse to boot when `AUTH_TOKEN` is configured AND begins with any reserved credential prefix (`cap_sk_`, `mcp_`), with a clear error. This prevents a legacy token from being silently mis-routed to a machine resolver and never reaching its constant-time comparison.

#### Scenario: Boot refused on a colliding AUTH_TOKEN

- **WHEN** the orchestrator starts with an `AUTH_TOKEN` that begins with a reserved prefix
- **THEN** it refuses to boot and emits a clear error naming the reserved prefixes

#### Scenario: Non-colliding AUTH_TOKEN boots normally

- **WHEN** the orchestrator starts with an `AUTH_TOKEN` that does not begin with any reserved prefix (or with the legacy path disabled)
- **THEN** it boots normally

### Requirement: Task actions attribute to the resolved principal's owner

When a task-changing operation runs behind the operator guard, the controller SHALL read the resolved principal and pass its owner's GitHub identity to the task service so the audit record attributes the action to that user. An `api-key` or `session` principal SHALL attribute to its owner; a principal with no user (legacy token, or an unattributable system action) SHALL attribute to the system sentinel as before.

#### Scenario: API-key-created task attributes to the key owner

- **WHEN** a task is created by a request authenticated with an `api-key` principal
- **THEN** the task's audit record attributes creation to the key owner's user, not the system sentinel

#### Scenario: Session-created task attributes to the session user

- **WHEN** a task is created by a GitHub-session principal
- **THEN** the task's audit record attributes creation to that session user
