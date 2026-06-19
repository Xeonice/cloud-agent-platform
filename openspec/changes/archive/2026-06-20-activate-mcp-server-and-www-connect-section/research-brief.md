# Research Brief — activate-mcp-server-and-www-connect-section

Side-car notes captured during `/opsx:explore` (2026-06-20). Not a tracked
artifact; grounds the proposal/design/specs/tasks below in measured evidence.

## Live verification (the trigger for this change)

A `curl` of the production endpoint with the operator-supplied token:

```
POST https://cap-api.douglasdong.com/mcp
Authorization: Bearer mcp_…Tbp0Z   (body = 36 chars)
→ HTTP/2 401
  www-authenticate: Bearer error="invalid_token",
                    error_description="Invalid or revoked MCP token"
  access-control-allow-methods: GET, POST, DELETE, OPTIONS
  access-control-allow-headers: Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version
```

Two facts follow immediately:
1. The `/mcp` endpoint is DEPLOYED and live — the MCP-specific CORS headers and
   the `requireBearerAuth` `www-authenticate` challenge prove the bearer
   middleware is running (it is not a 404 / not a disabled-toggle 503).
2. The token is rejected with `invalid_token` → `resolveMcpToken` returned
   `null` (it never reached the `mcpServerEnabled` 503 gate in `McpController`,
   which sits AFTER the bearer middleware).

## Root cause — confirmed, not inferred

`apps/web/src/lib/api/capabilities.ts:187` → `mcpServer: false`. With the flag
off, the console "MCP Server" settings card mints through the MOCK seam
(`mockMintMcpToken` → `fabricateMcpToken`), which builds a **browser-fabricated**
`mcp_` token that is NEVER written to the backend `McpToken` table. Pasting it at
the real `/mcp` endpoint → `resolveMcpToken` hashes it (sha256) → `findUnique`
misses → `null` → 401.

Token-shape proof (decisive):

| | real backend mint | mock `fabricateMcpToken` | supplied token |
|---|---|---|---|
| body length | 43 (`randomBytes(32).base64url`) | **36** (per-char loop) | **36** ✅ |
| charset | base64url | `A-Za-z0-9-_` | `A-Za-z0-9-_` (incl. `--`) ✅ |
| in backend DB | yes | **no** (built in browser) | DB miss ✅ |

`resolveMcpToken` returns `null` on any of: token not a string / hash DB-miss /
`revokedAt != null` / expired / owner no longer allowlisted. Here it is the
DB-miss branch (mock token was never persisted).

## Backend endpoints are live (flip-flag precondition holds)

```
GET /mcp-tokens         → 401   (session-gated, exists)
GET /settings/mcp-server → 401   (session-gated, exists)
GET /auth/session        → 401   (known-good reference)
```

All three behave like the known-good `/auth/session`, so flipping
`mcpServer: true` will let the console reach real, deployed endpoints.

## `apps/www` facts (Part B)

- Token fill-in: `lib/site-config.ts#resolveTokens()` replaces `{domain}`
  (site host, from `NEXT_PUBLIC_SITE_URL`) and `{repo}` (from
  `NEXT_PUBLIC_REPO_URL`). **The MCP endpoint lives on the API host
  (`cap-api.douglasdong.com`), NOT the site host (`cap.douglasdong.com`)** — so a
  new build-time token (e.g. `{apiDomain}`, from a new `NEXT_PUBLIC_API_URL`) is
  required; reusing `{domain}` would print the wrong host.
- Section order in `app/[locale]/page.tsx`:
  Hero → Features → HowItWorks → Security → SelfHostCta. New MCP section sits
  after HowItWorks, before Security.
- Bilingual content is strictly symmetric across `content/en.ts` + `content/zh.ts`.
- **No pixel harness** (`apps/www` has no `e2e/` dir, no `test:visual`/playwright
  script) — unit + build verification only; no pixel-baseline task.

## Existing spec surface (delta targets)

- `marketing-www`: "Landing information architecture" (IA), "Bilingual content",
  "Decoupled from console and backend" (the new api-domain token is a
  build-time-inlined STATIC string — the site still makes no runtime backend
  call, honoring this requirement).
- `frontend-console`: "Unified TanStack Query data layer with real/mock
  capability switch" (the `mcpServer` flag), "Settings page has an MCP Server
  section" (already shipped on mock).
- `mcp-server`: 5 requirements, all code-behavior, already implemented + verified.
  Unchanged by this change — activation (flag flip + toggle on + live mint) is a
  DEPLOY-TIME action, captured in tasks.md, not a spec-behavior change.

## Deploy topology

console = Vercel `cap-console.douglasdong.com`; www = Vercel
`cap.douglasdong.com`; backend = resident docker-compose stack on host `bwg-jp`,
public `cap-api.douglasdong.com` via Cloudflare tunnel.
