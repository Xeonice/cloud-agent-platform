## Context

The transcript view (`apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx`) renders each agent turn's text as plain inline children (`{ev.text}`), so GFM the agent actually emits — `**bold**`, lists, tables, fenced code — shows as raw `**`, `|`, and backticks. Agent turn text is **untrusted** model output, so it cannot reuse the existing trusted `Markdown` component (`apps/web/src/components/markdown/markdown.tsx`): that component loads remote `<img>` and injects `slugify`-derived heading `id`s, both of which are inappropriate surfaces for untrusted content. The de-facto industry path (Vercel Streamdown) is the right hardening posture but the wrong dependency under this repo's "no new deps" constraint.

`react-markdown@^10.1.0` and `remark-gfm@^4.0.1` are already installed (used by the trusted `Markdown`). This change is **frontend-only** — no backend, contract, or dependency changes. `SessionTurn` in `@cap/contracts` already carries the markdown source as a plain `z.string()`; the change is purely a render swap on `ev.text`.

## Goals / Non-Goals

**Goals:**

- Render the three text-bearing turn kinds (user text, reasoning, final answer) as GFM markdown using the already-installed `react-markdown` + `remark-gfm`.
- Treat agent turn text as untrusted: rely on react-markdown's built-in escaping posture (no `rehype-raw`), block remote images, retain default `urlTransform`, drop heading-anchor machinery.
- Match the compact transcript row styling (`text-[13px] leading-relaxed`, marginless paragraphs) rather than the trusted component's prose styling.
- Keep tool args `<code>`, tool output `<pre>`, and system turns byte-for-byte unchanged.

**Non-Goals:**

- No new dependencies (no `rehype-raw`, `rehype-sanitize`, `remark-breaks`, or Streamdown).
- No change to the trusted `Markdown` component or its only consumer (forge-tokens help page).
- No backend / contract / runtime changes — the swap is runtime-agnostic (codex/claude/opencode flow through the existing `kind` + `isFinalAnswer` switch).
- Not honoring intra-paragraph single newlines as `<br>` (collapses to space per CommonMark/GFM; only blank-line paragraph breaks are preserved).

## Decisions

- **New `TranscriptMarkdown` component, not reuse of `Markdown`.** A sibling component (`apps/web/src/components/markdown/transcript-markdown.tsx`) so the untrusted hardening (`disallowedElements={['img']}`, no heading `id`s) and compact styling live separately from the trusted prose renderer. _Alternative considered:_ parameterizing `Markdown` with a `trusted` flag — rejected because it muddies a security boundary inside one component and risks an unsafe default.

- **Hardening via react-markdown defaults only, no plugins.** Never add `rehype-raw` (raw HTML escapes to inert text by default — this default IS the guardrail); keep default `urlTransform` (strips `javascript:`/`data:`/`vbscript:` hrefs); add `disallowedElements={['img']}` to drop agent-supplied remote/tracking images. _Alternative considered:_ `rehype-sanitize` — rejected as a new dependency that duplicates the protection the no-`rehype-raw` posture already provides.

- **Scope "preserve line breaks" to paragraph-level only.** Use the blank-line paragraph breaks GFM already produces; do NOT add `remark-breaks` and do NOT apply `white-space:pre-wrap` (reported to break list/paragraph spacing in compact layouts). Documents the CommonMark/GFM single-newline-collapses behavior as expected.

- **`table` override wraps in `overflow-x:auto`.** GFM tables would otherwise blow out the narrow 56px-gutter timeline; wrapping in a horizontal scroll container contains them, matching the trusted component's table treatment.

- **Edit the three exact `TxRow` JSX sites.** User text, reasoning (preserving the italic/muted wrapper), and final answer (inside the `.bg-success-soft` bubble). Tool args/output and system turns are not touched.

## Risks / Trade-offs

- **Untrusted markdown rendering surface** → Mitigated by no `rehype-raw` (HTML inert), `disallowedElements={['img']}` (no remote image loads), default `urlTransform` (dangerous schemes stripped). Covered by security fixtures in `$taskId_.transcript.test.tsx` (`<script>` escaped, `![x](http://evil)` → no `<img>`, `[x](javascript:...)` → filtered href).

- **Single-newline collapse may surprise users expecting hard wraps** → Accepted and documented; honoring single newlines would require `remark-breaks` (new dep) or `pre-wrap` (breaks compact spacing).

- **Visual gate drift from formatted output** → Recalibrate the `transcript` Playwright baseline per the `wire-transcript-real-data` playbook (`VV_MEASURE=1`, rationale comment, run twice for determinism), after first confirming the `serve-design-baseline` ROOT is not the broken archived path.

## Migration Plan

Pure additive frontend render swap; no data migration. Rollback is reverting the component file and the three `TxRow` edits. No flags, no backend coordination.
