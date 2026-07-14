## ADDED Requirements

### Requirement: Public-surface changes require dynamic conformance verification

The verify flow SHALL classify any requirement that changes the public capability
registry, canonical public schema, Public V1 binding, MCP adapter, OpenAPI
projection, or Playground projection as high-risk and dynamically verify it; the
requirement MUST NOT pass on static inspection alone. Verify SHALL compare
`surface-impact.json`, the
canonical registry, actual reflected REST handlers, actual SDK MCP tools, and
observable adapter behavior, including every declared exclusion and projection.

#### Scenario: Typecheck passes but MCP strips a field

- **WHEN** the repository builds but the actual MCP callback drops a canonical
  request field before calling the shared use case
- **THEN** dynamic cross-transport conformance marks the requirement unmet
- **AND** the finding reopens an implementation task

#### Scenario: A declared exclusion is false

- **WHEN** a sidecar claims a capability is protocol-excluded but the registry or
  implementation exposes a partial undeclared mapping
- **THEN** verify reports a specification/impact defect rather than accepting the
  exclusion as self-authenticating

#### Scenario: Surface impact is undeclared

- **WHEN** code or registry evidence shows Public V1 or MCP behavior changed but
  `surface-impact.json` marks that surface unchanged or omits it
- **THEN** verify reports an undeclared-impact finding and archive remains gated
