import { z } from 'zod';
import { Sha256ChecksumSchema, TaskModelSelectorSchema } from '@cap/contracts';

export const CLAUDE_MODEL_MANIFEST_ENV =
  'CAP_CLAUDE_MODEL_CAPABILITY_MANIFEST_JSON';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const ClaudeSelectorProvenanceSchema = z
  .string()
  .trim()
  .url()
  .max(512)
  .refine((value) => new URL(value).protocol === 'https:', {
    message: 'Claude selector provenance must use HTTPS',
  });

export const ClaudeModelCapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    cliPins: z.array(z.string().trim().min(1).max(128)).min(1).max(16),
    artifacts: z
      .array(
        z
          .object({
            cliVersion: z.string().trim().min(1).max(128),
            cliArtifactChecksum: Sha256ChecksumSchema,
            evidenceChecksum: Sha256ChecksumSchema,
            verifiedAt: z.string().datetime({ offset: true }),
            verificationRef: z.string().trim().min(1).max(512),
            gatedReferenceSubscription: z.literal(true),
            selectors: z
              .array(
                z
                  .object({
                    id: TaskModelSelectorSchema,
                    displayName: z.string().trim().min(1).max(256),
                    provenance: ClaudeSelectorProvenanceSchema,
                    providerSeams: z
                      .array(z.enum(['aio', 'boxlite']))
                      .min(1)
                      .max(2),
                  })
                  .strict(),
              )
              .max(128),
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const artifactKeys = new Set<string>();
    for (const [artifactIndex, artifact] of manifest.artifacts.entries()) {
      if (!manifest.cliPins.includes(artifact.cliVersion)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts', artifactIndex, 'cliVersion'],
          message: 'Artifact version is not declared by cliPins',
        });
      }
      const key = `${artifact.cliVersion}\u0000${artifact.cliArtifactChecksum}`;
      if (artifactKeys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts', artifactIndex],
          message: 'Duplicate Claude CLI artifact evidence',
        });
      }
      artifactKeys.add(key);
      const selectors = new Set<string>();
      for (const [selectorIndex, selector] of artifact.selectors.entries()) {
        if (selectors.has(selector.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['artifacts', artifactIndex, 'selectors', selectorIndex, 'id'],
            message: 'Duplicate Claude selector evidence',
          });
        }
        selectors.add(selector.id);
      }
    }
  });

export type ClaudeModelCapabilityManifest = z.infer<
  typeof ClaudeModelCapabilityManifestSchema
>;

/** Checked pin fixture promoted from checksum-valid Phase1 + Phase2 evidence. */
export const CHECKED_CLAUDE_MODEL_CAPABILITY_MANIFEST =
  ClaudeModelCapabilityManifestSchema.parse({
    schemaVersion: 1,
    cliPins: ['2.1.207'],
    artifacts: [
      {
        cliVersion: '2.1.207',
        cliArtifactChecksum:
          'sha256:85e7e988a392d859f90802ca21fb26e89d3c9ab527f5ed0b08df3955e34d5c83',
        evidenceChecksum:
          'sha256:1fc2e8b8b2e71f201d54256cedff9c39c0b519a4473dcf7e7081a652f57517b2',
        verifiedAt: '2026-07-14T10:29:23.895Z',
        verificationRef:
          'evidence:sha256:1fc2e8b8b2e71f201d54256cedff9c39c0b519a4473dcf7e7081a652f57517b2',
        gatedReferenceSubscription: true,
        selectors: [
          {
            id: 'haiku',
            displayName: 'Haiku',
            provenance: 'https://code.claude.com/docs/en/model-config',
            providerSeams: ['aio'],
          },
          {
            id: 'opus',
            displayName: 'Opus',
            provenance: 'https://code.claude.com/docs/en/model-config',
            providerSeams: ['aio'],
          },
          {
            id: 'sonnet',
            displayName: 'Sonnet',
            provenance: 'https://code.claude.com/docs/en/model-config',
            providerSeams: ['aio'],
          },
        ],
      },
      {
        cliVersion: '2.1.207',
        cliArtifactChecksum:
          'sha256:8bc14a284065383460f37981d724b8f7aa7ca93c9849d2fe367e08f03383f454',
        evidenceChecksum:
          'sha256:1fc2e8b8b2e71f201d54256cedff9c39c0b519a4473dcf7e7081a652f57517b2',
        verifiedAt: '2026-07-14T10:30:30.545Z',
        verificationRef:
          'evidence:sha256:1fc2e8b8b2e71f201d54256cedff9c39c0b519a4473dcf7e7081a652f57517b2',
        gatedReferenceSubscription: true,
        selectors: [
          {
            id: 'haiku',
            displayName: 'Haiku',
            provenance: 'https://code.claude.com/docs/en/model-config',
            providerSeams: ['boxlite'],
          },
          {
            id: 'opus',
            displayName: 'Opus',
            provenance: 'https://code.claude.com/docs/en/model-config',
            providerSeams: ['boxlite'],
          },
          {
            id: 'sonnet',
            displayName: 'Sonnet',
            provenance: 'https://code.claude.com/docs/en/model-config',
            providerSeams: ['boxlite'],
          },
        ],
      },
    ],
  });

export function loadClaudeModelCapabilityManifest(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeModelCapabilityManifest {
  const raw = env[CLAUDE_MODEL_MANIFEST_ENV];
  if (!raw?.trim()) return CHECKED_CLAUDE_MODEL_CAPABILITY_MANIFEST;
  if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('Claude model capability manifest is oversized.');
  }
  try {
    return ClaudeModelCapabilityManifestSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('Claude model capability manifest is invalid.');
  }
}
