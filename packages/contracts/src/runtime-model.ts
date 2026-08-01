import { z } from 'zod';
import { Sha256ChecksumSchema } from './artifact-checksum.js';
import {
  SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS,
  SandboxEnvironmentProviderFamilySchema,
  SandboxEnvironmentResourcesSchema,
  type SandboxEnvironmentExtensionSourceKind,
} from './sandbox-environment.js';
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
 * MANAGED snapshot source members DERIVE from the single source-kind
 * declaration in `sandbox-environment.ts` (unlock-extension-axes D6): every
 * managed kind shares this one immutable-image shape, so adding a managed kind
 * to `SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS` surfaces in the snapshot union
 * with NO second hand edit here.
 */
const makeManagedSourceMember = <Kind extends string>(kind: Kind) =>
  z
    .object({
      kind: z.literal(kind),
      locator: z.string().trim().min(1).max(2_048),
      digest: z.string().trim().min(1).max(512),
      checksum: z.null(),
    })
    .strict();

type MapManagedSourceMembers<Kinds extends readonly string[]> = {
  -readonly [Index in keyof Kinds]: ReturnType<
    typeof makeManagedSourceMember<Kinds[Index] & string>
  >;
};
type ManagedSourceMembers = MapManagedSourceMembers<
  typeof SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS
>;
// The `.map` erases tuple positions, so re-assert them; the runtime value is a
// 1:1 map over the declaration, and `_assertSourceKindsReconcile` below keeps
// the assertion honest at compile time.
const MANAGED_SOURCE_MEMBERS = SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS.map(
  makeManagedSourceMember,
) as unknown as ManagedSourceMembers;

/**
 * EXTENSION/LEGACY snapshot source members — explicitly modeled, one row per
 * kind in the extension tier declared in `sandbox-environment.ts`. The
 * `satisfies Record<...>` makes the table TOTAL over that declaration: a new
 * extension kind without a row (or a row for an undeclared kind) is a compile
 * error, so this side cannot drift.
 *
 * D6 semantics (see the ruling record at the declaration): `provider-snapshot`
 * has a live production writer (the environment resolver's checksum fallback);
 * `boxlite-rootfs` is read-path legacy kept pending its own retirement change.
 */
const EXTENSION_SOURCE_MEMBERS = {
  'boxlite-rootfs': z
    .object({
      kind: z.literal('boxlite-rootfs'),
      locator: z.string().trim().min(1).max(2_048),
      digest: z.null(),
      checksum: z.string().trim().min(1).max(512),
    })
    .strict(),
  'provider-snapshot': z
    .object({
      kind: z.literal('provider-snapshot'),
      locator: z.string().trim().min(1).max(2_048),
      digest: z.string().trim().min(1).max(512).nullable(),
      checksum: z.string().trim().min(1).max(512).nullable(),
    })
    .strict(),
} as const satisfies Record<
  SandboxEnvironmentExtensionSourceKind,
  z.ZodTypeAny
>;

/**
 * Internal non-secret snapshot persisted with an explicit-model Task so catalog
 * validation and provisioning cannot observe different mutable images.
 *
 * Members = the derived managed tier + the explicitly modeled extension tier;
 * reconciled against the declaration by the R5 parity gate
 * (`scripts/sandbox-core-vocabulary-parity.mjs`).
 */
export const RuntimeExecutionEnvironmentSourceSchema = z.discriminatedUnion(
  'kind',
  [
    ...MANAGED_SOURCE_MEMBERS,
    EXTENSION_SOURCE_MEMBERS['boxlite-rootfs'],
    EXTENSION_SOURCE_MEMBERS['provider-snapshot'],
  ],
);
export type RuntimeExecutionEnvironmentSource = z.infer<
  typeof RuntimeExecutionEnvironmentSourceSchema
>;

/**
 * Compile-time reconciliation: the union's kind set is EXACTLY the declared
 * managed tier plus the declared extension tier — nothing more, nothing less.
 * This is what licenses the tuple cast on `MANAGED_SOURCE_MEMBERS` above: any
 * drift between the declaration and the derived union fails to compile here.
 */
type DeclaredSourceKind =
  | (typeof SANDBOX_ENVIRONMENT_MANAGED_SOURCE_KINDS)[number]
  | SandboxEnvironmentExtensionSourceKind;
type _AssertSourceKindsReconcile = [
  Exclude<DeclaredSourceKind, RuntimeExecutionEnvironmentSource['kind']>,
  Exclude<RuntimeExecutionEnvironmentSource['kind'], DeclaredSourceKind>,
] extends [never, never]
  ? true
  : never;
const _assertSourceKindsReconcile: _AssertSourceKindsReconcile = true;
void _assertSourceKindsReconcile;

export const RuntimeExecutionEnvironmentSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(['managed', 'deployment-default']),
    managedEnvironmentId: z.string().uuid().nullable(),
    validationId: z.string().uuid().nullable(),
    validationContractVersion: z.string().trim().min(1).max(128).nullable(),
    provider: z.string().trim().min(1).max(120),
    providerFamily: SandboxEnvironmentProviderFamilySchema,
    /** Immutable provider-neutral resources used by validation and launch. */
    resources: SandboxEnvironmentResourcesSchema.optional(),
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

// `RuntimeModelPreflightErrorSchema` / `RuntimeModelPreflightError` were declared
// here as bare aliases of the two above, and nothing ever imported either. The
// name collided with `apps/api`'s `RuntimeModelPreflightError` — a real Error
// subclass the api throws and its HTTP filter catches — which is an unrelated
// concept that happens to share the name. Keeping a dead alias whose name shadows
// a live class in the other subtree is how a search for one lands on the other.
