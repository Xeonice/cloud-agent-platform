## Context

The remote MCP server (`mcp-server`, shipped v0.10.0) serves `POST /mcp`
correctly (curl `initialize`/`tools/list`/`tools/call` → 200), but a real MCP
client (Claude Code `claude mcp add --transport http`) reports `! Connected ·
tools fetch failed`. The controller funnels `GET`/`DELETE`/`POST` into one
`handle()` → `transport.handleRequest`. In stateless (`sessionIdGenerator:
undefined`) + `enableJsonResponse: true` mode there is NO server→client SSE
stream, but GET handed to `transport.handleRequest` makes the SDK open an empty
SSE stream that hangs to timeout (curl `GET /mcp` → 10s, 0 bytes). A spike (same
SDK, only `GET/DELETE → 405`) flipped Claude Code to `✔ Connected`, proving the
fix. The prior verification was `POST`-only curl, so it never hit the GET channel.

## Goals / Non-Goals

**Goals:**
- Real MCP clients (Claude Code / Cursor / VS Code over streamable HTTP) connect
  successfully — stop the GET/DELETE hang.
- Pin the fix with a regression test.
- Document the concrete install commands publicly (www), incl. the `npx
  mcp-remote` fallback, answering "why not npx install?".

**Non-Goals:**
- No server→client SSE stream / resumability / stateful sessions (we stay
  stateless + JSON).
- No change to the POST tool surface, auth (401), or the `mcpServerEnabled`
  toggle (503).
- No bespoke `@cap/mcp` npm package (mcp-remote covers the stdio bridge).
- No Cloudflare-tunnel SSE work (405 sidesteps it entirely).

## Decisions

- **D1 — 405-stateless over "make SSE work through CF".** Return 405 for
  GET/DELETE rather than serving a real server→client SSE stream. It is the
  official stateless pattern, the spike proved it lets Claude Code fall back to
  POST-only, and it **sidesteps the entire SSE-over-Cloudflare-tunnel problem**
  (G7: cloudflared buffers GET-SSE + idle timeout) — nothing is streamed, so
  nothing can stall. *Alternative (rejected):* switch to stateful sessions +
  real SSE → more moving parts AND still has to survive the CF tunnel.
- **D2 — Status-code precedence is explicit.** The `/mcp` request path is:
  `requireBearerAuth` middleware (in `main.ts`, runs FIRST) → controller. So:
  - no/invalid bearer, ANY method → **401** (middleware, unchanged);
  - valid bearer + `GET`/`DELETE` → **405** (controller — method unsupported in
    stateless mode; the toggle is NOT consulted, the method is simply not served);
  - valid bearer + `POST` + toggle off → **503** disabled (unchanged);
  - valid bearer + `POST` + toggle on → served (unchanged).
  405 is a method-layer verdict that sits AFTER auth and is independent of the
  enable toggle.
- **D3 — www documents A (direct) + B (mcp-remote), not C (own package).** A:
  `claude mcp add --transport http` (works after this fix; same URL+header shape
  for Cursor/VS Code). B: `npx mcp-remote <url> --header` for stdio-only clients.
  C (publish `@cap/mcp`) is rejected — mcp-remote is the generic, maintained
  bridge; a bespoke package is duplicate work.
- **D4 — Release via the `release-pr-bundle` skill.** This `fix` is patch tier →
  v0.10.0 → v0.10.1, CREATE mode (no open `release-bundle` PR). The skill owns
  the manifest+CHANGELOG bump and supersedes release-please's auto PR; tagging is
  a post-merge PAT `gh release create`. This is a post-archive action, recorded
  here, NOT a code task in tasks.md.

## Risks / Trade-offs

- **[A client that REQUIRES a working GET SSE stream still fails]** → The spike
  shows Claude Code falls back to POST-only, which is the spec-mandated stateless
  client behavior; any conformant streamable-HTTP client must tolerate GET 405.
  Mitigation: the `npx mcp-remote` fallback (B) for non-conformant/stdio clients.
- **[The fix only matters once deployed]** → It lives in `apps/api`; the live
  re-connect proof needs the host upgraded to 0.10.1. Mitigation: the spike
  already proves the behavior offline; post-deploy is a quick `claude mcp add`
  re-test.
- **[www install docs could drift from reality if flags/endpoints change]** →
  Commands reuse the existing build-time `{apiDomain}` token (no hardcoded host);
  the `mcp_` token is shown as a placeholder, never a real credential.

## Migration Plan

Deploy order: propose → apply → verify → archive → **`release-pr-bundle`
(CREATE, v0.10.1)** → review+merge (rebase/merge-commit, NOT squash) → post-merge
`gh release create v0.10.1` (PAT) → `release.yml` builds GHCR images → host
upgrade `CAP_VERSION=0.10.1` + `up -d` → re-run `claude mcp add --transport http`
against the live host to confirm `✔ Connected`.

**Rollback:** revert the controller change (GET/DELETE go back to the prior
hang — i.e. status quo ante); no data/schema involved. The www doc change is
inert static copy.

## Open Questions

- Should the www section also show a Claude Desktop JSON-config snippet (the
  `{ "command": "npx", "args": ["mcp-remote", ...] }` form) in addition to the
  CLI commands? (Leaning yes for B, since Claude Desktop has no `claude mcp add`.)
