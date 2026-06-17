## Context

The codex execution credential is injected into each per-task AIO sandbox exactly once, at provision time, by `AioSandboxProvider.injectCodexAuth` (`aio-sandbox.provider.ts:818`), which asks a `CodexAuthSource` for material and writes `~/.codex/config.toml` + `~/.codex/auth.json` into the container. The only DB-backed source, `PrismaCodexAuthSource.resolveFromSettings` (`prisma-codex-auth-source.ts:74-86`), reads `cred.mode === 'official' ? authJsonCiphertext : null` and resolves the credential via `findFirst({ allowed: true }, orderBy: createdAt asc)`. The codex launch argv is a static string with no `--model`/provider flag (`aio-pty-client.ts:92`).

Net effect (audit-confirmed across 7 findings): a `compatible` credential — `{baseUrl, apiKey(ciphertext), defaultModel}`, correctly stored and encrypted by the settings layer — is **never read for execution**. Separately, the discovery probe (`model-discovery.client.ts:154`) fetches an operator-supplied Base URL with no SSRF guard, timeout, or body bound, and the web dialog uses a hardcoded mock instead of calling the real `POST /settings/codex/models`.

The storage/crypto layer is correct and out of scope. This change adds the execution bridge, fixes credential scoping, hardens discovery, and wires the real frontend path.

## Goals / Non-Goals

**Goals**
- A saved `compatible` credential makes codex call THAT Base URL with THAT API key and THAT default model, inside the sandbox.
- The injected credential belongs to the task **owner**, not the earliest allowlisted account.
- The discovery probe (and execution-time Base URL use) is SSRF-safe, time-bounded, and size-bounded.
- A compatible save requires a Base URL, and `connected` means provider-validated, not field-present.
- The web dialog drives off the real discovery endpoint via a shared `@cap/contracts` schema.
- Regression tests lock all of the above in.

**Non-Goals**
- No change to official (device-login) mode, the AES-256-GCM at-rest design, or the secret read-discipline (all present-ok).
- No failure-class refinement (DNS/TLS/timeout sub-codes) and no running-task credential-rotation/revocation mechanism (P2 follow-ups, recorded not built). NOTE: the `state` column's *read-side honoring* IS in scope (task V1) — the column is already written at save time with the validation-derived state, so the read path surfaces it instead of re-deriving `connected` from field presence; this is wiring, not the deferred P2 "single-source/cleanup" refactor of the write path.
- No change to the codex launch argv shape — all per-task provider state flows through provision-time config, since the argv has no per-task substitution seam (`D-EXEC-5`).

## Decisions

### D1 — Inject compatible material through the provision-time config seam (config.toml ONLY, not auth.json)
`injectCodexAuth` is the only per-task provisioning point; the launch argv (`aio-pty-client.ts:92`) is static with no credential-derived substitution. So all compatible provider state SHALL be written into `~/.codex/config.toml` at provision time (preserving the existing trust block). **VERIFIED against the codex 0.131 config reference (`developers.openai.com/codex/config-reference`, task 3.1)** — the emitted config is:

```toml
model = "<defaultModel>"
model_provider = "cap"
[model_providers.cap]
name = "Compatible provider"
base_url = "<saved Base URL>"
wire_api = "responses"
experimental_bearer_token = "<decrypted API key>"
```

Key facts the verification pinned down:
- `wire_api` has **exactly one valid value, `"responses"`** ("responses is the only supported value, and the default"). codex does NOT speak Chat Completions — see D7.
- For a **custom** provider the API key is NOT delivered via `auth.json`: `~/.codex/auth.json`'s `OPENAI_API_KEY` serves only the built-in `openai` provider. The key reaches a custom provider either through `env_key` (names a process env var) or, inline in config.toml, `experimental_bearer_token`.
- **`auth.json` is NOT written for compatible mode** (it belongs to the official/ChatGPT path). My earlier draft's "auth.json `{OPENAI_API_KEY}`" was wrong for custom providers.

_Key-delivery choice_: use `experimental_bearer_token` inline in the injected config.toml (chmod 600, `gem`-owned, inside the per-task container which IS the trust boundary per codex-execution-not-gated). It keeps ALL provider state in the single provision seam — no need to thread a secret env var into the separate terminal-launch seam (`codex-launch.ts`). codex labels it "discouraged"; acceptable here because the container is ephemeral and the trust boundary. _Alternative_ `env_key` + setting that env var in the codex launch process is the blessed path but spans the terminal launch seam (more moving parts, secret risks landing on the argv); kept as a fallback if the experimental key proves unstable on 0.131 (the 3.6 smoke test gates this).

_Rejected alternative_: append `--model`/provider flags to the launch argv — no code path rewrites the argv from a credential, so it is unreachable from the saved row.

### D2 — Extend the CodexAuthSource port with a compatible branch + a typed material shape
`CodexAuthMaterial` SHALL become a discriminated union: `{ kind: 'official', authJson }` (today's shape) vs `{ kind: 'compatible', baseUrl, apiKey, model }`. `PrismaCodexAuthSource` SHALL, for `mode === 'compatible'`, decrypt `apiKeyCiphertext` (reusing the existing `decryptSecret` primitive already invoked for official) and return the compatible material. `injectCodexAuth` branches on the material kind: `official` → write `auth.json` (unchanged); `compatible` → append the `[model_providers.cap]` block + top-level `model`/`model_provider` to config.toml (per D1) and write NO auth.json. The env fallback remains for the official deployment-level path.

### D3 — Owner-scoped credential resolution (correctness/security)
Resolution SHALL key off the task's owning account, not `findFirst({allowed:true}, createdAt asc)`. The provisioning lookup already threads task identity (`provision-lookup.port.ts`); the owning `githubId`/account SHALL be passed to `getCodexAuth` so the resolver loads THAT account's `codexCredential`. This is mandatory before wiring compatible mode — otherwise one operator's key leaks to every operator's tasks.

### D4 — SSRF + timeout + body bound on discovery, shared with execution-time URL use
Add a `assertSafeProviderUrl(baseUrl)` guard (scheme ∈ {http,https}; resolve host and reject loopback/private/link-local/ULA/`0.0.0.0`/`::`/`169.254.169.254`) called by the discovery client before fetch and by the execution path before the Base URL is written into config. The discovery `fetch` SHALL set `signal: AbortSignal.timeout(<few s>)` (pattern at `aio-sandbox.provider.ts:361`), `redirect: 'manual'` (re-validate any redirect target), and cap the response body (content-length check + bounded read) before `JSON.parse`.

### D5 — `connected` means validated; compatible save requires baseUrl
`SaveCodexCredentialRequestSchema` SHALL `refine` that `mode === 'compatible' ⇒ baseUrl` present (server-side, not UI-only). The connected-state derivation SHALL require a successful validation rather than `baseUrl && apiKeyCiphertext` presence — either by re-probing inside `saveCredential` for compatible mode (reject auth/unreachable; validate `defaultModel ∈` reported models) or by treating `connected` as set only after a probe-confirmed save. This realizes the already-written spec scenario "failed discovery does not mark connected".

### D6 — Lift the DiscoverModels contract; wire the real frontend dialog
The request/response schema (today `settings.controller.ts:39`, api-only) SHALL move to `packages/contracts/src/settings.ts` and be consumed by both the controller pipe and a new `real.ts` `discoverCodexModels` client. The dialog (`codex-api-key-dialog.tsx`) SHALL replace `discoverModelsMock` with a mutation calling `POST /settings/codex/models`, surface the real outcome class for "测试", populate the picker from the response, and gate save on a real successful probe with a required selection. This is an ADDED frontend-console requirement (not a modify of "Settings page…") so it does not collide with the active `redesign-settings-single-column` delta.

### D7 — The "compatible provider" is Responses-API-compatible, not Chat-Completions (product constraint surfaced by verification)
codex 0.131 only speaks the OpenAI **Responses API** (`wire_api` responses-only). So the feature supports providers that expose an OpenAI **Responses-API-compatible** surface (OpenAI itself, Azure OpenAI, or a gateway like LiteLLM/OpenRouter configured for Responses) — NOT arbitrary `/v1/chat/completions`-only endpoints (vLLM defaults, many self-hosted gateways). Consequences baked into this change:
- The settings dialog copy SHALL state the provider must be **OpenAI Responses-API compatible** (so operators don't enter a chat-completions-only URL that lists models fine but fails at run time).
- Discovery via `/v1/models` is **necessary but not sufficient**: a provider can list models yet not serve `/v1/responses`. `connected` after a models-probe therefore does not guarantee codex will run; a stronger validation (a minimal `/v1/responses` probe) is a recommended P1 refinement, recorded but not mandated here.

## Risks / Trade-offs

- **[Breaking] Saved compatible creds change runtime behavior** → previously inert credentials now redirect codex. Mitigate: gate behind owner-scope (D3) and validated-connected (D5) so only a *validated, owned* credential takes effect; document the behavior change; tests assert it.
- **codex config.toml schema for `[model_providers]`** → **RESOLVED (task 3.1)** against the codex 0.131 config reference: `wire_api` responses-only, key via `experimental_bearer_token` (or `env_key` env var), NO auth.json for compatible. Residual risk: `experimental_bearer_token` is an "experimental" key that could change/misbehave on 0.131. Mitigate: the 3.6 sandbox smoke test asserts codex actually targets the custom `base_url` + selected model and authenticates; if it fails, fall back to `env_key` + an injected env var.
- **Responses-API-only constraint (D7)** → operators may enter a chat-completions-only Base URL that passes `/v1/models` discovery but fails at codex run time. Mitigate: dialog copy states the Responses-API requirement; record the stronger `/v1/responses` validation probe as a P1 refinement.
- **SSRF guard via DNS resolution can be raced (rebinding)** → resolve-then-connect TOCTOU. Mitigate: validate at fetch time with `redirect:'manual'` re-validation; accept residual risk for an authenticated-operator-only endpoint, and note pinned-IP connect as a possible hardening follow-up.
- **Owner-scope change could break the official deployment-level fallback** → ensure env/official resolution still applies when an account has no compatible credential, so existing official users are unaffected.
- **Double-delta on frontend-console** with the active redesign change → avoided by using an ADDED requirement here rather than re-MODIFYing "Settings page…".

## Migration Plan

No data migration: existing `codexCredential` rows already carry the columns. Roll-out is code-only. Rollback = revert; a compatible credential simply returns to being inert (its encrypted row is untouched). Recommend shipping the SSRF guard (D4) and owner-scope (D3) even if the injection (D1/D2) is staged later, since both are independently correct hardening.
