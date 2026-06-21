## Context

The forge-credentials settings card (`add-forge-credentials`, task 5.2) lets an operator connect a GitHub / GitLab / Gitee PAT so a task can push edits and open a PR/MR. Today each row carries only a one-line scope hint ("需 repo 范围的 PAT", "需 api 范围", "需 projects + pull_requests 范围"). The operator must leave the console to discover which forge page to open, which scopes to tick, and — for agents driving a terminal — there is no recipe at all.

This change adds an in-console `/help/forge-tokens` page that renders trusted, app-authored markdown documenting both a human path (one-click prefilled web link) and an agent path (terminal command) per forge, reachable contextually from the forge card. It is a frontend-only, content-centric change, but it introduces the **first markdown-rendering path in the monorepo** — there is zero markdown tooling anywhere today — and that one architectural addition is what justifies a design note. Everything else (route registration under `_app`, two `<Link>` insertion points in the card) follows existing console conventions.

Constraints / current state:
- `_app` routes exist (`dashboard`, `repositories`, `history`, `settings`, `api`, `tasks/`) and are registered via TanStack `createFileRoute`; the auth gate and shell (`<Outlet/>`) are inherited, not rebuilt.
- No `?raw` import exists anywhere in `apps/web/src` yet; `vite/client` types are already in `apps/web/tsconfig.json`.
- The card's canonical forge kinds are `github` / `gitlab` / `gitee` — the same tokens used for the page anchors and link hashes, so a `#<kind>` deep link lands on the matching section with no mapping layer.

See `proposal.md` for motivation and `specs/forge-token-help/spec.md` + `specs/frontend-console/spec.md` for the testable requirements; this document explains the *why* behind the technical choices.

## Goals / Non-Goals

**Goals:**
- Render app-authored markdown in-console at the moment the operator is stuck (on the forge card), via a normal `_app`-gated route inside the existing shell.
- Establish a deliberately minimal, safe markdown-rendering path (`react-markdown` + `remark-gfm`, no raw-HTML re-enablement) that future trusted-content pages can reuse.
- Keep content single-sourced in a `.md` file imported at build time, so it is present at first paint with no runtime fetch and is diffable as prose.
- Keep help-page scope copy consistent with the card hints to prevent drift.

**Non-Goals:**
- No global sidebar / mobile-nav entry — the page is reached contextually from the card only.
- No pixel / visual-baseline manifest row — no OpenDesign HTML baseline exists for a markdown content page.
- No `rehype-raw` / `rehype-sanitize` / `@tailwindcss/typography` dependency.
- No backend / API / sandbox change; no token injection into the sandbox; no `gh` / `glab` preinstall; no change to the task-delivery flow; not added to the marketing www site.

## Decisions

### 1. Content source: a `.md` file imported via Vite `?raw`, not inline JSX or a fetched endpoint
Author the content as a `.md` file and pull it in as a build-time string (`import md from "./forge-tokens.md?raw"`). Rationale: the content is long-form prose with per-forge anchors — far more maintainable and reviewable as markdown than as escaped JSX, and a `.md` diff reads as documentation. Build-time import guarantees the content is present at first paint with **no runtime request to a content endpoint** (satisfies the SSR-safe / no-fetch requirement) and removes any loading/error state.
- *Alternatives considered:* (a) hand-written JSX — rejected: verbose, drifts from prose, harder to keep the human/agent dual structure consistent. (b) Fetch markdown from an API/asset at runtime — rejected: adds a network dependency, a loading state, and an SSR hazard for zero benefit since the content is static and app-owned.
- *Note:* `vite/client` types already cover `?raw`; only add a `declare module '*.md?raw'` ambient shim if `turbo typecheck` actually complains.

### 2. Renderer: `react-markdown` + `remark-gfm`, deliberately WITHOUT `rehype-raw` / `rehype-sanitize`
Render with `react-markdown` + `remark-gfm` and **no** rehype-raw. Rationale: the content is trusted and app-authored, and react-markdown's default behavior is to escape any embedded raw HTML to inert text (it does not parse raw HTML into live DOM unless `rehype-raw` is added). That default-escaping *is* the security guardrail — so we do not need `rehype-sanitize` either, and adding `rehype-raw` would be the only thing that could turn an embedded `<script>` into live DOM. Keeping the plugin set minimal makes the safety property easy to state and test: "no rehype-raw ⇒ raw HTML renders as text."
- *Alternatives considered:* (a) `rehype-raw` + `rehype-sanitize` — rejected: pulls in a sanitizer allowlist to maintain and a parser we don't need, since we never intend to render raw HTML. (b) a different markdown lib (markdown-it, marked) — rejected: react-markdown maps cleanly to React components, letting us style via a `components={{...}}` token map instead of injecting an HTML string.

### 3. Styling via a `components={{...}}` token map, not `@tailwindcss/typography`
Map markdown elements (h2/h3, p, ul/li, a, code/pre) to the console's existing design tokens through react-markdown's `components` prop, rather than adding the `@tailwindcss/typography` plugin. Rationale: a handful of elements need styling and the console already has tokens for them; pulling in the typography plugin to style one page is disproportionate and would introduce its own prose theme to reconcile with the design system.

### 4. Route as a normal `_app` child; anchors === canonical forge kinds
Register `routes/_app/help/forge-tokens.tsx` via `createFileRoute` so the TanStack generator wires `routeTree.gen.ts` automatically (gitignored — regenerated in CI / worktrees). The page inherits the `_app` auth gate and shell `<Outlet/>` with no shell rebuild. Use the canonical kinds `github` / `gitlab` / `gitee` verbatim as the section anchors and as the `<Link hash={kind}>` values in the card, so a deep link needs no kind→anchor mapping.

### 5. Two self-contained `<Link>` insertion points in the card; no nav entry
Add exactly two contextual links in `forge-credentials-card.tsx`: a per-row "如何申请令牌?" link beside each scope hint, and an in-dialog link near the connect `DialogDescription`, each `<Link to="/help/forge-tokens" hash={kind}>`. No global sidebar / mobile-nav entry. Rationale: the help is only relevant while connecting a forge, so contextual entry points keep the page discoverable exactly where it's needed without spending a top-level nav slot.

### 6. Content fidelity reflects real forge asymmetries (no fabricated uniformity)
The authored content encodes the actual per-forge differences rather than pretending they are uniform: GitHub fine-grained PAT deep link `?contents=write&pull_requests=write` with a classic `?scopes=repo` fallback and **no host prompt**; GitLab `https://<host>/-/user_settings/personal_access_tokens?scopes=api` with `read_repository`+`write_repository` least-privilege, **host required**; Gitee deep-links to `https://<host>/profile/personal_access_tokens` only (no query-param prefill exists) with scopes ticked **in prose**. The GitHub-no-host vs GitLab/Gitee-host and the Gitee-no-prefill asymmetries are stated explicitly so operators are not surprised. Scope copy stays aligned with the card hints (`repo` / `api` / `projects`+`pull_requests`). Rationale: a help page that papers over these differences would actively mislead — fidelity is the whole point.

## Risks / Trade-offs

- **Forge URL / scope-param drift** (a forge changes its token-creation path or query params) → Mitigation: the requirements pin the exact URLs as testable scenarios, and the content is a single `.md` file that is trivial to update; scope copy is cross-checked against the card hints to catch divergence in review.
- **Adding `rehype-raw` later would silently remove the security guardrail** → Mitigation: a spec scenario asserts that raw HTML in the source renders as inert text; that test fails the moment rehype-raw is introduced.
- **`?raw` typecheck friction in CI / worktrees** → Mitigation: `vite/client` already provides the type; the fallback `declare module '*.md?raw'` shim is a one-liner if `turbo typecheck` complains. `routeTree.gen.ts` is gitignored and must be regenerated by the generator (known worktree step).
- **New runtime deps in `apps/web`** (`react-markdown`, `remark-gfm`) → Trade-off accepted: both are small, widely-used, and confined to the web bundle; the minimal plugin set keeps the surface small.

## Migration Plan

No data migration, no backend deploy. Ship is purely additive frontend:
1. Add `react-markdown` + `remark-gfm` to `apps/web/package.json`; install.
2. Add the route page, the markdown-renderer component (token `components` map), and the `.md` content source; regenerate `routeTree.gen.ts`.
3. Add the two `<Link>` insertion points in `forge-credentials-card.tsx`.
4. Build / typecheck (`turbo build`, `turbo typecheck`).

Rollback: revert the change set — there is no persistent state or schema to unwind. The forge card's two added links and the new route disappear; the existing card behavior is untouched.

## Open Questions

None blocking. (If `turbo typecheck` flags `*.md?raw`, add the ambient `declare module` shim — already anticipated in Decision 1, not a design unknown.)
