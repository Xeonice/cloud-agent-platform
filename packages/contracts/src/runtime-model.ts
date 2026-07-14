import { z } from 'zod';
import { Sha256ChecksumSchema } from './artifact-checksum.js';
import { SandboxEnvironmentProviderFamilySchema } from './sandbox-environment.js';
import { SandboxMetadataSchema } from './sandbox-metadata.js';
import { RuntimeSchema, TaskModelSelectorSchema } from './task.js';

export const RuntimeModelCatalogQuerySchema = z
  .object({
    runtime: RuntimeSchema,
    /**
     * Omitted uses the owner's managed default; null bypasses it and selects the
     * deployment fallback; a UUID selects that exact managed environment.
     */
    sandboxEnvironmentId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type RuntimeModelCatalogQuery = z.infer<
  typeof RuntimeModelCatalogQuerySchema
>;

const RuntimeModelEffectiveEnvironmentBaseSchema = z.object({
  name: z.string().trim().min(1).max(160),
  provider: z.string().trim().min(1).max(120),
  /** Opaque, non-secret identity over the exact execution/toolchain context. */
  fingerprint: z.string().trim().min(1).max(256),
});

export const ManagedRuntimeModelEnvironmentSchema =
  RuntimeModelEffectiveEnvironmentBaseSchema.extend({
    kind: z.literal('managed'),
    id: z.string().uuid(),
  }).strict();

export const DeploymentRuntimeModelEnvironmentSchema =
  RuntimeModelEffectiveEnvironmentBaseSchema.extend({
    kind: z.literal('deployment-default'),
    id: z.null(),
  }).strict();

export const RuntimeModelEffectiveEnvironmentSchema = z.discriminatedUnion(
  'kind',
  [
    ManagedRuntimeModelEnvironmentSchema,
    DeploymentRuntimeModelEnvironmentSchema,
  ],
);
export type RuntimeModelEffectiveEnvironment = z.infer<
  typeof RuntimeModelEffectiveEnvironmentSchema
>;

/**
 * Internal non-secret snapshot persisted with an explicit-model Task so catalog
 * validation and provisioning cannot observe different mutable images.
 */
export const RuntimeExecutionEnvironmentSourceSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('aio-docker-image'),
        locator: z.string().trim().min(1).max(2_048),
        digest: z.string().trim().min(1).max(512),
        checksum: z.null(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('boxlite-image'),
        locator: z.string().trim().min(1).max(2_048),
        digest: z.string().trim().min(1).max(512),
        checksum: z.null(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('boxlite-rootfs'),
        locator: z.string().trim().min(1).max(2_048),
        digest: z.null(),
        checksum: z.string().trim().min(1).max(512),
      })
      .strict(),
    z
      .object({
        kind: z.literal('provider-snapshot'),
        locator: z.string().trim().min(1).max(2_048),
        digest: z.string().trim().min(1).max(512).nullable(),
        checksum: z.string().trim().min(1).max(512).nullable(),
      })
      .strict(),
  ],
);
export type RuntimeExecutionEnvironmentSource = z.infer<
  typeof RuntimeExecutionEnvironmentSourceSchema
>;

export const RuntimeExecutionEnvironmentSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(['managed', 'deployment-default']),
    managedEnvironmentId: z.string().uuid().nullable(),
    validationId: z.string().uuid().nullable(),
    validationContractVersion: z.string().trim().min(1).max(128).nullable(),
    provider: z.string().trim().min(1).max(120),
    providerFamily: SandboxEnvironmentProviderFamilySchema,
    /** Exact provider-consumable immutable source, never a mutable tag alone. */
    source: RuntimeExecutionEnvironmentSourceSchema,
    /** Content digest or provider-equivalent immutable identity. */
    immutableIdentity: z.string().trim().min(1).max(512),
    fingerprint: z.string().trim().min(1).max(256),
    /** Actual validated, non-secret image metadata used by the catalog. */
    sandboxMetadata: SandboxMetadataSchema,
    sandboxMetadataChecksum: Sha256ChecksumSchema,
    cliVersion: z.string().trim().min(1).max(128),
    cliArtifactChecksum: Sha256ChecksumSchema,
    /** ISO string rather than Date so this schema can be persisted as JSONB. */
    resolvedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'managed' && value.managedEnvironmentId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['managedEnvironmentId'],
        message: 'Managed environment snapshots require an environment id',
      });
    }
    if (
      value.kind === 'managed' &&
      (value.validationId === null || value.validationContractVersion === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validationId'],
        message: 'Managed snapshots require validation provenance',
      });
    }
    if (
      value.kind === 'deployment-default' &&
      value.managedEnvironmentId !== null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['managedEnvironmentId'],
        message: 'Deployment-default snapshots cannot carry a managed id',
      });
    }
    if (
      value.kind === 'deployment-default' &&
      (value.validationId !== null || value.validationContractVersion !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validationId'],
        message: 'Deployment-default snapshots cannot carry managed validation provenance',
      });
    }
    if (
      value.source.kind === 'provider-snapshot' &&
      value.source.digest === null &&
      value.source.checksum === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source'],
        message: 'Execution snapshots require a resolved digest or checksum',
      });
    }
    if (
      value.source.kind === 'aio-docker-image' &&
      value.source.locator !== value.source.digest &&
      !value.source.locator.endsWith(`@${value.source.digest}`)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'locator'],
        message: 'Image snapshot locators must include their resolved digest',
      });
    }
    if (
      value.source.kind === 'boxlite-image' &&
      !value.source.locator.endsWith(`@${value.source.digest}`)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'locator'],
        message: 'BoxLite image locators must end with their resolved digest',
      });
    }
    if (
      value.source.kind === 'aio-docker-image' &&
      value.providerFamily !== 'aio'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerFamily'],
        message: 'AIO image snapshots require the AIO provider family',
      });
    }
    if (
      (value.source.kind === 'boxlite-image' ||
        value.source.kind === 'boxlite-rootfs') &&
      value.providerFamily !== 'boxlite'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerFamily'],
        message: 'BoxLite snapshots require the BoxLite provider family',
      });
    }
    const sourceIdentity = value.source.digest ?? value.source.checksum;
    if (sourceIdentity && value.immutableIdentity !== sourceIdentity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['immutableIdentity'],
        message: 'Immutable identity must match the resolved source identity',
      });
    }
  });
export type RuntimeExecutionEnvironmentSnapshot = z.infer<
  typeof RuntimeExecutionEnvironmentSnapshotSchema
>;

export const RuntimeModelCatalogSourceSchema = z.enum([
  'codex-app-server',
  'compatible-provider',
  'versioned-cli-capabilities',
]);
export type RuntimeModelCatalogSource = z.infer<
  typeof RuntimeModelCatalogSourceSchema
>;

export const RuntimeModelCatalogCompletenessSchema = z.enum([
  'complete',
  'supported-subset',
]);
export type RuntimeModelCatalogCompleteness = z.infer<
  typeof RuntimeModelCatalogCompletenessSchema
>;

export const RuntimeModelAvailabilityEvidenceSchema = z.enum([
  'account-discovered',
  'cli-version-verified',
]);
export type RuntimeModelAvailabilityEvidence = z.infer<
  typeof RuntimeModelAvailabilityEvidenceSchema
>;

export const RuntimeModelCatalogItemSchema = z
  .object({
    id: TaskModelSelectorSchema,
    displayName: z.string().trim().min(1).max(256),
    isDefault: z.boolean(),
    availabilityEvidence: RuntimeModelAvailabilityEvidenceSchema,
  })
  .strict();
export type RuntimeModelCatalogItem = z.infer<
  typeof RuntimeModelCatalogItemSchema
>;

export const RuntimeModelCatalogSchema = z
  .object({
    runtime: RuntimeSchema,
    effectiveEnvironment: RuntimeModelEffectiveEnvironmentSchema,
    cliVersion: z.string().trim().min(1).max(128),
    source: RuntimeModelCatalogSourceSchema,
    completeness: RuntimeModelCatalogCompletenessSchema,
    revision: z.string().trim().min(1).max(256),
    defaultModel: TaskModelSelectorSchema.nullable(),
    models: z.array(RuntimeModelCatalogItemSchema).max(1_000),
  })
  .strict();
export type RuntimeModelCatalog = z.infer<typeof RuntimeModelCatalogSchema>;

export const RuntimeModelErrorCodeSchema = z.enum([
  'runtime_model_not_available',
  'runtime_model_catalog_unavailable',
]);
export type RuntimeModelErrorCode = z.infer<
  typeof RuntimeModelErrorCodeSchema
>;

export const RuntimeModelErrorContextSchema = z
  .object({
    runtime: RuntimeSchema,
    sandboxEnvironmentId: z.string().uuid().nullable().optional(),
    model: TaskModelSelectorSchema.optional(),
  })
  .strict();
export type RuntimeModelErrorContext = z.infer<
  typeof RuntimeModelErrorContextSchema
>;

export const RuntimeModelCapacityDataSchema = z
  .object({
    scope: z.enum(['principal', 'owner', 'global']),
    retryAfterMs: z.number().int().positive(),
  })
  .strict();
export type RuntimeModelCapacityData = z.infer<
  typeof RuntimeModelCapacityDataSchema
>;

const RuntimeModelErrorBaseShape = {
  message: z.string().trim().min(1).max(512),
  context: RuntimeModelErrorContextSchema.optional(),
} as const;

export const RuntimeModelNotAvailableErrorSchema = z
  .object({
    code: z.literal('runtime_model_not_available'),
    retryable: z.literal(false),
    ...RuntimeModelErrorBaseShape,
  })
  .strict();
export type RuntimeModelNotAvailableError = z.infer<
  typeof RuntimeModelNotAvailableErrorSchema
>;

export const RuntimeModelCatalogUnavailableErrorSchema = z
  .object({
    code: z.literal('runtime_model_catalog_unavailable'),
    retryable: z.literal(true),
    ...RuntimeModelErrorBaseShape,
    capacity: RuntimeModelCapacityDataSchema.optional(),
  })
  .strict();
export type RuntimeModelCatalogUnavailableError = z.infer<
  typeof RuntimeModelCatalogUnavailableErrorSchema
>;

/** Stable, transport-neutral failure projected independently by REST and MCP. */
export const RuntimeModelErrorSchema = z.discriminatedUnion('code', [
  RuntimeModelNotAvailableErrorSchema,
  RuntimeModelCatalogUnavailableErrorSchema,
]);
export type RuntimeModelError = z.infer<typeof RuntimeModelErrorSchema>;

export const RuntimeModelPreflightErrorSchema = RuntimeModelErrorSchema;
export type RuntimeModelPreflightError = RuntimeModelError;
