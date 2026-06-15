## ADDED Requirements

### Requirement: Read-only session-history endpoint reads the frozen rollout from the stopped container
The system SHALL expose a NEW read-only `GET /tasks/:id/session-history` endpoint, following the existing `GET /tasks/:taskId/metrics` controller convention (covered by the global `APP_GUARD` authentication, returning a discriminated response). The endpoint SHALL read the codex `rollout-*.jsonl` out of the task's STOPPED `cap-aio-<taskId>` container via the dockerode `getContainer(id).getArchive()` (docker-cp) API, which reads the frozen container layer directly without restarting the container and is reliable BECAUSE the container was retained with `AutoRemove: false`. The endpoint SHALL be a SEPARATE REST surface that NEVER touches the live WebSocket / PTY / write-lease pipeline. The endpoint SHALL glob `rollout-*.jsonl` (the per-session conversation record), NOT `history.jsonl` (the global user-input log). The endpoint SHALL NOT export `/home/gem/.codex/auth.json` or any credential file.

#### Scenario: Endpoint reads the rollout from a stopped container via getArchive
- **WHEN** an authenticated operator requests `GET /tasks/:id/session-history` for a task whose `cap-aio-<id>` container is stopped-and-retained
- **THEN** the endpoint reads `rollout-*.jsonl` out of the stopped container via dockerode `getArchive` (docker-cp) without restarting the container
- **AND** it parses the per-session `rollout-*.jsonl` record, not `history.jsonl`

#### Scenario: Endpoint requires authentication
- **WHEN** an unauthenticated request hits `GET /tasks/:id/session-history`
- **THEN** the global `APP_GUARD` rejects it, identically to the existing `GET /tasks/:taskId/metrics` endpoint

#### Scenario: Endpoint never exports credentials
- **WHEN** the endpoint reads files out of the stopped container
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
The endpoint SHALL return a DISCRIMINATED response mapping each terminal task status to one of five honest states, and a not-running / expired / no-rollout condition SHALL be an explicit STATE, never an error. The states are: (1) `completed` task → the parsed rollout transcript; (2) `cancelled` task → the parsed rollout transcript plus an interrupted-terminal indication; (3) `failed` task → the parsed rollout transcript up to the failure point; (4) `agent_failed_to_start` (and `provision_failed`, which lands the task in `failed`) → an EMPTY state carrying the failure reason and no fabricated transcript; (5) expired/reaped (the retained container has been removed by the cleaner, so no rollout can be read) → an EMPTY state indicating the record has aged out. The endpoint SHALL NEVER fabricate transcript content for an empty state. A schema for this discriminated response (`SessionHistoryResponse`) SHALL be added to `@cap/contracts` and used to validate the response on the client with a Zod `.parse`.

#### Scenario: Completed task returns the rollout transcript
- **WHEN** the endpoint is requested for a `completed` task whose rollout is present
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

#### Scenario: Expired/reaped record returns an empty aged-out state
- **WHEN** the endpoint is requested for a task whose retained container has already been removed by the retention cleaner (no rollout can be read)
- **THEN** the response discriminates to an empty state indicating the session record has aged out past the retention window, not an error

#### Scenario: Not-running is a state, never an error
- **WHEN** the endpoint cannot read a rollout for any honest reason (no container, no rollout, expired)
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
