# Research Brief: render-transcript-markdown

Synthesis of three research routes (Web / Codebase / Archive) feeding the
`render-transcript-markdown` change. The goal of the change is to render agent
turn text (user / reasoning / final-answer) in the transcript view as rich
markdown while treating that text as **untrusted** agent output, without adding
dependencies beyond the already-installed `react-markdown` + `remark-gfm` and
without touching the backend or `@cap/contracts`.

---

## Web route — library posture & industry prior art

These findings establish what `react-markdown` + `remark-gfm` guarantee out of
the box and how the broader ecosystem renders untrusted LLM output.

- **`react-markdown` is XSS-safe by default, no `rehype-raw` needed.** It renders
  to React elements via a syntax tree (never `dangerouslySetInnerHTML`); raw HTML
  in the markdown source is escaped and displayed as literal text rather than
  executed. A raw `<script>` therefore shows as text and does not run. This is the
  official documented posture.
  - Evidence: remarkjs/react-markdown Security section; LogRocket "How to safely
    render Markdown using react-markdown" ("does not rely on
    dangerouslySetInnerHTML… uses a syntax tree"; "does not support HTML by default
    and therefore prevents script injections").
  - Relevance: directly validates security design point #1 (never add `rehype-raw`
    → raw HTML escapes to text). The `<script>` unit-test assertion ("escape 成文本
    不执行") is a built-in guarantee; the non-goal of not adding `rehype-raw` is the
    right call.

- **Default `urlTransform` strips dangerous protocols.** `defaultUrlTransform`
  only permits `http`, `https`, `irc`, `ircs`, `mailto`, `xmpp` plus
  protocol-relative/relative URLs; `javascript:`, `data:`, `vbscript:` are stripped.
  The README warns that overriding `urlTransform` to something insecure opens XSS
  vectors — so the safe path is to **not override it**.
  - Evidence: remarkjs/react-markdown (`defaultUrlTransform` allowlist).
  - Relevance: validates security point #3 (`[x](javascript:...)` filtered with zero
    config). The "危险协议被过滤" unit test passes out of the box; the change must rely
    on the default and pass no custom `urlTransform`.

- **Two documented ways to block images.** (a) `disallowedElements={['img']}`
  (simplest, strips the element) or (b) `components={{ img: () => null }}` (more
  flexible, allows degrade/fallback). `disallowedElements` cannot be combined with
  `allowedElements`; `allowElement` is an additional per-node filter; `skipHtml`
  (default false) ignores HTML entirely. Defaults: `allowedElements`=all,
  `disallowedElements`=[].
  - Evidence: remarkjs/react-markdown; npm react-markdown prop table; Strapi
    react-markdown security/styling guide.
  - Relevance: answers the explore question (`disallowedElements` vs
    `components.img=()=>null`). For a pure block, `disallowedElements=['img']` is the
    canonical minimal approach; for "degrade to link text", `components.img` must
    render a fallback (alt/href as text) rather than returning null. Note: the default
    `urlTransform` already neutralizes `javascript:` in `img src`, so blocking `img`
    is about SSRF/tracking, not script execution.

- **Vercel Streamdown is the most direct prior art.** An official open-source
  drop-in replacement for `react-markdown` purpose-built for rendering UNTRUSTED
  LLM/AI output (it powers the AI SDK's AI Elements `Response` component). Ships
  `rehype-harden` + `rehype-sanitize`; it is the de-facto industry pattern for the
  transcript-of-agent-output use case.
  - Evidence: vercel/streamdown; Vercel "Introducing Streamdown" changelog;
    streamdown.ai/docs/security.
  - Relevance: confirms the change is aligned with mainstream practice. Also a
    build-vs-adopt data point: Streamdown is a heavier dependency (KaTeX, streaming
    animations, CSV export) and the non-goals forbid new deps — so the recommendation
    is to **replicate Streamdown's hardening posture** in a small `TranscriptMarkdown`
    component, not adopt Streamdown itself.

- **`rehype-harden` (Streamdown's security layer) defaults to block-all.**
  `allowedLinkPrefixes=[]` and `allowedImagePrefixes=[]` block all link/image URLs
  except hash-only links and `mailto:`; `allowDataImages` defaults false;
  `javascript:`/`data:`/`vbscript:`/`file:` are ALWAYS blocked regardless of config.
  Blocked images degrade to a `<span>` reading `[Image blocked: ${alt}]` (or
  `[Image blocked: No description]`); blocked links get a `[blocked]` indicator.
  Policies: `indicator` (default) / `text-only` / `remove`.
  - Evidence: deepwiki vercel-labs/markdown-sanitizers configuration reference;
    npm rehype-harden.
  - Relevance: a concrete, battle-tested template for the "degrade image to text"
    decision (security point #2): render a `[Image blocked: alt]` span rather than
    silently dropping. The `remove` / `text-only` / `indicator` taxonomy maps cleanly
    onto `components.img=()=>null` (remove) vs a fallback span/link (indicator/
    text-only). Also confirms `data:` image URLs are a real tracking/payload vector.

- **Single newlines are folded by CommonMark/GFM.** A single `\n` becomes a space
  within a paragraph; only a blank line starts a new paragraph (or trailing-spaces/
  backslash makes a hard break). To honor "保留换行" you must EITHER add
  `remark-breaks` (turns soft line endings into `<br>`) OR rely on CSS
  `white-space:pre-wrap` — but the two conflict, and `white-space:pre-wrap` is
  documented to cause unwanted gaps between block elements/lists.
  - Evidence: react-markdown issues #273 and #611 (`white-space:pre-wrap` breaks
    between elements); `remark-breaks` plugin docs.
  - Relevance: **flags a gap in the non-goals.** "No new deps beyond
    react-markdown+remark-gfm" collides with "保留换行" for agent output, which
    literally requires `remark-breaks` (a new dep) OR a CSS approach the community
    reports interferes with list/paragraph spacing in a compact timeline. The explore
    must resolve this explicitly — either accept `remark-breaks` as an allowed dep, or
    scope "保留换行" to paragraph-level breaks only (which GFM already gives) and accept
    that intra-paragraph single newlines collapse.

- **`remark-gfm` covers the full GFM feature list.** Enables tables, strikethrough,
  task lists, autolink literals, and footnotes; exposes `del`, `input`, `table`,
  `tbody`, `td`, `th`, `thead`, `tr` for the components map. Options: `singleTilde`
  (default true), `tablePipeAlign` (default true), `tableCellPadding` (default true).
  - Evidence: remarkjs/remark-gfm; npm remark-gfm; mdxjs GFM guide.
  - Relevance: confirms the GFM feature list (粗体/表格/列表/任务列表/删除线/inline code)
    is fully covered by the already-installed `remark-gfm` — no extra deps. The
    `TranscriptMarkdown` components map must cover `table`/`thead`/`tbody`/`tr`/`th`/
    `td` and `input` (task-list checkbox) for design-token styling, mirroring the
    existing `markdown.tsx` mapping.

- **Dominant industry pattern for AI chat markdown.** assistant-ui, prompt-kit,
  LangChain JS, and Vercel AI Elements all use `react-markdown` + `remark-gfm`,
  rendering to React elements (no HTML sanitization needed because no raw HTML is
  rendered), with heavy memoization for streaming. assistant-ui ships
  `@assistant-ui/react-markdown` + `remark-gfm`; AI Elements ships the `Response`/
  Streamdown component.
  - Evidence: assistant-ui markdown docs; prompt-kit markdown docs; LangChain JS
    frontend markdown-messages docs; ai-sdk.dev message element docs.
  - Relevance: validates the whole approach as standard practice. Since the transcript
    is **replayed (not streamed token-by-token)**, the change can skip the
    streaming-specific memoization complexity these libs add — a simplification
    argument favoring the small custom `TranscriptMarkdown` over a streaming-oriented
    dependency.

- **GFM tables overflow narrow containers.** The standard fix is a custom `table`
  component wrapping `<table>` in a div with `overflow-x:auto` (and table
  `width:max-content` / `display:block`), since markdown can't express the wrapper.
  CSS-only alternative: `table { display:block; width:max-content; max-width:100%;
  overflow:auto }`.
  - Evidence: Strapi react-markdown guide; mkang32 "Adding scroll to overflowing
    table"; CodePen akash-mittal/ZEKGZZO.
  - Relevance: directly answers the "表格在窄列要能横向滚动/换行" styling requirement. In
    the compact 56px-slot transcript layout the `components.table` override should wrap
    the table in an `overflow-x:auto` div (or `display:block` + `overflow:auto`) so
    tables scroll horizontally instead of breaking the timeline — confirms a
    components-map override is needed, not just CSS on existing prose styles.

- **2025/2026 security guides converge on the same untrusted-markdown checklist.**
  Never enable `rehype-raw` on untrusted input (or if you must, pair it with
  `rehype-sanitize` + DOMPurify + CSP); keep the default `urlTransform`; restrict
  elements via `allowedElements`/`disallowedElements`; block images/iframes; treat
  any custom `remarkPlugins`/`rehypePlugins`/`components` as a potential XSS surface.
  - Evidence: Strapi react-markdown security/styling guide; HackerOne "Secure
    Markdown Rendering in React"; CopilotKit issue #3938 (real-world XSS: shipped
    `rehype-raw` on untrusted AI output → stored XSS report).
  - Relevance: CopilotKit #3938 is concrete prior-art proof of the exact failure mode
    this change guards against. Strongly justifies the non-goal of never adding
    `rehype-raw` and the decision to NOT reuse the trusted `markdown.tsx` blindly.
    Also flags that any future `remarkPlugins`/`components` added to
    `TranscriptMarkdown` are themselves a security surface to review.

---

## Codebase route — render sites, deps, tests, visual gate

These findings pin the exact files, JSX sites, installed versions, and harnesses
the change will touch.

- **`TxRow` is the exported per-turn renderer; it renders all turn text as plain
  inline children with no markdown.** The four kinds render as: user text
  `<div className="text-[13px] leading-relaxed text-foreground">{ev.text}</div>`
  (line 223); reasoning (assistant `!isFinalAnswer`)
  `<div className="text-[13px] italic leading-relaxed text-muted-foreground">{ev.text}</div>`
  (232–234); final answer (assistant `isFinalAnswer`) inside the green card
  `<div className="rounded-[8px] bg-success-soft px-3 py-2.5 …">{ev.text}</div>`
  (282–284); tool args as `<code className="…whitespace-pre-wrap break-all rounded-[5px] bg-secondary…">{ev.args}</code>`
  (245–247) and tool output as `<pre className="…whitespace-pre-wrap break-all rounded-md bg-terminal-bg…">{ev.output}</pre>`
  (266–268).
  - Evidence: `apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx:199-290`.
  - Relevance: these are the exact JSX sites to change. The 3 markdown-rendered turns
    are user `<div>` (223), reasoning `<div>` (232–234, keep italic/muted level) and
    final-answer `<div>` (282–284, inside the green bubble). Tool args/output/system
    stay byte-for-byte unchanged per scope. `TxRow` is `export`ed (line 199) so the
    per-kind render is unit-testable off a `SessionTurn` fixture.

- **The existing trusted `Markdown` component already satisfies most untrusted
  requirements but has two trusted-only traits that are wrong for transcript.** It
  adds slugified `id` to h2/h3 headings (47–49, 54–57) and has NO `img` handling at
  all (no `disallowedElements`/`components.img`), so an agent `![](http://evil)`
  renders a live `<img>`. It does NOT use `rehype-raw` (default-escapes HTML) and
  links already get `target=_blank rel="noopener noreferrer"` (76–85). It styles via
  a `components` map onto design tokens (not `@tailwindcss/typography`) using
  `text-ink`/`text-foreground`, prose-spaced margins (`my-2.5`, `mt-9`, `mb-3`), and
  wraps in `max-w-[760px]`.
  - Evidence: `apps/web/src/components/markdown/markdown.tsx:42-134`.
  - Relevance: drives reuse-vs-new. Reusing as-is is unsafe (renders untrusted images)
    and misfits the layout (prose margins + max-w-760 vs compact 56px-gutter timeline).
    Cleanest is option (b): a new `TranscriptMarkdown` with explicit untrusted semantics
    — `disallowedElements={['img']}` (or `components.img=()=>null`), no heading slug ids,
    compact spacing — OR option (a) add an `untrusted`/`compact` flag. The `a` mapping,
    code/pre/table mappings, and the default-HTML-escape posture can be copied verbatim
    since they are already safe.

- **`react-markdown` is pinned `^10.1.0` (installed 10.1.0); `remark-gfm` `^4.0.1`
  — both already in `@cap/web` deps.** v10's default `urlTransform` is
  `defaultUrlTransform`, which strips any URL whose protocol is not in
  `safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i` — so `javascript:` and `data:` are
  already neutralized to empty string. Security knobs: `allowedElements`/
  `disallowedElements` (mutually exclusive), `allowElement`, `skipHtml`,
  `urlTransform`.
  - Evidence: `node_modules/.pnpm/react-markdown@10.1.0_…/react-markdown/lib/index.js`
    (safeProtocol regex :124, urlTransform default :320, defaultUrlTransform :421-443,
    option names :314-318); `apps/web/package.json`.
  - Relevance: the prompt assumed 9.x; it is actually **10.x** — same API surface for
    this work. Confirms no new dependency needed; `javascript:`/`data:` filtering is FREE
    via the default `urlTransform`; image suppression uses `disallowedElements=['img']`
    (cannot combine with `allowedElements`) — `components.img=()=>null` also works. Do
    NOT add `rehype-raw`.

- **The vitest suite runs in the `node` environment (no jsdom/window) and collects
  `.test.tsx`, so a component's STATIC render is asserted via `react-dom/server`
  `renderToStaticMarkup`.** The existing transcript test does exactly this against
  `TxRow`, asserting on the returned HTML string (e.g. `expect(html).toContain('推理')`,
  counting `grid-cols-[56px` rows). react-markdown 10 renders synchronously (returns a
  ReactElement, like the existing synchronous `Markdown`), so it works under
  `renderToStaticMarkup` with no DOM.
  - Evidence: `apps/web/vitest.config.ts` (environment `node`, includes `*.test.tsx`);
    `apps/web/src/routes/_app/tasks/$taskId_.transcript.test.tsx:17-100`.
  - Relevance: the required markdown + security unit tests fit the existing harness with
    zero new tooling. Add `SessionTurn` fixtures whose `text` contains `**粗体**` / a GFM
    table / list / inline+fenced code / a `<script>` / `![x](http://evil)` /
    `[x](javascript:...)`, render `TxRow` via `renderToStaticMarkup`, and assert:
    `<strong>`/`<table>`/`<ul>`/`<code>`/`<pre>` present; `&lt;script&gt;` escaped (no
    live `<script>`); no `<img`; `javascript:` href stripped to empty. Existing tool
    args/output regression asserts (56–65, 93–99) must keep passing.

- **The transcript route IS in the Playwright visual gate.** Manifest id `transcript`,
  appPath `/tasks/${TRANSCRIPT_TASK_ID}/transcript`, designPath
  `/screens/transcript.html`, thresholds desktop 0.06 / mobile 0.08, readySelector
  `.bg-success-soft`. Its mock fixture text (`availableSessionHistory`) is currently
  PLAIN PROSE with no markdown syntax — user `修复登录页…`, reasoning `我先查看登录页…`,
  final `已修复：登录容器改为 flex 居中…` — no `**`, no tables, no lists.
  - Evidence: `apps/web/e2e/visual/manifest.ts:227-243`;
    `apps/web/src/lib/api/mock.ts:482-552` (fixture text 494–526).
  - Relevance: because the fixture text has no markdown, wrapping it should produce
    near-identical output (`<p>` vs `<div>`, same single-line prose) — the existing
    baseline likely still passes within thresholds IF the new component's paragraph
    spacing matches the current `text-[13px] leading-relaxed`. **Risk:** the existing
    `Markdown` `p` uses `my-2.5` + `leading-[1.7]`, which would add vertical margin and
    trip the threshold. Mitigation: give `TranscriptMarkdown` compact/marginless
    paragraph styling matching the current row, OR set `VV_MEASURE=1` to recalibrate. To
    actually SHOW markdown in the baseline, enrich the `mock.ts` fixture text and update
    the design-baseline `transcript.html` — which is served from the ARCHIVED
    `2026-06-11-console-design-pixel-merge/design-baseline/` per `playwright.config.ts:10`.

- **`SessionTurn` is a zod discriminated union on `kind` (user/assistant/tool/system)
  exported from `@cap/contracts`.** assistant carries `{text:string,
  isFinalAnswer:boolean}`, user `{text:string}`, tool `{name,args,output:nullable,…}`,
  system `{title,detail?,…}`. The text fields are plain `z.string()` — the backend
  (unify-transcript-parsers) feeds markdown source text verbatim; no schema change is
  needed or in scope.
  - Evidence: `packages/contracts/src/session-history.ts:39-122`.
  - Relevance: confirms the rendering change is purely frontend and runtime-agnostic —
    it operates on `SessionTurn.text` regardless of codex/claude/opencode origin. The
    non-goal "不改 @cap/contracts" holds: the contract already carries the markdown string.
    The render switch is on `kind` + `isFinalAnswer`, exactly the existing `TxRow` branch
    structure.

- **Archived OpenSpec changes exist for the transcript wiring**, plus live specs.
  `2026-06-21-wire-transcript-real-data`, `2026-06-22-unify-transcript-parsers`, and
  live specs `session-history-replay`, `transcript-parser-registry`,
  `session-transcript-persistence`. The `Markdown` component is referenced only once in
  the app (the forge-tokens help page), confirming transcript would be a distinct
  second consumer.
  - Evidence: `openspec/changes/archive/2026-06-21-wire-transcript-real-data`,
    `…/2026-06-22-unify-transcript-parsers`, `openspec/specs/session-history-replay`;
    grep: only `apps/web/src/routes/_app/help/forge-tokens.tsx:24` imports
    `@/components/markdown/markdown`.
  - Relevance: provides spec lineage for the proposal's "modified spec" framing
    (`session-history-replay` is the capability that currently says assistant text renders
    as plain commentary/final-answer). Since `Markdown` has exactly one trusted consumer,
    adding a `TranscriptMarkdown` for the untrusted path will not disturb the help page,
    and a delta-spec on `session-history-replay` (turn text MUST render markdown with
    untrusted hardening) is the natural place to record the new behavior + security
    requirements.

---

## Archive route — precedent change & frozen contract

These findings establish the direct precedent (the change that authored the
existing `Markdown` component) and confirm the surrounding contract is frozen.

- **`add-forge-token-help-docs` is the DIRECT precedent.** It introduced the only
  markdown-rendering path in the monorepo and authored the existing `Markdown`
  component. Its design.md Decision 2 explicitly establishes the safety property the
  new change must inherit: `react-markdown` + `remark-gfm`, deliberately NO
  `rehype-raw` / `rehype-sanitize`, relying on react-markdown's default JSX-escaping of
  raw HTML to inert text as "the security guardrail." It also lists a spec scenario
  asserting raw HTML renders as inert text, which fails the moment `rehype-raw` is
  introduced.
  - Evidence: `openspec/changes/archive/2026-06-21-add-forge-token-help-docs/design.md`
    Decisions 2–3 + `proposal.md` lines 11, 27; component at
    `apps/web/src/components/markdown/markdown.tsx`.
  - Relevance: REUSE the no-`rehype-raw` + components-token-map + default-`urlTransform`
    approach wholesale (already proven and shipped). REUSE the "raw HTML renders inert"
    security-test pattern. But that change explicitly scoped itself to TRUSTED content;
    the new transcript change must NOT blindly reuse the same component because the
    `markdown.tsx` header comment marks it TRUSTED and it (a) renders `<img>` by default
    and (b) adds heading slug ids — both forbidden by the new untrusted requirement.

- **The existing `Markdown` component has exactly the two untrusted-unsafe traits the
  new change calls out.** It does NOT disallow `img` (so `![](url)` loads remote
  images), and its h2/h3 map adds `id={slugify(...)}` heading anchors. Its `<a>` already
  does `target=_blank rel=noopener noreferrer` + `break-all` (safe to reuse), and it
  relies on react-markdown's default `urlTransform` (no override).
  - Evidence: `apps/web/src/components/markdown/markdown.tsx:42-123`.
  - Relevance: confirms the reuse-vs-new tension is real. Option (b) new
    `TranscriptMarkdown` is cleaner: omit the slug-id h2/h3 map, add
    `disallowedElements=['img']` (or `components.img=()=>null` / link-downgrade), keep the
    safe `<a>`/code/pre/table maps. Option (a) adding an untrusted-mode flag to the shared
    component risks regressing the forge help page. The slug machinery (`textOf`/`slugify`)
    is dead weight for transcript.

- **The `SessionTurn` contract is fully specified across the two archived transcript
  changes and is frozen.** `wire-transcript-real-data` added optional `at?`, the
  `system` turn kind, tool diffstat, and meta totals; `unify-transcript-parsers` (Part 2)
  decided to map reasoning/thinking to `assistant{isFinalAnswer:false}` (rendered
  「推理」) rather than add a `reasoning` kind — so the contract is frozen and the new
  change needs ZERO contract change. Both changes ALSO declared as a hard rule that the
  turn text is markdown-faithful raw text and the parser stays rollout-only / no frontend
  contract change.
  - Evidence:
    `openspec/changes/archive/2026-06-21-wire-transcript-real-data/specs/session-history-replay/spec.md`
    + `tasks.md` 1.1–1.4;
    `openspec/changes/archive/2026-06-22-unify-transcript-parsers/proposal.md` lines
    52–55, 99–101.
  - Relevance: validates the non-goal "don't touch backend/@cap/contracts." The new change
    is purely a frontend render swap of `ev.text`. Reuse the discriminated-union kinds
    exactly: `assistant{isFinalAnswer:false}`=推理, `assistant{isFinalAnswer:true}`=最终回答,
    user=操作者, tool (args=code, output=`<pre>`), system (plain). The backward-compat
    reasoning-channel decision means markdown rendering automatically covers both codex and
    claude reasoning turns.

- **The current `TxRow` renders all four text-bearing turns as plain text divs.** user
  text at line 223 (`<div className='…text-foreground'>{ev.text}</div>`), reasoning at 232
  (italic muted), final answer at 282 (success-soft bubble); tool args is a `<code>`
  (245, `whitespace-pre-wrap break-all`) and tool output is a `<pre>` (266). `TxRow` is
  exported specifically so its per-kind render is unit-testable off a `SessionTurn`
  fixture.
  - Evidence: `apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx:199-290` (user 223,
    reasoning 232, final 282, tool args 245, tool output 266); export comment 193–198.
  - Relevance: these are the EXACT four JSX insertion points — wrap `ev.text` (user,
    reasoning, final) in `<TranscriptMarkdown>`; leave tool args `<code>` and output
    `<pre>` untouched (regression assert). The compact slot styling (56px gutter,
    `text-[13px] leading-relaxed`) means the `TranscriptMarkdown` components map must use
    tighter spacing than the forge help page's prose (`my-2.5` / `mt-9`) — the explore's
    "compact, not prose" note is correct. The reasoning turn's italic-muted wrapper and the
    final-answer's success-soft bubble must be preserved AROUND the markdown.

- **The transcript test harness is already built and reusable.**
  `$taskId_.transcript.test.tsx` renders `TxRow` via `react-dom/server`
  `renderToStaticMarkup` in the node-env vitest suite (no jsdom/@testing-library);
  react-markdown renders fine under `renderToStaticMarkup`, so the markdown + security unit
  tests fit the existing pattern with no new test infra. NOTE: this vitest suite is NOT in
  the CI gate per `unify-transcript-parsers` (the `.mjs` parser tests run standalone) — but
  the `.test.tsx` transcript suite IS collected by `vitest.config` include and runs with the
  web vitest run.
  - Evidence: `apps/web/src/routes/_app/tasks/$taskId_.transcript.test.tsx:17-99`
    (`renderToStaticMarkup` pattern, fixtures `toolTurn`/`reasoningTurn`/`finalTurn`,
    `html.toContain` asserts); `apps/web/vitest.config.ts:24-30`.
  - Relevance: REUSE this exact file and pattern: extend with fixtures whose text contains
    `**bold**`/table/list/inline-code/code-fence and assert `<strong>`/`<table>`/`<ul>`/
    `<code>`/`<pre>` in the static markup; add security fixtures (`<script>`,
    `![x](http://evil)`, `[x](javascript:...)`) asserting escaped/no-`<img>`/filtered. The
    existing tool args/output regression asserts (57–99) already cover "don't markdown-ify
    tool turns" — extend them. No need to invent a render harness.

- **The installed react-markdown is `^10.1.0` (NOT 9.x as the explore text guessed).**
  Verified in `node_modules`: `defaultUrlTransform` enforces
  `safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i` (so `javascript:`/`data:` dropped by
  default), and `allowedElements`/`disallowedElements`/`urlTransform`/`components` are all
  supported APIs. `allowedElements` and `disallowedElements` cannot be combined.
  - Evidence: `apps/web/package.json`; `node_modules/react-markdown/lib/index.js:124`
    safeProtocol, `:320` urlTransform default, `:340-342` cannot combine allowed/disallowed,
    `:389-391` element filtering.
  - Relevance: confirms the security defaults the explore relies on hold in the installed
    version: dangerous-protocol filtering is FREE (no `urlTransform` override needed for
    links). For disabling `img`, use `disallowedElements=['img']` OR `components.img=()=>null`
    (NOT both allowed+disallowed). The 10.x major (vs the explore's "9.x") doesn't change these
    APIs but should be stated correctly in the proposal.

- **The transcript visual gate is already wired and calibrated.** `manifest.ts` has a
  `transcript` entry pointed at `TRANSCRIPT_TASK_ID` (the COMPLETED mock task whose
  `mockSessionHistory` resolves to `available`), with readySelector `.bg-success-soft` and
  MEASURED thresholds `maxDiffPixelRatio` desktop 0.06 / mobile 0.08 (calibrated via
  `VV_MEASURE`). Baseline screenshots exist (`transcript-desktop.png` /
  `transcript-mobile.png`) against `design-baseline/screens/transcript.html`.
  - Evidence: `apps/web/e2e/visual/manifest.ts:116,227-243`;
    `apps/web/e2e/visual/__screenshots__/transcript-{desktop,mobile}.png`.
  - Relevance: markdown-rendering the mock transcript text WILL shift pixels (mock
    final-answer/user text becomes rich elements). Follow the `wire-transcript-real-data`
    playbook (tasks 6.1–6.3): re-run `VV_MEASURE=1 pnpm test:visual`, re-calibrate the
    threshold with a rationale comment, then run twice for determinism (mock timestamps are
    fixed). The readySelector `.bg-success-soft` still works since the final-answer bubble
    keeps that class. **Caveat (`visual-gate-baseline-path-broken` memory):** `test:visual`
    ROOT was broken pointing at an archived design-baseline; verify the
    `serve-design-baseline` path before relying on the gate.

---

## Implications for the proposal

1. **Build a small `TranscriptMarkdown`, do not reuse `markdown.tsx` and do not adopt
   Streamdown.** All three routes converge here. The trusted `Markdown` component
   (codebase + archive) is unsafe for untrusted agent text because it renders `<img>` by
   default and adds heading slug ids, and its prose margins (`my-2.5` / `mt-9` /
   `max-w-[760px]`) misfit the compact 56px-gutter timeline. Streamdown (web) is the right
   posture but the wrong dependency (KaTeX/streaming/CSV bloat) given the non-goal of no
   new deps. The recommendation is option (b): a new `TranscriptMarkdown` that copies the
   safe parts of `markdown.tsx` (`a` map with `target=_blank rel=noopener`, code/pre/table
   maps, default-HTML-escape posture) and adds untrusted-specific behavior.

2. **Security is free and built-in; the only required posture is "do nothing dangerous."**
   - Keep the default `urlTransform` (never override it) → `javascript:`/`data:`/`vbscript:`
     stripped automatically (web + codebase + archive, verified in installed 10.1.0).
   - Never add `rehype-raw` → raw HTML (`<script>`) escapes to inert text (web + archive
     precedent; CopilotKit #3938 is the cautionary prior art).
   - Block images via `disallowedElements=['img']` for a clean remove, OR
     `components.img=() => <span>[Image blocked: {alt}]</span>` to follow Vercel
     `rehype-harden`'s `[Image blocked: alt]` degrade UX (web). Decide remove vs
     indicator/text-only and state it. Note: `allowedElements` and `disallowedElements`
     cannot be combined, so pick one strategy.
   - No heading slug ids (drop the `markdown.tsx` h2/h3 `id={slugify}` map — dead weight and
     a needless surface).
   - Treat any future `remarkPlugins`/`rehypePlugins`/`components` as a reviewable XSS
     surface.

3. **Correct the version assumption.** The proposal must say `react-markdown ^10.1.0`
   (installed 10.1.0), not 9.x. Same API surface for this work; no migration concern.

4. **Resolve the "保留换行" tension explicitly — this is the one open design decision.** GFM
   folds single newlines into spaces; only blank lines start paragraphs. To preserve
   intra-paragraph newlines you must either (a) accept `remark-breaks` as an allowed new
   dependency (contradicts the current non-goal), or (b) re-scope "保留换行" to paragraph-level
   breaks only (which GFM already gives) and document that single newlines collapse. The CSS
   `white-space:pre-wrap` workaround is reported to break list/paragraph spacing in compact
   layouts and should be avoided. The proposal must pick (a) or (b) and update the non-goals
   accordingly.

5. **Edit exactly three JSX sites; leave tool/system untouched.** In `TxRow`
   (`$taskId_.transcript.tsx`), wrap `ev.text` in `<TranscriptMarkdown>` for: user (line 223),
   reasoning (232–234, preserving the italic/muted wrapper around the markdown), and final
   answer (282–284, inside the `.bg-success-soft` bubble). Tool args `<code>` (245), tool
   output `<pre>` (266), and system stay byte-for-byte unchanged and are protected by
   regression assertions.

6. **No backend / contract changes.** `SessionTurn` (`@cap/contracts`) already carries the
   markdown string as plain `z.string()`; the reasoning-channel mapping
   (`assistant{isFinalAnswer:false}`) means markdown rendering covers codex and claude
   uniformly. The change is purely frontend and runtime-agnostic. A delta-spec on
   `session-history-replay` is the right place to record the new "turn text MUST render
   markdown with untrusted hardening" requirement.

7. **Tests fit the existing harness with zero new tooling.** Extend
   `$taskId_.transcript.test.tsx` (node-env vitest, `renderToStaticMarkup`) with markdown
   fixtures (`**bold**` → `<strong>`, table → `<table>`, list → `<ul>`, inline+fenced code →
   `<code>`/`<pre>`) and security fixtures (`<script>` → escaped `&lt;script&gt;`,
   `![x](http://evil)` → no `<img`, `[x](javascript:...)` → empty href). Keep the existing
   tool args/output regression asserts green.

8. **Plan for the visual gate shift and the styling that controls it.** Because the current
   mock fixture text has no markdown syntax, paragraph spacing is the deciding factor: give
   `TranscriptMarkdown` compact, marginless paragraph styling matching the current
   `text-[13px] leading-relaxed` row to stay within thresholds, and add a `table` override
   wrapping `<table>` in an `overflow-x:auto` div for the narrow column. If the change wants
   to SHOW markdown in the baseline, enrich the `mock.ts` fixture text AND update
   `transcript.html` (served from the archived design-baseline). Either way, follow the
   `wire-transcript-real-data` recalibration playbook (`VV_MEASURE=1`, rationale comment, run
   twice) and first verify the `serve-design-baseline` ROOT path is not the broken archived
   one (`visual-gate-baseline-path-broken`).
