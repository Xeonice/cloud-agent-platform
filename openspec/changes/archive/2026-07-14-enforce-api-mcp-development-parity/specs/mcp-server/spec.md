## ADDED Requirements

### Requirement: MCP tool registration is exhaustively registry-bound

Every MCP-mapped public operation SHALL have exactly one adapter keyed by its
stable operation id. MCP registration SHALL iterate the registry projection and
derive the tool name, description, authorization policy, wire input schema,
canonical parser, output schema, annotations, and public error vocabulary from
that entry. The adapter SHALL delegate to the same application service as Public
V1 and SHALL contain only declared input/result projections. The registration
boundary MAY use one localized type cast to isolate MCP SDK generic limitations,
but the adapter map itself MUST remain an exact typed record and MUST NOT degrade
to `Record<string, ...>`.

#### Scenario: Mapped tool omission fails during development

- **WHEN** a registry operation is mapped to MCP without a corresponding adapter,
  or an adapter exists for a non-mapped operation id
- **THEN** the API typecheck fails before `registerMcpTools` can be built

#### Scenario: Advertised and executed schemas stay canonical

- **WHEN** an MCP client lists and calls a mapped tool after a field is added to
  its canonical request
- **THEN** the actual SDK `tools/list` input schema advertises the field
- **AND** the callback parses and forwards the field through the canonical parser
- **AND** returned `structuredContent` validates against the declared canonical
  output schema

#### Scenario: Scope and owner policy come from the operation

- **WHEN** an MCP caller invokes a mapped tool
- **THEN** the registration wrapper enforces the registry-declared scope and
  owner policy before calling its adapter
- **AND** the adapter does not carry a second handwritten scope literal

#### Scenario: Protocol differences are declared and tested

- **WHEN** an operation has an HTTP-only header, an MCP-only compatibility text
  envelope, an SDK-limited output-schema relaxation, a non-identity output
  projection, or no MCP representation
- **THEN** registration follows the operation's explicit difference/exclusion
- **AND** `pnpm test:public-surface` validates that exact behavior
- **AND** an undeclared omission or projection fails the command

#### Scenario: Domain failures preserve stable semantics

- **WHEN** an MCP adapter receives a stable public domain failure from the shared
  application use case
- **THEN** the central MCP error mapper returns the registry-declared JSON-RPC
  representation with the same stable code and retryability meaning as Public V1
- **AND** no Nest-specific exception detail is exposed
