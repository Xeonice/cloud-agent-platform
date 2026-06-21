# Research Brief: add-forge-token-help-docs

A forge-token help page for the console, surfacing how operators (human) and agents (terminal) mint
GitHub / GitLab / Gitee access tokens with the right scopes, reachable from the settings forge-credentials
card. This brief synthesizes findings across three research routes — Web, Codebase, and Archive — and closes
with implications for the proposal.

---

## Web route

External / industry findings on the proposed rendering stack, security posture, and forge-specific
token-creation deep links.

### Rendering stack & security

- **react-markdown is XSS-safe by default.** It converts each markdown token into a React element, so JSX
  escaping handles security; raw HTML (e.g. `<script>`) is ignored/rendered as text, and
  `dangerouslySetInnerHTML` is not used. `rehype-raw` is the *only* thing that re-introduces HTML/JS
  execution risk. For these two trusted, app-authored markdown files, pair `react-markdown` + `remark-gfm`
  and deliberately **do not add `rehype-raw`**. Because the content ships in-repo and is trusted, no
  `rehype-sanitize` is required either — keeping the dependency footprint minimal.
  - Evidence: [remarkjs/react-markdown README security section](https://github.com/remarkjs/react-markdown);
    [HackerOne — Secure Markdown Rendering in React](https://www.hackerone.com/blog/secure-markdown-rendering-react-balancing-flexibility-and-safety)

- **Vite `?raw` is the idiomatic way to load a `.md` file as a build-time string.** e.g.
  `import helpZh from './forge-tokens.zh.md?raw'`. Vite bundles it inline (it does not appear in `dist` as a
  separate file) and HMR re-renders on edit. This is the standard pattern paired with react-markdown,
  avoiding any custom Vite markdown plugin. Note: add a `declare module '*.md?raw'` ambient type (or rely on
  `vite/client` types) so the strict-typecheck repo accepts the import (CI runs `turbo typecheck`).
  - Evidence: [dev.to — load & render markdown in Vite+React+TS](https://dev.to/onticdani/how-to-load-and-render-markdown-files-into-your-vite-react-app-using-typescript-26jm);
    [react-markdown npm usage docs](https://www.npmjs.com/package/react-markdown)

- **Prefilled-PAT-link UX is established prior art (JetBrains, others).** GitHub's chakra-ui issue #1737 and
  the dev.to writeup show apps linking users to a settings/tokens URL with scopes+description pre-filled so
  the user only clicks "Generate" — exactly the human-version pattern. Confirms the proposed UX is an
  industry-standard convenience pattern (not a novel risk) and reinforces splitting human-version
  (one-click prefilled web link) from agent-version (terminal-first) as a recognized dual-audience approach.
  - Evidence: [chakra-ui issue #1737](https://github.com/chakra-ui/chakra-ui/issues/1737);
    [dev.to — link to a pre-filled new GitHub PAT page](https://dev.to/dakdevs/conveniently-link-to-a-pre-filled-new-github-personal-access-token-page-dn)

### Forge-specific token deep links & scopes

- **GitHub fine-grained PAT template/deep-link URLs (announced Aug 2025).** Base:
  `https://github.com/settings/personal-access-tokens/new`; permissions are query params using the exact
  names `contents` and `pull_requests` with values `read`/`write` (e.g. `?contents=write&pull_requests=write`),
  plus `name`, `description`, `target_name`, `expires_in`. Classic PATs use the older
  `https://github.com/settings/tokens/new?scopes=repo&description=...` prefill. Backs the human-version
  content (Contents + Pull requests read/write fine-grained; repo/public_repo classic) and enables a richer
  agent deep link than the bare page. GitHub needs **no instance address** (always github.com), matching the
  proposal's "GitHub: no host prompt" design.
  - Evidence: [github.blog changelog — template URLs for fine-grained PATs](https://github.blog/changelog/2025-08-26-template-urls-for-fine-grained-pats-and-updated-permissions-ui/);
    [GitHub docs — managing PATs (`contents`, `pull_requests`, `metadata`)](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

- **GitLab prefilled deep link.**
  `https://<host>/-/user_settings/personal_access_tokens?name=...&description=...&scopes=api,read_repository,write_repository`.
  The `<host>` is **required** (gitlab.com default but self-managed instances differ), confirming the agent
  step "ask the user for instance host (default gitlab.com) before constructing the deep link." Scope nuance:
  `api` is broad (sufficient for push+MR); `read_repository`/`write_repository` are the narrower
  least-privilege alternatives — the help page can present `api` as the simple path and the two `_repository`
  scopes as least-privilege.
  - Evidence: [GitLab docs — personal access tokens (URL prefill name/description/scopes)](https://docs.gitlab.com/user/profile/personal_access_tokens/)

- **Gitee personal access tokens ('私人令牌').** Created at `gitee.com/profile/personal_access_tokens` via
  Settings → 私人令牌 → 生成新令牌; scope set includes `projects` and `pull_requests` (plus user_info, issues,
  notes, keys, hook, groups, gists). **No documented query-param prefill was found**, so the Gitee deep link
  can only target the creation page — scope selection must be described in prose (the user manually ticks
  projects + pull_requests). This is an asymmetry the change should document: unlike GitHub/GitLab, the
  agent-version can only deep-link to the page and must instruct which checkboxes to tick.
  - Evidence: [bluelovers/gitee-api-token](https://github.com/bluelovers/gitee-api-token);
    Gitee scope list via [raycast/koinzhang/gitee](https://www.raycast.com/koinzhang/gitee) and Gitee docs

- **`gh auth login --scopes <csv>` mints a token in pure terminal.** Runs the default browser OAuth flow
  requesting exactly those scopes (`gh auth login --scopes repo`) without visiting a settings page; existing
  token scopes can be expanded with `gh auth refresh --scopes ...`. Directly backs the agent-version GitHub
  path. Worth noting: this produces an **OAuth token stored by gh, distinct from a PAT** — the user may need
  `gh auth token` to print it for pasting into the forge-credentials dialog, since the console stores a PAT
  string, not gh's keychain entry.
  - Evidence: [cli.github.com — gh_auth_login](https://cli.github.com/manual/gh_auth_login);
    [cli.github.com — gh_auth_refresh](https://cli.github.com/manual/gh_auth_refresh)

### Console integration points (observed in-repo via the web route)

- **Tailwind v4 is CSS-first with NO `tailwind.config.js`.** `apps/web/src/styles/app.css` is the single
  entry (`@import "tailwindcss"`). If `@tailwindcss/typography` is chosen, it is enabled by adding
  `@plugin "@tailwindcss/typography";` to that CSS file (the v4 mechanism), then using `prose dark:prose-invert`
  on the wrapper. Tokens live in `app.css` `@theme inline` with a custom `.dark` scope, so prose styling must
  be reconciled with those tokens (prose-invert under `.dark`, or prose-headings/prose-a overrides) to avoid
  the "desaturation" the file warns about.
  - Evidence: `apps/web/src/styles/app.css` header comment;
    [tailwindlabs/tailwindcss-typography (v4 @plugin setup)](https://github.com/tailwindlabs/tailwindcss-typography)

- **No markdown stack is installed anywhere in the monorepo.** `apps/web` has only `@tailwindcss/vite` 4.3.0
  + `tailwindcss` 4.3.0; no `prose`/markdown renderer exists. This change introduces the first
  markdown-rendering path in the console — it must add `react-markdown` + `remark-gfm` and decide between
  `@tailwindcss/typography` vs a hand-rolled components map. With no existing prose baseline, a lightweight
  `components={{...}}` map onto existing design tokens may match the OD/Geist aesthetic better than the
  plugin's opinionated defaults.
  - Evidence: `apps/web/package.json` (no markdown/remark/rehype/typography); repo-wide grep for
    `react-markdown|prose|MarkdownRenderer` returned zero hits

- **TanStack Router file-based routes under `apps/web/src/routes/_app/`** (api.tsx, dashboard.tsx, history.tsx,
  repositories.tsx, settings.tsx, tasks/). A new help page follows the same one-file pattern:
  `createFileRoute('/_app/help/forge-tokens')({ component: ... })`, rendered inside the existing `_app` shell
  `<Outlet/>` (sidebar/topbar already provided). The `api.tsx` route (api-playground precedent) is the
  closest sibling for a content-style in-shell page. The help route should live under `_app` to inherit auth
  + shell, reachable by direct URL and from the forge card link.
  - Evidence: `apps/web/src/routes/_app/` listing; `apps/web/src/routes/_app/repositories.tsx` header comment;
    `apps/web/src/routes/_app/api.tsx`

- **`forge-credentials-card.tsx` has two clear link-insertion points.** (1) Each `ROWS` entry already renders
  a per-forge `hint` `<p>` under the label — a "如何申请令牌?" link per row can be appended there keyed by
  `row.kind`; (2) the connect Dialog renders a `DialogDescription` ("在对应平台创建一个访问令牌并粘贴…"),
  the natural spot for a forge-anchored link in the popup. The card already imports Dialog primitives and uses
  TanStack patterns, so adding `<Link to="/help/forge-tokens" hash={kind}>` is low-friction. The `ROWS`
  already encode per-forge scope hints ("需 repo 范围的 PAT", "需 api 范围", "需 projects + pull_requests 范围"),
  which the help page should keep consistent with.
  - Evidence: `apps/web/src/components/settings/forge-credentials-card.tsx` (ROWS array ~lines 33-37; row hint
    `<p>`; Dialog/DialogDescription block)

---

## Codebase route

In-repo findings on where the change lands, what is net-new, and the exact files/lines to touch.

- **A matching OpenSpec change `add-forge-token-help-docs` already exists but is a stub** — only
  `.openspec.yaml` (schema: spec-driven, created 2026-06-21), no proposal/tasks/specs yet. Populate THIS
  existing directory rather than creating fresh. Sibling open changes: redesign-settings-single-column,
  session-approval-flow, static-terminal-log.
  - Evidence: `/Users/tanghehui/ExploreProject/cloud-agent-platform/openspec/changes/add-forge-token-help-docs/.openspec.yaml` (only file in dir)

- **NO markdown stack is installed anywhere in the monorepo** — zero hits for react-markdown / remark-gfm /
  @tailwindcss/typography / prose / `?raw` across apps/web, apps/www, packages. `react-markdown` +
  `remark-gfm` are net-new deps for `apps/web/package.json`. `@tailwindcss/typography` is also absent — must
  be added and wired, OR the prose look hand-rolled with a components map.
  - Evidence: grep across `/apps/web/src`, `/apps/www`, `/packages` empty for all four;
    `apps/web/package.json` dependencies block

- **Tailwind v4 is CSS-first with NO `tailwind.config.js`.** Tokens live in `app.css` via `@theme inline` +
  `@import "tailwindcss"`. Adding `@tailwindcss/typography` (a JS plugin) in v4 is done via
  `@plugin "@tailwindcss/typography";` in the CSS entry, not a config file. A components-map on react-markdown
  (mapping h1/p/a/code/ul to existing token utilities like text-ink, text-muted-foreground, text-accent-foreground)
  avoids the plugin entirely and stays on-token — likely the lower-risk path given the bespoke design system.
  - Evidence: `apps/web/src/styles/app.css:9-21`

- **`forge-credentials-card.tsx` already has the per-forge ROWS array and a connect Dialog** — the exact
  insertion points. Each row renders label+hint (lines 34-38, 101-104) and the dialog has a DialogDescription
  + host/token fields (lines 152-179). `ForgeKind = 'github'|'gitlab'|'gitee'`, `PUBLIC_HOST` map already
  present (lines 28-32). Per-row link goes near the hint (~101-104); the in-dialog link near DialogDescription
  (~152). Anchor target derives from `row.kind` / `dialogKind`; PUBLIC_HOST already holds the
  gitlab.com/gitee.com defaults the agent-version copy needs.
  - Evidence: `apps/web/src/components/settings/forge-credentials-card.tsx:28-38, 94-131, 152-179`

- **The card is mounted in settings under `<section id="forges">`** inside a single-column `max-w-[640px]`
  stack; the page is SSR-rendered behind the `_app` auth gate with a parallel loader. The forge card is
  self-contained (reads `forgeCredentialsQuery`, no extra wiring). The help page must be reachable from a
  settings (`_app`-gated) surface; the link navigates within the authed shell. No loader changes needed if
  help content is a static markdown import.
  - Evidence: `apps/web/src/routes/_app/settings.tsx:75-91, 176-180`

- **Route-adding precedent is exact (archived add-api-playground).** It added `routes/_app/api.tsx` via
  `createFileRoute('/_app/api')` + `component:`, registered a NavKey ('api') and NAV_ENTRIES/MOBILE_ENTRIES
  rows in app-sidebar.tsx + mobile-nav.tsx, plus a manifest pixel baseline. A simpler content route
  (resume.tsx) shows the standalone-page pattern with just `createFileRoute` + `component`. UNLIKE
  api-playground, a help page likely should NOT add a sidebar/mobile-nav entry (reached from the forge card,
  not a top-level nav item) — so the NavKey/nav-entry steps are intentionally skipped, but createFileRoute +
  manifest-baseline steps apply.
  - Evidence: `openspec/changes/archive/2026-06-19-add-api-playground/proposal.md:7,13,14`;
    `apps/web/src/components/shell/app-sidebar.tsx:37,75-80`; `apps/web/src/routes/resume.tsx:61-70`

- **`routeTree.gen.ts` is auto-generated and gitignored** (`src/routeTree.gen.ts` in apps/web/.gitignore line 2).
  New file-routes register by adding the file under `src/routes/_app/`; the generator wires it — no manual
  routeTree edit. CI/worktrees need it regenerated.
  - Evidence: `apps/web/.gitignore:2`; `apps/web/src/routeTree.gen.ts` header

- **Vite `?raw` imports work in this SPA.** `tsconfig` includes `"types": ["vite/client", "node"]` (provides
  the `*?raw` module declaration), and the build is Vite-native (tsconfigPaths + tailwindcss + tanstackStart +
  viteReact + nitro). A `?raw` markdown import resolves to a static string at build time, SSR-safe (no
  window/clock/random). Clean integration:
  `import humanMd from './forge-tokens.zh.md?raw'` then `<ReactMarkdown remarkPlugins={[remarkGfm]}>{humanMd}</ReactMarkdown>`.
  - Evidence: `apps/web/tsconfig.json` (`types: ["vite/client", "node"]`); `apps/web/vite.config.ts`

- **The Dialog component is shadcn/radix-based** with DialogContent/Body/Description/Title primitives;
  supports custom sizing via className (forge card uses `sm:max-w-[520px]`). No `.dialog-sm` CSS class exists
  — sizing is utility-driven. If "如何申请令牌?" opened content in a dialog, the existing primitives suffice;
  but the task spec calls for a dedicated markdown help PAGE, so a route is the primary surface and a link
  (not a dialog) from the card is the lighter touch.
  - Evidence: `apps/web/src/components/ui/dialog.tsx:48-80, 152-163`; `forge-credentials-card.tsx:139-143`

- **The visual pixel-gate harness (`test:visual`) registers every page in `e2e/visual/manifest.ts`** via the
  VisualPage interface (id, appPath, designPath, authed, maxDiffPixelRatio, masks, readySelector), comparing
  app render vs an OpenDesign HTML baseline. A new help page needs either a manifest baseline entry (requires
  a matching design-baseline HTML) OR an explicit decision to skip the pixel gate. Since no OD HTML exists for
  a markdown help page, the proposal should likely NOT add it to the pixel manifest, or note the design source
  must be created first.
  - Evidence: `apps/web/e2e/visual/manifest.ts:81-101,127-263`; `apps/web/playwright.config.ts:1-40`

- **`@cap/ui/styles.css` is a standalone fallback;** apps/web compiles @cap/ui component classes with its OWN
  `app.css` as the single source of truth. @cap/ui is tsc-only and does not run Tailwind. Any prose/typography
  styling (plugin or @theme additions) must go in `apps/web/src/styles/app.css` to take effect — adding it
  only to @cap/ui would not compile into the console. The markdown renderer and its styles belong in apps/web.
  - Evidence: `packages/ui/src/styles.css:1-20`

- **Existing forge-card hint copy already encodes the scope guidance** the human-version help page must expand:
  GitHub "需 repo 范围的 PAT", GitLab "需 api 范围", Gitee "需 projects + pull_requests 范围"; the connect
  dialog copy says "自托管请填写实例地址". The help-page content can be authored consistent with (and
  de-duplicating) these strings; per-forge anchors (#github/#gitlab/#gitee) map 1:1 to the ROWS kinds.
  `ForgeKindSchema = z.enum(['github','gitlab','gitee'])` confirms the canonical anchor set.
  - Evidence: `apps/web/src/components/settings/forge-credentials-card.tsx:34-38, 152-154`

---

## Archive route

Findings from the archived add-api-playground change (the closest structural precedent) and other archived
material — proposal/spec/tasks/design templates to reuse and pitfalls to avoid.

- **add-api-playground is the closest structural precedent for adding a new console page.** It added a new
  authed route at `routes/_app/api.tsx` via `createFileRoute("/_app/api")`, composing inside the existing
  `_app <Outlet/>` WITHOUT rebuilding the shell, gated behind the `_app` auth wrapper like
  dashboard/repositories/history/settings. The help page should follow the IDENTICAL pattern: a new
  `routes/_app/<help>.tsx` with createFileRoute under `_app`, composing inside the Outlet. Reuse this
  "additive page behind the gate, do not rebuild shell" recipe verbatim. `routeTree.gen.ts` is gitignored +
  auto-regenerated, not a source file to edit.
  - Evidence: `openspec/changes/archive/2026-06-19-add-api-playground/proposal.md:7`;
    `apps/web/src/routes/_app/api.tsx:60-62`

- **add-api-playground split capabilities into a NEW capability spec (api-playground) plus a MODIFIED
  frontend-console spec.** The frontend-console delta added two requirements: "(page) is in the route tree and
  navigation" and "(page) has a per-page pixel baseline", each with WHEN/THEN scenarios. Reuse this structure:
  a new capability for the help-page content (markdown rendering + the two-version GitHub/GitLab/Gitee content),
  plus a frontend-console MODIFIED delta for route-tree+nav reachability. The route+nav scenario shape ("WHEN
  operator activates the entry THEN navigates / unauth visitor is gated") ports directly.
  - Evidence: `openspec/changes/archive/2026-06-19-add-api-playground/specs/frontend-console/spec.md:3-19`;
    `proposal.md:19-23`

- **add-api-playground tasks.md uses a track-annotated parallel partition with an explicit file-map comment
  block** mapping each track to DISJOINT files (request-runner / catalog-panels / page-stream / navigation /
  pixel-baseline), noting NO integration track because no file is written by >1 track. For a help-page change
  the natural disjoint tracks are: (1) markdown content source files + renderer component, (2) the route page,
  (3) forge-credentials-card link insertion + dialog link, (4) optional pixel baseline. Reuse the file-map
  header comment convention so apply can parallelize and the partition is auditable.
  - Evidence: `openspec/changes/archive/2026-06-19-add-api-playground/tasks.md:1-12,14-40`

- **NO markdown tooling exists anywhere in the repo** — no react-markdown, remark-gfm, rehype, marked, or
  markdown-it in any package.json. Even apps/www (marketing site) hardcodes content in components rather than
  rendering markdown, so there is zero markdown-rendering precedent to lift. The proposal must list
  react-markdown + remark-gfm as a real dependency-addition impact, not "reuse existing".
  - Evidence: grep `react-markdown|remark|rehype|marked|markdown-it` across all package.json → only a
    `@tailwindcss/vite` false positive

- **NO `?raw` Vite imports and NO `prose` class are used anywhere in apps/web/src.** Styling is Tailwind v4
  CSS-first (no tailwind.config.js) with CUSTOM tokens (text-ink, bg-card, shadow-ring, text-muted-foreground)
  via `@theme inline` in `app.css`; `@tailwindcss/typography` is NOT installed/registered. Two consequences:
  (a) `?raw` markdown import is unproven in this SPA — must be validated (or import the .md as a string module);
  (b) prose styling must EITHER add `@tailwindcss/typography` via the v4 `@plugin` directive OR (more
  consistent with the codebase) supply a components-mapping to react-markdown using existing token utilities.
  The "prose vs components-map" decision is a real Decision the proposal must record.
  - Evidence: grep `?raw`/`prose` in apps/web/src → empty; `apps/web/src/styles/app.css:21-22`
  - *(Note: this archive-route conclusion that `?raw` is "unproven" is tempered by the codebase-route finding
    that `vite/client` types already cover the `?raw` suffix — see Implications.)*

- **forge-credentials-card.tsx is composed by `routes/_app/settings.tsx` (line 179)** and already contains
  per-row hints, a per-row 连接 button, and a connect Dialog with host+token inputs — the exact insertion
  points for a "如何申请令牌?" link (per-row and inside the dialog DialogDescription area). The link-insertion
  is purely within forge-credentials-card.tsx — a self-contained, single-track edit.
  - Evidence: `apps/web/src/components/settings/forge-credentials-card.tsx:34-38, 94-131, 152-155`;
    `settings.tsx:179`

- **The sidebar nav uses a typed NavKey union + activeNavKey(pathname) helper + a NAV_ENTRIES list**
  {key,to,label,shortcut}; add-api-playground extended NavKey with 'api', added activeNavKey matching, added
  the entry, and ALSO mirrored it into mobile-nav.tsx (intra-track serial coupling). IF the help page got its
  own sidebar entry, the proposal must extend NavKey + activeNavKey + NAV_ENTRIES AND mirror into
  mobile-nav.tsx. HOWEVER, reachability is from the settings forge card link, NOT a global nav entry — so this
  nav-extension may be intentionally OUT of scope (a help page reached only by contextual link). Worth an
  explicit non-goal.
  - Evidence: `apps/web/src/components/shell/app-sidebar.tsx:37,47,76-79`;
    `archive add-api-playground tasks.md:32-35`

- **The visual/pixel-baseline harness is OPT-IN per page and tightly coupled to an OpenDesign HTML baseline**
  (pages register a designPath pointing at a screens/<page>.html prototype, with a recorded maxDiffPixelRatio).
  A pixel baseline requires a matching OD screens/*.html. add-api-playground had a screens/api.html; the help
  page likely has none. The proposal should EITHER explicitly defer the pixel baseline (simplest, since this is
  a content/markdown page not a pixel-faithful port) OR commission an OD baseline first — making the pixel
  baseline an explicit non-goal avoids a broken/empty manifest row.
  - Evidence: `openspec/changes/archive/2026-06-19-add-api-playground/specs/frontend-console/spec.md:12-19`;
    `verification-report.md:70-76`; `apps/web/e2e/visual/manifest.ts` header

- **add-api-playground's design.md follows a fixed template** (Context / Goals+Non-Goals / numbered Decisions
  D1..D6 with Why+Alternative / Risks / Migration Plan / Open Questions); its verification-report.md does
  adversarial three-way routing with a Scope finding enumerating each beyond-spec behavior. Reuse this
  design.md skeleton. Decisions to pin for the help page: D-renderer (react-markdown+remark-gfm vs
  alternative), D-styling (typography plugin vs token components-map), D-content-source (.md ?raw vs inline
  string), D-two-versions (human vs agent content split), D-reachability (settings link only, no nav slot),
  D-scope (no token-into-sandbox / no gh/glab preinstall / no deliver-flow / not on www — mirroring the
  change's explicit Non-Goals discipline).
  - Evidence: `openspec/changes/archive/2026-06-19-add-api-playground/design.md:1-57`;
    `verification-report.md:9-13,96-137`

---

## Implications for the proposal

**1. Populate the existing stub, don't create fresh.** The `add-forge-token-help-docs` change already exists
with only `.openspec.yaml`. Fill in proposal.md, design.md, tasks.md, and specs against THIS directory.

**2. Lock the rendering stack: `react-markdown` + `remark-gfm`, no `rehype-raw`, no `rehype-sanitize`.**
These are net-new deps for `apps/web/package.json` (zero markdown tooling exists anywhere in the repo — all
three routes independently confirm this). Because content is trusted and app-authored, react-markdown's
default JSX-escaping is sufficient; explicitly NOT adding `rehype-raw` is the security guardrail to bake into
the design as a Decision.

**3. Resolve the `?raw` "unproven" tension in favor of using it.** The archive route flagged `?raw` as
unused/unproven, but the codebase route confirms `apps/web/tsconfig.json` already includes `vite/client`
types, which provide the `*?raw` module declaration, and the build is Vite-native. Conclusion: use
`import md from './forge-tokens.zh.md?raw'`; add a `declare module '*.md?raw'` ambient type only if typecheck
complains (CI runs `turbo typecheck`). Content lives in `.md` source files alongside the route — SSR-safe,
deterministic, no fetch.

**4. Prefer a token-based `components={{...}}` map over `@tailwindcss/typography`.** Tailwind v4 here is
CSS-first with no config file and a bespoke token system (text-ink, text-muted-foreground, bg-card). A
components-map keeps the help page on-token and on the OD/Geist aesthetic, avoids the plugin's opinionated
defaults and the prose-invert/desaturation reconciliation under `.dark`, and adds no JS plugin. Record
"prose plugin vs components-map" as an explicit Decision; if the plugin is chosen instead, it must be wired
via `@plugin "@tailwindcss/typography";` in `apps/web/src/styles/app.css` (the v4 mechanism) — and styles
must live in apps/web's app.css, never @cap/ui (which is tsc-only and doesn't run Tailwind).

**5. New route under `_app`, mirroring `api.tsx`; no sidebar/nav entry.** Add
`routes/_app/help/forge-tokens.tsx` (or `routes/_app/forge-tokens.tsx`) via
`createFileRoute('/_app/help/forge-tokens')({ component })`, composing inside the existing Outlet — do not
rebuild the shell. `routeTree.gen.ts` auto-regenerates (gitignored). Unlike add-api-playground, intentionally
SKIP the NavKey/NAV_ENTRIES/mobile-nav extension — the page is reached contextually from the forge card, not
a top-level nav slot. Make "no global nav entry" an explicit non-goal.

**6. Wire two link-insertion points in `forge-credentials-card.tsx` (one self-contained track).** Per-row
"如何申请令牌?" link next to each `row.kind` hint (~lines 101-104) and an in-dialog link near
`DialogDescription` (~line 152), both `<Link to="/help/forge-tokens" hash={kind}>`. Anchors
`#github/#gitlab/#gitee` map 1:1 to `ForgeKindSchema = z.enum(['github','gitlab','gitee'])`. Keep help-page
scope copy consistent with the existing ROWS hints ("需 repo 范围", "需 api 范围", "需 projects + pull_requests 范围")
to avoid drift.

**7. Author dual-audience content per forge, using real deep links where they exist.**
- *GitHub* — no host prompt (always github.com). Human: fine-grained PAT deep link
  `https://github.com/settings/personal-access-tokens/new?contents=write&pull_requests=write` (plus classic
  fallback `?scopes=repo`). Agent: `gh auth login --scopes repo`, then `gh auth token` to print it for pasting
  (note the gh-OAuth-token-vs-PAT distinction).
- *GitLab* — host required (default gitlab.com). Human/agent deep link
  `https://<host>/-/user_settings/personal_access_tokens?scopes=api` (mention `api` as simple path,
  `read_repository`+`write_repository` as least-privilege).
- *Gitee* — host then page only (NO prefill params): deep-link to
  `https://<host>/profile/personal_access_tokens` and instruct the user in prose to tick `projects` +
  `pull_requests`.
Document the Gitee/GitLab host-prompt vs GitHub no-host asymmetry, and the Gitee no-prefill asymmetry,
explicitly.

**8. Defer the pixel baseline as an explicit non-goal.** The visual harness needs a matching OpenDesign
screens/*.html; none exists for a markdown content page. Do NOT add a manifest row (which would break/empty
the gate). Note in the proposal that an OD baseline would be a prerequisite if pixel coverage is ever desired.

**9. Reuse the archived templates wholesale.** design.md skeleton (Context / Goals+Non-Goals / Decisions
D1..Dn with Why+Alternative / Risks / Migration / Open Questions), the two-spec split (new help-page
capability + MODIFIED frontend-console delta for route reachability), and the track-annotated tasks.md with a
disjoint file-map header. Natural disjoint tracks: (1) markdown content + renderer component, (2) route page,
(3) forge-credentials-card link insertion, (4) optional/deferred pixel baseline — no integration track needed.

**10. Pin the scope non-goals.** No token-into-sandbox, no gh/glab preinstall, no deliver-flow changes, not on
the marketing www site — mirroring the discipline of the archived change's explicit Non-Goals.
