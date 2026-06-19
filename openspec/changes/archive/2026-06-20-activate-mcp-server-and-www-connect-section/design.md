## Context

The remote MCP server backend shipped with PR #27. Live probes confirm the
surface is deployed: `/mcp` answers with the `requireBearerAuth`
`www-authenticate` challenge + MCP CORS headers, and `/mcp-tokens` /
`/settings/mcp-server` return 401 like the known-good `/auth/session`. But the
console's `mcpServer` capability flag is `false`, so the settings "MCP Server"
card mints through the mock seam — a browser-fabricated 36-char `mcp_` token
that is never persisted. A live `curl` of `/mcp` with that token returns `401
invalid_token` (the hash misses the `McpToken` table). The feature is shipped
but unusable, and the only connect instructions live behind login.

`apps/www` is a statically-exported bilingual Next.js site, decoupled from the
backend (no runtime fetch), with build-time `{domain}`/`{repo}` token
substitution via `resolveTokens()`. It has no pixel harness.

## Goals / Non-Goals

**Goals:**
- Make a console-minted MCP token actually connect at `/mcp` (close the
  mock-token gap).
- Publish a public, bilingual "connect your MCP client" section on the landing
  page, sourced from the same connect facts the console card already states.

**Non-Goals:**
- No change to `mcp-server` backend code (it is implemented + verified; this is
  activation, not re-implementation).
- No OAuth / DCR flow (the settings-minted token model is the shipped design).
- No token-mint affordance on the public site (tokens are owner-scoped; minting
  stays behind login).
- No per-user task scoping (the shared pool is an accepted prior decision).
- No runtime backend coupling introduced into `apps/www`.
- No pixel-baseline work (the site has no pixel harness).

## Decisions

- **D1 — API-domain build-time token, distinct from `{domain}`.** The `/mcp`
  endpoint is on the API host (`cap-api.…`), not the site host (`cap.…`). Add a
  new `NEXT_PUBLIC_API_URL` → `{apiDomain}` (or `{mcpEndpoint}`) token in
  `site-config.ts`/`resolveTokens`. *Alternatives:* hardcode the URL (rejected —
  not portable across self-host/deploys); reuse `{domain}` (rejected — prints
  the wrong host).
- **D2 — Section placement: after How-it-works, before Security.** "Connect your
  client" is a continuation of the how-to narrative and reads naturally before
  the host-root boundary disclosure.
- **D3 — Ship inert behind two gates.** The console code change is one flag flip;
  it adds no live MCP traffic until BOTH `mcpServer: true` (console) AND the
  backend `mcpServerEnabled` toggle (admin) are on — same pattern as
  `update-availability-check` / `self-update-action`.
- **D4 — Public page documents, console mints.** The landing section shows the
  endpoint + client setup steps + a pointer to mint in the console; it offers no
  mint control (a raw credential must never originate from an anonymous static
  page).
- **D5 — Activation precedes/accompanies the public copy.** Verify the live
  connect (flag + deploy + toggle + real token + `curl`) before/with shipping
  the landing copy, so the public site never advertises a connect path that
  cannot work yet.
- **D6 — `apps/www` stays decoupled.** The API-domain value is a build-time
  static string inlined into the static export; no runtime fetch is added,
  honoring the existing "Decoupled from console and backend" requirement.
- **D7 — frontend-console change is a flag flip only.** Flipping the existing
  `mcpServer` flag reuses the already-built `real.ts` MCP functions (from the
  remote-mcp-server change) with zero component-code change — exactly the
  capability-switch mechanism the spec already defines.

## Risks / Trade-offs

- **Live-connect proof needs a live tunnel + enabled toggle + real token** → keep
  it as a deploy-time smoke (curl `/mcp initialize` + a Claude/Cursor connect),
  not a CI gate.
- **Flag flipped but backend toggle off → minted token gets 503 at `/mcp`** →
  the console card already shows a "disabled" state; the landing copy notes the
  server must be enabled by an admin. Mitigated by D5 (enable + verify first).
- **No pixel harness on `apps/www` → new section has no visual-regression net** →
  reuse existing `section`/`card`/`command-box`/`container` components and the
  established design tokens; manual review.
- **`NEXT_PUBLIC_API_URL` unset in the www Vercel project → `{apiDomain}` falls
  to a placeholder** → mirror the `siteDomain()` fallback (readable placeholder,
  build never crashes); the deploy task includes setting the env.

## Migration Plan

**Deploy order:** flip `mcpServer: true` → redeploy console (Vercel) → set
`NEXT_PUBLIC_API_URL` in the www Vercel project → build/deploy www → admin
enables backend `mcpServerEnabled` → mint a real token in the console → `curl
/mcp initialize` confirms non-401/503 → Claude/Cursor live-connect smoke.

**Rollback:** flip `mcpServer: false` (console returns to mock; no live MCP), or
turn the backend toggle off (the `/mcp` endpoint immediately 503s). The landing
section is inert static copy — it can stay (harmless) or be reverted with its
commit.

## Open Questions

- Should the landing section also list the available MCP tools, or stay minimal
  and point to the console/docs? (Leaning minimal.)
- Exact bilingual wording for the nav anchor ("MCP" vs. "Connect MCP" / 连接 MCP).
