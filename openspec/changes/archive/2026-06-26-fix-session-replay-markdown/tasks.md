<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: session-replay-rendering (depends: none)

- [x] 1.1 Import `TranscriptMarkdown` in `apps/web/src/components/session/session-replay.tsx`.
- [x] 1.2 Replace direct `{turn.text}` rendering for user/operator turns with `TranscriptMarkdown`, preserving the existing operator bubble wrapper and typography.
- [x] 1.3 Replace direct `{turn.text}` rendering for assistant final-answer turns with `TranscriptMarkdown`, preserving the green `.bg-success-soft` bubble and "✓ 最终回答" label.
- [x] 1.4 Replace direct `{turn.text}` rendering for assistant commentary turns with `TranscriptMarkdown`, preserving the muted/italic treatment.
- [x] 1.5 Confirm tool-call args, tool output, token badges, system/milestone text, filters, tabs, and empty states remain rendered through their existing non-Markdown paths.

## 2. Track: test-and-verify (depends: session-replay-rendering)

- [x] 2.1 Add focused Vitest coverage for `SessionReplay` text-bearing turns: bold text, inline code, links, bullet lists, and fenced code render as formatted Markdown in user/commentary/final-answer bubbles.
- [x] 2.2 Add coverage proving tool-call arguments and tool output containing Markdown-significant characters remain verbatim and do not produce Markdown-generated elements.
- [x] 2.3 Run the focused web test file and `pnpm --filter @cap/web test` or the repository-equivalent targeted Vitest command.
- [x] 2.4 Run `pnpm --filter @cap/web typecheck` or the repository-equivalent typecheck command.
- [x] 2.5 If a dev or deployed task page is available, verify `/tasks/<id>` visually or through Chrome/Playwright DOM inspection that final-answer Markdown now renders like `/tasks/<id>/transcript`.
