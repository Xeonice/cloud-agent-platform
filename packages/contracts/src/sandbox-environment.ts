import { z } from 'zod';

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
  'aio-loaded-docker-image',
  'boxlite-image',
  'boxlite-rootfs',
  'provider-template',
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
    kind: z.literal('aio-loaded-docker-image'),
    label: z.string().min(1).optional(),
    image: z.string().min(1),
    imageId: z.string().min(1).optional(),
    digest: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('boxlite-image'),
    label: z.string().min(1).optional(),
    image: z.string().min(1),
    digest: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('boxlite-rootfs'),
    label: z.string().min(1).optional(),
    rootfsPath: z.string().min(1),
    checksum: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('provider-template'),
    label: z.string().min(1).optional(),
    providerFamily: SandboxEnvironmentProviderFamilySchema,
    templateId: z.string().min(1),
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

export const SandboxEnvironmentValidationProbeSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  command: z.string().min(1).optional(),
  output: z.string().optional(),
});
export type SandboxEnvironmentValidationProbe = z.infer<
  typeof SandboxEnvironmentValidationProbeSchema
>;

export const SandboxEnvironmentValidationSchema = z.object({
  id: z.string().uuid(),
  environmentId: z.string().uuid(),
  status: z.enum(['passed', 'failed']),
  providerFamily: SandboxEnvironmentProviderFamilySchema,
  runtimeId: z.string().min(1).nullable().optional(),
  sourceKind: SandboxEnvironmentSourceKindSchema,
  resolvedDigest: z.string().min(1).nullable().optional(),
  resolvedChecksum: z.string().min(1).nullable().optional(),
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
  isDefault: z.boolean(),
  lastValidationId: z.string().uuid().nullable().optional(),
  lastValidatedAt: z.coerce.date().nullable().optional(),
  contractVersion: z.string().min(1).nullable().optional(),
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
