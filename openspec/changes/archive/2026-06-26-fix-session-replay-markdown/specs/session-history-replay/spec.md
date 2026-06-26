## MODIFIED Requirements

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
