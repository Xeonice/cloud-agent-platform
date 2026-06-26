## Why

Terminal-state task detail pages currently show final answers as raw Markdown even
though operators expect the same formatted transcript they see on the dedicated
transcript page. This is visible on real stopped tasks where headings, bold text,
links, inline code, and lists remain unformatted in the `SessionReplay` final answer
bubble.

## What Changes

- Render text-bearing conversation turns in the `/tasks/$taskId` terminal-state
  `SessionReplay` as safe GitHub-Flavored Markdown.
- Reuse the existing `TranscriptMarkdown` renderer so the task detail replay and
  dedicated transcript route share the same trusted boundary and formatting rules.
- Preserve the current visual treatments for operator prompts, assistant
  commentary, and green final-answer bubbles.
- Keep tool-call arguments, tool output, and system/milestone text rendered
  verbatim, with no Markdown conversion.
- Add focused coverage proving formatted Markdown appears in `SessionReplay` while
  tool output remains byte-for-byte text.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `session-history-replay`: extend the terminal-state task detail replay contract so
  text-bearing turns render as safe GFM Markdown, matching the dedicated transcript
  route.

## Impact

- Affected UI: terminal-state `/tasks/$taskId` conversation replay, including
  stopped/completed/cancelled/failed task detail pages and running headless live
  replay if it uses the same `SessionReplay` turn renderer.
- Affected code: `apps/web/src/components/session/session-replay.tsx` and focused
  component tests around `SessionReplay`/turn rendering.
- Dependencies: no new runtime dependency; use existing `react-markdown` and
  `remark-gfm` through `TranscriptMarkdown`.
- APIs/contracts: no backend or wire-contract change.
