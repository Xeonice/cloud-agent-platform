# Research Brief — edit-sandbox-environment-parameters

Serial research pass (2026-07-20). Grounded in same-day live-ops incident on a
self-hosted deployment (vibe-zlyan): a custom gcode image needed `GCODE_TOKEN`
configured after registration, and the only workaround was re-registering a new
environment (or editing the database directly, which was actually done).

## Current state (verified in code)

- **Create-only parameters.** `CreateSandboxEnvironmentRequestSchema`
  (`packages/contracts/src/sandbox-environment.ts:181`) accepts
  `parameters: SandboxEnvironmentParameterInput[]` (`{name, value, secret?}`,
  strict). The controller
  (`apps/api/src/sandbox-environments/sandbox-environments.controller.ts`)
  exposes only: `GET /sandbox-environments`, `POST /sandbox-environments`,
  `POST /:id/validate`, `PATCH /:id/default`, `PATCH /:id/retire`,
  `GET /:id/validations`. **No endpoint mutates parameters after creation.**
- **Storage.** `SandboxEnvironmentsService.encodeParameters` splits into
  `env_vars` (plain jsonb) and `secret_env_vars` (jsonb of
  `ciphertext.iv.authTag` envelopes via `encryptToStored` from
  `apps/api/src/settings/secret-storage.ts`, AES-256-GCM under
  `CODEX_CRED_ENC_KEY`). Duplicate names are rejected with
  `sandbox_environment_duplicate_parameter`.
- **Read model already redacts.** `toParameterDescriptors` returns plain
  parameters with values and secret parameters as `{name, secret: true}` (no
  value); `SandboxEnvironmentSchema` already carries `parameters` on read
  responses, so an edit dialog can prefill names without any new read surface.
- **Injection path.** `resolveImageParameterProfileForTask` decrypts at task
  provisioning time; the profile is materialized to
  `/home/gem/.cap/image-env` after workspace materialization and before agent
  launch (`packages/sandbox/src/host-harness/image-parameters.ts`,
  `configured-provider.ts` runtimeSetup). Parameters are resolved per task at
  provision time — an edit is naturally picked up by tasks provisioned after
  the write; already-provisioned/running sandboxes are untouched.
- **Validation is orthogonal.** `openspec/specs/sandbox-image-parameters/spec.md`
  states materialization "SHALL NOT block task provisioning" and the docs state
  the parameter env file "is separate from image validation". Validation
  records (digest, probes) contain no parameter state, so editing parameters
  must not flip environment status or require re-validation.
- **Admin gate.** All mutating routes call `requireAdmin` (users.role='admin'
  and allowed=true). Same gate applies to the new endpoint.
- **Web console.** `apps/web/src/components/settings/sandbox-environments-card.tsx`
  renders parameter rows (name/value/secret checkbox) inside the create form
  only; registered environment cards have validate/default/retire actions but
  no edit affordance. Mutations live in the web api layer alongside
  `createSandboxEnvironmentMutation`.

## Prior art in the archive

- `2026-07-09-inject-sandbox-tool-credentials` introduced the whole capability
  (spec `sandbox-image-parameters`) — deliberately create-scoped, no edit.
- Secret write-only discipline precedent: settings credentials (forge PAT,
  codex compatible key) never return plaintext; reads expose at most last4 or
  key names. The edit surface must keep that.

## Key design constraints discovered

1. **Replace-set semantics is the simplest safe contract.** Because secret
   values are never readable, a partial "merge" UI cannot render current
   values; the dialog naturally submits the full desired parameter set. For
   secrets the client must distinguish "keep existing value" from "set new
   value" — an explicit `keep: true` sentinel (no value) per retained secret is
   cleaner than resubmitting plaintext, and avoids the client ever needing the
   plaintext back.
2. **No status transitions.** Editing parameters on a `ready` (or `stale`)
   environment must not change `status`, `contract_version`, validation
   records, or `is_default`.
3. **Concurrency.** Single admin surface, low contention; last-write-wins on
   the whole set is acceptable and matches the rest of the environment record.
4. **Audit.** Mutating admin endpoints in this module do not currently write
   audit_events; parameter edits should log names (never values) at the
   service log level, consistent with existing scrub discipline.

## Live-ops evidence (why now)

- Token rotation is real: the Gitee PAT behind `GCODE_TOKEN` is a copied
  snapshot of a forge credential; when the operator rotates the PAT the image
  parameter goes stale with no UI remedy.
- The re-register workaround is heavy: new environment record + re-validate +
  re-set default + old record cleanup (this exact sequence was performed
  manually on 2026-07-20 and required digest-qualified registration knowledge).
