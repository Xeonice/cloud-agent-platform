## MODIFIED Requirements

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
