import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  Sha256ChecksumSchema,
  TaskModelSelectorSchema,
} from '@cap/contracts';
import {
  ClaudeModelCapabilityManifestSchema,
  type ClaudeModelCapabilityManifest,
} from './claude-model-capability-manifest';

const ProviderSeamSchema = z.enum(['aio', 'boxlite']);
const SafeEvidenceTextSchema = z.string().trim().min(1).max(512);
const PrimarySourceUrlSchema = z
  .string()
  .trim()
  .url()
  .max(512)
  .refine((value) => new URL(value).protocol === 'https:', {
    message: 'Claude selector provenance must use HTTPS',
  });

const ClaudeEvidenceSelectorSchema = z
  .object({
    id: TaskModelSelectorSchema,
    displayName: z.string().trim().min(1).max(256),
    provenance: PrimarySourceUrlSchema,
  })
  .strict();

const ClaudeReferenceEnvironmentConfigSchema = z
  .object({
    providerSeam: ProviderSeamSchema,
    sandboxEnvironmentId: z.string().uuid().nullable().optional(),
    cliArtifactChecksum: Sha256ChecksumSchema,
    selectors: z.array(ClaudeEvidenceSelectorSchema).min(1).max(128),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, selector] of value.selectors.entries()) {
      if (ids.has(selector.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selectors', index, 'id'],
          message: 'Reference selectors must be unique per environment',
        });
      }
      ids.add(selector.id);
    }
  });

/**
 * Non-secret operator input for the gated live run. Credentials stay in a
 * dedicated environment variable and can never enter this strict schema.
 */
export const ClaudeReferenceSubscriptionE2eConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    repoId: z.string().uuid(),
    pollTimeoutMs: z.number().int().min(10_000).max(30 * 60_000).default(300_000),
    environments: z
      .array(ClaudeReferenceEnvironmentConfigSchema)
      .min(2)
      .max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seams = new Set(value.environments.map((item) => item.providerSeam));
    for (const required of ProviderSeamSchema.options) {
      if (!seams.has(required)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['environments'],
          message: `Reference E2E requires a representative ${required} seam`,
        });
      }
    }
  });
export type ClaudeReferenceSubscriptionE2eConfig = z.infer<
  typeof ClaudeReferenceSubscriptionE2eConfigSchema
>;

const ClaudeArtifactImageConfigSchema = z
  .object({
    providerSeam: ProviderSeamSchema,
    image: z.string().trim().min(1).max(512),
    platform: z
      .string()
      .regex(/^linux\/(?:amd64|arm64)(?:\/v8)?$/u)
      .optional(),
  })
  .strict();

/** Exact packaged images and candidate selectors used by the raw CLI gate. */
export const ClaudeArtifactCompatibilityE2eConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    timeoutMs: z.number().int().min(10_000).max(10 * 60_000).default(120_000),
    maxBudgetUsd: z.number().positive().max(5).default(0.1),
    images: z.array(ClaudeArtifactImageConfigSchema).min(2).max(16),
    selectors: z.array(ClaudeEvidenceSelectorSchema).min(1).max(128),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seams = new Set(value.images.map((item) => item.providerSeam));
    for (const required of ProviderSeamSchema.options) {
      if (!seams.has(required)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['images'],
          message: `Artifact evidence requires a representative ${required} image`,
        });
      }
    }
    const selectorIds = new Set<string>();
    for (const [index, selector] of value.selectors.entries()) {
      if (selectorIds.has(selector.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selectors', index, 'id'],
          message: 'Artifact evidence selectors must be unique',
        });
      }
      selectorIds.add(selector.id);
    }
  });
export type ClaudeArtifactCompatibilityE2eConfig = z.infer<
  typeof ClaudeArtifactCompatibilityE2eConfigSchema
>;

const ClaudeArtifactImageEvidenceSchema = z
  .object({
    providerSeam: ProviderSeamSchema,
    imageIdentity: Sha256ChecksumSchema,
    cliVersion: z.string().trim().min(1).max(128),
    cliArtifactChecksum: Sha256ChecksumSchema,
  })
  .strict();

const ClaudeArtifactLaunchEvidenceSchema = z
  .object({
    providerSeam: ProviderSeamSchema,
    imageIdentity: Sha256ChecksumSchema,
    cliVersion: z.string().trim().min(1).max(128),
    cliArtifactChecksum: Sha256ChecksumSchema,
    selector: TaskModelSelectorSchema,
    requestedModel: TaskModelSelectorSchema,
    actualModel: TaskModelSelectorSchema.nullable(),
    requestedVsActual: z.enum(['matched', 'different', 'unknown']),
    structuredOutput: z.literal('claude-stream-json'),
    result: z.literal('success'),
    resultDigest: Sha256ChecksumSchema,
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.selector !== value.requestedModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedModel'],
        message: 'Artifact evidence must retain the requested selector',
      });
    }
    const expected = requestedVsActual(value.requestedModel, value.actualModel);
    if (value.requestedVsActual !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedVsActual'],
        message: 'Artifact requested/actual comparison is inconsistent',
      });
    }
  });

export const ClaudeArtifactCompatibilityEvidencePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('claude-artifact-reference-subscription-e2e'),
    gate: z.literal('explicit-operator-opt-in'),
    gatedReferenceSubscription: z.literal(true),
    entitlementClaim: z.literal('cli-compatibility-only'),
    generatedAt: z.string().datetime({ offset: true }),
    selectors: z.array(ClaudeEvidenceSelectorSchema).min(1).max(128),
    images: z.array(ClaudeArtifactImageEvidenceSchema).min(2).max(64),
    runs: z.array(ClaudeArtifactLaunchEvidenceSchema).min(2).max(2_048),
  })
  .strict();
export type ClaudeArtifactCompatibilityEvidencePayload = z.infer<
  typeof ClaudeArtifactCompatibilityEvidencePayloadSchema
>;

export const ClaudeArtifactCompatibilityEvidenceSchema =
  ClaudeArtifactCompatibilityEvidencePayloadSchema.extend({
    evidenceChecksum: Sha256ChecksumSchema,
  }).strict();
export type ClaudeArtifactCompatibilityEvidence = z.infer<
  typeof ClaudeArtifactCompatibilityEvidenceSchema
>;

const ClaudeReferenceCatalogEvidenceSchema = z
  .object({
    providerSeam: ProviderSeamSchema,
    sandboxEnvironmentId: z.string().uuid().nullable(),
    environmentFingerprint: SafeEvidenceTextSchema,
    cliVersion: z.string().trim().min(1).max(128),
    cliArtifactChecksum: Sha256ChecksumSchema,
    catalogRevision: SafeEvidenceTextSchema,
    source: z.literal('versioned-cli-capabilities'),
    completeness: z.literal('supported-subset'),
    availabilityEvidence: z.literal('cli-version-verified'),
    selectors: z.array(ClaudeEvidenceSelectorSchema).min(1).max(128),
  })
  .strict();

const ClaudeReferenceLaunchEvidenceSchema = z
  .object({
    providerSeam: ProviderSeamSchema,
    environmentFingerprint: SafeEvidenceTextSchema,
    cliVersion: z.string().trim().min(1).max(128),
    cliArtifactChecksum: Sha256ChecksumSchema,
    catalogRevision: SafeEvidenceTextSchema,
    selector: TaskModelSelectorSchema,
    requestedModel: TaskModelSelectorSchema,
    actualModel: TaskModelSelectorSchema.nullable(),
    requestedVsActual: z.enum(['matched', 'different', 'unknown']),
    requestSurface: z.literal('public-v1'),
    executionMode: z.literal('headless-exec'),
    taskId: z.string().uuid(),
    taskStatus: z.literal('completed'),
    transcriptStatus: z.literal('available'),
    transcriptDigest: Sha256ChecksumSchema,
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.selector !== value.requestedModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedModel'],
        message: 'Requested model must retain the tested selector',
      });
    }
    const expected =
      value.actualModel === null
        ? 'unknown'
        : value.actualModel === value.requestedModel
          ? 'matched'
          : 'different';
    if (value.requestedVsActual !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedVsActual'],
        message: 'Requested/actual comparison is inconsistent',
      });
    }
  });

export const ClaudeReferenceSubscriptionEvidencePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('claude-reference-subscription-e2e'),
    gate: z.literal('explicit-operator-opt-in'),
    gatedReferenceSubscription: z.literal(true),
    entitlementClaim: z.literal('cli-compatibility-only'),
    artifactEvidenceChecksum: Sha256ChecksumSchema,
    generatedAt: z.string().datetime({ offset: true }),
    catalogs: z
      .array(ClaudeReferenceCatalogEvidenceSchema)
      .min(2)
      .max(64),
    runs: z.array(ClaudeReferenceLaunchEvidenceSchema).min(2).max(2_048),
  })
  .strict();
export type ClaudeReferenceSubscriptionEvidencePayload = z.infer<
  typeof ClaudeReferenceSubscriptionEvidencePayloadSchema
>;

export const ClaudeReferenceSubscriptionEvidenceSchema =
  ClaudeReferenceSubscriptionEvidencePayloadSchema.extend({
    evidenceChecksum: Sha256ChecksumSchema,
  }).strict();
export type ClaudeReferenceSubscriptionEvidence = z.infer<
  typeof ClaudeReferenceSubscriptionEvidenceSchema
>;

export interface ClaudeReferenceArtifactBinding {
  readonly environmentIndex: number;
  readonly cliVersion: string;
  readonly cliArtifactChecksum: string;
  readonly artifactEvidenceChecksum: string;
}

/** Deterministic JSON used only for integrity digests, never for secret input. */
export function canonicalEvidenceJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error('Evidence cannot contain undefined values.');
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalEvidenceJson(item)).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalEvidenceJson(object[key])}`,
    )
    .join(',')}}`;
}

export function evidenceChecksum(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalEvidenceJson(value), 'utf8')
    .digest('hex')}`;
}

export function signClaudeArtifactCompatibilityEvidence(
  input: unknown,
): ClaudeArtifactCompatibilityEvidence {
  const payload = ClaudeArtifactCompatibilityEvidencePayloadSchema.parse(input);
  return ClaudeArtifactCompatibilityEvidenceSchema.parse({
    ...payload,
    evidenceChecksum: evidenceChecksum(payload),
  });
}

export function parseClaudeArtifactCompatibilityEvidence(
  input: unknown,
): ClaudeArtifactCompatibilityEvidence {
  const evidence = ClaudeArtifactCompatibilityEvidenceSchema.parse(input);
  const { evidenceChecksum: observed, ...payload } = evidence;
  if (evidenceChecksum(payload) !== observed) {
    throw new Error('Claude artifact evidence checksum mismatch.');
  }
  return evidence;
}

/** Promote the pre-catalog raw CLI proof into the first usable manifest. */
export function promoteClaudeArtifactCompatibilityEvidence(
  input: unknown,
): ClaudeModelCapabilityManifest {
  const evidence = parseClaudeArtifactCompatibilityEvidence(input);
  type ArtifactImage = (typeof evidence.images)[number];
  type ArtifactRun = (typeof evidence.runs)[number];
  type ArtifactGroup = {
    cliVersion: string;
    cliArtifactChecksum: string;
    images: ArtifactImage[];
    runs: ArtifactRun[];
  };
  const selectors = new Map(
    evidence.selectors.map((selector) => [selector.id, selector]),
  );
  if (selectors.size !== evidence.selectors.length) {
    throw new Error('Duplicate Claude artifact selector evidence.');
  }

  const imageContexts = new Map<string, ArtifactImage>();
  const artifacts = new Map<string, ArtifactGroup>();
  for (const image of evidence.images) {
    const contextKey = artifactImageContextKey(image);
    if (imageContexts.has(contextKey)) {
      throw new Error('Duplicate Claude artifact image evidence.');
    }
    imageContexts.set(contextKey, image);
    const artifactKey = artifactEvidenceKey(image);
    let artifact = artifacts.get(artifactKey);
    if (!artifact) {
      artifact = {
        cliVersion: image.cliVersion,
        cliArtifactChecksum: image.cliArtifactChecksum,
        images: [],
        runs: [],
      };
      artifacts.set(artifactKey, artifact);
    }
    artifact.images.push(image);
  }

  for (const run of evidence.runs) {
    if (!selectors.has(run.selector)) {
      throw new Error('Claude artifact run uses an undeclared selector.');
    }
    if (!imageContexts.has(artifactImageContextKey(run))) {
      throw new Error('Claude artifact run is not backed by its exact image.');
    }
    const artifact = artifacts.get(artifactEvidenceKey(run));
    if (!artifact) throw new Error('Claude artifact run has no artifact group.');
    artifact.runs.push(run);
  }

  const manifestArtifacts = [...artifacts.values()]
    .sort((left, right) =>
      artifactEvidenceKey(left).localeCompare(artifactEvidenceKey(right)),
    )
    .map((artifact) => {
      for (const selector of selectors.values()) {
        if (!artifact.runs.some((run) => run.selector === selector.id)) {
          throw new Error(
            `Claude selector ${selector.id} lacks checksum-specific artifact evidence.`,
          );
        }
      }
      const providerSeams = new Set(
        artifact.images.map((image) => image.providerSeam),
      );
      for (const seam of providerSeams) {
        if (!artifact.runs.some((run) => run.providerSeam === seam)) {
          throw new Error(`Claude ${seam} artifact seam lacks a live smoke.`);
        }
      }
      const verifiedAt = artifact.runs
        .map((run) => run.completedAt)
        .sort()
        .at(-1);
      if (!verifiedAt) throw new Error('Claude artifact has no launch evidence.');

      return {
        cliVersion: artifact.cliVersion,
        cliArtifactChecksum: artifact.cliArtifactChecksum,
        evidenceChecksum: evidence.evidenceChecksum,
        verifiedAt,
        verificationRef: `evidence:${evidence.evidenceChecksum}`,
        gatedReferenceSubscription: true as const,
        selectors: [...selectors.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((selector) => ({
            ...selector,
            providerSeams: ProviderSeamSchema.options.filter((seam) =>
              providerSeams.has(seam),
            ),
          })),
      };
    });

  return ClaudeModelCapabilityManifestSchema.parse({
    schemaVersion: 1,
    cliPins: [...new Set(manifestArtifacts.map((item) => item.cliVersion))].sort(),
    artifacts: manifestArtifacts,
  });
}

/**
 * Bind the second-stage CAP run to the signed first-stage artifact proof.
 * Operator-copied checksums/selectors are treated only as assertions: every
 * value must exactly match the promoted artifact evidence, and every artifact
 * provider seam must have a configured CAP environment before any live task is
 * created.
 */
export function bindClaudeReferenceConfigToArtifactEvidence(
  configInput: unknown,
  artifactEvidenceInput: unknown,
): readonly ClaudeReferenceArtifactBinding[] {
  const config = ClaudeReferenceSubscriptionE2eConfigSchema.parse(configInput);
  const artifactEvidence = parseClaudeArtifactCompatibilityEvidence(
    artifactEvidenceInput,
  );
  const manifest = promoteClaudeArtifactCompatibilityEvidence(artifactEvidence);
  const coveredArtifactSeams = new Set<string>();

  const bindings = config.environments.map((environment, environmentIndex) => {
    const candidates = manifest.artifacts.filter(
      (artifact) =>
        artifact.cliArtifactChecksum === environment.cliArtifactChecksum &&
        artifact.selectors.some((selector) =>
          selector.providerSeams.includes(environment.providerSeam),
        ),
    );
    if (candidates.length !== 1) {
      throw new Error(
        'Reference environment does not identify exactly one evidenced Claude artifact.',
      );
    }
    const artifact = candidates[0];
    const expectedSelectors = artifact.selectors
      .filter((selector) =>
        selector.providerSeams.includes(environment.providerSeam),
      )
      .map(({ id, displayName, provenance }) => ({
        id,
        displayName,
        provenance,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const configuredSelectors = [...environment.selectors].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (
      canonicalEvidenceJson(expectedSelectors) !==
      canonicalEvidenceJson(configuredSelectors)
    ) {
      throw new Error(
        'Reference environment selectors do not match signed artifact evidence.',
      );
    }

    coveredArtifactSeams.add(
      artifactSeamKey(artifact, environment.providerSeam),
    );
    return {
      environmentIndex,
      cliVersion: artifact.cliVersion,
      cliArtifactChecksum: artifact.cliArtifactChecksum,
      artifactEvidenceChecksum: artifactEvidence.evidenceChecksum,
    };
  });

  for (const artifact of manifest.artifacts) {
    const seams = new Set(
      artifact.selectors.flatMap((selector) => selector.providerSeams),
    );
    for (const seam of seams) {
      if (!coveredArtifactSeams.has(artifactSeamKey(artifact, seam))) {
        throw new Error(
          `Signed Claude artifact ${artifact.cliArtifactChecksum} lacks a configured ${seam} CAP environment.`,
        );
      }
    }
  }

  return bindings;
}

export function signClaudeReferenceSubscriptionEvidence(
  input: unknown,
): ClaudeReferenceSubscriptionEvidence {
  const payload = ClaudeReferenceSubscriptionEvidencePayloadSchema.parse(input);
  return ClaudeReferenceSubscriptionEvidenceSchema.parse({
    ...payload,
    evidenceChecksum: evidenceChecksum(payload),
  });
}

export function parseClaudeReferenceSubscriptionEvidence(
  input: unknown,
): ClaudeReferenceSubscriptionEvidence {
  const evidence = ClaudeReferenceSubscriptionEvidenceSchema.parse(input);
  const { evidenceChecksum: observed, ...payload } = evidence;
  if (evidenceChecksum(payload) !== observed) {
    throw new Error('Claude reference-subscription evidence checksum mismatch.');
  }
  return evidence;
}

/**
 * Promote only a complete, checksum-valid live evidence bundle. The resulting
 * manifest remains a CLI-compatible supported subset; it never claims that a
 * later querying owner has the same subscription entitlement.
 */
export function promoteClaudeReferenceSubscriptionEvidence(
  input: unknown,
  artifactEvidenceInput: unknown,
): ClaudeModelCapabilityManifest {
  const evidence = parseClaudeReferenceSubscriptionEvidence(input);
  const artifactEvidence = parseClaudeArtifactCompatibilityEvidence(
    artifactEvidenceInput,
  );
  if (evidence.artifactEvidenceChecksum !== artifactEvidence.evidenceChecksum) {
    throw new Error(
      'Claude reference evidence does not match its artifact evidence checksum.',
    );
  }
  const artifactManifest = promoteClaudeArtifactCompatibilityEvidence(
    artifactEvidence,
  );
  type EvidenceCatalog = (typeof evidence.catalogs)[number];
  type EvidenceRun = (typeof evidence.runs)[number];
  type ArtifactEvidence = {
    cliVersion: string;
    cliArtifactChecksum: string;
    catalogs: EvidenceCatalog[];
    runs: EvidenceRun[];
  };
  const catalogByContext = new Map<string, (typeof evidence.catalogs)[number]>();
  const artifacts = new Map<string, ArtifactEvidence>();

  for (const catalog of evidence.catalogs) {
    const contextKey = catalogContextKey(catalog);
    if (catalogByContext.has(contextKey)) {
      throw new Error('Duplicate Claude catalog evidence context.');
    }
    catalogByContext.set(contextKey, catalog);
    const artifactKey = artifactEvidenceKey(catalog);
    let artifact = artifacts.get(artifactKey);
    if (!artifact) {
      artifact = {
        cliVersion: catalog.cliVersion,
        cliArtifactChecksum: catalog.cliArtifactChecksum,
        catalogs: [],
        runs: [],
      };
      artifacts.set(artifactKey, artifact);
    }
    artifact.catalogs.push(catalog);
  }

  for (const run of evidence.runs) {
    const context = catalogByContext.get(catalogContextKey(run));
    if (
      !context ||
      !context.selectors.some((selector) => selector.id === run.selector)
    ) {
      throw new Error('Claude launch evidence is not backed by its catalog.');
    }
    const artifact = artifacts.get(artifactEvidenceKey(run));
    if (!artifact) {
      throw new Error('Claude launch evidence has no artifact catalog.');
    }
    artifact.runs.push(run);
  }

  const manifestArtifacts = [...artifacts.values()]
    .sort((left, right) =>
      artifactEvidenceKey(left).localeCompare(artifactEvidenceKey(right)),
    )
    .map((artifact) => {
      const selectors = new Map<
        string,
        {
          id: string;
          displayName: string;
          provenance: string;
          providerSeams: Set<'aio' | 'boxlite'>;
        }
      >();
      const requiredSeams = new Set<'aio' | 'boxlite'>();
      for (const catalog of artifact.catalogs) {
        requiredSeams.add(catalog.providerSeam);
        for (const selector of catalog.selectors) {
          const existing = selectors.get(selector.id);
          if (
            existing &&
            (existing.displayName !== selector.displayName ||
              existing.provenance !== selector.provenance)
          ) {
            throw new Error('Claude selector provenance is inconsistent.');
          }
          const next = existing ?? {
            ...selector,
            providerSeams: new Set<'aio' | 'boxlite'>(),
          };
          next.providerSeams.add(catalog.providerSeam);
          selectors.set(selector.id, next);
        }
      }

      for (const selector of selectors.values()) {
        if (!artifact.runs.some((run) => run.selector === selector.id)) {
          throw new Error(
            `Claude selector ${selector.id} lacks artifact launch evidence.`,
          );
        }
      }
      for (const seam of requiredSeams) {
        if (!artifact.runs.some((run) => run.providerSeam === seam)) {
          throw new Error(`Claude ${seam} provider seam lacks a live smoke.`);
        }
      }

      const verifiedAt = artifact.runs
        .map((run) => run.completedAt)
        .sort()
        .at(-1);
      if (!verifiedAt) {
        throw new Error('Claude artifact has no successful launch evidence.');
      }
      return {
        cliVersion: artifact.cliVersion,
        cliArtifactChecksum: artifact.cliArtifactChecksum,
        evidenceChecksum: evidence.evidenceChecksum,
        verifiedAt,
        verificationRef: `evidence:${evidence.evidenceChecksum}`,
        gatedReferenceSubscription: true as const,
        selectors: [...selectors.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((selector) => ({
            id: selector.id,
            displayName: selector.displayName,
            provenance: selector.provenance,
            providerSeams: ProviderSeamSchema.options.filter((seam) =>
              selector.providerSeams.has(seam),
            ),
          })),
      };
    });

  const capabilityProjection = (
    artifact: (typeof manifestArtifacts)[number],
  ) => ({
    cliVersion: artifact.cliVersion,
    cliArtifactChecksum: artifact.cliArtifactChecksum,
    selectors: artifact.selectors.map(
      ({ id, displayName, provenance, providerSeams }) => ({
        id,
        displayName,
        provenance,
        providerSeams,
      }),
    ),
  });
  const liveCapabilities = manifestArtifacts.map(capabilityProjection);
  const artifactCapabilities = artifactManifest.artifacts.map(
    capabilityProjection,
  );
  if (
    canonicalEvidenceJson(liveCapabilities) !==
    canonicalEvidenceJson(artifactCapabilities)
  ) {
    throw new Error(
      'Claude live evidence capabilities do not match signed artifact evidence.',
    );
  }

  return ClaudeModelCapabilityManifestSchema.parse({
    schemaVersion: 1,
    cliPins: [...new Set(manifestArtifacts.map((item) => item.cliVersion))].sort(),
    artifacts: manifestArtifacts,
  });
}

function artifactEvidenceKey(input: {
  readonly cliVersion: string;
  readonly cliArtifactChecksum: string;
}): string {
  return `${input.cliVersion}\u0000${input.cliArtifactChecksum}`;
}

function artifactSeamKey(
  artifact: {
    readonly cliVersion: string;
    readonly cliArtifactChecksum: string;
  },
  providerSeam: string,
): string {
  return `${artifactEvidenceKey(artifact)}\u0000${providerSeam}`;
}

function artifactImageContextKey(input: {
  readonly providerSeam: string;
  readonly imageIdentity: string;
  readonly cliVersion: string;
  readonly cliArtifactChecksum: string;
}): string {
  return [
    input.providerSeam,
    input.imageIdentity,
    input.cliVersion,
    input.cliArtifactChecksum,
  ].join('\u0000');
}

function catalogContextKey(input: {
  readonly providerSeam: string;
  readonly environmentFingerprint: string;
  readonly cliVersion: string;
  readonly cliArtifactChecksum: string;
  readonly catalogRevision: string;
}): string {
  return [
    input.providerSeam,
    input.environmentFingerprint,
    input.cliVersion,
    input.cliArtifactChecksum,
    input.catalogRevision,
  ].join('\u0000');
}

function requestedVsActual(
  requestedModel: string,
  actualModel: string | null,
): 'matched' | 'different' | 'unknown' {
  if (actualModel === null) return 'unknown';
  return actualModel === requestedModel ? 'matched' : 'different';
}
