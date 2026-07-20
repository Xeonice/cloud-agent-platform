# mcp-server

## ADDED Requirements

### Requirement: MCP task reads surface the shared provisioning progress

MCP task tools (`create_task`, `list_tasks`, `get_task`, `stop_task`) SHALL
surface the transfer-progress object through the same canonical
`TaskProvisioningSummary` projection used by Console and Public V1, with no
MCP-specific progress shape, field renames, or extra fields. When progress is
unknown or the deployment capability gate is closed, MCP structured output
SHALL omit/null the progress object exactly as the canonical schema does, and
legacy payloads without the field SHALL remain valid for MCP consumers.

#### Scenario: MCP task read includes clone progress

- **WHEN** an MCP client calls `get_task` for a task whose detached clone reports a known percentage
- **THEN** the tool's structured output validates against the canonical Task schema and contains the same numeric progress object as the equivalent Public V1 read
- **AND** no lease identity, provider endpoint, command text, or raw git output appears

#### Scenario: MCP output stays valid without progress

- **WHEN** an MCP client reads a task with no progress snapshot (unknown phase, gate closed, or legacy task)
- **THEN** the structured output validates with the progress object null/absent
- **AND** the remaining summary fields (state, stage, attempt, resolvedBranch, updatedAt) are unchanged
