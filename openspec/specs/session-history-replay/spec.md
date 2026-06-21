# session-history-replay Specification

## Purpose
TBD - created by archiving change session-sandbox-retention. Update Purpose after archive.
## Requirements
### Requirement: Read-only session-history endpoint reads the frozen rollout from the stopped container
The system SHALL expose a read-only `GET /tasks/:id/session-history` endpoint, following the existing `GET /tasks/:taskId/metrics` controller convention (covered by the global `APP_GUARD` authentication, returning a discriminated response). The endpoint SHALL resolve the rollout DURABLE-FIRST: it SHALL read the persisted transcript archive (the index record plus the gzip-compressed raw `rollout-*.jsonl` on the durable workspace volume) FIRST and, on a hit, decompress and parse it WITHOUT touching the container. ONLY when no durable archive exists SHALL the endpoint FALL BACK to reading the codex `rollout-*.jsonl` out of the task's STOPPED `cap-aio-<taskId>` container via the dockerode `getContainer(id).getArchive()` (docker-cp) API, which reads the frozen container layer directly without restarting the container and is reliable BECAUSE the container was retained with `AutoRemove: false`. On a successful container fallback the endpoint SHALL read-through BACKFILL the durable archive and index so the next read is a durable hit. The endpoint SHALL be a SEPARATE REST surface that NEVER touches the live WebSocket / PTY / write-lease pipeline. The endpoint SHALL glob `rollout-*.jsonl` (the per-session conversation record), NOT `history.jsonl` (the global user-input log). The endpoint SHALL NOT export `/home/gem/.codex/auth.json` or any credential file.

#### Scenario: Endpoint reads the durable archive first
- **WHEN** an authenticated operator requests `GET /tasks/:id/session-history` for a task that has a persisted transcript archive
- **THEN** the endpoint reads, decompresses, and parses the durable archive and returns the transcript WITHOUT reading from or depending on the container

#### Scenario: Endpoint falls back to the container and backfills
- **WHEN** the endpoint is requested for a task that has NO durable archive yet but whose `cap-aio-<id>` container is stopped-and-retained with a rollout
- **THEN** the endpoint reads `rollout-*.jsonl` out of the stopped container via dockerode `getArchive` (docker-cp) without restarting the container
- **AND** it read-through backfills the durable archive and index so a subsequent request resolves as a durable hit
- **AND** it parses the per-session `rollout-*.jsonl` record, not `history.jsonl`

#### Scenario: Endpoint requires authentication
- **WHEN** an unauthenticated request hits `GET /tasks/:id/session-history`
- **THEN** the global `APP_GUARD` rejects it, identically to the existing `GET /tasks/:taskId/metrics` endpoint

#### Scenario: Endpoint never exports credentials
- **WHEN** the endpoint reads the durable archive or files out of the stopped container
- **THEN** it does not include `/home/gem/.codex/auth.json` or any credential file in its response

#### Scenario: Endpoint stays off the live terminal pipeline
- **WHEN** the session-history read executes
- **THEN** it operates as a standalone REST read and does not open, mutate, or depend on the task's live WebSocket / PTY / write-lease path

### Requirement: RolloutItems parse into a phase-keyed structured render contract
The endpoint SHALL parse the rollout JSONL lines (each `{timestamp, type, payload}`) into a structured render contract consumed by the console. Assistant `output_text` blocks SHALL be categorized as FINAL-ANSWER versus COMMENTARY by the explicit `phase` field on the assistant message — a block with `phase == 'final_answer'` is the final answer; all other assistant `output_text` blocks are commentary — and the categorization SHALL NOT be inferred from message ordering or a "last assistant message" heuristic. A `response_item` `function_call` SHALL map to a tool-call item (carrying name/arguments/`call_id`) and its `function_call_output` SHALL map to a tool-output item LINKED to the call by matching `call_id`. A user prompt SHALL have any developer/instruction wrapper SPLIT OFF before display, so only the operator's own prompt text is shown in the user bubble. An inline token count SHALL be surfaced on tool-call items from the rollout token data.

#### Scenario: Final answer is keyed off the phase field, not ordering
- **WHEN** the parser encounters an assistant `output_text` block whose `phase == 'final_answer'`
- **THEN** it categorizes that block as the final answer (the green-tinted "最终回答")
- **AND** an assistant `output_text` block with any other `phase` is categorized as commentary, regardless of its position in the message sequence

#### Scenario: tool_call and tool_output link by call_id
- **WHEN** the parser reads a `function_call` and a later `function_call_output` sharing the same `call_id`
- **THEN** it emits a tool-call item carrying the call's name/arguments and a tool-output item linked to that tool-call by the matching `call_id`

#### Scenario: User prompt wrapper is stripped before display
- **WHEN** a user prompt payload carries a developer/instruction wrapper around the operator's text
- **THEN** the parser splits off the wrapper and the render contract exposes only the operator's own prompt text for the user bubble

#### Scenario: Tool-call items carry an inline token count
- **WHEN** the parser emits a tool-call item and the rollout carries a token count for that step
- **THEN** the item includes the inline token count for rendering on the tool-call card

### Requirement: Session-history response is a discriminated honest 5-state contract
The endpoint SHALL return a DISCRIMINATED response mapping each terminal task status to one of five honest states, and a not-running / expired / no-rollout condition SHALL be an explicit STATE, never an error. The states are: (1) `completed` task → the parsed rollout transcript; (2) `cancelled` task → the parsed rollout transcript plus an interrupted-terminal indication; (3) `failed` task → the parsed rollout transcript up to the failure point; (4) `agent_failed_to_start` (and `provision_failed`, which lands the task in `failed`) → an EMPTY state carrying the failure reason and no fabricated transcript; (5) expired/reaped → an EMPTY state indicating the record has aged out, returned ONLY when NEITHER a durable transcript archive NOR the container holds the rollout (going forward this is limited to sessions that were reaped BEFORE transcript persistence existed, since new terminal tasks are archived durably). The endpoint SHALL NEVER fabricate transcript content for an empty state. A schema for this discriminated response (`SessionHistoryResponse`) SHALL be added to `@cap/contracts` and used to validate the response on the client with a Zod `.parse`.

#### Scenario: Completed task returns the rollout transcript
- **WHEN** the endpoint is requested for a `completed` task whose rollout is present (durable archive or container)
- **THEN** the response discriminates to the rollout-transcript state carrying the parsed conversation items

#### Scenario: Cancelled task returns rollout plus interrupted indication
- **WHEN** the endpoint is requested for a `cancelled` task
- **THEN** the response carries the parsed rollout transcript AND an interrupted-terminal indication so the terminal-replay source can be shown as a mid-run interrupted frame

#### Scenario: Failed task returns the rollout up to the failure
- **WHEN** the endpoint is requested for a `failed` task that produced a rollout before failing
- **THEN** the response carries the parsed rollout transcript up to the failure point

#### Scenario: No-rollout failure returns an empty state with the reason
- **WHEN** the endpoint is requested for an `agent_failed_to_start` task, or a `failed` task whose cause was `provision_failed` and codex never produced a rollout
- **THEN** the response discriminates to an empty state carrying the failure reason and no fabricated transcript

#### Scenario: Expired/reaped record returns an empty aged-out state only when both sources are gone
- **WHEN** the endpoint is requested for a task that has NO durable transcript archive AND whose retained container has already been removed by the retention cleaner (no rollout can be read from either source)
- **THEN** the response discriminates to an empty state indicating the session record has aged out, not an error

#### Scenario: Not-running is a state, never an error
- **WHEN** the endpoint cannot read a rollout for any honest reason (no archive, no container, no rollout)
- **THEN** it returns a discriminated empty/degraded state rather than throwing an error response

#### Scenario: Response is schema-validated on the client
- **WHEN** the console receives the session-history response
- **THEN** it validates the payload against the `@cap/contracts` `SessionHistoryResponse` schema via Zod `.parse` before rendering

### Requirement: Console renders the read-only structured transcript on the terminal-state branch
On the terminal-state branch of the `/tasks/$taskId` session page, the console SHALL render the session-history replay as a READ-ONLY structured transcript, with the parsed rollout as the source. The replay region SHALL offer two tabs — 对话记录 (conversation, the in-scope source) and 终端回放 (terminal) — and a review sidebar carrying a search input and the FIVE sticky filter presets 默认 / 无工具 / 用户 / 答案 / 全部. The 终端回放 tab SHALL be present as a placeholder; the `session.log` cold-replay secondary source is a DEFERRED follow-up, explicitly out of scope for this change (the operator deferred the session-log work to focus this change on the conversation replay — see design.md "Deferred scope"). The conversation rendering SHALL visually distinguish the three item kinds: a final-answer assistant turn SHALL render green-tinted with a "最终回答" label; a commentary assistant turn SHALL render muted italic, distinct from the final answer; a tool-call SHALL render as a bordered card showing the tool badge, the command summary, and the inline token count. The replay region SHALL present NO operation controls (no resume-run, no stop) because terminal tasks are already non-operable (`canStop` is false). A new `queryKeys.sessionHistory(id)` + `sessionHistoryQuery`, a `real.getSessionHistory` reading via the contract schema, a mock fallback, and a capability flag SHALL plumb the real/mock data seam, mirroring the existing metrics seam.

#### Scenario: Terminal-state session page renders the structured replay
- **WHEN** the operator opens `/tasks/$taskId` for a task in a terminal state (`completed`, `cancelled`, or `failed`) whose rollout is available
- **THEN** the page renders the read-only structured conversation transcript as the source, with a 终端回放 tab PRESENT as a placeholder (the `session.log` cold-replay secondary source is a deferred follow-up, out of scope for this change)

#### Scenario: Five filter presets are present on the review sidebar
- **WHEN** the replay region renders for a task with a rollout
- **THEN** the review sidebar shows a search input and exactly the five filter presets 默认 / 无工具 / 用户 / 答案 / 全部
- **AND** selecting 无工具 hides tool-call turns, 用户 shows only user turns, and 答案 shows user prompts plus final answers

#### Scenario: Final answer, commentary, and tool-call render distinctly
- **WHEN** the conversation transcript renders a final-answer assistant turn, a commentary assistant turn, and a tool-call
- **THEN** the final-answer turn is green-tinted with a "最终回答" label, the commentary turn is muted italic and visually distinct from the final answer, and the tool-call is a bordered card showing the tool badge, command summary, and inline token count

#### Scenario: No operation controls on the terminal-state replay
- **WHEN** the read-only replay renders for a terminal task
- **THEN** it exposes no resume-run control and no stop control, because the task is already non-operable (`canStop` is false)

#### Scenario: Empty/aged-out states render an honest empty card, not the transcript
- **WHEN** the session-history response discriminates to an empty state (agent-failed-to-start, provision-failed with no rollout, or expired/reaped)
- **THEN** the page renders an honest empty card (e.g. "会话未能启动" with the failure reason, or "会话记录已过期" for an aged-out record) rather than a fabricated transcript

#### Scenario: Real/mock data seam is plumbed for session history
- **WHEN** the session page requests session history
- **THEN** it uses `queryKeys.sessionHistory(id)` + `sessionHistoryQuery`, with `real.getSessionHistory` validating via the contract schema and a mock fallback selected by the capability flag, mirroring the existing per-task metrics seam

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

