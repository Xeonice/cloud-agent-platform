# api-mcp-development-parity Specification

## Purpose
TBD - created by archiving change enforce-api-mcp-development-parity. Update Purpose after archive.
## Requirements
### Requirement: Canonical public capability registry

The system SHALL keep one literal-preserving public capability registry in
`@cap/contracts`. Every entry SHALL have a unique stable operation id and SHALL
declare its canonical wire input and output schemas, authorization policy,
read/write semantics, stable public error codes, REST mapping, and either an MCP
tool mapping or an explicit MCP exclusion with a non-empty protocol reason. An
omitted MCP decision SHALL NOT be treated as an implicit exclusion.

#### Scenario: A new REST capability has no MCP decision

- **WHEN** a public REST operation is added to the registry without an MCP tool
  mapping or an explicit reasoned exclusion
- **THEN** the registry typecheck or `pnpm test:public-surface` exits non-zero
- **AND** the incomplete capability cannot pass the development parity gate

#### Scenario: A protocol-specific capability is explicitly excluded

- **WHEN** a lifecycle SSE operation declares that request-response MCP tools
  cannot represent its streaming contract and supplies a non-empty reason
- **THEN** the registry accepts the explicit exclusion
- **AND** the MCP server does not advertise a tool for that operation
- **AND** the exclusion is covered by the parity suite

#### Scenario: Registry identities are unique

- **WHEN** two entries declare the same operation id, REST method/path pair, or
  MCP tool name
- **THEN** `pnpm test:public-surface` exits non-zero and identifies the duplicate

### Requirement: Transport bindings are exhaustive

The Public V1 handler bindings and the MCP adapter map SHALL be exhaustive over
their respective registry projections. A mapped MCP adapter SHALL be keyed by
stable operation id and SHALL contain only protocol input projection, invocation
of the shared application use case, and result projection; tool name, scope,
wire schemas, output schema, and public error vocabulary SHALL be derived from
the registry. The implementation SHALL retain exact per-entry types so a missing
or extra binding is a TypeScript error rather than a runtime discovery.

#### Scenario: A mapped MCP operation lacks an adapter

- **WHEN** a registry entry maps an operation to MCP but the exhaustive adapter
  object has no entry for that operation id
- **THEN** the API typecheck fails before the server can be built

#### Scenario: A Public V1 handler and registry diverge

- **WHEN** a real Nest data handler has no registry binding, or a REST-mapped
  registry operation has no real handler
- **THEN** the reflected Public V1 parity test exits non-zero
- **AND** the test compares derived sets rather than a hard-coded operation count

### Requirement: Wire schemas and parse schemas cannot drift

For a public request, one field-owning Zod object SHALL define the wire schema
used by REST/OpenAPI and MCP tool advertisement. A separate parse schema MAY add
defaults, refinements, or transforms only by deriving from that wire schema;
REST and MCP execution SHALL parse through the canonical parse schema. A
transport MAY project params, query, headers, or body into a different envelope
only when that projection is declared in the registry and covered by a focused
test. Handwritten copies of canonical field lists SHALL NOT be used as transport
schemas.

#### Scenario: A canonical request gains a field

- **WHEN** a field is added to the canonical public request wire schema
- **THEN** the OpenAPI operation and mapped MCP `tools/list` schema both expose it
- **AND** both execution adapters parse and forward the field to the same use case
- **AND** the parity gate fails if either transport strips or omits it

#### Scenario: Existing protocol projections remain explicit

- **WHEN** task idempotency remains an HTTP-only header, task creation retains an
  MCP text compatibility wrapper, the SDK requires a declared transcript output
  schema relaxation, or schedule deletion projects a REST 204 into an MCP
  acknowledgement
- **THEN** the difference is declared by operation id with its projection/reason
- **AND** the canonical structured output is still schema-validated
- **AND** an equivalent undeclared difference fails the parity gate

### Requirement: Public errors have exhaustive transport mappings

The contracts package SHALL export a stable public error-code vocabulary, and
the API SHALL provide exhaustive REST and MCP mappings for every code. Both
transport adapters SHALL derive their protocol response from the same normalized
stable code, retryability meaning, and allowlisted safe details. The public
envelope MAY differ only through a registry-declared compatibility projection;
in particular, an existing REST error body that predates the stable code MAY
retain its byte-compatible shape while MCP exposes its declared representation.
Internal exception names, stack traces, credentials, and provider diagnostics
MUST NOT cross either public boundary.

#### Scenario: A new error code lacks one transport mapping

- **WHEN** a stable public error code is added without both a REST mapping and an
  MCP mapping
- **THEN** the API typecheck or public-surface parity test exits non-zero

#### Scenario: One use-case failure crosses both transports

- **WHEN** the shared application use case returns the same public domain failure
  through REST and MCP
- **THEN** both transport boundaries select their response from the same stable
  public error code and retryability semantics
- **AND** each uses its declared protocol representation without exposing
  non-allowlisted diagnostics
- **AND** any legacy REST envelope that does not serialize the stable code is an
  explicit, tested compatibility projection rather than an accidental mismatch

### Requirement: Focused public-surface verification is runnable locally

The repository SHALL expose `pnpm test:public-surface` as one deterministic
command that requires no database, container, listening port, network access, or
external credential. It SHALL exercise registry uniqueness, Public V1 reflection,
MCP SDK registration and result schemas, OpenAPI projection, Playground catalog
projection, authorization metadata, error mappings, and every explicit protocol
difference. It SHALL exit zero only when all checks pass. A watch variant SHALL
be available for iterative contract work.

#### Scenario: Healthy public surfaces pass

- **WHEN** `pnpm test:public-surface` runs on a tree whose registry and all
  projections agree
- **THEN** the command exits zero without starting infrastructure or opening a
  listening socket

#### Scenario: Any covered projection drifts

- **WHEN** a fixture changes a scope, schema field, output, error mapping, tool
  mapping, route binding, or declared exclusion in only one covered surface
- **THEN** `pnpm test:public-surface` exits non-zero and names the operation and
  mismatched surface

### Requirement: REST and MCP adapters pass shared behavioral conformance

The parity suite SHALL drive shared all-fields and failure fixtures through the
REST and MCP adapter boundaries and compare their normalized use-case arguments,
canonical successful output, validation verdicts, authorization/owner verdicts,
public domain errors, and whether a state-changing use case was invoked. A
transport-specific envelope SHALL be normalized only by its declared projection.

#### Scenario: All-fields create input is equivalent

- **WHEN** the same canonical all-fields task or schedule creation fixture is
  submitted through Public V1 and MCP
- **THEN** both adapters pass equivalent normalized arguments to the same
  application use case
- **AND** their successful results validate against the same canonical output
  schema after declared projection

#### Scenario: Rejected input causes no write

- **WHEN** either adapter receives a fixture that fails canonical validation,
  scope, or owner policy
- **THEN** both adapters produce the corresponding declared public failure
- **AND** neither invokes the state-changing application use case
