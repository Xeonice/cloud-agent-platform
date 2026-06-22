## Why

The transcript view renders every agent turn's text as plain inline children (`{ev.text}`), so markdown the agent actually emits — bold, lists, tables, fenced code — shows up as raw `**`, `|`, and backticks instead of formatted output, making final answers and reasoning hard to read. Agent turn text is untrusted output, so it cannot be rendered with the existing trusted `Markdown` component as-is (it loads remote `<img>` and injects heading slug ids), and the de-facto industry path (Vercel Streamdown) is the right hardening posture but the wrong dependency under our "no new deps" constraint. We can fix this now using only the already-installed `react-markdown@^10.1.0` + `remark-gfm@^4.0.1`.

## What Changes

- Add a small frontend-only `TranscriptMarkdown` component that renders untrusted agent turn text as GFM markdown (bold, lists, task lists, strikethrough, tables, inline + fenced code) using `react-markdown` + `remark-gfm`, with compact, marginless paragraph styling matching the current `text-[13px] leading-relaxed` transcript row (NOT the prose `my-2.5`/`max-w-[760px]` styling of the trusted `Markdown` component).
- Render the three text-bearing turn kinds through `TranscriptMarkdown` at the exact `TxRow` JSX sites: user text, reasoning (assistant `isFinalAnswer:false`, preserving the italic/muted wrapper), and final answer (assistant `isFinalAnswer:true`, inside the `.bg-success-soft` bubble). Tool args `<code>`, tool output `<pre>`, and system turns stay byte-for-byte unchanged.
- Harden against untrusted output using react-markdown's built-in posture only — no dangerous configuration:
  - Never add `rehype-raw`: raw HTML (`<script>`) escapes to inert text.
  - Keep the default `urlTransform` (never override): `javascript:`/`data:`/`vbscript:` are stripped automatically in links.
  - Block remote images with `disallowedElements={['img']}` (a clean remove) so an agent `![](http://evil)` cannot load remote/tracking images.
  - Drop the heading slug-id machinery the trusted component carries (dead weight and a needless surface for transcript).
- Resolve the "保留换行" (preserve line breaks) tension by scoping it to paragraph-level breaks only — the breaks GFM already produces from blank lines — and documenting that intra-paragraph single newlines collapse to spaces per CommonMark/GFM. We do NOT add `remark-breaks` and do NOT apply `white-space:pre-wrap` (reported to break list/paragraph spacing in compact layouts), preserving the "no new deps" non-goal.
- Add a `table` component override wrapping `<table>` in an `overflow-x:auto` container so GFM tables scroll horizontally instead of breaking the narrow 56px-gutter timeline layout.
- Extend the existing `$taskId_.transcript.test.tsx` (node-env vitest, `renderToStaticMarkup`) with markdown fixtures (`**bold**` → `<strong>`, table → `<table>`, list → `<ul>`, inline + fenced code → `<code>`/`<pre>`) and security fixtures (`<script>` → escaped, not executed; `![x](http://evil)` → no `<img>`; `[x](javascript:...)` → filtered href), keeping the existing tool args/output regression assertions green.
- Recalibrate the Playwright transcript visual gate per the `wire-transcript-real-data` playbook (`VV_MEASURE=1`, rationale comment, run twice for determinism), after first verifying the `serve-design-baseline` ROOT path is not the broken archived one.

## Capabilities

### New Capabilities

_None._ The change introduces no new spec-level capability; it modifies the rendering behavior of an existing one.

### Modified Capabilities

- `session-history-replay`: the requirement covering how a parsed turn's text is rendered in the console changes from plain text to "turn text for user, reasoning, and final-answer kinds MUST render as GFM markdown with untrusted hardening (no `rehype-raw`, default `urlTransform` retained, remote images blocked, no heading anchors), while tool args/output and system turns continue to render verbatim."

## Impact

- **Frontend (`@cap/web`) only.** New component `apps/web/src/components/markdown/transcript-markdown.tsx` (or sibling); three edited JSX sites in `apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx` (`TxRow` user / reasoning / final-answer renders). The trusted `apps/web/src/components/markdown/markdown.tsx` and its only consumer (the forge-tokens help page) are untouched.
- **Tests.** Extends `apps/web/src/routes/_app/tasks/$taskId_.transcript.test.tsx`; recalibrates the `transcript` entry in `apps/web/e2e/visual/manifest.ts` and its baseline screenshots.
- **Dependencies.** No new dependencies. Uses already-installed `react-markdown@^10.1.0` and `remark-gfm@^4.0.1`. Does NOT add `rehype-raw`, `rehype-sanitize`, `remark-breaks`, or Streamdown.
- **No backend / contract changes.** `SessionTurn` in `@cap/contracts` already carries the markdown source as plain `z.string()`; the change is purely a render swap on `ev.text` and is runtime-agnostic (covers codex/claude/opencode reasoning and final answers uniformly via the existing `kind` + `isFinalAnswer` switch).
