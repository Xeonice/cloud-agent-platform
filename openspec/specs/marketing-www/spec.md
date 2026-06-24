# marketing-www Specification

## Purpose
TBD - created by archiving change add-marketing-www-site. Update Purpose after archive.
## Requirements
### Requirement: Standalone statically-exported site

The marketing site SHALL be a new workspace app `apps/www` (`@cap/www`) built
with Next.js App Router configured for static export (`output: 'export'`),
producing only static assets with no serverless functions, and SHALL slot into
the existing pnpm + Turborepo workspace.

#### Scenario: Production build emits only static assets

- **WHEN** the production build runs (`turbo build` / the app's build script)
- **THEN** the build completes successfully and emits a static `out/` directory
  of HTML/CSS/JS assets with no serverless/API function output

#### Scenario: Passes the workspace CI gate

- **WHEN** the repo CI gate runs (install → turbo build → typecheck → lint)
- **THEN** `@cap/www` builds, typechecks, and lints with no errors

### Requirement: Decoupled from console and backend

The site SHALL NOT import from `@cap/api`, read any auth/session state, or call
the backend at runtime; it SHALL render identically whether or not the backend
is reachable.

#### Scenario: No backend coupling

- **WHEN** the site source is inspected and built
- **THEN** it contains no import of `@cap/api`, no session/auth query, and no
  runtime fetch to the backend, and the static output renders fully offline

### Requirement: Landing information architecture

The single landing page SHALL present, in order, a Hero, a Features section, a
How-it-works section, an MCP-connect section, a Security section, and a Self-host
CTA, with navigation and footer. Content SHALL be sourced from real product
capabilities and SHALL NOT claim capabilities the product does not have. The landing
SHALL present BOTH one-line install commands — the source-build `install.sh` and the
prebuilt-image `quick-deploy.sh` — so a visitor can pick the path that fits their host.

#### Scenario: Required sections present

- **WHEN** the landing page is rendered
- **THEN** Hero, Features, How-it-works, MCP-connect, Security, and Self-host CTA
  sections are all present and reachable via in-page navigation

#### Scenario: Hero one-line install command with copy

- **WHEN** a visitor views the Hero
- **THEN** the source-build one-line `curl … /install.sh | sh` command is shown in a
  command block with a working copy-to-clipboard control, alongside the inspectable
  script URL and a disclosed manual `git clone && make up` alternative

#### Scenario: Prebuilt one-line install command is also presented

- **WHEN** a visitor views the install options on the landing
- **THEN** a second one-line `curl … /quick-deploy.sh | bash` command (prebuilt images,
  no OAuth) is shown with copy-to-clipboard and the inspectable script URL, labelled
  with its caveats — amd64-only, legacy-token (not OAuth-first production), host-root
  via `docker.sock`, and prebuilt `cap-web` localhost-only — so it is not mistaken for
  the OAuth-first production path

#### Scenario: Features reflect real capabilities

- **WHEN** a visitor reads the Features section
- **THEN** it describes only real capabilities (per-task container isolation,
  byte-identical terminal streaming, dual runtime Codex + Claude Code, GitHub
  repo import, history/audit/metrics, multi-user OAuth + hard allowlist)

#### Scenario: Security section is honest about the host-root boundary

- **WHEN** a visitor reads the Security section
- **THEN** it discloses that tasks run host-root via `docker.sock` ("who can log
  in = who can run as root on the host") and the fail-closed allowlist posture,
  rather than omitting the caveat

#### Scenario: Both install commands are bilingual

- **WHEN** the landing is rendered in either locale (`en` / `zh`)
- **THEN** both install commands and their caveat copy render in that locale with no
  client-side translation fetch

### Requirement: Bilingual content

The site SHALL be available in Chinese and English, with a language toggle, and
SHALL produce a statically-exported HTML page per locale with no runtime
language fetch.

#### Scenario: Both locales export statically

- **WHEN** the site is built
- **THEN** a static page is emitted for both `en` and `zh`, and each renders its
  locale's copy without a client-side translation fetch

#### Scenario: Language toggle switches locale

- **WHEN** a visitor activates the language toggle
- **THEN** the page content switches to the other locale and the URL reflects
  the selected locale

#### Scenario: SEO alternate locale hints

- **WHEN** a locale page is served
- **THEN** it includes `hreflang` alternate links pointing to the other locale

### Requirement: Vercel-style design system and accessibility

The site SHALL use a monochrome, high-contrast, Vercel-style visual language
(Geist Sans + Geist Mono, hairline borders, restrained motion) and SHALL meet
the ui-ux-pro-max delivery bar for accessibility and responsiveness.

#### Scenario: Accessibility and motion

- **WHEN** the site is audited
- **THEN** body/normal text meets at least 4.5:1 contrast, interactive elements
  have visible focus states, icon-only controls have accessible labels, and
  animations are suppressed under `prefers-reduced-motion`

#### Scenario: Responsive across breakpoints

- **WHEN** the site is viewed at 375px, 768px, 1024px, and 1440px widths
- **THEN** the layout adapts with no horizontal scroll and remains legible at
  each breakpoint

### Requirement: SEO and social metadata

The site SHALL provide page metadata for search and social sharing, including
title, description, canonical URL, and Open Graph / Twitter card tags with an
Open Graph image.

#### Scenario: Metadata present in exported HTML

- **WHEN** the exported HTML is inspected
- **THEN** it contains a title, meta description, canonical link, and Open Graph
  / Twitter card tags including an `og:image`

### Requirement: MCP client connect section

The landing page SHALL include a standalone, bilingual "connect your MCP client"
section documenting how to point an MCP client at the platform's remote MCP
server. The section SHALL show the `/mcp` endpoint URL built from a BUILD-TIME
API-domain token that is DISTINCT from the site-host `{domain}` token (the MCP
endpoint is served on the API host, not the site host). It SHALL present the
client setup as: configure that URL as a Streamable HTTP endpoint in an MCP
client (e.g. Cursor / Claude Desktop / VS Code) and put the minted `mcp_` token
in the `Authorization: Bearer` request header. The section SHALL ALSO show
concrete, copyable install commands, in two forms: (A) a DIRECT streamable-HTTP
command — `claude mcp add --transport http cap https://<apiDomain>/mcp --header
"Authorization: Bearer mcp_<token>"` — for clients that speak streamable HTTP
natively; and (B) a FALLBACK — `npx mcp-remote https://<apiDomain>/mcp --header
"Authorization: Bearer mcp_<token>"` — a local stdio↔remote-HTTP bridge for
stdio-only clients. Both commands SHALL render the endpoint from the same
build-time API-domain token (never a hardcoded host) and SHALL show the token as
a `mcp_<token>` placeholder, never a real credential. The section SHALL briefly
distinguish the two transports (stdio runs a local process; streamable HTTP
connects to the remote service) so the "why not npx install?" question is
answered. The section SHALL direct the reader to mint the token in the console
settings page and SHALL NOT itself offer any token-mint affordance. The endpoint
URL SHALL be a build-time-inlined static string, introducing no runtime backend
call, so the site still renders fully offline.

#### Scenario: Connect section shows endpoint and client steps

- **WHEN** a visitor reads the MCP-connect section
- **THEN** it shows the `/mcp` endpoint URL (rendered from the build-time
  API-domain token) and the steps to configure it as a Streamable HTTP endpoint
  with the `mcp_` token in the `Authorization: Bearer` header

#### Scenario: Concrete install commands are shown for both transports

- **WHEN** a visitor wants to actually connect a client
- **THEN** the section shows a direct `claude mcp add --transport http` command
  AND an `npx mcp-remote` fallback command, both rendering the endpoint from the
  build-time API-domain token with a `mcp_<token>` placeholder, plus a short note
  distinguishing stdio (local) from streamable HTTP (remote)

#### Scenario: Token minting is delegated to the console

- **WHEN** a visitor looks for how to obtain the token
- **THEN** the section points them to mint it in the console settings page and
  exposes no mint control on the public page

#### Scenario: API-domain token is distinct and build-time inlined

- **WHEN** the site is built with the API-domain env configured
- **THEN** the rendered endpoint (in both the URL display and the install
  commands) uses the API host (not the site host) and is a static inlined string
  with no runtime backend fetch

#### Scenario: Bilingual and statically exported

- **WHEN** the site is built for both locales
- **THEN** the MCP-connect section renders in `en` and `zh` with symmetric
  content (including the install commands) in each statically-exported page

