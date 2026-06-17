## Why

A 6-dimension backend audit (21 confirmed findings) proved the compatible/custom model provider is a **silent runtime no-op**: an operator can enter a Base URL + API key, (appear to) test it, pick a model, save, and see the credential read back as `connected` — yet **no execution-path code ever reads `{baseUrl, apiKey, defaultModel}`**, so codex runs against the deployment-level official/env credential and its built-in default model, calling `api.openai.com` instead of the operator's provider. The settings *storage* layer is correct (encryption-at-rest, write-only key, discovery endpoint all present-ok); the gap is the missing **bridge into execution**, plus an **SSRF-exposed discovery fetch** and a **multi-operator credential-scope bug**. This change makes the compatible provider actually drive codex, safely.

## What Changes

**Execution injection (the core fix)**
- The compatible-mode credential SHALL be resolved for execution: `PrismaCodexAuthSource` gains a `mode === 'compatible'` branch that decrypts `apiKeyCiphertext` and yields compatible material `{baseUrl, apiKey, model}` (today it hard-gates on `mode === 'official'` and returns `null`, falling through to the env source). Evidence: `prisma-codex-auth-source.ts:77`.
- At provision time, `injectCodexAuth` SHALL write the compatible provider into `~/.codex/config.toml`: a `[model_providers.cap]` block (`base_url` = saved Base URL, `wire_api = "responses"`, key via `experimental_bearer_token`), plus top-level `model_provider = "cap"` and `model` (the saved default). No `auth.json` is written for compatible mode — verified (task 3.1) against the codex 0.131 config reference: `auth.json`'s `OPENAI_API_KEY` serves only the built-in `openai` provider, and `wire_api` is `"responses"`-only. Today the config.toml carries only the workspace trust block and no provider/model. Evidence: `aio-sandbox.provider.ts:822`, `aio-pty-client.ts:92` (static argv, no `--model`).
- **Product constraint (verified)**: codex 0.131 speaks only the OpenAI **Responses API**, so the feature supports Responses-API-compatible providers (OpenAI/Azure/LiteLLM/OpenRouter-Responses), NOT chat-completions-only endpoints. The dialog copy SHALL state this.
- **BREAKING (behavioral)**: a saved compatible credential changes which endpoint/model codex uses — previously inert.

**Credential scope correctness**
- The injected credential SHALL be the **task owner's**, not the earliest allowlisted operator's. The auth source currently resolves `findFirst({ allowed: true }, orderBy createdAt asc)`, so once compatible is wired, one operator's key would be used for every operator's tasks. This SHALL be scoped to the task's owning account.

**Discovery hardening (SSRF + DoS)**
- The model-discovery probe SHALL validate the operator-supplied Base URL before fetching: scheme ∈ {http, https}, and reject loopback / private / link-local / ULA / `0.0.0.0` / `::` / cloud-metadata (`169.254.169.254`) hosts; redirects SHALL be constrained (`manual`) and re-validated. Today only `z.string().url()` guards it, which accepts `http://169.254.169.254/`, `http://localhost:6379`, `file://…`, `gopher://…`. Evidence: `model-discovery.client.ts:154`, `settings.controller.ts:39`.
- The discovery fetch SHALL carry a bounded timeout (`AbortSignal.timeout`, a pattern already used at `aio-sandbox.provider.ts:361`) and a response-body size cap before `JSON.parse`.
- The same host validation SHALL apply when the Base URL is used at execution time.

**Save integrity**
- A `mode === 'compatible'` save SHALL require a non-null `baseUrl` (server-side guard / schema refine), so a half-saved key-only row cannot persist.
- `connected` SHALL mean *validated*: save SHALL NOT report a compatible credential `connected` on field-presence alone — it SHALL reflect a successful provider validation (re-probe on save, or a probe-confirmed token), bringing the code in line with the existing "failed discovery does not mark connected" spec scenario.

**Shared contract + real frontend wiring**
- The `DiscoverModels` request/response schema SHALL be lifted into `@cap/contracts` (it lives only in `apps/api` today, `settings.controller.ts:39`), so the web app can call the endpoint type-safely.
- The compatible-provider settings dialog SHALL call the **real** `POST /settings/codex/models` (replacing the hardcoded mock model list and the non-empty-string "test"), populate the picker from the real response, require a real selection, and gate save on a real successful probe. Evidence: `codex-api-key-dialog.tsx:61` (`discoverModelsMock`).

**Regression tests**
- Tests SHALL lock in: compatible credential → config.toml/auth.json/model material; owner-scoped resolution; SSRF rejection of internal hosts; discovery timeout/size bound. (Today zero tests assert any compatible wiring.)

Out of scope: failure-class refinement (DNS/TLS/timeout sub-codes), the vestigial `state` column cleanup, and explicit running-task credential-rotation semantics are recorded as P2 follow-ups, not required here.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `aio-sandbox-execution`: ADD a requirement that the compatible-mode Codex credential is injected into the codex run (config.toml `[model_providers.*]` + `auth.json` `OPENAI_API_KEY` + selected model) and that the injected credential is scoped to the task owner.
- `account-settings`: MODIFY "Compatible-provider model discovery and selection" (SSRF host-validation + timeout + body bound on the probe; shared `@cap/contracts` discovery schema) and "Codex credential storage with two provider modes" / the connected-state derivation (compatible save requires `baseUrl`; `connected` requires successful validation, not field presence).
- `frontend-console`: ADD a requirement that the compatible-provider dialog is backed by the real discovery endpoint (real probe-gated test, real model picker, required selection) instead of a mock — added as a new requirement so it composes with, and does not collide with, the active `redesign-settings-single-column` settings-layout delta.

## Impact

- **Backend**: `apps/api/src/sandbox/{prisma-codex-auth-source.ts,codex-auth-source.port.ts,aio-sandbox.provider.ts}` (compatible material + injection + owner scope), `apps/api/src/settings/{model-discovery.client.ts,settings.service.ts,settings.controller.ts,settings-logic.ts}` (SSRF guard, timeout/bound, save re-validation, baseUrl guard).
- **Contracts**: `packages/contracts/src/settings.ts` (export DiscoverModels request/response).
- **Frontend**: `apps/web/src/components/settings/codex-api-key-dialog.tsx` + the query/mutation + `real.ts` client (real discovery call; gated save). Composes with `redesign-settings-single-column` Track 2.
- **Tests**: new `apps/api` specs for the injection, owner-scope, SSRF, and discovery bounds.
- **Unaffected**: official (device-login) mode, the encryption/secret-discipline layer (correct as-is), and the AES-256-GCM at-rest design.
