import { z } from 'zod';
import { AGENT_RUNTIME_IDS } from './agent-runtime-id.js';
import { Sha256ChecksumSchema } from './artifact-checksum.js';
import { SandboxMetadataSchema } from './sandbox-metadata.js';
import { SANDBOX_PROVIDER_FAMILIES } from './provider-family.js';

export const SandboxEnvironmentStatusSchema = z.enum([
  'draft',
  'validating',
  'ready',
  'failed',
  'stale',
  'disabled',
]);
export type SandboxEnvironmentStatus = z.infer<
  typeof SandboxEnvironmentStatusSchema
>;

export const SandboxEnvironmentProviderFamilySchema = z.enum(
  SANDBOX_PROVIDER_FAMILIES,
);
export type SandboxEnvironmentProviderFamily = z.infer<
  typeof SandboxEnvironmentProviderFamilySchema
>;

/**
 * Environment source-kind vocabulary — the SINGLE declaration, two tiers
 * (unlock-extension-axes D6).
 *
 * MANAGED kinds are creatable/validatable through the managed-environment
 * surface. `SandboxEnvironmentSourceKindSchema` below wraps ONLY this tier, so
 * managed creation/validation keeps rejecting every non-managed kind exactly as
 * before the merge — the extension tier does not widen the managed surface.
 *
 * EXTENSION/LEGACY kinds exist only on the runtime-model snapshot paths and are
 * never selectable as managed environments. D6 RULING RECORD (integration task
 * 7.2, 2026-08-01):
 * - `provider-snapshot` has a LIVE production writer — the environment resolver
 *   falls back to it whenever a checksum resolves without a matching configured
 *   source kind (`runtime-model-environment.resolver.ts`). Deleting or renaming
 *   it would be a silent behavior change, so it is modeled as an explicit
 *   extension member.
 * - `boxlite-rootfs` survives only on the READ path (historical persisted
 *   snapshots, the snapshot validation refinement, and the taskless probe).
 *   Decision: keep it as an explicitly modeled LEGACY member; migrating the
 *   historical snapshots away is deliberately NOT a side effect of this change
 *   and requires its own user-approved follow-up (see the runtime-model-catalog
 *   spec: "Retiring boxlite-rootfs is not a side effect of this change").
 *
 * `runtime-model.ts` DERIVES its snapshot source union from these two tiers —
 * managed members programmatically, extension members through a
 * totality-checked table — and must not grow an independent member list. The
 * R5 parity gate (`scripts/sandbox-core-vocabulary-parity.mjs`) reconciles the
 * declaration against that derivation site.
 */
export const SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS = [
  'aio-docker-image',
  'boxlite-image',
] as const;
export const SANDBOX_ENVIRONMENT_EXTENSION_SOURCE_KINDS = [
  'boxlite-rootfs',
  'provider-snapshot',
] as const;

export const SandboxEnvironmentSourceKindSchema = z.enum(
  SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS,
);
export type SandboxEnvironmentSourceKind = z.infer<
  typeof SandboxEnvironmentSourceKindSchema
>;
export type SandboxEnvironmentExtensionSourceKind =
  (typeof SANDBOX_ENVIRONMENT_EXTENSION_SOURCE_KINDS)[number];

export const SandboxEnvironmentSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('aio-docker-image'),
    label: z.string().min(1).optional(),
    image: z.string().min(1),
    digest: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('boxlite-image'),
    label: z.string().min(1).optional(),
    image: z.string().min(1),
    digest: z.string().min(1).optional(),
  }),
]);
export type SandboxEnvironmentSource = z.infer<
  typeof SandboxEnvironmentSourceSchema
>;

export const SandboxEnvironmentCompatibilitySchema = z.object({
  providerFamilies: z.array(SandboxEnvironmentProviderFamilySchema).min(1),
  runtimeIds: z.array(z.string().min(1)).optional(),
});
export type SandboxEnvironmentCompatibility = z.infer<
  typeof SandboxEnvironmentCompatibilitySchema
>;

export const SandboxEnvironmentParameterNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name');

export const SandboxEnvironmentParameterInputSchema = z.object({
  name: SandboxEnvironmentParameterNameSchema,
  value: z.string(),
  secret: z.boolean().optional(),
}).strict();
export type SandboxEnvironmentParameterInput = z.infer<
  typeof SandboxEnvironmentParameterInputSchema
>;

export const SandboxEnvironmentParameterSchema = z.object({
  name: SandboxEnvironmentParameterNameSchema,
  value: z.string().optional(),
  secret: z.boolean(),
}).strict();
export type SandboxEnvironmentParameter = z.infer<
  typeof SandboxEnvironmentParameterSchema
>;

/** Platform admission bounds for managed sandbox root disks, in GiB. */
export const SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MIN = 1;
export const SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MAX = 1024;

export const SandboxEnvironmentDiskSizeGbSchema = z
  .number()
  .int()
  .min(SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MIN)
  .max(SANDBOX_ENVIRONMENT_DISK_SIZE_GB_MAX);

/**
 * Provisioning-time resources are deliberately separate from guest image
 * parameters. Keep this object strict so a resource is only admitted after a
 * central contract has defined its validation and persistence semantics.
 */
export const SandboxEnvironmentResourcesSchema = z
  .object({
    diskSizeGb: SandboxEnvironmentDiskSizeGbSchema.optional(),
  })
  .strict();
export type SandboxEnvironmentResources = z.infer<
  typeof SandboxEnvironmentResourcesSchema
>;

export const SandboxEnvironmentValidationProbeSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  command: z.string().min(1).optional(),
  output: z.string().optional(),
});
export type SandboxEnvironmentValidationProbe = z.infer<
  typeof SandboxEnvironmentValidationProbeSchema
>;

/**
 * Per-runtime packaged CLI artifact checksums, keyed by THE runtime vocabulary
 * instead of literal keys (unlock-extension-axes D1) — this was the last axis-B
 * physical rejection: with strict literal keys, declaring a new runtime made
 * its attestations unparseable.
 *
 * INTENDED SEMANTICS = PARTIAL. Under the Zod classic v3 entrypoint an
 * enum-keyed `z.record` accepts any SUBSET of the declared runtime keys: a
 * historical attestation persisted before a runtime was declared (so it lacks
 * that runtime's checksum) MUST keep parsing; a key outside the vocabulary is
 * rejected; values stay validated sha-256 checksums. Zod v4 FLIPS enum-keyed
 * `z.record` to exhaustive (a missing declared key fails the parse), so the v4
 * migration path for this schema is `z.partialRecord(...)`, NOT `z.record(...)`.
 * Pinned constraint: `packages/contracts`, `apps/api`, and `apps/web` import
 * only the classic v3 `zod` entrypoint (never the `zod/v4` subpath) — asserted
 * by the scan test in `sandbox-environment.test.mjs`.
 *
 * The key schema derives from `AGENT_RUNTIME_IDS` directly — the same single
 * declaration `RuntimeSchema` (task.ts) wraps — rather than importing
 * `RuntimeSchema`, because task.js already imports this module and the reverse
 * import would be an initialization cycle.
 */
export const RuntimeArtifactChecksumsSchema = z.record(
  z.enum(AGENT_RUNTIME_IDS),
  Sha256ChecksumSchema,
);
export type RuntimeArtifactChecksums = z.infer<
  typeof RuntimeArtifactChecksumsSchema
>;

export const SandboxEnvironmentValidationSchema = z.object({
  id: z.string().uuid(),
  environmentId: z.string().uuid(),
  status: z.enum(['passed', 'failed']),
  providerFamily: SandboxEnvironmentProviderFamilySchema,
  runtimeId: z.string().min(1).nullable().optional(),
  sourceKind: SandboxEnvironmentSourceKindSchema,
  resolvedLocator: z.string().min(1).nullable().optional(),
  resolvedDigest: z.string().min(1).nullable().optional(),
  resolvedChecksum: z.string().min(1).nullable().optional(),
  runtimeArtifactChecksums: RuntimeArtifactChecksumsSchema.nullable().optional(),
  /** @deprecated Read runtimeArtifactChecksums for new validation rows. */
  cliArtifactChecksum: Sha256ChecksumSchema.nullable().optional(),
  sandboxMetadata: SandboxMetadataSchema.nullable().optional(),
  resourceSnapshot: SandboxEnvironmentResourcesSchema.nullable().optional(),
  probes: z.array(SandboxEnvironmentValidationProbeSchema).nullable().optional(),
  error: z.string().nullable().optional(),
  contractVersion: z.string().min(1).nullable().optional(),
  checkedAt: z.coerce.date(),
});
export type SandboxEnvironmentValidation = z.infer<
  typeof SandboxEnvironmentValidationSchema
>;

export const SandboxEnvironmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  status: SandboxEnvironmentStatusSchema,
  source: SandboxEnvironmentSourceSchema,
  compatibility: SandboxEnvironmentCompatibilitySchema,
  resources: SandboxEnvironmentResourcesSchema.nullable().optional(),
  parameters: z.array(SandboxEnvironmentParameterSchema).optional(),
  isDefault: z.boolean(),
  lastValidationId: z.string().uuid().nullable().optional(),
  lastValidatedAt: z.coerce.date().nullable().optional(),
  contractVersion: z.string().min(1).nullable().optional(),
  sandboxMetadata: SandboxMetadataSchema.nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type SandboxEnvironment = z.infer<typeof SandboxEnvironmentSchema>;

export const TaskSandboxEnvironmentSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  status: SandboxEnvironmentStatusSchema,
  providerFamily: SandboxEnvironmentProviderFamilySchema.nullable().optional(),
  sourceKind: SandboxEnvironmentSourceKindSchema,
  runtimeIds: z.array(z.string().min(1)).optional(),
});
export type TaskSandboxEnvironmentSummary = z.infer<
  typeof TaskSandboxEnvironmentSummarySchema
>;

export const CreateSandboxEnvironmentRequestSchema = z.object({
  name: z.string().min(1),
  source: SandboxEnvironmentSourceSchema,
  runtimeIds: z.array(z.string().min(1)).optional(),
  resources: SandboxEnvironmentResourcesSchema.nullable().optional(),
  parameters: z.array(SandboxEnvironmentParameterInputSchema).optional(),
  isDefault: z.boolean().optional(),
});
export type CreateSandboxEnvironmentRequest = z.infer<
  typeof CreateSandboxEnvironmentRequestSchema
>;

/**
 * One entry of an update-parameters request. Secrets are write-only, so an
 * edit that retains an existing secret cannot resubmit its value: it sends a
 * keep entry (`{name, keep: true}`) and the server copies the stored
 * ciphertext verbatim. Both variants are strict so a keep entry can never
 * smuggle a value and a set entry can never carry `keep`.
 */
export const UpdateSandboxEnvironmentParameterEntrySchema = z.union([
  SandboxEnvironmentParameterInputSchema,
  z.object({
    name: SandboxEnvironmentParameterNameSchema,
    keep: z.literal(true),
  }).strict(),
]);
export type UpdateSandboxEnvironmentParameterEntry = z.infer<
  typeof UpdateSandboxEnvironmentParameterEntrySchema
>;

export const UpdateSandboxEnvironmentParametersRequestSchema = z
  .object({
    parameters: z.array(UpdateSandboxEnvironmentParameterEntrySchema),
  })
  .strict()
  .superRefine((request, ctx) => {
    const seen = new Set<string>();
    for (const entry of request.parameters) {
      if (seen.has(entry.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parameters'],
          message: `duplicate parameter name: ${entry.name}`,
        });
      }
      seen.add(entry.name);
    }
  });
export type UpdateSandboxEnvironmentParametersRequest = z.infer<
  typeof UpdateSandboxEnvironmentParametersRequestSchema
>;

export const SandboxEnvironmentResponseSchema = SandboxEnvironmentSchema;
export type SandboxEnvironmentResponse = z.infer<
  typeof SandboxEnvironmentResponseSchema
>;

export const ListSandboxEnvironmentsResponseSchema = z.object({
  environments: z.array(SandboxEnvironmentSchema),
});
export type ListSandboxEnvironmentsResponse = z.infer<
  typeof ListSandboxEnvironmentsResponseSchema
>;

export const ListSandboxEnvironmentValidationsResponseSchema = z.object({
  validations: z.array(SandboxEnvironmentValidationSchema),
});
export type ListSandboxEnvironmentValidationsResponse = z.infer<
  typeof ListSandboxEnvironmentValidationsResponseSchema
>;

export const ValidateSandboxEnvironmentResponseSchema = z.object({
  environment: SandboxEnvironmentSchema,
  validation: SandboxEnvironmentValidationSchema,
});
export type ValidateSandboxEnvironmentResponse = z.infer<
  typeof ValidateSandboxEnvironmentResponseSchema
>;
