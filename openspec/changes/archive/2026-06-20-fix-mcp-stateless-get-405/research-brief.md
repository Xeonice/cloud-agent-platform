# Research Brief — fix-mcp-stateless-get-405

Side-car notes from `/opsx:explore` + a spike (2026-06-20). Not a tracked
artifact; grounds the proposal/design/specs/tasks in measured evidence.

## The bug, reproduced

Real MCP client (Claude Code, `claude mcp add --transport http cap <url>`):
```
cap: https://cap-api.douglasdong.com/mcp (HTTP) - ! Connected · tools fetch failed
```
"Connected" (TCP + bearer OK) but "tools fetch failed" (the MCP handshake never
completes).

curl probes against the live `/mcp` (v0.10.0):
| request | result |
|---|---|
| `POST` initialize / tools/list / tools/call | **200** ✓ (all fine) |
| **`GET /mcp`** (the SSE channel) | **hangs → 10s timeout, 0 bytes** ✗ |

So `POST`-only curl testing (what the prior verification did) never touched the
`GET` SSE channel — the blind spot that hid this.

## Root cause — in the spec text itself

`apps/api/src/mcp/mcp.controller.ts`: `handleGet`/`handleDelete`/`handlePost` all
funnel into one `handle()` → `transport.handleRequest`. We run **stateless**
(`sessionIdGenerator: undefined`) + `enableJsonResponse: true` (plain JSON, NO
server→client SSE stream). But GET is handed to `transport.handleRequest`, which
the SDK treats as an SSE-stream channel and opens a stream that **never emits**,
hanging until timeout.

The `mcp-server` spec requirement "The /mcp endpoint mounts the official SDK and
is bearer-protected" literally says *"in stateless mode (POST/GET/DELETE),
passing the pre-parsed JSON body to `transport.handleRequest`"* — i.e. the spec
itself mandated the buggy all-methods funnel. The fix is a spec MODIFY, not just
a code patch.

## Official guidance (MCP TS SDK, via context7)

Fastify middleware README: *"If you create a new McpServer per request in
stateless mode... **To reject non-POST requests with 405 Method Not Allowed, add
routes for GET and DELETE that send a JSON-RPC error response.**"* And
`enableJsonResponse: true` = *"output plain JSON instead of SSE streams"*. We
have no SSE stream to serve, so GET/DELETE should 405. We omitted that.

## Spike — fix direction proven (the decisive evidence)

Built a minimal stub with the SAME production SDK + stateless + enableJsonResponse,
POST through the SDK, but **GET/DELETE → 405**. Only variable vs production: GET
405 vs GET hang.

| server | GET behavior | Claude Code result |
|---|---|---|
| production cap | hangs 10s | `tools fetch failed` |
| spike (405) | immediate 405 (0.0005s) | **`✔ Connected`** |

→ Claude Code falls back to POST-only request/response after a GET 405 (the
official stateless client behavior). **Fixing GET/DELETE to 405 is sufficient —
no SSE needed.** Spike cleaned up (throwaway script deleted, test config removed,
process killed).

## Why 405 over "make SSE work through Cloudflare"

405 sidesteps the entire SSE-over-Cloudflare-tunnel problem (G7: cloudflared
buffers GET-SSE + ~idle timeout). No SSE stream opened → nothing for CF to
buffer. Simpler AND more robust than serving a real SSE stream through the
tunnel.

## Transport landscape (answers "why not npx install?")

Three MCP connection shapes:
- **stdio** (the `npx some-mcp` the user has seen): client spawns a local
  subprocess; tool logic runs on the user's machine. Good for local tools.
- **streamable HTTP** (ours): client connects to a remote URL + Bearer. Good for
  hosted services with a backend/DB/auth (we're a task pool + sandboxes + OAuth).
- **`npx mcp-remote <url>`**: a local stdio↔remote-HTTP bridge — the standard
  "npx way" to reach a REMOTE MCP from stdio-only clients. Still connects to our
  HTTP, so it does NOT bypass the server bug; the 405 fix is still the core.

Our service is inherently remote (can't pack a task pool into an npx package), so
streamable HTTP is right; we'll document A (direct `claude mcp add -t http`) +
B (`npx mcp-remote` fallback), not ship a bespoke `@cap/mcp` package.

## Release path (user added the release-pr-bundle skill)

Releasing now goes through the `release-pr-bundle` skill (self-managed release PR,
owns the version bump), superseding release-please's auto PR. This fix is a `fix`
→ patch tier → v0.10.0 → v0.10.1. CREATE mode (no open `release-bundle` PR yet).
Post-merge tag via PAT `gh release create`. This is a post-archive action, not a
code task in this change.
