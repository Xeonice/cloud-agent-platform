# Verification Report — wire-compatible-provider-execution

Adversarial spec verification. Each spec requirement was enumerated, statically
triaged, and the high-risk ones re-traced end-to-end against the actual code
(not rubber-stamped from the skeptic's claims). Findings are routed three ways:
UNMET → a re-opened code task in `tasks.md`; SPEC-DEFECT → an Open Question in
`design.md`; MET → folded in below.

## Three-way tally (this pass)

- Re-opened code tasks: 0 net new this pass. The raw-unmet input set was empty —
  every named requirement was already adjudicated in the prior pass. Task `V1`
  (the read-side `not_saved` defect, covering BOTH "Codex credential storage with
  two provider modes" and "Compatible-provider model discovery and selection")
  remains from that pass and is NOT re-opened here (already tracked, marked done).
- Spec defects routed to design.md Open Questions: 0.
- Reclassified MET (re-traced as satisfied despite the skeptic's refutation): 0
  net new — the MET inventory below already holds.
- Scope / over-delivery re-trace (this pass): 4 additional defensive extras
  confirmed as scope, not defects, and folded into the scope notes below
  (`name="Compatible provider"` TOML label; env-source auth.json sanity-check;
  `authJson` official field; frontend mock-path state derivation). None re-traces
  as a code defect or a spec ambiguity; none re-opens a task.

## Re-opened (UNMET) — read-side `not_saved` state is re-derived, not read

The single real defect in this pass. `saveCredential` (task 2.4) CORRECTLY
persists `state = 'not_saved'` for a compatible row when the discovery probe
fails or never runs, while still storing the `baseUrl` and encrypted key. But
the read path discards that persisted state:

- `readCredential` (`apps/api/src/settings/settings.service.ts:238-260`) assembles
  `StoredCredentialFacts` from `row.{mode,baseUrl,apiKeyCiphertext,…}` but NEVER
  reads `row.state`.
- `projectCredentialRead` → `deriveCredentialState`
  (`apps/api/src/settings/settings-logic.ts:258-259`) returns `connected`
  whenever `hasBaseUrl && hasApiKey`, regardless of validation.

Net effect: a credential saved as `not_saved` reads back as `connected`,
directly contradicting `specs/account-settings/spec.md:41-43` ("Compatible
credential present but unvalidated reads as `not_saved`") and the requirement
clause "field presence without a successful validation SHALL read as
`not_saved`". The test `credential-storage-two-modes.test.mjs:243-274` documents
this contradiction in its own comments and then asserts only the SAVE-side state
(`deriveCompatibleSaveState`), explicitly side-stepping the read-side assertion
that would fail. Routed to task `V1`. This is a CODE defect (spec is clear and
testable), not a spec ambiguity, so it is NOT an Open Question.

## MET inventory (re-traced as satisfied)

### Requirement: Compatible-provider model discovery and selection — MET except the read-side state scenario

- "Discover models": `ModelDiscoveryClient.discover` (`model-discovery.client.ts:234`)
  calls `assertSafeProviderUrl` then `GET {baseUrl}/models`; contract lifted to
  `packages/contracts/src/settings.ts`. MET.
- "Selected default model persists": `saveCredential` upserts `defaultModel`;
  `readCredential` returns it via `projectCredentialRead`. MET.
- "Failed discovery does not persist a broken credential": `saveCredential`
  re-probes via `validateCompatibleProvider` and sets `state='not_saved'` on
  probe failure (`settings.service.ts:371-388`). The SAVE side is MET; the
  read-side surfacing of that state is the re-opened defect above.
- "Discovery rejects unsafe SSRF base URLs": `assertSafeProviderUrl`
  (`assert-safe-provider-url.ts`) rejects loopback/private/link-local/ULA/
  metadata before any fetch; tested. MET.
- "Discovery is time- and size-bounded": `REQUEST_TIMEOUT_MS=8000`,
  `MAX_BODY_BYTES=1_048_576`, `readBoundedText` enforces both. MET.
- Frontend wiring: `discoverCodexModels` (`apps/web/src/lib/api/real.ts`) posts to
  `/settings/codex/models` with shared schemas; dialog gates save on
  `probePassed && model.trim()`. MET.

### Requirement: Codex credential storage with two provider modes — MET except the read-side state scenario

- "Official-account mode stores connection state only": `projectCredentialRead`
  nulls compatible fields for official mode; `projectCredentialSave` clears the
  key/baseUrl. MET.
- "Compatible-provider mode stores base URL, key, default model; `connected` once
  validated": save-side derives `connected` only after a successful provider
  probe (D5); injection emits `[model_providers.cap]` with
  `wire_api="responses"` + `experimental_bearer_token`. MET.
- "Compatible save without a base URL is rejected": rejected both at the contract
  `superRefine` and again in `saveCredential` before any write
  (`settings.service.ts:281-286`). MET.
- "Compatible credential present but unvalidated reads as `not_saved`" — UNMET on
  the read side; re-opened as task `V1`.
- "Unsaved compatible provider (base URL only) reads back as `not_saved`": the
  base-URL-only / key-only partial rows DO read `not_saved` via
  `deriveCredentialState`'s `hasBaseUrl || hasApiKey` branch. MET (this partial
  case works; the FULL baseUrl+key-but-unvalidated case is the defect).
- Two-mode storage union (`CodexAuthMaterial` discriminated union; owner-scoped
  resolution; per-task injection) all re-trace as MET.

## Gap note (recorded, not separately re-opened)

The defect is a CORRECTNESS gap, not a zero-implementation gap: the `state`
column IS written on save (correctly `not_saved` on failed validation) but is
NOT read back — the read path re-derives state from field presence. The skeptic's
own gap analysis reached the same conclusion (no requirement has ZERO traceable
implementation; every named requirement has an implementation path). The only
failing scenario is the read-side surfacing of the persisted `not_saved` state,
captured by task `V1`.

## Scope / over-delivery notes (defensive extras beyond spec — NOT defects)

These were flagged as scope creep. Each is correct hardening that exceeds the
written spec; none re-traces as a defect and none re-opens a task. Recorded for
archive completeness:

- Redirect following with re-validation up to 3 hops + treating a missing
  `Location` as a network error — `model-discovery.client.ts:265`. Spec mandates
  constraining/re-validating redirects but not a numeric hop limit.
- `extractModelIds` accepting a bare `string[]` (non-OpenAI-envelope) model list —
  `model-discovery.client.ts:137`.
- Distinct `malformed_url` / `missing_host` rejection codes —
  `assert-safe-provider-url.ts:43`. Spec only requires rejecting unsafe hosts.
- Same-mode compatible re-save re-probing with the stored (decrypted) key when no
  new key is supplied — `settings.service.ts:446`.
- Official `auth.json` structural sanity-check before injection —
  `prisma-codex-auth-source.ts:174`.
- Incomplete-compatible-row degradation to env fallback —
  `prisma-codex-auth-source.ts:149`.
- `scrubSecrets()` redacting userinfo / Basic auth from `/v1/shell/exec` output —
  `aio-sandbox.provider.ts:1099`.
- Explicit TOML string escaping of baseUrl/apiKey/model —
  `aio-sandbox.provider.ts:943`.
- `PATCH /settings` alias for `PUT /settings` — `settings.controller.ts:80`.
- Dialog auto-defaulting to `models[0]` when the current selection is no longer
  offered — `codex-api-key-dialog.tsx:155`.
- Dialog client-side completeness guard before `runProbe` —
  `codex-api-key-dialog.tsx:178`.
- Probe-gate reset on input edit (`setProbePassed(false)`) —
  `codex-api-key-dialog.tsx:206`.
- `name = "Compatible provider"` written into the `[model_providers.cap]` TOML
  block — `aio-sandbox.provider.ts:948`. The spec (and D1's example) emit
  `base_url`/`wire_api`/`experimental_bearer_token`; no requirement mandates a
  `name` field. Harmless cosmetic label codex accepts; not a defect.
- Official `auth.json` structural sanity-check (auth_mode/tokens/OPENAI_API_KEY
  presence) ALSO in the env source path — `env-codex-auth-source.ts:52-76`
  (mirrors the prisma-source check at `:174`). Spec only asks to keep the
  official/deployment-level auth unchanged; the pre-injection validation is a
  defensive extra, not a required scenario. Not a defect.
- `SaveCodexCredentialRequestSchema` carries an `authJson` field for official-mode
  ChatGPT-login storage — `packages/contracts/src/settings.ts:208`. The
  account-settings spec frames official state as "connection status and optional
  non-secret metadata," but the design Context/D2 and the aio-sandbox-execution
  injection path treat the per-task official `auth.json` as the credential that
  replaces deployment-level env injection — so this field is the transport for
  that already-designed official per-task path, write-only and never echoed.
  Out of THIS change's spec letter on account-settings but consistent with the
  cross-cutting design; recorded as scope, not a defect.
- Frontend MOCK-path compatible-state derivation (`mutations.ts:354-355`):
  `state = hasApiKey ? 'connected' : baseUrl ? 'not_saved' : 'not_connected'`.
  This is the in-memory DEV mock, NOT the real `PUT /settings/codex` transport;
  the frontend-console spec governs only the real probe-gated path
  (`codex-api-key-dialog.tsx`). Mock state derivation is unspecified by design
  and does not affect the real flow. Not a defect.
