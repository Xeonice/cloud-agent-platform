<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: api-405-fix (depends: none)

- [x] 1.1 In `apps/api/src/mcp/mcp.controller.ts`, change `handleGet` and `handleDelete` to return `405 Method Not Allowed` — a JSON-RPC error body (`{ jsonrpc: "2.0", error: { code, message }, id: null }`) with an `Allow: POST` response header — instead of calling the shared `handle()`/`transport.handleRequest`. Keep `handlePost` exactly as is (it still runs the enable-toggle gate + `transport.handleRequest`). Update the controller doc comment to state: stateless + `enableJsonResponse` serves no server→client SSE stream, so GET/DELETE are 405 (routing them to the transport opens an empty SSE stream that hangs).
- [x] 1.2 Add a regression test in `apps/api/src/mcp/*.spec.ts` asserting: `GET /mcp` and `DELETE /mcp` return 405 with a JSON-RPC error body + `Allow: POST`, and do so SYNCHRONOUSLY (no hang / no open stream). Keep the existing POST scenarios (initialize/tools/list/tool-call) green. If the existing mcp spec drives the controller via a mocked transport, assert the transport's `handleRequest` is NOT invoked for GET/DELETE.
- [x] 1.3 Run `pnpm --filter @cap/api test` + `pnpm --filter @cap/api typecheck` (and lint) — all green, including the new 405 assertions and the unchanged POST tool tests.

## 2. Track: www-install-docs (depends: none)

- [x] 2.1 In `apps/www/content/index.ts`, extend `McpConnectContent` with fields for the two install commands + a short transport note (e.g. `installLabel`, `directCommand` carrying `{apiDomain}`, `fallbackLabel`, `fallbackCommand` carrying `{apiDomain}`, `transportNote`, plus copy labels). Keep it shaped so en/zh stay structurally symmetric.
- [x] 2.2 In `apps/www/content/en.ts` and `apps/www/content/zh.ts`, author the new fields (symmetric): (A) direct `claude mcp add --transport http cap https://{apiDomain}/mcp --header "Authorization: Bearer mcp_<token>"`; (B) fallback `npx mcp-remote https://{apiDomain}/mcp --header "Authorization: Bearer mcp_<token>"`; and a one-line note distinguishing stdio (local process) from streamable HTTP (remote service) — answering "why not npx install?". Token shown as the `mcp_<token>` placeholder, never a real value.
- [x] 2.3 In `apps/www/components/sections/mcp-connect.tsx`, render the two install commands (reuse `CommandBox` with `prompt={null}`, `resolveTokens(...)` to fill `{apiDomain}`) under the existing endpoint block, plus the transport note. Keep the section `id="mcp"`, the existing endpoint display, the steps, and the "mint in the console" pointer (still NO token-mint control).
- [x] 2.4 Run the `@cap/www` build + typecheck + lint with `NEXT_PUBLIC_API_URL` set; confirm BOTH `en` and `zh` static exports render the two install commands with the API-host endpoint (`https://cap-api.douglasdong.com/mcp`, not the raw `{apiDomain}` token, not the site host). No pixel harness on www — unit/build verification only.
