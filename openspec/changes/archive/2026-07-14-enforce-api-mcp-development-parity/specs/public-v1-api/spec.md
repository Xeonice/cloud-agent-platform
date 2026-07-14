## ADDED Requirements

### Requirement: Public V1 handlers are exhaustively registry-bound

Every public `/v1` data handler SHALL carry exactly one typed public operation id
binding. A central fail-closed REST boundary SHALL resolve the operation's scope,
owner policy, canonical parser, output schema, and public error mapping from the
shared capability registry rather than repeating policy literals in controllers.
The real Nest handler inventory and the registry REST projection SHALL form a
two-way exact match. Metadata/docs routes and internal callbacks SHALL remain
outside the data registry only through their existing explicit classification.
The development gate SHALL recursively inspect production API sources and SHALL
reject bound handlers that consume standard Nest input decorators, raw request
data outside the registry authorization helpers, or a raw response object for an
operation that is not declared as streaming.

#### Scenario: A handler is added without a registry binding

- **WHEN** a developer adds a public `/v1` data handler without a typed operation
  id, or binds an id that has no REST registry entry
- **THEN** `pnpm test:public-surface` exits non-zero before the change can merge

#### Scenario: Registry authorization drives the real handler

- **WHEN** a request reaches a bound Public V1 handler
- **THEN** its required scope and owner policy are loaded from that handler's
  registry entry and enforced before the application use case runs
- **AND** a missing principal, missing binding, or unknown id fails closed

#### Scenario: REST schema metadata diverges

- **WHEN** a bound handler's accepted input or returned canonical output differs
  from the schemas declared for its operation id
- **THEN** the focused public-surface conformance test fails and identifies the
  operation

#### Scenario: A handler bypasses canonical request or response projection

- **WHEN** a bound handler reads an undeclared raw request field, uses a standard
  Nest input decorator, or injects `@Res` for a non-streaming operation
- **THEN** the recursive production-source conformance test exits non-zero
- **AND** direct and namespace-qualified decorator forms are subject to the same
  policy
