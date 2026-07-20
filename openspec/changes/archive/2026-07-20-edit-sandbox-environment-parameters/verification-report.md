# Verification Report: edit-sandbox-environment-parameters

Pass date: 2026-07-20 (third adjudicated pass — final). Three-way routing over the raw skeptic output; every requirement was re-traced end-to-end against the actual code before routing. This pass supersedes the same-day second pass, whose sole blocker was a sidecar defect: the `deterministic-public-surface-cli` lens refuted all four requirements with `undeclared-impact` because `surface-impact.json` declared publicV1/mcp/openapi/apiPlayground `not-applicable` while the change edits the shared `packages/contracts/src/sandbox-environment.ts` module those surfaces consume. That sidecar has since been rewritten with scoped `changed` declarations (shared-contracts-module scope, no operation/tool/projection/catalog change) mirroring the registry's eight standing protocol differences. This pass the machine-routed public findings list is **empty** — the dynamic lens no longer refutes — and `pnpm verify:public-surface` passes clean (14/14 turbo tasks, 63/63 contracts public-surface parity tests, re-run live this pass).

## Summary

| Requirement (stable id) | Static re-trace | Dynamic (public-surface) | Routing |
| --- | --- | --- | --- |
| sandbox-image-parameters/image-parameters-are-editable-after-registration | PASS | PASS (no findings; corrected sidecar accepted) | MET (reclassified from prior blocking spec-defect) |
| sandbox-image-parameters/parameter-edits-are-decoupled-from-validation-state | PASS | PASS (no findings; corrected sidecar accepted) | MET (reclassified from prior blocking spec-defect) |
| sandbox-image-parameters/edited-parameters-take-effect-at-next-task-provisioning | PASS | PASS (no findings; corrected sidecar accepted) | MET (reclassified from prior blocking spec-defect) |
| sandbox-image-parameters/image-management-console-exposes-parameter-editing | PASS | PASS (no findings; corrected sidecar accepted) | MET (reclassified from prior blocking spec-defect) |

Zero requirements re-opened as code tasks; zero spec defects remain (the design.md Open Questions entry now records the sidecar resolution as non-blocking history). All four stable ids are reclassified MET.

## End-to-end re-traces (confirmed against current source this pass)

### Image parameters are editable after registration — MET

- `apps/api/src/sandbox-environments/sandbox-environments.service.ts:156-193` `updateParameters` (re-read this pass): rejects retired (`status === 'disabled'` → `sandbox_environment_retired`, :162-167); resolves keep-refs against stored `secretEnvVars`, rejecting unknown keep names with `sandbox_environment_unknown_keep_parameter` before any Prisma write (:172-183); Prisma update writes only `envVars`/`secretEnvVars` (:184-191). Kept secrets copy stored ciphertext verbatim — plaintext never leaves storage (no decrypt call for kept entries).
- Duplicate-name rejection at the contract boundary across keep+set (`packages/contracts/src/sandbox-environment.ts:211-230` `UpdateSandboxEnvironmentParametersRequestSchema` superRefine) plus per-entry guard in `encodeParameters` (`sandbox_environment_duplicate_parameter`).
- Admin gate identical to image management: `requireAdmin` wired on `PATCH :id/parameters` (`sandbox-environments.controller.ts:62`; gate checks `role === 'admin' && allowed === true`).
- Redacted read model via `toParameterDescriptors` (secret entries name-only).
- Tests: `sandbox-environments.service.spec.ts` and `sandbox-environments.controller.spec.ts` cover the scenarios directly.

### Parameter edits are decoupled from validation state — MET

- The update `data` object (service :186-189) contains only `envVars` and `secretEnvVars`; the method never touches `status`, `lastValidationId`, `contractVersion`, `isDefault` and never creates a validation record (contrast `validate()` at :195+). Retired-only rejection at :162-167; all other statuses (draft/ready/validating/failed/stale) permitted.
- Tests assert status/isDefault/contractVersion/lastValidationId and validation count unchanged, edit permitted on `failed`, rejected on `disabled`.

### Edited parameters take effect at next task provisioning — MET

- `apps/api/src/sandbox/prisma-provision-lookup.ts` `getTaskImageParameterProfile` delegates to `resolveImageParameterProfileForTask`, which does a fresh `prisma.sandboxEnvironment.findUnique` and decrypts secrets at call time — no snapshot/cache/creation-time pinning anywhere in the traced path.
- The lookup is invoked only from one-shot provision-stage hooks (`packages/sandbox/src/host-harness/configured-provider.ts` AIO `runtimeSetup` and BoxLite), materializing `/home/gem/.cap/image-env` via `buildSandboxImageParameterSetupCommands`. Exactly two call sites for `runImageParameterSetup`, both provisioning-time; no re-materialization path exists for running sandboxes.
- End-to-end unit coverage edits (plain change + keep + rotate) then resolves via the exact provisioning function and asserts the new plain value, the retained secret's original plaintext, and the rotated secret's new plaintext.

### Image Management console exposes parameter editing — MET

- `apps/web/src/components/settings/sandbox-environments-card.tsx`: `draftsFromParameters` (:73) prefills plain values and secret rows name-only with `keepExisting: true`; `buildUpdateParametersBody` (:89) maps untouched secret drafts to `{name, keep: true}` so plaintext never round-trips; secret inputs render as password fields; `EditParametersDialog` (:725) wired via the per-row edit button (:466) and `updateParams.mutate`; `sandbox_environment_unknown_keep_parameter` conflicts invalidate the `sandboxEnvironments` query to refetch redacted state.
- Mutation wiring: `apps/web/src/lib/api/mutations.ts` → `real.updateSandboxEnvironmentParameters` against the PATCH endpoint.
- Component tests verify prefill redaction (no secret plaintext rendered, password input empty) and keep-entry submission.

## Resolution of the prior pass's blocking spec defects

The second pass routed all four stable ids to blockingSpecDefects for a false public-impact exclusion: the sidecar claimed publicV1/mcp/openapi/apiPlayground `not-applicable` while the path classifier attributes any `packages/contracts/src` edit to those surfaces. Remediation (completed before this pass, recorded in design.md Open Questions): `surface-impact.json` now declares each of the four surfaces `changed` with an explicit shared-contracts-module scope and a reason asserting no operation/tool/projection/catalog change, and mirrors the registry's standing protocol differences. Evidence accepted this pass: the machine-routed public findings list is empty, and `pnpm verify:public-surface` was re-run live during this pass — 14/14 tasks successful, 63/63 contracts public-surface tests pass, zero drift. The sidecar no longer makes a false exclusion claim, so nothing remains for blockingSpecDefects.

## Gap findings

All four requirements in the spec have confirmed, traceable implementations (verified directly against source, matching the change's own verification-report.md). None are missing implementation entirely — the verification report's only findings were sidecar/metadata defects (undeclared public-surface impact in `surface-impact.json`), not absence of code; that sidecar defect is now corrected and verified resolved (see section above).

```json
[]
```

## Scope findings

Confirmed — no touches to V1/MCP/OpenAPI surfaces, matching the surface-impact.json claim (scoped shared-contracts-module declarations; generated OpenAPI document byte-identical, no MCP tool or V1 operation change).

Based on a full review of the diff (contracts, API controller/service, web console dialog, docs, and all test files) against `openspec/changes/edit-sandbox-environment-parameters/specs/sandbox-image-parameters/spec.md` and `tasks.md`, every implemented behavior traces to a requirement or scenario (or is a pre-existing, consistently-applied convention like `invalidateRuntimeModelCatalogs` that every other sandbox-environment mutation already calls). No scope creep found.

```json
[]
```

## Three-way tally

- Reopened as code tasks (UNMET): 0
- Spec defects (routed to design.md Open Questions): 0 — the prior pass's 4 blocking sidecar defects are resolved and verified; design.md Open Questions retains the resolution record as non-blocking history
- Reclassified MET: 4 — sandbox-image-parameters/image-parameters-are-editable-after-registration, sandbox-image-parameters/parameter-edits-are-decoupled-from-validation-state, sandbox-image-parameters/edited-parameters-take-effect-at-next-task-provisioning, sandbox-image-parameters/image-management-console-exposes-parameter-editing
