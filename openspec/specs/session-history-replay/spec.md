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

The terminal-state replay SHALL render the turn TEXT of the three text-bearing conversation turn kinds — user/operator text, assistant commentary (`isFinalAnswer:false`), and assistant final answer (`isFinalAnswer:true`) — as GitHub-Flavored Markdown (GFM) via the existing untrusted transcript Markdown renderer, so that bold, lists, task lists, strikethrough, tables, inline code, links, and fenced code blocks render as formatted output rather than raw markup. The commentary render SHALL preserve its muted/italic wrapper and the final-answer render SHALL remain inside its green `.bg-success-soft` bubble with the "最终回答" label. Tool-call arguments, tool-call output, token badges, and system/milestone text SHALL render verbatim and SHALL NOT be passed through the Markdown renderer.

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

#### Scenario: Text-bearing replay turns render Markdown
- **WHEN** the terminal-state replay renders user/operator text, assistant commentary, or a final-answer turn whose text contains `**bold**`, a `-`/`*` bullet list, a GFM table, `[link](https://example.com)`, `` `inline code` ``, and a fenced code block
- **THEN** those Markdown constructs render as formatted output inside the existing turn wrapper instead of appearing as raw Markdown syntax
- **AND** the final-answer Markdown output remains inside the green `.bg-success-soft` bubble with the "最终回答" label
- **AND** the assistant commentary Markdown output remains inside the muted/italic commentary treatment

#### Scenario: Tool and system replay text remains verbatim
- **WHEN** the terminal-state replay renders a tool-call turn, tool output, token badge, or system/milestone text containing Markdown-significant characters such as `*`, `|`, `[link](url)`, or backticks
- **THEN** those strings render verbatim with no Markdown-generated `<strong>`, `<a>`, `<ul>`, `<table>`, or fenced-code formatting introduced by the text renderer

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

The route SHALL render the turn TEXT of the three text-bearing turn kinds — user
text, reasoning (assistant commentary, `isFinalAnswer:false`), and final answer
(assistant `isFinalAnswer:true`) — as GitHub-Flavored Markdown (GFM) via
`react-markdown` + `remark-gfm`, so that bold, lists, task lists, strikethrough,
tables, inline code, and fenced code blocks render as formatted output rather than
raw markup. The reasoning render SHALL preserve its muted/italic wrapper and the
final-answer render SHALL remain inside its `.bg-success-soft` bubble. Tool-call
turn args (`<code>`), tool-call turn output (`<pre>`), and system milestone turns
SHALL render verbatim, byte-for-byte unchanged, and SHALL NOT be passed through the
markdown renderer.

Because turn text is UNTRUSTED agent output, the markdown render SHALL use only
react-markdown's safe-by-default posture and SHALL NOT enable any dangerous
configuration. Specifically it SHALL NOT use `rehype-raw` (so embedded raw HTML
such as `<script>` is emitted as inert escaped text, never live DOM); SHALL retain
react-markdown's default `urlTransform` without override (so `javascript:`,
`data:`, and `vbscript:` link/image URLs are stripped); SHALL block remote images
by disallowing the `img` element (so an agent `![](http://evil)` loads no remote
or tracking resource); and SHALL NOT emit heading slug/anchor ids. Line-break
preservation SHALL be scoped to paragraph-level breaks produced by GFM from blank
lines; intra-paragraph single newlines MAY collapse to spaces per CommonMark/GFM,
and neither `remark-breaks` nor a `white-space:pre-wrap` rule is required. GFM
tables SHALL render inside a horizontally scrollable (`overflow-x:auto`) container
so they do not break the narrow timeline layout. No new runtime dependency SHALL be
added: the render SHALL use the already-installed `react-markdown` and `remark-gfm`
only, and SHALL NOT add `rehype-raw`, `rehype-sanitize`, `remark-breaks`, or
Streamdown.

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

#### Scenario: Bold, list, and inline code in turn text render as formatted markdown
- **WHEN** the transcript renders a user, reasoning, or final-answer turn whose text contains `**bold**`, a `-`/`*` bullet list, and `` `inline code` ``
- **THEN** the rendered output for that turn contains a `<strong>` element, a `<ul>` with at least one `<li>`, and an inline `<code>` element
- **AND** the literal characters `**` and the surrounding backticks do NOT appear as visible text in the rendered turn

#### Scenario: Fenced code block renders as a pre/code block
- **WHEN** a text-bearing turn contains a triple-backtick fenced code block
- **THEN** the rendered output for that turn contains a `<pre>` element wrapping a `<code>` element carrying the fenced contents

#### Scenario: GFM table renders inside a horizontally scrollable container
- **WHEN** a text-bearing turn contains a GFM pipe table (a header row, a `---` separator row, and at least one data row)
- **THEN** the rendered output contains a `<table>` element with `<th>` and `<td>` cells
- **AND** the `<table>` is wrapped in a container whose computed `overflow-x` is `auto`

#### Scenario: Reasoning and final-answer wrappers are preserved while text renders as markdown
- **WHEN** a reasoning turn (`isFinalAnswer:false`) and a final-answer turn (`isFinalAnswer:true`) each render markdown text
- **THEN** the reasoning turn's markdown output remains inside its muted/italic wrapper and the final-answer turn's markdown output remains inside the `.bg-success-soft` bubble

#### Scenario: Tool args, tool output, and system turns are not markdown-rendered
- **WHEN** the transcript renders a tool-call turn (args + output) and a system milestone turn whose text contains markdown-significant characters such as `*`, `|`, or backticks
- **THEN** the tool args `<code>`, tool output `<pre>`, and system turn text render those characters verbatim, byte-for-byte unchanged, with no `<strong>`/`<ul>`/`<table>` introduced by a markdown renderer

#### Scenario: Embedded raw HTML is escaped, never executed
- **WHEN** a text-bearing turn contains the literal string `<script>alert(1)</script>`
- **THEN** the rendered output contains no live `<script>` element and the sequence appears only as inert escaped text

#### Scenario: Remote image markdown loads no image element
- **WHEN** a text-bearing turn contains `![x](http://evil.example/track.png)`
- **THEN** the rendered output for that turn contains no `<img>` element

#### Scenario: javascript: link URL is filtered
- **WHEN** a text-bearing turn contains `[click](javascript:alert(1))`
- **THEN** the rendered link's `href` is NOT `javascript:alert(1)` (the unsafe scheme is stripped by the default urlTransform)

#### Scenario: No heading anchor ids are emitted
- **WHEN** a text-bearing turn contains a markdown heading (e.g. `## Result`)
- **THEN** the rendered heading element carries no `id` attribute

#### Scenario: No new runtime dependency is introduced
- **WHEN** the markdown render is implemented and the workspace lockfile is inspected
- **THEN** the only markdown packages relied on are the already-installed `react-markdown` and `remark-gfm`, and none of `rehype-raw`, `rehype-sanitize`, `remark-breaks`, or `streamdown` is added as a dependency

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

### Requirement: Codex tool turns carry a human-readable command extracted per tool name
The codex rollout parser SHALL dispatch on the tool name BEFORE extracting the tool turn's `args`,
emitting a human-readable command rather than the raw arguments JSON string. The extraction SHALL be:
`apply_patch` keeps its raw `input` patch text verbatim; `exec_command` uses `arguments.cmd` (a
shell string); `shell`, `local_shell`, and `container.exec` use `arguments.command` (an argv array,
joined with single spaces). The extractor SHALL DROP `workdir` and `timeout_ms` from the
human-readable command. The extractor SHALL guard the input shape: when the expected field is
absent or of the wrong type, it SHALL fall back to the raw arguments string rather than throw or
emit an empty command. This REPLACES the prior behavior of storing the raw arguments JSON string as
`args` for `exec_command`/`shell`/`local_shell`/`container.exec` (the existing golden assertion for
that raw value SHALL be updated to the extracted command).

#### Scenario: exec_command extracts the cmd string
- **WHEN** the parser reads a codex `exec_command` call with `arguments` `{"cmd":"ls src"}`
- **THEN** the tool turn's `args` is `ls src`, not the JSON string `{"cmd":"ls src"}`

#### Scenario: shell-family extracts and joins the command array
- **WHEN** the parser reads a `shell` / `local_shell` / `container.exec` call with `arguments.command` `["bash","-lc","echo hi"]`
- **THEN** the tool turn's `args` is the array joined with single spaces (`bash -lc echo hi`)

#### Scenario: workdir and timeout_ms are dropped from the command
- **WHEN** the parser reads a `shell`-family call whose `arguments` also carry `workdir` and `timeout_ms`
- **THEN** the emitted `args` contains neither the `workdir` value nor the `timeout_ms` value — only the command

#### Scenario: apply_patch keeps its raw patch text
- **WHEN** the parser reads an `apply_patch` call whose patch body is in `input`
- **THEN** the tool turn's `args` is the raw `*** Begin Patch …` patch text, unchanged from the prior behavior

#### Scenario: Malformed tool arguments fall back to the raw string
- **WHEN** the parser reads a tool call whose expected field (`cmd`/`command`) is absent or of the wrong type
- **THEN** the emitted `args` is the raw arguments string and the parser does not throw or emit an empty command

### Requirement: Codex exec output is conservatively stripped of the documented wrapper grammar
The codex rollout parser SHALL strip the documented `exec` output wrapper from a tool turn's
`output` so the operator sees the command output, not the harness wrapper. The wrapper grammar SHALL
be recognized conservatively: a leading `Exit code:` / `Wall time:` / `Total output lines:` prefix,
the `Output:\n` cut point, and a `(N lines omitted)` middle marker. The parser SHALL keep the
content AFTER the `Output:\n` cut point as the displayed output. When the output does NOT match the
wrapper grammar (cross-version drift, or a non-wrapped output), the parser SHALL pass the output
through UNCHANGED rather than mangle it. Stripping SHALL never produce an empty output when the
wrapper carried body content.

#### Scenario: A wrapped exec output is reduced to its body
- **WHEN** the parser reads a tool output of the form `Exit code: 0\nWall time: 1.23 seconds\nTotal output lines: 2\nOutput:\napp.tsx\nlogin.tsx`
- **THEN** the tool turn's `output` is `app.tsx\nlogin.tsx` (the content after `Output:\n`), with the Exit code / Wall time / Total output lines prefix removed

#### Scenario: A non-wrapped output passes through unchanged
- **WHEN** the parser reads a tool output that does not contain the `Output:\n` cut point or the wrapper prefix
- **THEN** the tool turn's `output` is byte-identical to the input (conservative passthrough on format mismatch)

#### Scenario: Stripping never empties a body-carrying output
- **WHEN** the wrapper carries body content after `Output:\n`
- **THEN** the stripped `output` is non-empty and equals that body content

### Requirement: Codex adjacent duplicate user turns are deduplicated
The codex rollout parser SHALL deduplicate ADJACENT identical user turns, because codex writes the
same prompt into both the `event_msg` stream and the `response_item` stream. When two consecutive
user turns carry identical text, the parser SHALL emit ONE user turn, not two. Non-adjacent user
turns with identical text (a genuine repeated prompt later in the session) SHALL NOT be collapsed —
only the immediately-adjacent duplicate is removed.

#### Scenario: Two adjacent identical user turns collapse to one
- **WHEN** the parser would emit two consecutive user turns with identical text
- **THEN** it emits a single user turn for that text

#### Scenario: Non-adjacent identical user turns are preserved
- **WHEN** two user turns carry identical text but are separated by at least one other turn
- **THEN** both user turns are emitted (only the adjacent duplicate is removed)

### Requirement: Codex environment_context user wrappers are filtered from operator text
The codex rollout parser SHALL filter the injected `<environment_context>` / `<system-reminder>`
wrapper so it is NOT rendered as operator prompt text. A user payload that is ENTIRELY an
`<environment_context>` (or `<system-reminder>`) block SHALL NOT produce a user turn. A user payload
that wraps the operator's own text in such a block SHALL be DEGRADED so only the operator's text
remains in the user turn. This filtering SHALL apply on the `event_msg` user path (in addition to
the existing `stripPromptWrapper` fallback path), since `stripPromptWrapper`'s tag regex does not
match `<environment_context>`.

#### Scenario: A pure environment_context user message produces no user turn
- **WHEN** the parser reads a user payload whose entire content is an `<environment_context><cwd>…</environment_context>` block
- **THEN** no user turn is emitted for that payload

#### Scenario: An operator message wrapped in environment_context keeps only the operator text
- **WHEN** the parser reads a user payload that wraps the operator's own prompt inside an `<environment_context>` / `<system-reminder>` block
- **THEN** the emitted user turn's text is only the operator's prompt, with the wrapper removed

#### Scenario: Filtering runs on the event_msg user path
- **WHEN** an `<environment_context>` block arrives via the `event_msg` user stream (not the response_item fallback)
- **THEN** it is filtered there, not left to the `stripPromptWrapper` fallback which does not match the tag

### Requirement: The Claude parser emits tool_use turns with a per-tool command field
The Claude sandbox render parser SHALL emit a `tool` turn for each `tool_use` content block,
extracting a human-readable command via a per-tool field map: `Bash` → `input.command`, `Grep` →
`input.pattern`, `Read` / `Edit` / `Write` → `input.file_path`. The extractor SHALL guard the input
shape with a string-vs-object check: when `input` is a JSON string (pre-v2.1.92 transcripts) it
SHALL be parsed to an object before field extraction, and when the named field is absent it SHALL
fall back to a stable serialization of the input rather than throw. The emitted tool turn SHALL
carry the tool `name` and the extracted command as `args`. This is net-new: the prior parser emitted
only user and assistant text turns and dropped `tool_use` blocks entirely.

#### Scenario: A Bash tool_use becomes a tool turn with the command
- **WHEN** the parser reads a `tool_use` block with `name: "Bash"` and `input.command: "npm test"`
- **THEN** it emits a `tool` turn with `name` `Bash` and `args` `npm test`

#### Scenario: Read/Edit/Write extract the file_path
- **WHEN** the parser reads a `tool_use` block for `Read`, `Edit`, or `Write` with `input.file_path: "src/index.ts"`
- **THEN** the emitted tool turn's `args` is `src/index.ts`

#### Scenario: A JSON-string input is parsed before extraction
- **WHEN** the parser reads a `tool_use` block whose `input` is a JSON string (pre-v2.1.92 shape) rather than an object
- **THEN** it parses the string to an object before pulling the per-tool field, and does not throw

#### Scenario: An unmapped tool falls back to a stable serialization
- **WHEN** the parser reads a `tool_use` block whose tool name has no field-map entry or whose named field is absent
- **THEN** it emits a tool turn whose `args` is a stable serialization of `input` rather than throwing or emitting empty `args`

### Requirement: The Claude parser pairs tool_result to tool_use by tool_use_id with frozen-sandbox degradation
The Claude sandbox render parser SHALL pair each `tool_result` block to its originating `tool_use`
by matching `tool_use_id`, attaching the result as the tool turn's `output`. Because `tool_result`
blocks live in a SUBSEQUENT `type: user` entry, the parser SHALL buffer the `tool_use` by id and
attach the later result. A `tool_use` whose `tool_result` never arrives SHALL still yield a tool
turn with `output: null` (never dropped). When a result references an externalized/missing result
file that cannot be read out of the FROZEN sandbox container, the parser SHALL degrade the output to
a `[output unavailable]` marker rather than abort the parse. This is net-new: the prior parser
explicitly SKIPPED `tool_result`-only user records.

#### Scenario: A tool_result attaches to its tool_use by id
- **WHEN** the parser reads a `tool_use` with id `X` and a later `type: user` entry carrying a `tool_result` with `tool_use_id: X`
- **THEN** the tool turn for that `tool_use` carries the result content as its `output`

#### Scenario: An unmatched tool_use yields a null-output turn
- **WHEN** a `tool_use` with id `X` has no `tool_result` with `tool_use_id: X` anywhere in the transcript
- **THEN** the tool turn is emitted with `output: null` rather than being dropped

#### Scenario: An externalized/missing result degrades, never aborts
- **WHEN** a `tool_result` references content externalized to a disk file that is unreadable from the frozen container
- **THEN** the tool turn's `output` is the marker `[output unavailable]` and the parse continues to completion

#### Scenario: tool_result-only user entries no longer produce spurious user turns
- **WHEN** a `type: user` entry contains ONLY `tool_result` blocks (no operator text)
- **THEN** the parser consumes it for pairing and emits no user turn for it

### Requirement: Codex reasoning and Claude thinking map to the existing assistant commentary channel
The parsers SHALL map agent reasoning to the EXISTING `assistant` turn with `isFinalAnswer: false`
(the channel the frontend already renders as 「推理」), with ZERO change to `@cap/contracts` — no new
`reasoning` turn kind is introduced. The codex reasoning event and the Claude `thinking` content
block SHALL each produce an `assistant` turn whose `isFinalAnswer` is `false` and whose `text` is the
reasoning content. A final-answer assistant turn SHALL remain `isFinalAnswer: true` and SHALL NOT be
confused with reasoning.

#### Scenario: Claude thinking becomes an assistant commentary turn
- **WHEN** the Claude parser reads a `thinking` content block
- **THEN** it emits an `assistant` turn with `isFinalAnswer: false` carrying the thinking text, and adds no new turn kind to the contract

#### Scenario: Codex reasoning becomes an assistant commentary turn
- **WHEN** the codex parser reads a reasoning event
- **THEN** it emits an `assistant` turn with `isFinalAnswer: false` carrying the reasoning text

#### Scenario: A final answer stays distinct from reasoning
- **WHEN** the same transcript carries both a reasoning turn and a final-answer turn
- **THEN** the reasoning turn is `isFinalAnswer: false` and the final-answer turn is `isFinalAnswer: true`, and they render as 「推理」 vs 「最终回答」 with no contract change

### Requirement: The fixed parsers preserve prior wire-transcript behaviors and re-run over raw archives without migration
The Part 2 parser fixes SHALL NOT regress the prior wire-transcript-real-data behaviors: per-turn
`at` timestamps, `apply_patch` diffstat, session totals (`totalTokens` / `durationMs`), the
phase-keyed final-answer categorization, and the system-turn merge staying OUTSIDE the parser (in
the controller/service). Because durable archives store RAW JSONL keyed by runtime format, the
improved parsers SHALL re-run cleanly over historical archives on re-read with NO migration and NO
re-parse step; a shift in FTS `content` text caused by the new arg extraction is acceptable and
additive. The Claude parser's new tool/thinking turns SHALL carry `at` from their source line when
present (omitted, never fabricated, when absent), consistent with the existing per-turn-timestamp
requirement.

#### Scenario: A historical raw archive re-parses with the fixed parser, no migration
- **WHEN** a durable archive stored as RAW JSONL before this change is re-read and re-parsed by the fixed parser
- **THEN** it parses without error and produces the improved turns, with no migration or re-parse step performed on the archive

#### Scenario: The system-turn merge stays outside the parser
- **WHEN** the fixed rollout/claude parser runs on its source
- **THEN** it emits no `system` turns (those are still merged by the controller/service layer from audit rows)

#### Scenario: New Claude tool/thinking turns carry their source timestamp when present
- **WHEN** the Claude parser emits a tool or thinking turn from a line that has a `timestamp`
- **THEN** the turn's `at` equals that line's timestamp, and a line with no timestamp yields a turn with `at` omitted (never fabricated)

#### Scenario: Prior codex behaviors are unchanged by the fixes
- **WHEN** the fixed codex parser runs on a rollout that also exercises diffstat, session totals, and phase-keyed final-answer categorization
- **THEN** the `apply_patch` diffstat, `totalTokens`/`durationMs` totals, and the final-answer-by-phase categorization are unchanged from the wire-transcript-real-data behavior

### Requirement: A running headless task serves a live, polled transcript

For a RUNNING headless task (`executionMode = headless-exec`), the session-history endpoint SHALL serve
the live transcript by reading the task's SANDBOX rollout (over `/v1/shell/exec`, as the finished
capture path does) and parsing it with the SAME `rollout-parser` used for a finished task — so the live
and finished views use one parser and one `session-replay` renderer. Each poll is a STATELESS full
re-parse (the whole rollout is read and parsed once; tool-call↔output pairing completes WITHIN that
single pass — no byte offset, no cross-poll state), so a `function_call` whose `function_call_output`
is not yet written yields a tool turn with no output on one poll, and the next poll's full re-parse —
now seeing the written output — yields ONE completed tool turn (never dropped, never duplicated). The
console SHALL POLL this
endpoint while the headless task runs (no WebSocket), render the accumulating turns via `session-replay`
with a running indicator, and switch to the durable finished transcript on terminal status. Interactive
(`interactive-pty`) tasks are unaffected.

#### Scenario: Running headless task returns a live transcript

- **WHEN** the console requests session-history for a RUNNING headless task
- **THEN** the backend reads the live sandbox rollout and returns the parsed transcript (populated, not the not-running empty state), using the same `rollout-parser` / `SessionTurn` contract as a finished task

#### Scenario: A tool call whose output lands on a later poll yields one paired turn

- **WHEN** one poll re-parses a `function_call` whose `function_call_output` is not yet written, and a later poll re-reads the now-complete rollout
- **THEN** the result is ONE completed tool turn (the later full re-parse pairs the call and its output within a single pass) — not dropped, not duplicated

#### Scenario: Console polls while running, switches on terminal

- **WHEN** a headless task is running
- **THEN** the console polls session-history on a modest cadence and renders the accumulating turns via `session-replay`; **WHEN** the task reaches a terminal status, polling stops and the durable finished transcript is loaded

#### Scenario: Interactive tasks keep the existing finished-only path

- **WHEN** an `interactive-pty` task is viewed
- **THEN** its live view remains the xterm/WS terminal and its session-history remains the finished-task path — unchanged by this requirement
