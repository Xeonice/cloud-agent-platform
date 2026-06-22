<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: transcript-markdown-component (depends: none)

- [x] 1.1 Create `apps/web/src/components/markdown/transcript-markdown.tsx` as a new untrusted-text GFM renderer, separate from the trusted `markdown.tsx` (do not modify `markdown.tsx` or its forge-tokens consumer)
- [x] 1.2 Wire `react-markdown` + `remark-gfm` (already installed) with the safe-by-default posture: no `rehype-raw`, retain default `urlTransform` (no override), `disallowedElements={['img']}`, and emit no heading slug/anchor ids
- [x] 1.3 Apply compact transcript-row styling (`text-[13px] leading-relaxed`, marginless paragraphs) instead of the trusted component's prose styling; do not add `remark-breaks` or a `white-space:pre-wrap` rule
- [x] 1.4 Add a `table` component override wrapping `<table>` in a container whose computed `overflow-x` is `auto`

## 2. Track: transcript-route-render-swap (depends: transcript-markdown-component)

- [x] 2.1 In `apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx`, render the user-text `TxRow` site's `ev.text` through `TranscriptMarkdown`
- [x] 2.2 Render the reasoning `TxRow` site (assistant `isFinalAnswer:false`) through `TranscriptMarkdown`, preserving its muted/italic wrapper
- [x] 2.3 Render the final-answer `TxRow` site (assistant `isFinalAnswer:true`) through `TranscriptMarkdown`, keeping it inside the `.bg-success-soft` bubble
- [x] 2.4 Confirm tool-call args `<code>`, tool output `<pre>`, and system milestone turns remain on the verbatim path (not passed through `TranscriptMarkdown`)

## 3. Track: transcript-render-tests (depends: transcript-route-render-swap)

- [x] 3.1 Extend `apps/web/src/routes/_app/tasks/$taskId_.transcript.test.tsx` with formatting fixtures: `**bold**` → `<strong>`, `-`/`*` list → `<ul>`/`<li>`, `` `inline code` `` → `<code>` (and assert raw `**`/backticks are not visible text)
- [x] 3.2 Add fixtures for fenced code block → `<pre>` wrapping `<code>`, and a GFM pipe table → `<table>` with `<th>`/`<td>` inside the `overflow-x:auto` wrapper
- [x] 3.3 Add wrapper-preservation fixtures: reasoning markdown stays in the muted/italic wrapper, final-answer markdown stays in `.bg-success-soft`
- [x] 3.4 Add security fixtures: `<script>alert(1)</script>` escaped (no live `<script>`), `![x](http://evil...)` → no `<img>`, `[x](javascript:...)` → href not `javascript:...`, markdown heading → no `id` attribute
- [x] 3.5 Keep the existing tool-args/output and system-turn regression assertions green (verbatim, no `<strong>`/`<ul>`/`<table>` introduced)

## 4. Track: transcript-visual-gate (depends: transcript-route-render-swap)

- [x] 4.1 Verify the `serve-design-baseline` ROOT path is not the broken archived path before recalibrating; fix the ROOT if it points at a removed active path
- [x] 4.2 Recalibrate the `transcript` entry in `apps/web/e2e/visual/manifest.ts` (`VV_MEASURE=1`, rationale comment, run twice for determinism) and regenerate its baseline screenshots
