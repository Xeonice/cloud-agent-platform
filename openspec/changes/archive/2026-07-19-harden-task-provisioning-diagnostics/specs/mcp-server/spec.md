## ADDED Requirements

### Requirement: MCP exposes scoped task provisioning diagnostics

The canonical `tasks.provisioningDiagnostics` operation SHALL map to an MCP
tool named `get_task_provisioning_diagnostics`. The tool SHALL require
`tasks:diagnostics`, require the authenticated MCP token owner's account id,
and apply the same task-owner policy as Public V1; `tasks:read` and
`tasks:write` SHALL NOT imply access. The tool SHALL delegate to the same
task-owned diagnostic query service as Public V1 and Console and SHALL NOT read
container logs, audit prose, or provider output directly.

The tool input SHALL contain the same task id, bounded `limit`, and opaque
`cursor` fields as `tasks.provisioningDiagnostics`. Its advertised
`outputSchema` and returned `structuredContent` SHALL be the exact canonical
strict provisioning-diagnostics response used by Public V1, including the
same evidence-availability/degradation state, stable pagination semantics, and
separate primary-provisioning and secondary-cleanup outcomes. JSON text content
SHALL be the direct serialization of that validated canonical response and
SHALL NOT summarize, omit, or add diagnostic fields relative to
`structuredContent`.

The REST operation and MCP tool SHALL have no semantic protocol difference:
scope, owner policy, query behavior, pagination, safe field allowlist, and
not-found behavior SHALL remain identical. The MCP adapter SHALL never expose a
command, stdout/stderr, request or response body, header,
repository-authenticated URL, credential or temporary path, prompt,
environment dump, lease owner, provider endpoint, stack, or arbitrary
diagnostic bag.

The tool SHALL share Public V1's deployment capability gate and retryable
`task_provisioning_diagnostics_unavailable` error. The gate SHALL be checked before the diagnostic
query while any serving role lacks the matching registry, owner policy, scope
parser, or wire contract.

#### Scenario: MCP owner reads the canonical diagnostic page

- **WHEN** an MCP principal with `tasks:diagnostics` and an account id calls `get_task_provisioning_diagnostics` for its own task
- **THEN** the tool delegates to the shared diagnostic query and returns canonical `structuredContent`
- **AND** following `nextCursor` has the same stable, duplicate-free behavior as Public V1

#### Scenario: MCP diagnostic scope is explicit

- **WHEN** an MCP principal has `tasks:read`, `tasks:write`, or both but lacks `tasks:diagnostics`
- **THEN** `get_task_provisioning_diagnostics` returns an MCP error with 403 semantics
- **AND** no diagnostic query runs

#### Scenario: MCP owner policy fails closed

- **WHEN** an MCP principal calls the tool without an account id or for a task owned by another account
- **THEN** the adapter fails closed using the canonical owner-policy semantics
- **AND** it does not reveal whether a cross-owner task or its diagnostic ledger exists

#### Scenario: MCP capability gate fails closed

- **WHEN** the deployment has not attested every serving role for the diagnostics contract and scope parser
- **THEN** the tool returns retryable `task_provisioning_diagnostics_unavailable` before querying evidence

#### Scenario: MCP compatibility text has no protocol-only summary

- **WHEN** the tool returns a successful diagnostic page
- **THEN** compatibility text is a direct JSON serialization of canonical `structuredContent`
- **AND** it introduces no summarized, omitted, or transport-only diagnostic field

#### Scenario: MCP and Public V1 responses are identical

- **WHEN** the same authorized owner reads one diagnostic page through Public V1 and MCP with the same task id, limit, and cursor
- **THEN** both responses validate against the same schema and contain the same ordered records, degradation state, and next cursor
- **AND** no transport-specific field or omitted safe outcome creates semantic drift

#### Scenario: MCP reports legacy degradation without inventing evidence

- **WHEN** the tool reads a historical task that predates complete diagnostic persistence
- **THEN** it returns the same explicit partial or unavailable evidence state as Public V1
- **AND** it does not infer a provider outcome from logs or generic failure prose

#### Scenario: MCP output remains secret-free

- **WHEN** fault injection places a unique secret canary in provider errors, command material, output, and cleanup failures
- **THEN** neither MCP `structuredContent` nor compatibility text contains the canary or any forbidden raw field
