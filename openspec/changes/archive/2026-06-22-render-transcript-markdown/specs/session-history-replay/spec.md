## MODIFIED Requirements

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
