## ADDED Requirements

### Requirement: The dedicated transcript route renders real session-history data
The console's dedicated transcript route `/tasks/$taskId/transcript` SHALL render
the read-only transcript from the REAL `sessionHistoryQuery` (the `GET /tasks/:id/session-history`
real/mock seam gated by the `sessionHistory` capability), keyed by the route's
`taskId` param. It SHALL NOT render a hardcoded sample transcript. The route SHALL
present the transcript.html timeline form — a per-row time gutter plus typed rows
(system / user / commentary / tool / final answer) — and SHALL apply its type
filter and free-text search together over the REAL turns. The route SHALL render
the contract's honest non-available states (empty / expired) rather than
fabricating content, and SHALL remain reachable from the history page's 「查看会话」
entry.

#### Scenario: Route consumes taskId and fetches real data
- **WHEN** an authenticated operator opens `/tasks/<id>/transcript` for a finished task
- **THEN** the route issues `sessionHistoryQuery(<id>)` keyed by the route param and renders the returned `SessionHistory` turns
- **AND** no hardcoded sample transcript is rendered for any task

#### Scenario: Filter and search narrow the real timeline together
- **WHEN** the operator selects a type filter and/or types a search query on the transcript route
- **THEN** only the real turns matching BOTH the active filter and the search query remain visible
- **AND** when nothing matches, the route shows its empty "没有匹配的记录" state

#### Scenario: Non-available states render honestly
- **WHEN** the session-history response for the task discriminates to `empty` or `expired`
- **THEN** the transcript route renders the corresponding honest state and fabricates no transcript content

#### Scenario: History 「查看会话」 reaches the data-driven route
- **WHEN** the operator clicks 「查看会话」 for a finished task on the history page
- **THEN** they land on `/tasks/<id>/transcript` rendering that task's real transcript

### Requirement: Parsed turns carry their source timestamp
The session-history parse contract SHALL carry, on each turn, the timestamp of
the rollout line that produced it, read from the existing `{timestamp, type, payload}`
line `timestamp`. The field SHALL be OPTIONAL: when the producing line has no
timestamp, the turn SHALL omit it rather than fabricate one. The timestamp SHALL
NOT be inferred from message ordering.

#### Scenario: A turn carries the producing line's timestamp
- **WHEN** the parser emits a turn from a rollout line that has a `timestamp`
- **THEN** the turn's timestamp field equals that line's timestamp

#### Scenario: A turn with no source timestamp omits it
- **WHEN** the producing rollout line carries no `timestamp`
- **THEN** the emitted turn omits the timestamp field and no value is fabricated

### Requirement: Both runtime transcript parsers carry per-turn timestamps and session duration
The per-turn timestamp and session-duration enrichment SHALL apply to BOTH
runtime transcript parsers behind the shared session-history contract — the codex
rollout parser AND the Claude Code session-JSONL parser — so the transcript
timeline is not degraded for Claude-runtime tasks. The Claude parser SHALL carry
each user/assistant turn's `at` from its session-JSONL line timestamp (omitted
when the line has none) and SHALL set `meta.durationMs` from the first-to-last
line timestamp (omitted when unresolvable). `meta.totalTokens` MAY be omitted for
the Claude runtime when the session JSONL carries no clean per-turn token delta;
omission is an honest degradation, never a fabricated total.

#### Scenario: Claude-runtime turns carry their line timestamp
- **WHEN** the Claude session-JSONL parser emits a user or assistant turn from a line that has a `timestamp`
- **THEN** the turn's `at` equals that line's timestamp, and a line with no timestamp yields a turn with `at` omitted

#### Scenario: Claude-runtime session carries a duration
- **WHEN** the Claude session JSONL has resolvable first and last line timestamps
- **THEN** `meta.durationMs` is the span between them, and it is omitted when the timestamps are unresolvable

#### Scenario: Claude-runtime token total is omitted, not fabricated
- **WHEN** the Claude session JSONL carries no clean per-turn token delta
- **THEN** `meta.totalTokens` is omitted rather than reported as a fabricated or double-counted total

### Requirement: System milestone turns are merged from the audit timeline
The session-history response SHALL include `system` milestone turns derived from
the task's `AuditEvent` rows (e.g. `task.created`, `task.running`,
`task.completed`, `task.failed`, `task.cancelled`, `agent_failed_to_start`,
`force_failed`), fetched by `taskId` ordered by `timestamp`, and MERGED into the
turn stream in timestamp order with the rollout-derived turns. System turns SHALL
be produced OUTSIDE the pure rollout parser (in the controller/service layer that
holds task/audit access), keeping the parser rollout-only. A system turn SHALL
carry only fields present in the audit source (title/detail/timestamp/level); it
SHALL NOT fabricate values (e.g. a sandbox node id) the audit row does not carry.

#### Scenario: Audit events become ordered system turns
- **WHEN** the session-history response is assembled for a task with audit rows
- **THEN** each audit row maps to a `system` turn carrying its title/detail/timestamp/level
- **AND** the system turns are merged with the rollout turns in timestamp order

#### Scenario: The rollout parser stays rollout-only
- **WHEN** the pure rollout parser runs on rollout JSONL
- **THEN** it emits no `system` turns (system turns are added by the controller/service merge layer)

#### Scenario: Absent audit fields are not fabricated
- **WHEN** an audit row carries no node id (or other optional detail)
- **THEN** the resulting system turn omits that detail rather than inventing one

### Requirement: Tool turns carry an apply-patch diffstat
A tool turn for an `apply_patch` call SHALL carry a diffstat — the count of added
and removed lines — derived from the patch text already captured in the tool
turn's arguments. The diffstat SHALL be OPTIONAL: a non-patch tool turn SHALL
carry no diffstat, and an `apply_patch` whose patch body cannot be parsed SHALL
carry no diffstat rather than a fabricated or wrong count.

#### Scenario: apply_patch turn carries an accurate diffstat
- **WHEN** the parser emits a tool turn for an `apply_patch` whose patch text adds N and removes M lines
- **THEN** the tool turn's diffstat reports add N and del M

#### Scenario: Non-patch tools carry no diffstat
- **WHEN** the parser emits a tool turn for a non-`apply_patch` tool (e.g. a shell exec)
- **THEN** the tool turn carries no diffstat

#### Scenario: Unparseable patch yields no diffstat
- **WHEN** an `apply_patch` turn's patch body cannot be parsed into hunks
- **THEN** the tool turn omits the diffstat rather than reporting a fabricated count

### Requirement: Session-history meta carries session totals
The session-history meta SHALL carry session-level totals computed from the
rollout: a total token count (the sum of the rollout per-turn token deltas) and a
session duration (last rollout timestamp minus the start timestamp). Both fields
SHALL be OPTIONAL and SHALL be omitted when the rollout carries no token data or
no resolvable start/end timestamps, rather than reporting zero or a fabricated
value.

#### Scenario: Totals are computed from the rollout
- **WHEN** the rollout carries per-turn token counts and resolvable start/end timestamps
- **THEN** the meta reports the summed total tokens and the computed duration

#### Scenario: Missing totals are omitted, not zeroed
- **WHEN** the rollout carries no token data (or no resolvable timestamps)
- **THEN** the corresponding meta total is omitted rather than reported as zero

### Requirement: New transcript fields are additive and backward-compatible
The system SHALL keep all transcript-contract additions — per-turn timestamp,
the `system` turn kind, tool diffstat, and session totals — additive and
optional, so that durable transcript archives parsed under the prior schema
deserialize WITHOUT error and the existing `/tasks/$taskId` `SessionReplay`
renderer continues to work unchanged. The change SHALL NOT require any re-parse
or migration of historical durable archives.

#### Scenario: Old durable archive reads back without error
- **WHEN** a `SessionHistory` is resolved from a durable archive parsed before this change
- **THEN** the response validates against the contract with the new fields simply absent, and no error is raised

#### Scenario: The existing session-page replay is unaffected
- **WHEN** the `/tasks/$taskId` session page renders `SessionReplay` against the enriched contract
- **THEN** it continues to render correctly, ignoring fields it does not consume
