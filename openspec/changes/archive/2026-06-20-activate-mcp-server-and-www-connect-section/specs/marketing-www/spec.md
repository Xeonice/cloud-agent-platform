## MODIFIED Requirements

### Requirement: Landing information architecture

The single landing page SHALL present, in order, a Hero, a Features section, a
How-it-works section, an MCP-connect section, a Security section, and a Self-host
CTA, with navigation and footer. Content SHALL be sourced from real product
capabilities and SHALL NOT claim capabilities the product does not have.

#### Scenario: Required sections present

- **WHEN** the landing page is rendered
- **THEN** Hero, Features, How-it-works, MCP-connect, Security, and Self-host CTA
  sections are all present and reachable via in-page navigation

#### Scenario: Hero one-line install command with copy

- **WHEN** a visitor views the Hero
- **THEN** the one-line `curl | sh` install command is shown in a command block
  with a working copy-to-clipboard control, alongside the inspectable script URL
  and a disclosed manual `git clone && make up` alternative

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

## ADDED Requirements

### Requirement: MCP client connect section

The landing page SHALL include a standalone, bilingual "connect your MCP client"
section documenting how to point an MCP client at the platform's remote MCP
server. The section SHALL show the `/mcp` endpoint URL built from a BUILD-TIME
API-domain token that is DISTINCT from the site-host `{domain}` token (the MCP
endpoint is served on the API host, not the site host). It SHALL present the
client setup as: configure that URL as a Streamable HTTP endpoint in an MCP
client (e.g. Cursor / Claude Desktop / VS Code) and put the minted `mcp_` token
in the `Authorization: Bearer` request header. The section SHALL direct the
reader to mint the token in the console settings page and SHALL NOT itself offer
any token-mint affordance. The endpoint URL SHALL be a build-time-inlined static
string, introducing no runtime backend call, so the site still renders fully
offline.

#### Scenario: Connect section shows endpoint and client steps

- **WHEN** a visitor reads the MCP-connect section
- **THEN** it shows the `/mcp` endpoint URL (rendered from the build-time
  API-domain token) and the steps to configure it as a Streamable HTTP endpoint
  with the `mcp_` token in the `Authorization: Bearer` header

#### Scenario: Token minting is delegated to the console

- **WHEN** a visitor looks for how to obtain the token
- **THEN** the section points them to mint it in the console settings page and
  exposes no mint control on the public page

#### Scenario: API-domain token is distinct and build-time inlined

- **WHEN** the site is built with the API-domain env configured
- **THEN** the rendered endpoint uses the API host (not the site host) and is a
  static inlined string with no runtime backend fetch

#### Scenario: Bilingual and statically exported

- **WHEN** the site is built for both locales
- **THEN** the MCP-connect section renders in `en` and `zh` with symmetric
  content in each statically-exported page
