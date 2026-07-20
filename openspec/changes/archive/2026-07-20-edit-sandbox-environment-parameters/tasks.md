<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-and-api (depends: none)

- [x] 1.1 Add the update-parameters request contract to `packages/contracts/src/sandbox-environment.ts`: a strict schema whose entries are a discriminated union of set entries (`{name, value, secret?}`, reusing the existing parameter-name schema) and keep entries (`{name, keep: true}`, no value), plus schema tests rejecting duplicate names, keep-with-value, and unknown fields.
  - requirements: ["sandbox-image-parameters/image-parameters-are-editable-after-registration"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [x] 1.2 Implement `updateParameters` in `apps/api/src/sandbox-environments/sandbox-environments.service.ts`: resolve the environment (reject retired), map set entries through the existing `encodeParameters` path (`encryptToStored` for secrets), copy stored ciphertext envelopes verbatim for keep entries, reject keep-references to names not currently stored as secrets (`sandbox_environment_unknown_keep_parameter`) and duplicate names, and persist only `env_vars`/`secret_env_vars`/`updated_at`; unit tests prove status, validation records, contract version, and default flag are untouched (including on a failed-status environment) and that `resolveImageParameterProfileForTask` returns the edited set immediately after the write while parameter values never appear in logs or error bodies.
  - requirements: ["sandbox-image-parameters/image-parameters-are-editable-after-registration", "sandbox-image-parameters/parameter-edits-are-decoupled-from-validation-state", "sandbox-image-parameters/edited-parameters-take-effect-at-next-task-provisioning"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 1.3 Add `PATCH /sandbox-environments/:id/parameters` to `apps/api/src/sandbox-environments/sandbox-environments.controller.ts` behind the existing `requireAdmin` gate with Zod validation of the new request schema; controller tests cover non-admin rejection (403, no state change), unknown environment (404), retired environment rejection, and a successful edit returning the redacted environment read shape (secret entries name-only).
  - requirements: ["sandbox-image-parameters/image-parameters-are-editable-after-registration", "sandbox-image-parameters/parameter-edits-are-decoupled-from-validation-state"]
  - surfaces: ["contracts"]
  - verify: "api-public-errors"

## 2. Track: web-console (depends: contracts-and-api)

- [x] 2.1 Add an edit-parameters dialog to registered environment cards in `apps/web/src/components/settings/sandbox-environments-card.tsx` with a mutation in the web api layer: prefill plain rows with editable values and secret rows name-only in a kept-value state, allow adding/removing rows and typing replacement secret values, map untouched secret rows to keep entries on submit, never render secret plaintext, refetch on `sandbox_environment_unknown_keep_parameter` conflicts, and note in the dialog copy that edits apply to newly provisioned tasks only; component tests cover prefill redaction and the keep-entry mapping.
  - requirements: ["sandbox-image-parameters/image-management-console-exposes-parameter-editing", "sandbox-image-parameters/image-parameters-are-editable-after-registration", "sandbox-image-parameters/edited-parameters-take-effect-at-next-task-provisioning"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.2 Update `docs/sandbox-images.md`, `docs/sandbox-images.zh.md`, and the mirrored `apps/web/src/content/sandbox-images.md` to document post-registration parameter editing: where the edit entry lives, secret keep/rotate semantics, no re-validation needed, and new-tasks-only effect timing.
  - requirements: ["sandbox-image-parameters/image-management-console-exposes-parameter-editing"]
  - surfaces: ["docs"]
  - verify: "docs"
