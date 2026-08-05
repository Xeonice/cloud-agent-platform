## ADDED Requirements

### Requirement: Capacity projection is owned in platform-ops and read directly, with no orchestrator forwarder

The capacity/occupancy projection the metrics response derives SHALL be owned under
`apps/api/src/runner-metrics/` and reached through a `*.port.ts` plus its DI token, exactly as the
running-interval ledger already is. The orchestrator SHALL stop exporting a projection accessor, and
the accessor SHALL be DELETED rather than left as an uncalled forwarder. The metrics consumer SHALL
obtain the projection from the owner directly rather than routing through the orchestrator.

This removes the orchestrator's last type-level dependency on the projection module, so the
orchestrator no longer names that collaborator at all and its budget entry reaches zero. `GET /metrics`
and `GET /tasks/:taskId/metrics` SHALL be unchanged in field names, types, and values for the same
observed state; the owner SHALL add no logging, persistence, timers, or error handling the projection
did not already have.

#### Scenario: The forwarding accessor is gone from the tree

- **WHEN** the tree is searched for the orchestrator's projection accessor by name
- **THEN** zero matches are found, in production code and in test doubles alike, and no replacement
  forwarder exists on any orchestrator

#### Scenario: The orchestrator no longer names the projection

- **WHEN** the dependency-budget gate's measurement is run over the post-change orchestrator
- **THEN** the metrics-projection count is 0, including the type-only import, which the counter counts

#### Scenario: The metrics response is unchanged for the same state

- **WHEN** the metrics response is built from the same capacity and occupancy state before and after
  the move, with a frozen clock
- **THEN** the two response bodies are deep-equal, including every capacity and occupancy field

#### Scenario: The public-surface position is executed, not assumed

- **WHEN** the adversarial public-surface verifier is run for this change on the integrated tree
- **THEN** it exits 0 against the declared surface statuses with an empty findings list, every
  dynamic evidence lane passing, and its output is recorded rather than the declaration being taken
  on trust

#### Scenario: The transcript owner's move is declared where it lands, not where it is convenient

- **WHEN** the surface declaration is compared against the files this change actually edits
- **THEN** `publicV1` and `mcp` are declared **derived** rather than unchanged, each selecting
  `tasks.transcript` / `get_transcript`, because the transcript owner's relocation rewrote the
  `TRANSCRIPT_STORE` binding's import path in both `v1.module.ts` and `mcp.module.ts` — the verifier
  routes an edit under a surface declared `unchanged` as a blocking spec defect, and it did
- **AND** the single entry in `protocolDifferences` is the registry's OWN pre-existing
  `tasks.transcript / mcp-output-schema-relaxation`, transcribed because selecting the operation
  requires it — this change introduces no protocol difference of its own, which is what the passing
  registry, REST-metadata, MCP-SDK-metadata, and behavior lanes establish
