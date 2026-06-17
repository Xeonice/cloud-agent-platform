<!-- Track-annotated tasks (CORRECTED PARTITION). contracts first (shared dep),
     then three DISJOINT code areas in parallel: discovery-hardening (api/settings
     SSRF+validation), execution-injection (api/sandbox config.toml bridge), and
     frontend-wiring (web data layer). A serial INTEGRATION track follows for the
     cross-track shared-file tasks (2.3 shares packages/contracts/src/settings.ts
     with 1.1; 3.7 + 4.2 both edit apps/web/.../codex-api-key-dialog.tsx).
     P0 = makes compatible provider functional & safe; P1/P2 tagged inline.

     File ownership (post-rebalance, disjoint per parallel track):
       contracts          → packages/contracts/src/settings.ts (ADD schemas only),
                             apps/api/src/settings/settings.controller.ts
       discovery-hardening → apps/api/src/settings/assert-safe-provider-url.ts (NEW),
                             model-discovery.client.ts, settings.service.ts,
                             settings-logic.ts, settings/*.test.mjs
       execution-injection → apps/api/src/sandbox/{codex-auth-source.port,
                             prisma-codex-auth-source, env-codex-auth-source,
                             aio-sandbox.provider}.ts, sandbox/*.test.mjs
       frontend-wiring     → apps/web/src/lib/api/{real,queries,mutations}.ts
       integration (serial)→ packages/contracts/src/settings.ts (2.3 refine, after 1.1),
                             apps/web/.../codex-api-key-dialog.tsx (4.2 then 3.7)
     NOTE: 2.3 was rebalanced OUT of discovery-hardening and 3.7 OUT of
     execution-injection because each co-writes a file owned by another track. -->

## 1. Track: contracts (depends: none)

- [x] 1.1 Lift the `DiscoverModels` request schema (today `apps/api/src/settings/settings.controller.ts:39`) and a `DiscoverModelsResponse`/model-list schema into `packages/contracts/src/settings.ts`, export them, and update the controller to import from `@cap/contracts` so the api and web app share one shape. [P0]

## 2. Track: discovery-hardening (depends: contracts)

- [x] 2.1 Add an `assertSafeProviderUrl(baseUrl)` guard in a shared `apps/api/src/settings` module: require scheme ∈ {http,https}; resolve the host and reject loopback / private / link-local / ULA / `0.0.0.0` / `::` / `169.254.169.254`. Export it for reuse by the execution path. [P0]
- [x] 2.2 In `apps/api/src/settings/model-discovery.client.ts`, call `assertSafeProviderUrl` before fetching; add `signal: AbortSignal.timeout(<few s>)` (pattern at `aio-sandbox.provider.ts:361`), `redirect: 'manual'` with redirect-target re-validation, and a response-body size cap (content-length check + bounded read) before `JSON.parse`. [P0 SSRF / P1 bounds]
- [x] 2.4 Make compatible `connected` mean *validated*: in `settings.service.ts saveCredential`, re-probe the provider for compatible mode (reject auth/unreachable; validate `defaultModel ∈` reported models) or carry a probe-confirmed token, and derive `connected` from a successful validation rather than `baseUrl && apiKeyCiphertext` presence. [P1]
- [x] 2.5 Tests (`apps/api/src/settings/*.test.mjs`): SSRF rejection of `169.254.169.254`/`localhost`/`file:`/`gopher:` with NO outbound fetch; timeout + body-size bound; compatible-save-without-baseUrl rejected; `connected` only after a successful validation. [P0]

## 3. Track: execution-injection (depends: contracts, discovery-hardening)

- [x] 3.1 Verify the codex `0.131` `config.toml` `[model_providers.*]` schema and key-delivery against the canonical reference (`developers.openai.com/codex/config-reference`). **DONE — findings**: `wire_api` is `"responses"`-only (default); the API key for a custom provider is delivered via `experimental_bearer_token` (inline) or an `env_key` env var, NOT `auth.json` (which serves only the built-in `openai` provider); top-level keys `model` + `model_provider`. Emit: `[model_providers.cap]` { name, base_url, wire_api="responses", experimental_bearer_token } + top-level model/model_provider; write NO auth.json for compatible. Product constraint: provider must be Responses-API compatible (not chat-completions-only). [P0 — de-risks D1]
- [x] 3.2 Extend `CodexAuthMaterial` in `apps/api/src/sandbox/codex-auth-source.port.ts` into a discriminated union: `{ kind:'official', authJson }` vs `{ kind:'compatible', baseUrl, apiKey, model }`. [P0]
- [x] 3.3 In `apps/api/src/sandbox/prisma-codex-auth-source.ts`, add a `mode === 'compatible'` branch that decrypts `apiKeyCiphertext` (reusing `decryptSecret`) and returns compatible material; replace the `findFirst({ allowed:true }, createdAt asc)` resolution with **task-owner-scoped** resolution by threading the owning account identity through `getCodexAuth` / the provision lookup. [P0 — injection + owner-scope]
- [x] 3.4 In `apps/api/src/sandbox/aio-sandbox.provider.ts injectCodexAuth`, branch on material kind: for compatible, call `assertSafeProviderUrl(baseUrl)`, then append to the injected `~/.codex/config.toml` a `[model_providers.cap]` block (`base_url`, `wire_api = "responses"`, `experimental_bearer_token = "<decrypted key>"`) + top-level `model_provider = "cap"` + `model = "<defaultModel>"`, preserving the workspace `trust_level` block. **Write NO auth.json for compatible mode.** Leave the official path (auth.json) and the env fallback (accounts with no compatible cred) unchanged. [P0]
- [x] 3.5 Tests (`apps/api/src/sandbox/*.test.mjs`): compatible material yields the expected config.toml (`model_providers.cap` base_url + wire_api responses + experimental_bearer_token + top-level model/model_provider) and NO auth.json; resolution is owner-scoped (operator B's task gets B's cred); official/none falls back unchanged; an unsafe Base URL is not written. [P0]
- [x] 3.6 Sandbox smoke check asserting codex actually targets the custom `base_url` + selected model and authenticates end-to-end (confirms `experimental_bearer_token` works on 0.131; if not, fall back to `env_key` + an injected process env var). [P1]

## 4. Track: frontend-wiring (depends: contracts)

- [x] 4.1 Add a `discoverCodexModels` client in `apps/web/src/.../real.ts` (POST `/settings/codex/models` via the shared `@cap/contracts` schema) plus a query/mutation in the data layer. [P0]
- [x] 4.3 Run the web app's typecheck/lint/build to confirm the dialog compiles against the shared contract with the mock removed. [P0] (Green: @cap/web build + typecheck clean; web vitest 103/103.)

## 5. Track: integration (depends: contracts, discovery-hardening, execution-injection, frontend-wiring) — SERIAL

<!-- Shared-file tasks isolated here so no two parallel tracks co-write a file.
     Run AFTER all parallel tracks finish; within this track the order matters
     where two tasks edit the same file (4.2 before 3.7 on the dialog). -->

- [x] 2.3 Refine `SaveCodexCredentialRequestSchema` (`packages/contracts/src/settings.ts`) and/or `projectCredentialSave` (`settings-logic.ts`) so `mode === 'compatible'` requires a non-null `baseUrl`; reject a compatible save without a base URL in `saveCredential` before any write. [P1] (SHARED `packages/contracts/src/settings.ts` with 1.1 — apply after the contracts track's additive schema lift.)
- [x] 4.2 In `apps/web/src/components/settings/codex-api-key-dialog.tsx`, replace `discoverModelsMock` and the non-empty-field "test" with the real mutation: reflect the real outcome class for 测试, populate the default-model picker from the response, require a selection, and gate save on a real successful probe. [P0] (SHARED `codex-api-key-dialog.tsx` with 3.7 — apply before 3.7.)
- [x] 3.7 In the settings compatible-provider dialog (`apps/web/src/components/settings/codex-api-key-dialog.tsx`), add copy stating the provider must be OpenAI Responses-API compatible (not chat-completions-only). [P1] (SHARED `codex-api-key-dialog.tsx` with 4.2 — apply after 4.2's rewrite.)

## Track: verify-reopened (depends: none)

<!-- Re-opened by adversarial verification: a spec requirement re-traced
     end-to-end as UNMET against the actual read path. Save-side (task 2.4)
     is correct; the READ side is the defect. -->

- [x] V1 Make the credential READ surface the persisted `state` column instead of re-deriving it from field presence. `settings.service.ts readCredential` (`apps/api/src/settings/settings.service.ts:238-260`) builds `StoredCredentialFacts` WITHOUT `row.state`, and `projectCredentialRead` → `deriveCredentialState` (`settings-logic.ts:258-259`) returns `connected` for any compatible row with `hasBaseUrl && hasApiKey`. Result: a compatible row that task 2.4 correctly persisted as `not_saved` (probe failed or no probe ran — the key+baseUrl are still stored) reads back as `connected`, violating the spec scenario "Compatible credential present but unvalidated reads as not_saved" (`specs/account-settings/spec.md:41-43`) and the requirement clause "field presence without a successful validation SHALL read as `not_saved`". Fix: thread `row.state` into the read projection (carry it on `StoredCredentialFacts` and have `projectCredentialRead` honor the stored compatible state, falling back to field-presence derivation only when no state was persisted). Add a read-side test (the existing `credential-storage-two-modes.test.mjs:243-274` only asserts the SAVE-side state and explicitly side-steps the read because it would fail). NOTE: design.md's Non-Goal "no `state`-column cleanup" must be reconciled — the column is already written by 2.4, so honoring it on read is wiring, not a refactor; address deliberately. Unblocks BOTH "Codex credential storage with two provider modes" and "Compatible-provider model discovery and selection". [P1]
