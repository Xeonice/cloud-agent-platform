# Verification Report — activate-mcp-server-and-www-connect-section

Adjudicated re-trace of every spec requirement against the actual implementation
(not a rubber-stamp of the raw skeptic pass). Three-way routing tally:

- **Re-opened code tasks (UNMET):** 0
- **Spec defects (routed to design.md Open Questions):** 0
- **Reclassified / confirmed MET:** 3

The raw-unmet input was empty (`[]`); each requirement below was independently
re-traced end-to-end and confirmed MET.

---

## MET — `frontend-console`: MCP Server settings operate against the live backend

**Verdict: MET (end-to-end).** Spec file:
`specs/frontend-console/spec.md`.

Evidence:

- `mcpServer: true` is set in `apps/web/src/lib/api/capabilities.ts:189` (the
  single real/mock switch point), with the inline comment updated to record the
  `/mcp-tokens` + `/settings/mcp-server` endpoints are verified live.
- All five real-seam functions exist in `apps/web/src/lib/api/real.ts`:
  `listMcpTokens` (797), `mintMcpToken` (831), `revokeMcpToken` (855),
  `getMcpServerEnabled` (865), `setMcpServerEnabled` (877).
- They are wired through the `isCapable("mcpServer")` seam in
  `apps/web/src/lib/api/queries.ts` (`mcpTokensQuery` 465, `mcpServerEnabledQuery`
  479) and `apps/web/src/lib/api/mutations.ts` (`mintMcpTokenMutation` 427,
  `revokeMcpTokenMutation` 444, `setMcpServerEnabledMutation` 465) — `true` →
  `real.*`, `false` → `mock.*`.
- The show-once raw token is the SERVER's one-time response, never
  client-fabricated: `MintMcpTokenResponse.token` (`real.ts:786-792`) carries the
  raw `mcp_…` value from the api's `/mcp-tokens` POST reply.
- Ship-inert posture holds: the backend `/mcp` endpoint returns `503 "MCP server
  is disabled"` when `mcpServerEnabled=false` (`apps/api/src/mcp/mcp.spec.ts:286`
  + the no-`SystemSettings`-row default-off test), and the bearer is resolved via
  `requireBearerAuth → resolveMcpToken` (`mcp.controller.ts:27`,
  `mcp-tools.ts:16`) when enabled. So an admin MUST enable the toggle for a minted
  token to drive a live session.
- All three scenarios trace: (a) mint hits real `/mcp-tokens`; (b) a real token
  connects once the toggle is on (no 401/503); (c) with the flag on but toggle
  off, the section still mints/lists/revokes real tokens while `/mcp` reports
  disabled.

Regression check: `pnpm --filter @cap/web test` → **156/156 green**, including
the 6 `mcp-server-section` and 6 `mcp-tokens` tests (the two `mcp-server-section`
queryFn tests were correctly re-pointed to the real seam by the flag flip, per
task 1.2).

Note (met-as-written, non-blocking): the full live-connect proof (scenario "a
minted token connects once the server is enabled" against the real `/mcp`) is a
deploy-time smoke (tasks 5.1–5.6, LEFT FOR THE OPERATOR per the same ship-inert
activation pattern as update-availability-check / self-update). The code path is
complete and the negative gate (503 when off) is unit-proven; the affirmative
live JSON-RPC round-trip requires the live tunnel + enabled toggle + a real
token, which is not a CI-gateable step. This does not block the primary
"settings operate against the live backend" scenario, which is fully satisfied
by the flag flip + real-seam wiring above.

---

## MET — `marketing-www`: Landing information architecture (MODIFIED)

**Verdict: MET (end-to-end).** Spec file: `specs/marketing-www/spec.md`.

Evidence:

- All six sections render in the spec-required order in
  `apps/www/app/[locale]/page.tsx`: `Hero → Features → HowItWorks → McpConnect →
  Security → SelfHostCta`, wrapped by `SiteNav` + `SiteFooter` (the MCP-connect
  section is correctly inserted after How-it-works, before Security — D2).
- Hero `curl | sh`: `installCommand: "curl -fsSL https://{domain}/install.sh | sh"`
  (`content/en.ts:40`) shown in a `CommandBox` with copy control
  (`copyLabel`/`copiedLabel`), an inspectable script URL (`inspectLabel`), and the
  disclosed manual `git clone … && make up` alternative (en.ts:47-51).
- Features describe only real capabilities (per-task isolation, terminal
  streaming, dual runtime Codex + Claude Code, GitHub import, history/metrics,
  OAuth + allowlist).
- Security section discloses the host-root `docker.sock` boundary and the
  fail-closed allowlist posture (en.ts Security points; zh.ts symmetric title
  "控制台访问即等于主机 root").

---

## MET — `marketing-www`: MCP client connect section (ADDED)

**Verdict: MET (end-to-end).** Spec file: `specs/marketing-www/spec.md`.

Evidence:

- `apps/www/components/sections/mcp-connect.tsx` renders a `Section id="mcp"`
  (the nav/footer anchor target) with the endpoint, three ordered client-setup
  steps, the `tokenNote`, and a `tokenCta` link — and NO token-mint control.
- The endpoint is resolved at build time from the `{apiDomain}` token:
  `resolveTokens(mcpConnect.endpoint)` → `mcp-connect.tsx:21`; `endpoint:
  "https://{apiDomain}/mcp"` (`content/en.ts:139`, `content/zh.ts:135`).
- `{apiDomain}` is DISTINCT from the site-host `{domain}`:
  `resolveTokens` (`lib/site-config.ts:98-103`) maps `{domain}` → `siteDomain()`
  and `{apiDomain}` → `apiDomain()` (reads `NEXT_PUBLIC_API_URL`, with a safe
  `your-api-domain.example` fallback) — two separate hosts.
- **Build-time inlined, no runtime fetch — proven by the static export**: the
  existing `apps/www/out/` build renders `https://cap-api.douglasdong.com/mcp`
  (the API host, NOT the site host `cap.douglasdong.com`) in BOTH
  `out/en/index.html` and `out/zh/index.html`, with **zero `{apiDomain}` raw
  tokens leaked** (grep count 0). No runtime backend call is introduced (the
  value is a static string).
- Token minting delegated to the console: `tokenNote` states "Tokens are minted
  in the console settings page … This page documents the connection; it never
  mints a token" (en.ts:159-160; zh.ts symmetric), and there is no mint
  affordance on the page.
- Bilingual + statically exported: `McpConnectContent` is part of `SiteContent`
  (`content/index.ts:154/219`); `generateStaticParams` enumerates `en` + `zh`
  (`page.tsx`); both locales carry the rendered `id="mcp"` section with strict
  structural parity (eyebrow/title/description/endpointLabel/endpoint/copy
  labels/3 steps/tokenNote/tokenCta).
- `apps/www` typecheck passes clean (exit 0) with the new component + type.

Note (met-as-written, non-blocking): `tokenCta.href` is `#self-host` (the
in-page self-host section that carries the console link) rather than a direct
console-settings deep link. The requirement is "direct the reader to mint the
token in the console settings page" — the `tokenNote` copy states this
explicitly and the CTA routes toward the console path, with no mint control on
the public page. The minor href target is a copy/navigation detail that does not
block the "token minting is delegated to the console" scenario. (Cross-ref the
design.md Open Question on exact nav wording.)

---

## Gap / scope findings

**Gap:** None blocking. All checks complete. The only items NOT provable in CI
are the deploy-time live-connect smokes (tasks 5.1–5.6) — by design a
LEFT-FOR-THE-OPERATOR activation step (live Vercel deploys + admin toggle + a
real token + the live tunnel), mirroring update-availability-check /
self-update Phase-1 activation. The code ships INERT and complete; these smokes
are activation, not implementation.

**Scope — skeptic's "scope creep" REFUTED on re-trace.** A prior skeptic pass
flagged five files as out-of-scope for this change:

1. `apps/web/e2e/serve-design-baseline.mjs` (ROOT re-pointed)
2. `apps/web/e2e/visual/baseline.capture.ts` (comment path)
3. `apps/web/e2e/visual/manifest.ts` (comment path)
4. `apps/web/e2e/visual/verify-replay.mjs` (BASELINE const re-pointed)
5. `apps/web/e2e/design-baseline/` (the relocated baseline tree, 10+ files)

These are NOT scope creep against `activate-mcp-server-and-www-connect-section`.
Re-trace shows every one of them is OWNED by a separate, properly-proposed,
co-resident change in the working tree: **`stabilize-visual-baseline-path`**, whose
`tasks.md` enumerates them explicitly — task 1.1 copies the baseline tree to
`apps/web/e2e/design-baseline/`, task 1.2 adds `history-replay-preview.html`,
task 2.1 re-points `serve-design-baseline.mjs` ROOT, task 2.2 re-points
`verify-replay.mjs` BASELINE, task 2.3 cleans the `baseline.capture.ts` /
`manifest.ts` comments. Sharing one working tree across multiple in-flight
OpenSpec changes is an established pattern in this repo. The files are correctly
attributed to that sibling change and require commit-time separation, not a
scope-creep reopen here.

The actual surface of THIS change is exactly its proposal's Impact list:
`apps/web/src/lib/api/capabilities.ts` (flag flip) + the two MCP test files it
re-pointed; and on the www side `apps/www/lib/site-config.ts`,
`apps/www/content/{index,en,zh}.ts`, `apps/www/components/sections/mcp-connect.tsx`,
`apps/www/app/[locale]/page.tsx`, `apps/www/.env.example`. No scope creep within
this change's own files.

---

## Tally

| Destination | Count |
| --- | --- |
| Re-opened code tasks (UNMET) | 0 |
| Spec defects (design.md Open Questions) | 0 |
| Confirmed / reclassified MET | 3 |

All three spec requirements are MET end-to-end. The change is verified at the
code/build/unit level; only the operator-run deploy-time live-connect smokes
(5.1–5.6) remain, by design.
