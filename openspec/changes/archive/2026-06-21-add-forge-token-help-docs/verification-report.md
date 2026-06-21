# Verification Report — add-forge-token-help-docs

Three-way adjudication of the raw verify findings. The raw-unmet list was **empty** —
the skeptic flagged zero requirements as unmet. Every requirement below was
re-traced end-to-end against the actual code and confirmed **MET**. No UNMET code
tasks were re-opened and no new SPEC-DEFECTs were routed to Open Questions.

## Adjudication summary

- **UNMET (re-opened code tasks):** 0
- **SPEC-DEFECT (routed to design.md Open Questions):** 0
- **MET (re-traced as satisfied):** all requirements (both specs)

## MET requirements — end-to-end traces

### capability `forge-token-help`

1. **In-console forge-token help page renders trusted app-authored markdown** — MET.
   `routes/_app/help/forge-tokens.tsx` imports `@/content/forge-tokens.md?raw`
   (build-time string, no fetch) and renders via `<Markdown>`.
   `components/markdown/markdown.tsx` uses `react-markdown` + `remark-gfm` with
   **no** `rehype-raw` / `rehype-sanitize` (default JSX-escaping is the guardrail).
   Pure render: no `window`/clock/random during render; the only browser access is
   the client-side `useEffect` hash-scroll. `package.json` declares
   `react-markdown@^10.1.0` + `remark-gfm@^4.0.1` and no rehype plugin.

2. **Per-forge anchored sections for GitHub, GitLab, Gitee** — MET.
   `slugify` maps `"GitHub"→"github"`, `"GitLab"→"gitlab"`, `"Gitee"→"gitee"`; the
   `h2` renderer sets `id={slugify(textOf(children))}`. The markdown has exactly
   `## GitHub`, `## GitLab`, `## Gitee` as top-level forge sections, so `#github` /
   `#gitlab` / `#gitee` resolve to the matching sections. The `useEffect` scrolls
   the targeted anchor into view on a `#<kind>` deep link.

3. **Dual-audience content per forge (human web-link vs agent terminal)** — MET.
   Each forge section has a labeled `### 网页版` (human web link) and
   `### 终端版（Agent）` (agent terminal) sub-section in `forge-tokens.md`.

4. **GitHub human deep link (fine-grained PAT) + classic fallback + no host** — MET.
   `forge-tokens.md` contains the fine-grained link
   `https://github.com/settings/personal-access-tokens/new?contents=write&pull_requests=write`,
   the classic fallback `https://github.com/settings/tokens/new?scopes=repo`, and
   states GitHub is always `github.com` with no host prompt.

5. **GitHub agent path `gh auth login --scopes repo` + `gh auth token` + OAuth-vs-PAT** — MET.
   The GitHub agent fenced block has `gh auth login --scopes repo` then
   `gh auth token`, and the blockquote notes the gh-OAuth-token-vs-PAT distinction.

6. **GitLab host + `api` + least-privilege repo scopes** — MET.
   `https://<host>/-/user_settings/personal_access_tokens?scopes=api` (default
   `gitlab.com`), `read_repository` + `write_repository` documented as
   least-privilege, and the agent version prompts for the instance host first.

7. **Gitee deep-link only + prose scope selection** — MET.
   `https://<host>/profile/personal_access_tokens` (default `gitee.com`, no scope
   query params); prose instructs ticking `projects` + `pull_requests` manually and
   calls out the Gitee no-prefill asymmetry.

8. **Host-prompt and prefill asymmetries documented explicitly** — MET.
   The cross-forge asymmetry table states GitHub needs no host while GitLab/Gitee
   require one, and that GitHub/GitLab support prefill while Gitee does not.

9. **Scope copy consistent with card hints** — MET.
   Card hints (`forge-credentials-card.tsx` `ROWS`): GitHub `需 repo 范围`,
   GitLab `需 api 范围`, Gitee `需 projects + pull_requests 范围`. The md references
   `repo` / `api` / `projects`+`pull_requests` respectively — no contradiction.

### capability `frontend-console`

10. **Help route behind `_app` auth gate + reachable from the forge card** — MET.
    `createFileRoute("/_app/help/forge-tokens")` is wired in `routeTree.gen.ts`
    (`/_app/help/forge-tokens`, path `/help/forge-tokens`). The `_app` route
    `beforeLoad` redirects unauthenticated visitors to `/login` before any child
    renders. The page renders inside the inherited `_app` `<Outlet/>` shell (no
    shell rebuild). `forge-credentials-card.tsx` has the per-row link
    (`<Link to="/help/forge-tokens" hash={row.kind}>`, lines 105–111) and the
    in-dialog link (`hash={dialogKind ?? undefined}`, lines 163–169). Neither
    `app-sidebar.tsx` nor `mobile-nav.tsx` references the help page — no global
    nav entry was added.

## Gap / scope findings (do not block any primary scenario)

These are additive behaviors beyond the stated requirements. None contradicts a
requirement, so each is folded into MET (met-as-written; the extras are harmless
chrome / fidelity beyond the minimum spec):

- Page header section with a decorative subtitle outside the markdown card
  (`forge-tokens.tsx:43–55`) — extra UX, not required, not prohibited.
- Card styling (`rounded-xl bg-card p-6 shadow-ring`) around `<Markdown>`
  (`forge-tokens.tsx:57`) — aesthetic, not required.
- Smooth-scroll (`behavior:"smooth", block:"start"`) in the hash-scroll effect
  (`forge-tokens.tsx:38`) — spec only requires landing on the anchor; smooth is a
  superset.
- `h3` headings also get slugified `id`s (`markdown.tsx:54–61`) — only the `h2`
  forge anchors are required; extra ids are harmless.
- Full styled renderer map: `h1`/`h3`/`blockquote`/`table`/`thead`/`th`/`td`/`hr`/
  `ol`/`li`/`pre`/`code` (`markdown.tsx`) — broader than the minimum element set,
  but the spec only requires headings/lists/links/code blocks be rendered; the
  extra renderers style content that the content file actually uses (table,
  blockquote, ordered lists).
- Links open `target="_blank"` + `rel="noopener noreferrer"` (`markdown.tsx:76–85`)
  — no link-target behavior is specified; safe default.
- `glab auth login` / `glab auth status` validation commands in the GitLab agent
  section (`forge-tokens.md:45–48`) — spec requires prompting for the instance
  host (present); the CLI validation is additive helpfulness, and the content
  correctly states GitLab PATs cannot be minted purely from the terminal.
- `curl` API validation command for Gitee (`forge-tokens.md:70`) — additive
  validation aid beyond the required deep link + prose scopes.
- Cross-platform comparison rendered as a Markdown table (`forge-tokens.md:75–79`)
  — spec requires documenting the asymmetries (present); table is one valid form.

## Conclusion

All requirements across both specs (`forge-token-help`, `frontend-console`)
re-trace end-to-end as satisfied. Build/typecheck wiring (deps, `?raw` import,
generated route tree, two typed `<Link>` targets) is in place. No code tasks
re-opened; no spec defects routed.
