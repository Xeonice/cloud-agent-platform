## Context

The production task detail page for
`/tasks/1a1d1645-5578-40a8-9132-f7aee1384eaf` renders the final answer as raw
Markdown inside the terminal-state conversation replay. The final answer contains
common Markdown syntax such as `**项目结构**`, inline code, links, and bullet lists,
but the DOM shows a plain `<div>` containing the raw source text rather than
rendered `<strong>`, `<a>`, or list elements.

The dedicated transcript page for the same task,
`/tasks/1a1d1645-5578-40a8-9132-f7aee1384eaf/transcript`, already renders the same
turn text through `TranscriptMarkdown`, and Markdown is formatted there.

## Existing Code

- `apps/web/src/routes/_app/tasks/$taskId.tsx` routes terminal-state tasks to
  `SessionReplay`.
- `apps/web/src/components/session/session-replay.tsx` renders user, assistant
  commentary, and final-answer text directly as `{turn.text}`.
- `apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx` imports and uses
  `TranscriptMarkdown` for user, commentary, and final-answer rows.
- `apps/web/src/components/markdown/transcript-markdown.tsx` already provides the
  untrusted-turn Markdown renderer with `react-markdown`, `remark-gfm`, no raw HTML,
  default URL handling, and image blocking.

## Existing Spec

The `session-history-replay` capability already specifies both the terminal-state
task detail replay and the dedicated transcript route.

The current Markdown rendering requirement is scoped to the dedicated
`/tasks/$taskId/transcript` route. The terminal-state `/tasks/$taskId` replay
requirement only requires visual distinction for final answer, commentary, and
tool-call turns, so the implementation can satisfy the current spec while still
showing raw Markdown in the task detail replay.

## Recommendation

Modify the existing `session-history-replay` capability so both transcript surfaces
share the same text rendering rule:

- Text-bearing conversation turns in `SessionReplay` render as safe GFM Markdown.
- The final-answer bubble and commentary styling remain unchanged.
- Tool-call arguments, tool output, and system/milestone text remain verbatim and
  are not passed through the Markdown renderer.

The implementation should reuse `TranscriptMarkdown` rather than introduce another
Markdown stack or dependency.
