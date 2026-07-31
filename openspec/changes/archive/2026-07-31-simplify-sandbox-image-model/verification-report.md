# Verification Report — simplify-sandbox-image-model

Date: 2026-07-31

## Result

All 8 requirements across the 4 spec deltas (`sandbox-environments`,
`aio-sandbox-execution`, `boxlite-sandbox-provider`, `frontend-console`) trace
end-to-end to implementation and tests. Verify raised one high-risk finding for
dynamic refutation; it survived ground-truth testing and independent re-trace and
is adjudicated MET. No requirement was re-opened as a code task. No spec defect
was routed to design Open Questions. Machine-routed public findings: none.

Three-way routing tally: reopened 0 · spec-defect 0 (blocking 0) · reclassified-met 1.

## Adjudicated MET (verify high-risk finding, re-traced)

### `sandbox-environments/environment-resolution-produces-immutable-provisioning-metadata`

Requirement (spec.md:103-126): environment resolution must produce immutable,
non-secret provisioning metadata — env id, source kind, provider family, runtime
id, resolved image reference/digest, validation id/version — and provisioning
must consume that snapshot rather than rereading a mutable tag.

Static re-trace (independently confirmed against current code):

- `normalizeResolvedEnvironment` / `stripResolvedEnvironmentUndefined`
  (`packages/sandbox-environment/src/index.ts:258-310`) build a fresh metadata
  object carrying exactly the required field set; unit tests
  `packages/sandbox-environment/test/sandbox-environment.test.mjs:156-205`
  assert the field set, absence of removed kinds (`rootfsPath`/`loadedImage`),
  and that the resources sub-object is a frozen defensive copy.
- `resolveImmutableForTask` → `resolveSelectedEnvironment(requireImmutable=true)`
  (`apps/api/src/sandbox-environments/sandbox-environments.service.ts:358-503`)
  fails closed (`sandbox_environment_immutable_identity_unavailable`, line 459/468)
  unless the pinned validation (`findPinnedValidation` follows
  `row.lastValidationId`) is `passed`, family/kind/contract-matched, and carries
  `resolvedLocator` plus digest/checksum and a runtime CLI artifact checksum; the
  returned metadata canonicalizes `sourceRef` to the validation's digest-pinned
  locator instead of the row's raw (possibly mutable-tag) image string. Covered by
  `sandbox-environments.service.spec.ts:971` (canonicalizes `:mutable` tag to
  `...@sha256:resolved-image`), `:1022` (follows `lastValidationId`, not a newer
  unrelated row), `:1148` (fails closed for stale/identity-less validation).
- Default fallback: `findDefaultEnvironment` (service.ts:595) with
  deployment-default returning `null` at line 376; covered by
  `sandbox-environments.service.spec.ts:650-734`.
- Downstream immutability: `buildRuntimeExecutionEnvironmentSnapshot` /
  `validateRuntimeExecutionEnvironmentSnapshot`
  (`apps/api/src/runtime-models/runtime-model-snapshot.ts`) fingerprint (sha256)
  and revalidate the persisted snapshot; the strict
  `RuntimeExecutionEnvironmentSnapshotSchema`
  (`packages/contracts/src/runtime-model.ts:99-223`) enforces
  locator-includes-digest and `immutableIdentity === source identity`. At launch,
  `apps/api/src/sandbox/prisma-provision-lookup.ts:205-230` revalidates the
  snapshot and passes `environment: resolvedEnvironmentFromSnapshot(...)` into
  the launch context; `packages/sandbox-provider-aio/src/aio-provider.ts:973`
  short-circuits re-resolution when `ctx.environment` is supplied, so
  provisioning consumes the pinned snapshot.

Dynamic ground truth (verify pass): a `node:test` spec at
`apps/api/src/sandbox-environments/ground-truth-immutable-provisioning-metadata.spec.ts`
exercises the real (unmodified) `resolveImmutableForTask` with only a Prisma
stub — a ready managed environment pinned to a mutable tag whose passed
validation carries a resolved digest locator. All assertions passed
(`sourceRef === 'cap/aio@sha256:pinned-immutable-digest'`, digest, validation
id/version, env id/kind/family/runtime). Discrimination check: flipping the
fixture validation to `failed` made the test fail closed with
`sandbox_environment_immutable_identity_unavailable`, proving the assertion is
not vacuous; reverting restored the pass. Run: `pnpm exec nest build` then
`node --test dist/sandbox-environments/ground-truth-immutable-provisioning-metadata.spec.js`
→ 1 pass, 0 fail.

Verdict: MET. The skeptic's dynamic lens did not refute the requirement
(`refuted: false`), and independent re-trace confirms every scenario.

## Requirement trace (all 8 requirements, gap sweep)

Gap findings: **none** — no requirement has zero traceable implementation.

- **AIO provisions from a resolved Docker-image environment** —
  `packages/sandbox-provider-aio/src/aio-local-provider.ts:239` rejects
  non-`aio-docker-image` source kinds before building the image;
  `aio-environment-validation.ts` gates identically; run metadata persisted via
  `apps/api/src/sandbox/sandbox-run-owner.service.ts`.
- **BoxLite provisions from a resolved environment source** —
  `packages/sandbox-provider-boxlite/src/boxlite-provider.ts:1684`
  (`resolveSandboxSource`) accepts only `boxlite-image` for managed
  environments, throws otherwise; falls back to `resolveBoxLiteSandboxSource`
  only when no managed environment is present.
- **Console exposes sandbox image management** —
  `apps/web/src/routes/_app/images.tsx` +
  `apps/web/src/components/settings/sandbox-environments-card.tsx` (provider
  selector, template copy, probe/error display); `settings-form.tsx` keeps only
  a plain default-image `Select`, no admin controls.
- **Admin-managed sandbox environment registry** —
  `apps/api/src/sandbox-environments/sandbox-environments.service.ts` `create()`
  parses through `SandboxEnvironmentSourceSchema` (only
  `aio-docker-image`/`boxlite-image`); the controller enforces admin-only via
  `requireAdmin`; migration
  `20260707010000_remove_legacy_sandbox_environment_sources` purges legacy rows.
- **Sandbox environment source descriptors are provider-aware** —
  `packages/contracts/src/sandbox-environment.ts` discriminated union limited to
  the two kinds; `providerFamiliesForEnvironmentSource` in `@cap-console/sandbox`.
- **Environment validation gates task selection** —
  `sandbox-environments.validator.ts` runs real provider-backed probes
  (Docker/BoxLite REST) before marking `ready`; `assertEnvironmentSelectable`
  gates `resolveForTask`/`resolveTaskAdmission`.
- **Environment resolution produces immutable provisioning metadata** —
  adjudicated MET above (static re-trace + dedicated ground-truth spec).
- **Environment run metadata is auditable but non-secret** —
  `sandbox-run-owner.service.ts` allowlists exactly
  `environmentId, providerFamily, sourceKind, sourceRef, digest`; no secrets.

### Loose thread (not a behavioral gap; cleanup candidate)

`packages/contracts/src/runtime-model.ts` retains a `boxlite-rootfs` arm in
`RuntimeExecutionEnvironmentSourceSchema` (line 79; family check at line 206),
and `apps/api/src/runtime-models/configured-runtime-model-taskless-probe.ts:247`
tolerates it. Correction to the raw gap note: this schema is *not* unconsumed —
it is embedded in `RuntimeExecutionEnvironmentSnapshotSchema` (line 111), which
provisioning does validate. It is nonetheless dead tolerance, not a behavioral
gap, because (a) the only snapshot producer, `managedSnapshotSource`
(`apps/api/src/runtime-models/runtime-model-environment.resolver.ts:336-364`),
can emit only `aio-docker-image`/`boxlite-image` and throws otherwise, so no new
`boxlite-rootfs` snapshot can be created; and (b) even a hypothetical legacy
persisted snapshot fails closed at the BoxLite provider's
`resolveSandboxSource`, which rejects any managed source kind other than
`boxlite-image`. No spec scenario is left unimplemented; recommend removing the
dead arm in a follow-up cleanup, outside this change.

## Scope findings (implementation beyond spec text; recorded, non-blocking)

1. **Retroactive data deletion is task-covered but not spec-covered.** Migration
   `apps/api/prisma/migrations/20260707010000_remove_legacy_sandbox_environment_sources/migration.sql`
   irreversibly `DELETE`s pre-existing `sandbox_environments` /
   `sandbox_environment_validations` rows whose source kind was removed. The
   spec deltas only require rejecting *new* create attempts for those kinds;
   retroactive purge is covered by tasks.md 2.4 ("cleanup/migration behavior …
   documenting the intentionally breaking behavior") but not by any spec
   scenario. Operators upgrading with legacy rows lose them without a spec-level
   statement of that contract.
2. **Validation probe policy is stricter than the spec's abstract wording.**
   `apps/api/src/sandbox-environments/sandbox-environments.validator.ts:419-421,434-436`
   hard-gates every AIO/BoxLite image on fixed `test -d <workspace>`,
   `command -v sh`, and `command -v git` probes for all runtimes. The spec only
   requires passing abstract "runtime/tool probes"; the mandatory
   workspace-dir/shell/git policy can fail otherwise-valid custom images and is
   currently documented only in code and templates (which do keep
   `/home/gem/workspace`).

Neither item makes a requirement ambiguous, untestable, or contradictory as
written, and neither is an undeclared public-surface impact or a false protocol
exclusion — both are recorded here for the archive record rather than routed as
spec defects.

## Routing summary

| Route | Count | Ids |
| --- | --- | --- |
| UNMET → verify-reopened tasks | 0 | — |
| SPEC-DEFECT → design Open Questions | 0 | — |
| blocking spec defects | 0 | — |
| MET (reclassified) | 1 | `sandbox-environments/environment-resolution-produces-immutable-provisioning-metadata` |
