## ADDED Requirements

### Requirement: In-console forge-token help page renders trusted app-authored markdown

The console SHALL provide an in-console help page that renders app-authored markdown content explaining how to mint a forge access token with the scopes the forge-credentials connect flow requires. The content source SHALL be a `.md` file (or files) loaded at build time as a string via a Vite `?raw` import and rendered with `react-markdown` + `remark-gfm`. The renderer SHALL NOT use `rehype-raw` (nor any plugin that re-enables raw HTML / JS execution), so react-markdown's default JSX-escaping is the security guardrail against embedded HTML in the rendered output. The page SHALL be static and SSR-safe: it SHALL NOT perform a network fetch and SHALL NOT read `window`, the clock, or a random source during render.

#### Scenario: Help page renders the markdown content

- **WHEN** an operator opens the forge-token help page
- **THEN** the page renders the app-authored markdown content (headings, lists, links, code blocks) produced by `react-markdown` with `remark-gfm`, and renders without any network fetch

#### Scenario: Raw HTML in markdown is escaped, not executed

- **WHEN** the rendered markdown source contains a raw HTML/script fragment (e.g. `<script>` or an inline event-handler element)
- **THEN** the renderer (no `rehype-raw`) escapes it to inert text rather than injecting it as live DOM, so no script executes

#### Scenario: Content is loaded at build time, not fetched

- **WHEN** the page module is built and served
- **THEN** the markdown content is imported as a build-time string (Vite `?raw`) and is present at first paint without any runtime request to a content endpoint

### Requirement: Per-forge anchored sections for GitHub, GitLab, and Gitee

The help page SHALL contain a distinct section for each of the three supported forges — GitHub, GitLab, and Gitee — and each section SHALL be addressable by the anchor `#github`, `#gitlab`, and `#gitee` respectively. These anchors SHALL match the canonical forge kinds (`github` / `gitlab` / `gitee`) used by the forge-credentials connect flow, so a deep link carrying a `#<kind>` hash lands on the matching section.

#### Scenario: Each forge has an anchored section

- **WHEN** the help page is rendered
- **THEN** it contains three sections addressable by the anchors `#github`, `#gitlab`, and `#gitee`, one per supported forge

#### Scenario: Anchor deep link scrolls to the matching forge

- **WHEN** the operator opens the help page with the hash `#gitlab` (or `#github` / `#gitee`)
- **THEN** the GitLab (respectively GitHub / Gitee) section is the targeted anchor on the page

### Requirement: Dual-audience content per forge (human web-link vs agent terminal)

Each forge section SHALL document two distinct paths: a **human version** that gives a one-click web link to the forge's token-creation page, and an **agent version** that gives a terminal command path an agent can run. Both versions SHALL be present for all three forges and SHALL be visually/textually distinguishable so an operator can tell the human path from the agent path.

#### Scenario: Both a human and an agent path exist per forge

- **WHEN** an operator reads the GitHub, GitLab, or Gitee section
- **THEN** that section presents a human version (a web link to the token-creation page) AND an agent version (a terminal command), labeled so the two audiences are distinguishable

### Requirement: GitHub human deep link uses the fine-grained PAT template with a classic fallback and no host prompt

The GitHub human-version content SHALL link to the GitHub fine-grained PAT creation page with the contents+pull-requests write permissions prefilled — `https://github.com/settings/personal-access-tokens/new?contents=write&pull_requests=write` — and SHALL also document the classic-PAT fallback link `https://github.com/settings/tokens/new?scopes=repo`. The GitHub content SHALL NOT prompt for an instance host (GitHub is always `github.com`).

#### Scenario: GitHub fine-grained deep link is prefilled with write permissions

- **WHEN** the operator follows the GitHub human-version link
- **THEN** the link is `https://github.com/settings/personal-access-tokens/new?contents=write&pull_requests=write` (fine-grained PAT, Contents + Pull requests write prefilled)

#### Scenario: GitHub classic fallback is documented

- **WHEN** the operator reads the GitHub section
- **THEN** the classic-PAT fallback link `https://github.com/settings/tokens/new?scopes=repo` is also present

#### Scenario: GitHub never asks for a host

- **WHEN** the operator reads the GitHub section (human or agent version)
- **THEN** no instance-host prompt or host placeholder appears — the target host is always `github.com`

### Requirement: GitHub agent path uses gh auth login then gh auth token with the OAuth-token-vs-PAT distinction

The GitHub agent-version content SHALL document minting a token in the terminal via `gh auth login --scopes repo` followed by `gh auth token` to print the token for pasting into the connect dialog, and SHALL explicitly note that the token produced by `gh` is a gh-managed OAuth token distinct from a Personal Access Token.

#### Scenario: GitHub agent terminal recipe is documented

- **WHEN** the operator reads the GitHub agent version
- **THEN** it shows `gh auth login --scopes repo` then `gh auth token`, and states that the resulting token is a gh OAuth token distinct from a PAT

### Requirement: GitLab content requires an instance host and documents api plus least-privilege repository scopes

The GitLab content SHALL require an instance host (defaulting to `gitlab.com`, but allowing self-managed instances) before constructing the token-creation deep link, building `https://<host>/-/user_settings/personal_access_tokens?scopes=api`. It SHALL present the broad `api` scope as the simple path and SHALL document `read_repository` + `write_repository` as the least-privilege alternative. The GitLab agent version SHALL document asking the operator for the instance host (default `gitlab.com`) before constructing the deep link.

#### Scenario: GitLab deep link is host-parameterized with the api scope

- **WHEN** the operator reads the GitLab section
- **THEN** the deep link is shown as `https://<host>/-/user_settings/personal_access_tokens?scopes=api` with `<host>` defaulting to `gitlab.com`

#### Scenario: GitLab least-privilege scopes are documented

- **WHEN** the operator reads the GitLab section
- **THEN** `read_repository` + `write_repository` are documented as the least-privilege alternative to the broad `api` scope

#### Scenario: GitLab agent path prompts for the instance host first

- **WHEN** the operator reads the GitLab agent version
- **THEN** it instructs asking for the instance host (default `gitlab.com`) before constructing the deep link

### Requirement: Gitee content deep-links to the creation page only and selects scopes in prose

The Gitee content SHALL require an instance host (defaulting to `gitee.com`) and deep-link only to the token-creation page `https://<host>/profile/personal_access_tokens`, because no query-param scope prefill exists for Gitee. It SHALL therefore describe the scope selection in prose — instructing the operator to tick the `projects` + `pull_requests` scopes manually. The content SHALL explicitly call out this Gitee no-prefill asymmetry relative to GitHub/GitLab.

#### Scenario: Gitee deep link targets the creation page without scope params

- **WHEN** the operator reads the Gitee section
- **THEN** the deep link is `https://<host>/profile/personal_access_tokens` (default host `gitee.com`) with NO scope query parameters

#### Scenario: Gitee scope selection is described in prose

- **WHEN** the operator reads the Gitee section
- **THEN** it instructs ticking the `projects` + `pull_requests` scopes manually, and states that Gitee provides no prefill query params (unlike GitHub/GitLab)

### Requirement: Host-prompt and prefill asymmetries are documented explicitly

The help content SHALL explicitly document the cross-forge asymmetries so an operator is not surprised: GitHub requires no host (always `github.com`) while GitLab and Gitee require an instance host; and GitHub/GitLab support scope prefill via query params while Gitee supports only a page-level deep link with no prefill.

#### Scenario: The GitHub-no-host vs GitLab/Gitee-host asymmetry is stated

- **WHEN** the operator reads the help page
- **THEN** it states that GitHub needs no host (always `github.com`) whereas GitLab and Gitee require an instance host

#### Scenario: The Gitee-no-prefill asymmetry is stated

- **WHEN** the operator reads the help page
- **THEN** it states that GitHub and GitLab support scope prefill via query params while Gitee supports only a page deep link with no prefill

### Requirement: Scope copy stays consistent with the forge-credentials card hints

The help-page scope guidance SHALL stay consistent with the existing forge-credentials card hints to avoid drift: GitHub "需 repo 范围", GitLab "需 api 范围", and Gitee "需 projects + pull_requests 范围". The help content SHALL NOT describe a scope set that contradicts these card hints.

#### Scenario: Help scope copy matches the card hints

- **WHEN** the help page describes the required scope for GitHub, GitLab, and Gitee
- **THEN** GitHub references the `repo` scope, GitLab references the `api` scope, and Gitee references the `projects` + `pull_requests` scopes — matching the forge-credentials card row hints with no contradictory scope set
