# Verification Report — render-transcript-markdown

Adjudicated three-way routing of verify findings. The raw-unmet input set was
empty (`[]`); every named requirement/scenario was re-traced end-to-end against
the actual code (not rubber-stamped) and confirmed MET. No spec defects, no
reopened code tasks. Dynamic checks (vitest + a standalone react-markdown render
probe) corroborate the static trace.

## Adjudication summary

- **Reopened code tasks:** none.
- **Spec defects:** none.
- **Reclassified / confirmed MET:** all 14 requirements/scenarios below.

## Evidence harness

- `pnpm --filter @cap/web exec vitest run "$taskId_.transcript.test.tsx"` →
  **13 passed (13)**. Covers bold/list/inline-code, fenced code + GFM table in an
  `overflow-x-auto` wrapper, reasoning-italic/final-answer-bubble preservation,
  `<script>` escaping, remote-image blocking, `javascript:` href stripping,
  no-heading-id, and the tool-args verbatim regression.
- Standalone `react-markdown` render probe (same plugins/options as
  `transcript-markdown.tsx`) confirmed the hardening at the library boundary:
  - `[点我](javascript:alert(1))` → `<a href="">` (scheme stripped by default urlTransform).
  - `[d](data:text/html,abc)` → `<a href="">` (data: stripped too).
  - `# 我的标题` → `<div>我的标题</div>` (no `id`).
  - `![x](http://evil…)` → no `<img>` (empty `<p>`).
  - `<script>alert(1)</script>` → `&lt;script&gt;…` inert text.
  - `- [ ] / - [x]` → GFM task list; `~~gone~~` → `<del>` (the proposal's
    task-list + strikethrough GFM features render).

## Confirmed MET requirements / scenarios

1. **Route consumes taskId and fetches real data** — `$taskId_.transcript.tsx`
   calls `useQuery(sessionHistoryQuery(taskId))` keyed by `Route.useParams()`;
   no hardcoded sample. Turns come from `history.status === "available"`. MET.
2. **Filter and search narrow the real timeline together** — `filterTurns(turns,
   filter, search)`; the "没有匹配的记录" empty state renders when `visible.length === 0`. MET.
3. **Non-available states render honestly** — `expired` and `empty` (with the
   `agent-failed-to-start` reason branch) each render an `EmptyState`; no
   fabricated transcript content. MET.
4. **History 「查看会话」 reaches the data-driven route** — `history.tsx:252`
   `<Link to="/tasks/$taskId/transcript" params={{ taskId: task.id }}>`. MET.
5. **Bold, list, inline code render as formatted markdown** — `TranscriptMarkdown`
   wires `remark-gfm` with `strong`/`ul`/`ol`/`li`/`code` component overrides;
   test asserts `<strong>`/`<ul>`/`<li>`/`<code>` present and raw `**`/backticks
   absent. MET.
6. **Fenced code block renders as pre/code** — `pre` handler wraps the
   className-bearing `code`; test asserts `<pre>` + `<code>` + `x=1`. MET.
7. **GFM table inside a horizontally scrollable container** — `table` override
   wraps `<table>` in `<div className="… overflow-x-auto …">`; test asserts
   `<table>`/`<th>`/`<td>` + `overflow-x-auto`. MET.
8. **Reasoning and final-answer wrappers preserved** — reasoning keeps the
   `text-… italic … text-muted-foreground` wrapper, final answer stays inside
   `.bg-success-soft`; both wrap `<TranscriptMarkdown>`. Test asserts `italic` +
   `<strong>` and `bg-success-soft` + `<strong>`. MET.
9. **Tool args / tool output / system turns NOT markdown-rendered** — `ev.args`
   renders in a raw `<code>`, `ev.output` in a raw `<pre>`, system turn uses
   `ev.title`/`ev.detail` as plain text; none pass through `TranscriptMarkdown`.
   Test asserts `echo **not bold**` verbatim with no `<strong>`/`<table>`. MET.
10. **Embedded raw HTML escaped, never executed** — no `rehype-raw`; react-markdown
    default escapes raw HTML. Probe + test confirm `&lt;script&gt;`. MET.
11. **Remote image markdown loads no image element** — `disallowedElements={['img']}`.
    Probe + test confirm no `<img>`. MET.
12. **`javascript:` link URL filtered** — default `urlTransform` retained (not
    overridden). Probe shows `href=""`; test asserts no `href="javascript:`. MET.
13. **No heading anchor ids** — headings render as `<div>` with no `id`. Probe +
    test confirm. MET.
14. **No new runtime dependency** — `apps/web/package.json` carries only the
    pre-existing `react-markdown@^10.1.0` + `remark-gfm@^4.0.1`; no `rehype-raw`,
    `rehype-sanitize`, `remark-breaks`, or `streamdown` in package.json or the
    lockfile. MET.

## Gap findings (recorded, non-blocking to the primary scenarios)

- **Track 4 (transcript-visual-gate) is functionally incomplete despite tasks
  4.1/4.2 being marked `[x]`.** Task 4.1 (serve-design-baseline ROOT not the
  broken archived path) IS satisfied — `apps/web/e2e/serve-design-baseline.mjs`
  resolves `ROOT = path.resolve(here, "design-baseline")`, the stable relocated
  path. But task 4.2 (recalibrate the `transcript` entry for THIS change) was NOT
  done: the `transcript` entry in `apps/web/e2e/visual/manifest.ts` still carries
  the `wire-transcript-real-data` rationale + MEASURED 0.03/0.06 thresholds, with
  NO `render-transcript-markdown` VV_MEASURE rationale for the new
  formatted-markdown drift. `manifest.ts` has no diff in this change's working
  tree, and the `mock-session.ts` fixture (modified, ~20 markdown markers) now
  renders formatted in the gate without a recalibrated threshold/comment. This is
  a TASK-completion gap, not a spec-requirement defect — spec.md contains no
  visual-baseline scenario, so it is not routed as an unmet requirement. It does
  not block any of the 14 functional scenarios, all of which are green. Flagged
  here for the visual-gate owner to close before archive.

## Scope findings (behaviors beyond any requirement)

These are extra component overrides in `transcript-markdown.tsx` not mapped to any
spec requirement/scenario. None is unsafe or regressive; recorded for awareness.
The element-level overrides for required behaviors (`strong`/`em`/`ul`/`ol`/`li`/
`pre`/`code`/`th`/`td`/`del`, plus the `min-w-0` wrapper) are styling
implementation choices WITHIN required behaviors, not scope creep.

1. `a` override adds `target="_blank" rel="noopener noreferrer"` (new-tab
   navigation) — `transcript-markdown.tsx:41`. No scenario prescribes link
   navigation behavior; the spec only requires the default `urlTransform` to
   stay (it does). Benign, and the `rel` makes the new-tab safe.
2. `blockquote` override with `border-l`/muted styling — `transcript-markdown.tsx:51`.
   No requirement or scenario mentions blockquotes.
3. `hr` override — `transcript-markdown.tsx:63`. No requirement or scenario
   mentions horizontal rules.
4. `thead` passthrough override — `transcript-markdown.tsx:86`. Behaviorally
   redundant (no change vs default); harmless extra code.
