## Context

`SessionReplay` is the terminal-state conversation surface on `/tasks/$taskId`.
It already consumes the parsed `session-history` contract and visually separates
operator input, assistant commentary, final answers, and tool calls. However, it
renders text-bearing turns directly as `{turn.text}`, so Markdown source remains
visible in the task detail page.

The dedicated `/tasks/$taskId/transcript` route already solved this problem with
`TranscriptMarkdown`, a compact renderer for untrusted transcript text. That
renderer uses `react-markdown` with `remark-gfm`, blocks images, does not enable
raw HTML parsing, and preserves default URL safety behavior.

## Goals / Non-Goals

**Goals:**

- Make `SessionReplay` render user/operator text, assistant commentary, and final
  answers as safe GFM Markdown.
- Keep the current `SessionReplay` visual hierarchy: operator bubbles, muted/italic
  commentary, and green final-answer bubbles.
- Reuse `TranscriptMarkdown` so transcript rendering behavior and security posture
  are consistent across both transcript surfaces.
- Add focused test coverage for Markdown formatting and verbatim tool rendering.

**Non-Goals:**

- No backend, contract, or parser changes.
- No new Markdown dependencies or alternate renderer.
- No Markdown rendering for tool-call arguments, tool output, token badges, or
  system/milestone rows.
- No redesign of the replay layout, filters, terminal placeholder, or transcript
  data fetching.

## Decisions

1. Reuse `TranscriptMarkdown` inside `SessionReplay`.

   Rationale: the existing component already encodes the correct untrusted-content
   boundary and GFM support. Reusing it avoids drift between `/tasks/$taskId` and
   `/tasks/$taskId/transcript`.

   Alternative considered: add a second local `ReactMarkdown` setup inside
   `session-replay.tsx`. Rejected because it would duplicate security-sensitive
   renderer configuration and make future hardening easier to miss.

2. Apply Markdown rendering only to text-bearing conversation turns.

   Rationale: user/operator prompts, assistant commentary, and final answers are
   prose intended for reading. Tool-call args and output are command/log material
   where Markdown-significant characters must stay byte-for-byte visible.

   Alternative considered: render every string in the replay as Markdown. Rejected
   because tool output may contain code, logs, ANSI-adjacent text, tables, shell
   snippets, or raw delimiters where formatting would be misleading.

3. Preserve wrappers and styling while swapping only the inner text renderer.

   Rationale: the regression is content formatting, not layout. Keeping existing
   wrappers reduces visual risk and maintains the current filter/sidebar behavior.

   Alternative considered: replace `TurnItem` with the dedicated transcript route's
   row component. Rejected because the task detail replay has different structure,
   tabs, sidebar filtering, and live-headless usage.

## Risks / Trade-offs

- Markdown block elements may slightly change vertical rhythm inside existing
  bubbles. Mitigation: use the already compact `TranscriptMarkdown` styling and
  verify final-answer/commentary bubbles with component tests or a browser check.
- Links in transcript Markdown become clickable in the task detail page. Mitigation:
  keep `TranscriptMarkdown` defaults: safe URL transform, `target="_blank"`, and
  `rel="noopener noreferrer"`.
- `SessionReplay` may also be used by running headless live tasks. Mitigation:
  the same text-bearing-turn rule is acceptable there because it uses the same
  parsed `SessionTurn` semantics; tests should cover the shared renderer behavior
  rather than terminal status branching only.
