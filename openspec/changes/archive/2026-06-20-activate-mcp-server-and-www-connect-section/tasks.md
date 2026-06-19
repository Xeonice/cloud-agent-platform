<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: console-mcp-flag (depends: none)

- [x] 1.1 In `apps/web/src/lib/api/capabilities.ts`, flip `mcpServer` from `false` to `true`, and update its inline comment to record that the `/mcp-tokens` + `/settings/mcp-server` endpoints are verified live against the running api (mirror the `apiKeys`/`settings` comment style).
- [x] 1.2 Run the web unit suite (incl. `mcp-server-section` + `mcp-tokens` tests) + typecheck to confirm the flag flip introduces no regression. (Flipping the flag routed the two `mcp-server-section` queryFn tests to the real seam; updated them to stub `fetch` and assert real-seam routing + refreshed the stale "mcpServer is false" comments in both MCP test files. Web suite: 156/156 green.)

## 2. Track: www-api-domain-config (depends: none)

- [x] 2.1 In `apps/www/lib/site-config.ts`, add an API-host helper (`apiOrigin()` / `apiDomain()`) reading `NEXT_PUBLIC_API_URL`, with a safe readable fallback (`your-api-domain.example`) when unset (mirrors the `siteUrl()`/`siteDomain()` fallback so the build never crashes).
- [x] 2.2 Extend `resolveTokens()` to replace a NEW `{apiDomain}` token with the API host — kept DISTINCT from the site-host `{domain}` token.
- [x] 2.3 Document `NEXT_PUBLIC_API_URL` in `apps/www/.env.example`.
- [x] 2.4 ADJUSTED (apply finding): `apps/www` has NO unit-test runner (only `build`/`typecheck`/`lint` — adding vitest to the static marketing site is out-of-scope scope-creep). The `{apiDomain}` resolution is instead proven by the build export (task 4.4): a build with `NEXT_PUBLIC_API_URL` set renders `https://cap-api.douglasdong.com/mcp` (the API host) — distinct from the site host `cap.douglasdong.com` — so `resolveTokens` honours `{apiDomain}` ≠ `{domain}`. No vitest added.

## 3. Track: www-mcp-content (depends: none)

- [x] 3.1 In `apps/www/content/index.ts`, extend the `SiteContent` type with an `mcpConnect` section shape (`McpConnectContent`: eyebrow/title/description, endpointLabel, an `endpoint` string carrying `{apiDomain}`, copy labels, ordered `steps`, a `tokenNote` + `tokenCta` "mint in console" pointer).
- [x] 3.2 In `apps/www/content/en.ts`, author the English `mcpConnect` content: endpoint `https://{apiDomain}/mcp`; steps for Cursor / Claude Desktop / VS Code (configure as a Streamable HTTP endpoint + put the `mcp_` token in `Authorization: Bearer`); note the token is minted in the console settings page (no mint here). Added an MCP nav link + footer link (`href: "#mcp"`).
- [x] 3.3 In `apps/www/content/zh.ts`, author the symmetric Chinese `mcpConnect` content + nav/footer links (strict parity with en — same structure, localized copy).

## 4. Track: www-mcp-section (depends: www-api-domain-config, www-mcp-content)

- [x] 4.1 Created `apps/www/components/sections/mcp-connect.tsx` — a section with `id="mcp"` (for the nav anchor) reusing the existing `Section`/`Container`/`CommandBox`/`FadeUp` components and design tokens; renders the endpoint via `resolveTokens(...)` (prompt hidden) and the ordered client-setup steps; includes the "mint in the console settings page" pointer with NO token-mint control.
- [x] 4.2 Mounted `<McpConnect>` in `apps/www/app/[locale]/page.tsx` AFTER `<HowItWorks>` and BEFORE `<Security>`, passing `content.mcpConnect`; updated the page's section-order doc comment.
- [x] 4.3 Verified the MCP nav/footer anchors target the section: `id="mcp"` is present in BOTH exported locales (`out/en/index.html` + `out/zh/index.html`); `Section` carries `scroll-mt-20` under the fixed nav; no dead anchors (the link resolves to the rendered section).
- [x] 4.4 Ran `turbo build`-equivalent for `@cap/www` + typecheck + lint: build succeeds, both `en` and `zh` export WITH the MCP section, and the resolved endpoint is `https://cap-api.douglasdong.com/mcp` (the API host — not the raw `{apiDomain}` token, not the site host). www typecheck + lint clean.

## 5. Track: deploy-and-live-verify (depends: console-mcp-flag, www-mcp-section)

<!-- Deploy-time activation — NOT CI-gated and NOT executable by the apply agent
     (needs real Vercel deploys, admin rights, a live token, and the live tunnel).
     Mirrors update-availability-check / self-update Phase-1 activation. LEFT FOR
     THE OPERATOR. The spec's end-to-end "minted token connects" scenario is only
     fully provable after these run. -->

- [ ] 5.1 Redeploy the console to Vercel (`cap-console.douglasdong.com`) carrying `mcpServer: true`.
- [ ] 5.2 Set `NEXT_PUBLIC_API_URL=https://cap-api.douglasdong.com` in the www Vercel project and redeploy www (`cap.douglasdong.com`); confirm the published MCP section shows the correct endpoint.
- [ ] 5.3 As an admin, enable the "MCP Server" toggle in console settings (writes backend `SystemSettings.mcpServerEnabled = true`).
- [ ] 5.4 Mint a fresh MCP token in the console (now a REAL 43-char backend token); keep it out of the repo.
- [ ] 5.5 `curl -X POST https://cap-api.douglasdong.com/mcp` with `Authorization: Bearer <real token>` + an `initialize` body; confirm a successful JSON-RPC result (NOT `401 invalid_token`, NOT `503` disabled).
- [ ] 5.6 Live-connect smoke: add the endpoint + real token to Claude/Cursor as a Streamable HTTP MCP server; confirm `tools/list` returns the platform tools and one tool call succeeds.
