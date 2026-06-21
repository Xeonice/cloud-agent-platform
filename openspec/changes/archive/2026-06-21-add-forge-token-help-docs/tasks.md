<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: deps-and-types (depends: none)

- [x] 1.1 Add `react-markdown` and `remark-gfm` as runtime dependencies in `apps/web/package.json` and install (zero markdown tooling exists in the monorepo today; do NOT add `rehype-raw` / `rehype-sanitize` / `@tailwindcss/typography`).
- [x] 1.2 Run `turbo typecheck` for `apps/web` to confirm the `?raw` import resolves under the existing `vite/client` types; only if it complains, add a one-line ambient `declare module '*.md?raw'` shim (e.g. in `apps/web/src/vite-env.d.ts` or equivalent) so the build-time string import typechecks.

## 2. Track: markdown-content (depends: none)

- [x] 2.1 Author the `.md` content source (e.g. `apps/web/src/.../forge-tokens.md`) with three sections anchored by headings whose slugs resolve to `#github`, `#gitlab`, and `#gitee` (matching the canonical forge kinds), each section giving a clearly-labeled human (web-link) version and an agent (terminal) version so the two audiences are textually distinguishable.
- [x] 2.2 Write the GitHub section: human deep link `https://github.com/settings/personal-access-tokens/new?contents=write&pull_requests=write` (fine-grained PAT, Contents + Pull requests write) plus the classic fallback `https://github.com/settings/tokens/new?scopes=repo`; agent path `gh auth login --scopes repo` then `gh auth token`, explicitly noting the gh-OAuth-token-vs-PAT distinction; state no host prompt (always `github.com`); reference the `repo` scope to match the card hint.
- [x] 2.3 Write the GitLab section: human deep link `https://<host>/-/user_settings/personal_access_tokens?scopes=api` with `<host>` defaulting to `gitlab.com` (self-managed allowed), documenting `read_repository` + `write_repository` as the least-privilege alternative to broad `api`; agent path instructs asking for the instance host (default `gitlab.com`) before constructing the deep link; reference the `api` scope to match the card hint.
- [x] 2.4 Write the Gitee section: deep-link only to `https://<host>/profile/personal_access_tokens` (default host `gitee.com`, NO scope query params) and describe ticking `projects` + `pull_requests` scopes manually in prose; reference the `projects` + `pull_requests` scopes to match the card hint.
- [x] 2.5 Add the explicit cross-forge asymmetry copy: GitHub needs no host (always `github.com`) while GitLab/Gitee require an instance host; GitHub/GitLab support scope prefill via query params while Gitee supports only a page-level deep link with no prefill.
- [x] 2.6 Cross-check all scope copy against the live `forge-credentials-card.tsx` row hints ("需 repo 范围", "需 api 范围", "需 projects + pull_requests 范围") so no contradictory scope set is described.

## 3. Track: markdown-renderer (depends: deps-and-types)

- [x] 3.1 Add a markdown-renderer component (e.g. `apps/web/src/components/markdown/markdown.tsx`) that renders a markdown string with `react-markdown` + `remark-gfm` and NO `rehype-raw` (relying on react-markdown's default JSX-escaping as the security guardrail), with a `components={{...}}` map styling h2/h3, p, ul/li, a, code/pre via existing console design tokens (not `@tailwindcss/typography`); keep it pure/SSR-safe (no fetch, no `window`/clock/random during render).

## 4. Track: help-route (depends: markdown-renderer, markdown-content)

- [x] 4.1 Create `apps/web/src/routes/_app/help/forge-tokens.tsx`, registered via `createFileRoute` so the TanStack generator wires it; import the `.md` content via Vite `?raw` build-time string and render it through the markdown-renderer component inside the inherited `_app` shell `<Outlet/>` (no shell rebuild), with the three forge anchors (`#github` / `#gitlab` / `#gitee`) addressable for hash deep links.
- [x] 4.2 Regenerate `apps/web/src/routeTree.gen.ts` (gitignored) via the TanStack generator and confirm the new `/help/forge-tokens` route is wired behind the `_app` auth gate with no manual edit to the generated tree; do NOT add a global sidebar or mobile-nav entry for the page.

## 5. Track: card-links (depends: help-route)

- [x] 5.1 In `apps/web/src/components/settings/forge-credentials-card.tsx`, add a per-row "如何申请令牌?" `<Link to="/help/forge-tokens" hash={kind}>` next to each forge's scope hint, navigating to the matching anchor (`#github` / `#gitlab` / `#gitee`).
- [x] 5.2 In the same card, add the in-dialog `<Link to="/help/forge-tokens" hash={kind}>` near the connect `DialogDescription`, navigating to the open dialog's forge-kind anchor.

## 6. Track: build-verify (depends: help-route, card-links)

- [x] 6.1 Run `turbo build` and `turbo typecheck` for `apps/web` to confirm the new route, renderer, `?raw` import, and the two typed card `<Link>` targets all compile and the bundle builds clean.
