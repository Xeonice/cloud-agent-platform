## ADDED Requirements

### Requirement: Capacity projection is owned in platform-ops and read directly, with no orchestrator forwarder

The capacity/occupancy projection the metrics response derives SHALL be owned under
`apps/api/src/runner-metrics/` and reached through a `*.port.ts` plus its DI token, exactly as the
running-interval ledger already is. The orchestrator SHALL stop exporting a projection accessor, and
the accessor SHALL be DELETED rather than left as an uncalled forwarder. The metrics consumer SHALL
obtain the projection from the owner directly rather than routing through the orchestrator.

What this achieves is a change of FORM, not the removal of the dependency, and the distinction SHALL
be recorded rather than rounded up. The orchestrator's reference to the projection module becomes a
`*.port.ts` + DI token reference — the only cross-context form the manifest allows — which is why the
cross-context-import findings fall for both files. It does NOT stop the orchestrator naming the
collaborator: the capacity state (the semaphore) still lives in the orchestrator, so the owner cannot
own it, and the orchestrator hands it over at boot. The budget entry therefore SHALL be re-pointed at
the collaborator's new symbol and SHALL record that the count did not move, rather than being deleted.

Deleting the entry because its OLD symbol reached zero is forbidden, and the reason is the repository's
standing anti-forgery rule read in the other direction: a count that falls because a symbol was renamed
is a forged burn-down, and an entry retired on that basis leaves a live coupling with nothing measuring
it — strictly worse than before the change. An entry is deleted when its COLLABORATOR is gone, never
when its identifier changed.

`GET /metrics` and `GET /tasks/:taskId/metrics` SHALL be unchanged in field names, types, and values
for the same observed state; the owner SHALL add no logging, persistence, timers, or error handling
the projection did not already have.

#### Scenario: The old accessor and its type are gone from the tree

- **WHEN** the tree is searched for the orchestrator's projection accessor and for the old projection
  source type
- **THEN** zero matches are found, in production code and in test doubles alike, and no replacement
  accessor exists on any orchestrator

#### Scenario: The renamed collaborator is still measured, at its true count

- **WHEN** the dependency-budget gate is run over the post-change orchestrator
- **THEN** the metrics-projection entry is PRESENT, its symbol is the port type the extraction
  introduced, and its count is 2 — unmoved from the 2 the old symbol measured — so the rename is
  visible as a rename rather than as a burn-down

#### Scenario: The cross-context form improved even though the count did not

- **WHEN** the cross-context-import ratchet is compared before and after
- **THEN** the orchestrator's count falls by one and the metrics consumer's falls by one, because a
  bare module import became a port import and the consumer stopped importing the orchestrator —
  which is the decoupling this change actually delivers

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
