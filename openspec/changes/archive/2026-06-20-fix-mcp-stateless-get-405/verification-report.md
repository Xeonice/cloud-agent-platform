# Verification Report — fix-mcp-stateless-get-405

Three-way routing of the adversarial verify pass. The raw skeptic raised ONE
requirement as unmet; on end-to-end re-trace it resolves to **MET**
(met-as-written, with a deliberately-deferred live smoke that does not block the
primary scenario). No code task is re-opened and no spec defect is recorded.

## Tally (adjudicated, not raw skeptic count)

- reopenedTasks: 0
- specDefects: 0
- reclassifiedMet: 1

## MET (folded from raw-unmet)

### The /mcp endpoint mounts the official SDK and is bearer-protected — `mcp-server`

**Skeptic's refutation:** Scenario 4 ("A real MCP client completes the handshake
over POST" — Claude Code via `claude mcp add --transport http` connects, gets 405
on its GET attempt, proceeds over POST, fetches the tool list, no `tools fetch
failed` hang) has NO traceable implementation: every test is a structural unit
test with fake responses; there is no E2E/live test driving a real
streamable-HTTP MCP client against the server. (Confirmed: a clean grep of
`apps/api/src/mcp/` finds no `StreamableHTTPClientTransport`, no `new Client`, no
`mcp-remote` harness.)

**Re-trace verdict — MET (met-as-written; the one missing piece is an
intentionally-deferred post-deploy smoke, not a code gap).** The requirement
carries four scenarios; three are directly traced and the fourth shares its
entire load-bearing code path with Scenario 3:

- **Scenario 1 (authorized client lists + calls a tool) — MET.**
  `mcp.controller.ts:118-135` builds a fresh stateless transport
  (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), connects the one
  shared `McpServer`, and hands the pre-parsed body to `transport.handleRequest`.
  `mcp-bearer-sdk.spec.ts:56-168` connects a *real* `StreamableHTTPServerTransport`
  to the shared server and asserts `connect` + `handleRequest` run, one fresh
  transport per request. `mcp.spec.ts` exercises tool dispatch through the
  captured callbacks against the same `McpToolDeps` the console uses.

- **Scenario 2 (unauthorized → 401) — MET.** `main.ts:246-271` mounts
  `mcpBearerAuthMiddleware` (wrapping the SDK `requireBearerAuth` with the
  `resolveMcpToken` verifier) on `/mcp` before the Nest pipeline.
  `mcp-bearer-sdk.spec.ts:175-258` drives the real SDK middleware → 401 on
  absent/invalid bearer and confirms `next()` is NOT called.
  `auth-session.service.ts:343-401` enforces hash lookup + revocation/expiry +
  allowlist + mandatory `expiresAt`.

- **Scenario 3 (authorized GET/DELETE → 405 without hanging) — MET.**
  `mcp.controller.ts:82-91` routes `@Get`/`@Delete` to `methodNotAllowed`
  (`:159-168`): status 405, `Allow: POST`, JSON-RPC error body, written
  synchronously. `mcp.spec.ts:365-425` asserts 405 + `Allow: POST` + JSON-RPC
  envelope + `state.ended === true` (synchronous, no open stream / no hang) +
  `serverTouched === false` (no transport opened) + the toggle is NOT consulted
  (`findUnique` throws if called). This is the regression that the change exists
  to pin.

- **Scenario 4 (a real MCP client completes the handshake over POST) — MET as
  written; its only unautomated part is a deferred live smoke.** The *behavior*
  Scenario 4 asserts is produced entirely by code that is present and tested: a
  conformant streamable-HTTP client opens a GET stream during its handshake,
  receives a **clean synchronous 405 with `Allow: POST`** (Scenario 3's exact
  code path — no empty SSE stream is opened, so nothing can hang), then falls
  back to POST-only request/response, which dispatches tools (Scenario 1). The
  change deliberately scopes the *live re-connect* of a real client to a
  **post-deploy smoke against the upgraded host**, not an in-repo automated test:
  - proposal.md:67-68 — "The live re-connect is a post-deploy smoke (re-run
    `claude mcp add` against the upgraded host)."
  - design.md:11-12 (Context) — "A spike (same SDK, only `GET/DELETE → 405`)
    flipped Claude Code to `✔ Connected`, proving the fix."
  - design.md:79-80 (Migration Plan) — "re-run `claude mcp add --transport http`
    against the live host to confirm `✔ Connected`."
  No edit to the shipped controller or its unit tests would satisfy "a real
  Claude Code client connects" more than the present synchronous-405 + working
  POST already does; standing up a real MCP client in CI is explicitly outside
  the unit/build verification scope this change set. Hence: **a minor gap (no
  automated live-client E2E) that does NOT block the primary scenario** — routed
  to MET, not re-opened as a code task and not a spec defect (the scenario is
  unambiguous and *is* testable — at deploy time, per the migration plan).

**Structural guards also satisfied (requirement preamble):** official SDK pinned
(`package.json:27` `@modelcontextprotocol/sdk ^1.29.0`, installed at
`node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0`); the controller imports
the v1.x single-package subpath `@modelcontextprotocol/sdk/server/streamableHttp.js`
and `mcp-bearer-sdk.spec.ts:32-54` asserts it does **not** import `@rekog/mcp-nest`
or the v2-alpha `@modelcontextprotocol/express`; coexists with the `ws`
`/terminal` adapter + global JSON parser; status-code precedence (401 →
405 → 503) holds across the controller (`mcp.controller.ts`) + bearer
middleware (`main.ts`).

## Gap / scope findings

### Gap — Scenario 4 has no in-repo automated live-client test (accepted, deferred)

The marketing-www "MCP client connect section" requirement (the change's other
spec) is fully implemented across all five scenarios — content/commands/token
pointer in `en.ts` + `zh.ts`, `McpConnect` rendering both commands via
`resolveTokens`, `site-config.ts` `apiDomain()` from `NEXT_PUBLIC_API_URL`, and
both `en`/`zh` static exports rendering the section — and was not contested. The
sole gap across both specs is Scenario 4 of `mcp-server`: no E2E/live MCP-client
connection test exists in the repo. This is **accepted and deferred** to the
post-deploy `claude mcp add` smoke that the proposal and design migration plan
already prescribe (host upgrade to v0.10.1 → re-run against the live host). It is
NOT a code task and NOT a spec defect.

### Scope — co-located working-tree changes from a different change (isolate at commit)

The working tree contains **two** change directories side-by-side:
`fix-mcp-stateless-get-405` (this change — `apps/api/src/mcp/*` +
`apps/www/content/*` + `apps/www/components/sections/mcp-connect.tsx`) and
`align-claude-runtime-resident-session` (a separate, unrelated change). The
following modified files carry NO requirement in either of THIS change's two
tracks (`api-405-fix`, `www-install-docs`) and belong to the other change — they
must be isolated out of this change's commit at release time:

- `apps/api/src/agent-runtime/claude-code-runtime.ts` — `detectExit` refactored
  from JSONL `end_turn` detection to a tmux `has-session` probe (resident-session
  behavior).
- `apps/api/src/agent-runtime/agent-runtime.test.mjs:422` — golden test updated to
  assert the tmux `has-session` probe and no kill-session/transcript-tail for
  claude `detectExit`.
- `apps/api/src/agent-runtime/claude-transcript.ts` — new transcript helpers
  (turn-complete retention primitives for the resident-session layer).
- `apps/api/src/guardrails/guardrails.service.ts` — modified (no guardrails
  requirement in this spec).
- `apps/api/src/guardrails/guardrails-exit-roundtrip.test.mjs` — updated (no
  guardrails requirement in this spec).
- `apps/api/src/terminal/aio-pty-client.ts` — modified (no terminal/pty
  requirement in this spec).

This is working-tree co-location (two changes share one checkout), not scope
creep authored into this change. No action on the spec; the release/commit step
must stage only the mcp + www files for `fix-mcp-stateless-get-405`.
