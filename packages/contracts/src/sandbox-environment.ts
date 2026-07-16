import { z } from 'zod';
import { Sha256ChecksumSchema } from './artifact-checksum.js';
import { SandboxMetadataSchema } from './sandbox-metadata.js';

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

export const SandboxEnvironmentProviderFamilySchema = z.enum([
  'aio',
  'boxlite',
  'cloud-http',
]);
export type SandboxEnvironmentProviderFamily = z.infer<
  typeof SandboxEnvironmentProviderFamilySchema
>;

export const SandboxEnvironmentSourceKindSchema = z.enum([
  'aio-docker-image',
  'boxlite-image',
]);
export type SandboxEnvironmentSourceKind = z.infer<
  typeof SandboxEnvironmentSourceKindSchema
>;

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

export const RuntimeArtifactChecksumsSchema = z
  .object({
    codex: Sha256ChecksumSchema.optional(),
    'claude-code': Sha256ChecksumSchema.optional(),
  })
  .strict();
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
