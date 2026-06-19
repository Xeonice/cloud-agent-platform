## Why

The remote MCP server code shipped to production with PR #27 — the `/mcp`
streamable-HTTP endpoint, `/mcp-tokens` CRUD, and the `/settings/mcp-server`
toggle are all live (verified: each returns a deployed, session/bearer-gated
response, not a 404). But the console's `mcpServer` capability flag is still
`false`, so the settings "MCP Server" card mints tokens through the MOCK seam — a
browser-fabricated `mcp_` token that never reaches the backend. A live `curl` of
`/mcp` with such a token returns `401 invalid_token` (the hash misses the
`McpToken` table). The feature is deployed but unusable, and there is no public
documentation of how to connect an MCP client at all (the only connect
instructions live behind login, in the console settings card).

This change activates MCP end-to-end (so a minted token actually connects) and
publishes a public "Connect your MCP client" section on the marketing site's
landing page.

## What Changes

- **Flip the `mcpServer` capability flag** in the console
  (`apps/web/src/lib/api/capabilities.ts`) from `false` → `true`, so the MCP
  Server settings card mints / lists / revokes / toggles against the REAL
  backend (`/mcp-tokens`, `/settings/mcp-server`) instead of the mock seam.
- **Deploy-time activation** (not code — same ship-inert pattern as
  `update-availability-check` / `self-update-action`): redeploy the console,
  have an admin flip `SystemSettings.mcpServerEnabled` on, mint a REAL token
  (43-char body) in the console, then re-`curl` `/mcp initialize` to confirm a
  non-401/503 response, and finally a live Claude/Cursor connect smoke.
- **Add a standalone "MCP connect" section** to the `apps/www` landing page
  (bilingual en/zh, mirroring the existing How-it-works / Security sections):
  the `/mcp` endpoint URL plus a three-step client setup (configure the URL as a
  Streamable HTTP endpoint in Cursor / Claude Desktop / VS Code and paste the
  `mcp_` token into the `Authorization: Bearer` header), and a pointer that the
  token is minted in the console settings page (the landing page itself mints no
  token).
- **Add a build-time API-domain config token** to the marketing site
  (`NEXT_PUBLIC_API_URL` → a new `{apiDomain}` / endpoint token in
  `resolveTokens`), kept DISTINCT from the existing `{domain}` (the site host):
  the MCP endpoint is on the API host (`cap-api.…`), not the site host
  (`cap.…`). The value is inlined at build time as a static string — the site
  makes no runtime backend call, preserving the "decoupled from backend"
  guarantee.
- **Add nav + footer anchors** for the new section (bilingual).

No **BREAKING** changes. The console code change ships INERT: deploying it adds
no live MCP traffic until both the flag is `true` AND an admin enables the
backend toggle.

## Capabilities

### New Capabilities
<!-- None — this change activates and extends existing capabilities. -->

### Modified Capabilities

- `marketing-www`: The landing information architecture gains a new, standalone
  bilingual "MCP connect" section (endpoint URL + client setup steps + a pointer
  to console-minted tokens), and the site gains a build-time API-domain config
  token distinct from the site-host token — added without breaking the
  "decoupled from console and backend" requirement (the token is a static,
  build-time-inlined string; no runtime backend call is introduced).
- `frontend-console`: The `mcpServer` entry of the real/mock capability switch
  flips from mock to real, so the existing "MCP Server" settings section mints /
  lists / revokes / toggles against the live `/mcp-tokens` and
  `/settings/mcp-server` endpoints (closing the "minted token doesn't connect"
  gap created by the mock seam).

## Impact

- **Code**:
  - `apps/web/src/lib/api/capabilities.ts` — `mcpServer: false → true`.
  - `apps/www/lib/site-config.ts` — new `apiDomain()`/endpoint helper + token in
    `resolveTokens`.
  - `apps/www/content/en.ts` + `apps/www/content/zh.ts` — new `mcpConnect`
    section content (symmetric) + nav/footer links.
  - `apps/www/components/sections/mcp-connect.tsx` — new section component.
  - `apps/www/app/[locale]/page.tsx` — mount after HowItWorks, before Security.
  - `apps/www/components/site-nav.tsx`, `apps/www/components/site-footer.tsx` —
    new anchor.
  - `apps/www/.env.example` — document `NEXT_PUBLIC_API_URL`.
- **Deploy**: redeploy console (Vercel `cap-console.douglasdong.com`) and www
  (Vercel `cap.douglasdong.com`); the resident backend stack on `bwg-jp` needs
  an admin to flip `mcpServerEnabled` (no backend code change, no redeploy).
- **Verification**: `apps/www` has no pixel harness — unit + build checks only,
  no pixel-baseline work. The MCP live-connect is a deploy-time smoke (needs the
  live tunnel + an enabled toggle + a real token), not a CI check.
- **Dependencies**: none new; relies on the already-shipped `mcp-server` backend
  (PR #27) and `NEXT_PUBLIC_API_URL` being set in the www Vercel project.
