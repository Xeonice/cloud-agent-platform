# Proposal: edit-sandbox-environment-parameters

## Why

Image parameters (plain and secret runtime values such as `GCODE_TOKEN`) can only be set when a sandbox environment is registered; there is no API endpoint and no console affordance to change them afterwards, so routine secret rotation forces admins to re-register, re-validate, and re-default a whole new environment record (or edit the database by hand, as happened on a live deployment on 2026-07-20).

## What Changes

- Add an admin-gated console API endpoint that replaces the image parameter set of an existing sandbox environment, with an explicit "keep existing secret value" affordance so plaintext secrets never round-trip.
- Preserve secret write-only semantics: secret values are encrypted with the existing `settings/secret-storage` path on write and are never returned by any read surface.
- Editing parameters never touches validation state: environment `status`, validation records, `contract_version`, and `is_default` are unchanged by a parameter edit, and no re-validation is required.
- Pin the effect timing in the spec: tasks provisioned after the edit materialize the new values; already-provisioned or running sandboxes are unaffected.
- Add an edit dialog to the Image Management web console on registered environment cards, prefilled from the existing redacted read model (plain values shown, secret entries name-only).

## Capabilities

### New Capabilities

_None — this extends the existing image-parameter capability rather than introducing a new one._

### Modified Capabilities

- `sandbox-image-parameters`: parameters become editable after registration through an admin-gated replace-set operation; secret values stay write-only with a keep-existing sentinel; edits are decoupled from validation status and take effect only for tasks provisioned after the write.

## Impact

- `packages/contracts/src/sandbox-environment.ts`: new update-parameters request schema (parameter entries gain a keep-existing variant for secrets).
- `apps/api/src/sandbox-environments/sandbox-environments.controller.ts`: new `PATCH /sandbox-environments/:id/parameters` route behind the existing `requireAdmin` gate.
- `apps/api/src/sandbox-environments/sandbox-environments.service.ts`: update path reusing `encodeParameters`/`encryptToStored`; duplicate-name and unknown-keep rejections; logs parameter names only.
- `apps/web/src/components/settings/sandbox-environments-card.tsx` (+ web api layer): edit-parameters dialog and mutation on registered environment cards.
- `openspec/specs/sandbox-image-parameters/spec.md`: delta for the new requirement set.
- No Public V1, MCP, OpenAPI, or API Playground surface changes (admin console API only; see `surface-impact.json`).
