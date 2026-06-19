## Why

The remote MCP server ships and works for `POST` (curl `initialize` /
`tools/list` / `tools/call` all return 200 against v0.10.0), but a real MCP
client — Claude Code via `claude mcp add --transport http` — fails to connect:
`! Connected · tools fetch failed`. The cause is the `GET /mcp` channel: our
controller funnels `GET`/`DELETE`/`POST` into one `handle()` →
`transport.handleRequest`, but in stateless (`sessionIdGenerator: undefined`) +
`enableJsonResponse: true` mode there is no server→client SSE stream to serve, so
the SDK opens a GET stream that never emits and **hangs until timeout** (curl
`GET /mcp` hangs 10s, 0 bytes). Real clients open that GET channel during the
handshake and stall.

This was invisible to the prior `POST`-only curl verification. The official MCP
TS SDK guidance is explicit: in stateless mode, **reject non-POST requests with
405** (a JSON-RPC error). A spike with the same production SDK — identical except
`GET/DELETE → 405` — flips Claude Code from `tools fetch failed` to `✔ Connected`,
proving the fix direction.

## What Changes

- **`mcp.controller.ts`: `handleGet` / `handleDelete` return `405 Method Not
  Allowed`** (JSON-RPC error body + `Allow: POST`) instead of routing to
  `transport.handleRequest`. `handlePost` is unchanged (POST already works). This
  stops the hang so real MCP clients complete the handshake over POST-only.
- **Regression test** pinning `GET /mcp` and `DELETE /mcp` to a 405 JSON-RPC
  error that returns immediately (not a hang), alongside the existing POST tests.
- **www MCP-connect section gains concrete install commands** (bilingual), so the
  public docs show how to actually connect, not just the endpoint URL:
  - A (direct, recommended): `claude mcp add --transport http cap
    https://{apiDomain}/mcp --header "Authorization: Bearer mcp_<token>"`.
  - B (fallback): `npx mcp-remote https://{apiDomain}/mcp --header "..."` for
    stdio-only clients, with a short note on stdio-vs-streamable-HTTP so the
    "why not npx install?" question is answered.

No **BREAKING** change. The fix only stops GET/DELETE from hanging; the POST tool
surface, auth (401), and the `mcpServerEnabled` toggle (503) are untouched.

## Capabilities

### New Capabilities
<!-- None — this change corrects and documents existing capabilities. -->

### Modified Capabilities

- `mcp-server`: The "/mcp endpoint mounts the official SDK" requirement is
  corrected — stateless mode passes **only POST** to `transport.handleRequest`;
  `GET`/`DELETE` return `405` (no server→client SSE stream exists in
  `enableJsonResponse` stateless mode), so a real MCP client's handshake
  completes instead of hanging on an empty GET stream.
- `marketing-www`: The "MCP client connect section" requirement gains concrete,
  bilingual client install commands (direct `claude mcp add -t http` + the
  `npx mcp-remote` fallback) on top of the existing endpoint URL + token pointer.

## Impact

- **Code**:
  - `apps/api/src/mcp/mcp.controller.ts` — `handleGet`/`handleDelete` → 405.
  - `apps/api/src/mcp/*.spec.ts` — GET/DELETE 405 regression assertions.
  - `apps/www/components/sections/mcp-connect.tsx` + `content/{en,zh}.ts` — the
    install-command block (reusing the existing `{apiDomain}` token).
- **Behavior**: real MCP clients (Claude Code / Cursor / VS Code over streamable
  HTTP) connect successfully after deploy; POST tool calls unchanged.
- **No new deps**; `mcp-remote` is invoked by the END USER via `npx` (documented,
  not bundled).
- **Verification**: `apps/api` unit tests (GET/DELETE 405); `apps/www` build (no
  pixel harness). The live re-connect is a post-deploy smoke (re-run `claude mcp
  add` against the upgraded host).
- **Release**: ships via the `release-pr-bundle` skill (CREATE mode, `fix` →
  patch, v0.10.0 → v0.10.1); host upgrade to 0.10.1 makes it live. Not a code
  task here — a post-archive action.
