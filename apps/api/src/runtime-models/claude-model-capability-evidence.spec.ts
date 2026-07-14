import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClaudeArtifactCompatibilityE2eConfigSchema,
  ClaudeReferenceSubscriptionE2eConfigSchema,
  bindClaudeReferenceConfigToArtifactEvidence,
  parseClaudeArtifactCompatibilityEvidence,
  parseClaudeReferenceSubscriptionEvidence,
  promoteClaudeArtifactCompatibilityEvidence,
  promoteClaudeReferenceSubscriptionEvidence,
  signClaudeArtifactCompatibilityEvidence,
  signClaudeReferenceSubscriptionEvidence,
  type ClaudeArtifactCompatibilityEvidencePayload,
  type ClaudeReferenceSubscriptionEvidencePayload,
} from './claude-model-capability-evidence';

const CHECKSUM = `sha256:${'a'.repeat(64)}`;
const TRANSCRIPT_A = `sha256:${'b'.repeat(64)}`;
const TRANSCRIPT_B = `sha256:${'c'.repeat(64)}`;
const FINGERPRINT_AIO = 'environment-aio';
const FINGERPRINT_BOXLITE = 'environment-boxlite';
const SELECTORS = [
  {
    id: 'vendor/selector-a',
    displayName: 'Selector A',
    provenance: 'https://docs.example.test/models#a',
  },
  {
    id: 'vendor/selector-b',
    displayName: 'Selector B',
    provenance: 'https://docs.example.test/models#b',
  },
] as const;

function run(
  selector: (typeof SELECTORS)[number]['id'],
  providerSeam: 'aio' | 'boxlite',
  options: { actualModel?: string | null; completedAt?: string } = {},
) {
  const actualModel =
    options.actualModel === undefined ? selector : options.actualModel;
  return {
    providerSeam,
    environmentFingerprint:
      providerSeam === 'aio' ? FINGERPRINT_AIO : FINGERPRINT_BOXLITE,
    cliVersion: '2.1.207',
    cliArtifactChecksum: CHECKSUM,
    catalogRevision: `catalog-${providerSeam}`,
    selector,
    requestedModel: selector,
    actualModel,
    requestedVsActual:
      actualModel === null
        ? ('unknown' as const)
        : actualModel === selector
          ? ('matched' as const)
          : ('different' as const),
    requestSurface: 'public-v1' as const,
    executionMode: 'headless-exec' as const,
    taskId:
      selector === SELECTORS[0].id
        ? providerSeam === 'aio'
          ? '11111111-1111-4111-8111-111111111111'
          : '22222222-2222-4222-8222-222222222222'
        : '33333333-3333-4333-8333-333333333333',
    taskStatus: 'completed' as const,
    transcriptStatus: 'available' as const,
    transcriptDigest:
      selector === SELECTORS[0].id ? TRANSCRIPT_A : TRANSCRIPT_B,
    completedAt: options.completedAt ?? '2026-07-14T01:00:00.000Z',
  };
}

function payload(
  artifactEvidenceChecksum = signedArtifactEvidence().evidenceChecksum,
): ClaudeReferenceSubscriptionEvidencePayload {
  return {
    schemaVersion: 1,
    kind: 'claude-reference-subscription-e2e',
    gate: 'explicit-operator-opt-in',
    gatedReferenceSubscription: true,
    entitlementClaim: 'cli-compatibility-only',
    artifactEvidenceChecksum,
    generatedAt: '2026-07-14T00:00:00.000Z',
    catalogs: [
      {
        providerSeam: 'aio',
        sandboxEnvironmentId: null,
        environmentFingerprint: FINGERPRINT_AIO,
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
        catalogRevision: 'catalog-aio',
        source: 'versioned-cli-capabilities',
        completeness: 'supported-subset',
        availabilityEvidence: 'cli-version-verified',
        selectors: [...SELECTORS],
      },
      {
        providerSeam: 'boxlite',
        sandboxEnvironmentId: '44444444-4444-4444-8444-444444444444',
        environmentFingerprint: FINGERPRINT_BOXLITE,
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
        catalogRevision: 'catalog-boxlite',
        source: 'versioned-cli-capabilities',
        completeness: 'supported-subset',
        availabilityEvidence: 'cli-version-verified',
        selectors: [...SELECTORS],
      },
    ],
    // One run per selector/checksum plus one representative second-provider
    // smoke is sufficient when both provider images contain identical bytes.
    runs: [
      run(SELECTORS[0].id, 'aio'),
      run(SELECTORS[1].id, 'aio', { actualModel: null }),
      run(SELECTORS[0].id, 'boxlite', {
        actualModel: 'provider/concrete-a',
        completedAt: '2026-07-14T02:00:00.000Z',
      }),
    ],
  };
}

function artifactPayload(): ClaudeArtifactCompatibilityEvidencePayload {
  return {
    schemaVersion: 1,
    kind: 'claude-artifact-reference-subscription-e2e',
    gate: 'explicit-operator-opt-in',
    gatedReferenceSubscription: true,
    entitlementClaim: 'cli-compatibility-only',
    generatedAt: '2026-07-14T00:00:00.000Z',
    selectors: [...SELECTORS],
    images: [
      {
        providerSeam: 'aio',
        imageIdentity: `sha256:${'d'.repeat(64)}`,
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
      },
      {
        providerSeam: 'boxlite',
        imageIdentity: `sha256:${'e'.repeat(64)}`,
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
      },
    ],
    runs: [
      {
        providerSeam: 'aio',
        imageIdentity: `sha256:${'d'.repeat(64)}`,
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
        selector: SELECTORS[0].id,
        requestedModel: SELECTORS[0].id,
        actualModel: SELECTORS[0].id,
        requestedVsActual: 'matched',
        structuredOutput: 'claude-stream-json',
        result: 'success',
        resultDigest: TRANSCRIPT_A,
        completedAt: '2026-07-14T01:00:00.000Z',
      },
      {
        providerSeam: 'aio',
        imageIdentity: `sha256:${'d'.repeat(64)}`,
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
        selector: SELECTORS[1].id,
        requestedModel: SELECTORS[1].id,
        actualModel: null,
        requestedVsActual: 'unknown',
        structuredOutput: 'claude-stream-json',
        result: 'success',
        resultDigest: TRANSCRIPT_B,
        completedAt: '2026-07-14T01:30:00.000Z',
      },
      {
        providerSeam: 'boxlite',
        imageIdentity: `sha256:${'e'.repeat(64)}`,
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
        selector: SELECTORS[0].id,
        requestedModel: SELECTORS[0].id,
        actualModel: 'provider/concrete-a',
        requestedVsActual: 'different',
        structuredOutput: 'claude-stream-json',
        result: 'success',
        resultDigest: TRANSCRIPT_A,
        completedAt: '2026-07-14T02:00:00.000Z',
      },
    ],
  };
}

function signedArtifactEvidence() {
  return signClaudeArtifactCompatibilityEvidence(artifactPayload());
}

test('live E2E config requires explicit AIO and BoxLite reference seams', () => {
  assert.throws(() =>
    ClaudeReferenceSubscriptionE2eConfigSchema.parse({
      schemaVersion: 1,
      repoId: '55555555-5555-4555-8555-555555555555',
      environments: [
        {
          providerSeam: 'aio',
          cliArtifactChecksum: CHECKSUM,
          selectors: SELECTORS,
        },
        {
          providerSeam: 'aio',
          sandboxEnvironmentId: null,
          cliArtifactChecksum: CHECKSUM,
          selectors: SELECTORS,
        },
      ],
    }),
  );

  const config = ClaudeReferenceSubscriptionE2eConfigSchema.parse({
    schemaVersion: 1,
    repoId: '55555555-5555-4555-8555-555555555555',
    environments: [
      {
        providerSeam: 'aio',
        cliArtifactChecksum: CHECKSUM,
        selectors: SELECTORS,
      },
      {
        providerSeam: 'boxlite',
        sandboxEnvironmentId: null,
        cliArtifactChecksum: CHECKSUM,
        selectors: SELECTORS,
      },
    ],
  });
  assert.equal(config.pollTimeoutMs, 300_000);
});

test('raw artifact config and promotion require every selector per checksum plus both seams', () => {
  assert.doesNotThrow(() =>
    ClaudeArtifactCompatibilityE2eConfigSchema.parse({
      schemaVersion: 1,
      images: [
        { providerSeam: 'aio', image: 'fixture/aio', platform: 'linux/amd64' },
        { providerSeam: 'boxlite', image: 'fixture/boxlite', platform: 'linux/arm64' },
      ],
      selectors: SELECTORS,
    }),
  );

  const evidence = signClaudeArtifactCompatibilityEvidence(artifactPayload());
  assert.deepEqual(parseClaudeArtifactCompatibilityEvidence(evidence), evidence);
  const manifest = promoteClaudeArtifactCompatibilityEvidence(evidence);
  assert.deepEqual(manifest.cliPins, ['2.1.207']);
  assert.equal(manifest.artifacts[0]?.evidenceChecksum, evidence.evidenceChecksum);
  assert.deepEqual(
    manifest.artifacts[0]?.selectors.map((selector) => selector.providerSeams),
    [
      ['aio', 'boxlite'],
      ['aio', 'boxlite'],
    ],
  );

  const incomplete = artifactPayload();
  incomplete.runs = incomplete.runs.filter(
    (item) => item.selector !== SELECTORS[1].id,
  );
  assert.throws(
    () =>
      promoteClaudeArtifactCompatibilityEvidence(
        signClaudeArtifactCompatibilityEvidence(incomplete),
      ),
    /lacks checksum-specific artifact evidence/,
  );
});

test('live CAP config is bound to the signed artifact selectors, checksum, version and seams', () => {
  const config = ClaudeReferenceSubscriptionE2eConfigSchema.parse({
    schemaVersion: 1,
    repoId: '55555555-5555-4555-8555-555555555555',
    environments: [
      {
        providerSeam: 'aio',
        cliArtifactChecksum: CHECKSUM,
        selectors: SELECTORS,
      },
      {
        providerSeam: 'boxlite',
        sandboxEnvironmentId: null,
        cliArtifactChecksum: CHECKSUM,
        selectors: SELECTORS,
      },
    ],
  });
  const artifactEvidence = signedArtifactEvidence();
  const bindings = bindClaudeReferenceConfigToArtifactEvidence(
    config,
    artifactEvidence,
  );

  assert.deepEqual(
    bindings.map(({ environmentIndex, cliVersion, cliArtifactChecksum }) => ({
      environmentIndex,
      cliVersion,
      cliArtifactChecksum,
    })),
    [
      {
        environmentIndex: 0,
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
      },
      {
        environmentIndex: 1,
        cliVersion: '2.1.207',
        cliArtifactChecksum: CHECKSUM,
      },
    ],
  );
  assert.ok(
    bindings.every(
      (binding) =>
        binding.artifactEvidenceChecksum ===
        artifactEvidence.evidenceChecksum,
    ),
  );

  const mismatched = structuredClone(config);
  mismatched.environments[0].selectors[0].displayName = 'Unreviewed label';
  assert.throws(
    () =>
      bindClaudeReferenceConfigToArtifactEvidence(
        mismatched,
        artifactEvidence,
      ),
    /do not match signed artifact evidence/,
  );
});

test('signed evidence is strict, secret-free, and tamper-evident', () => {
  const signed = signClaudeReferenceSubscriptionEvidence(payload());
  assert.match(signed.evidenceChecksum, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(parseClaudeReferenceSubscriptionEvidence(signed), signed);
  assert.throws(() =>
    parseClaudeReferenceSubscriptionEvidence({
      ...signed,
      generatedAt: '2026-07-14T03:00:00.000Z',
    }),
  );
  assert.throws(() =>
    signClaudeReferenceSubscriptionEvidence({
      ...payload(),
      oauthToken: 'must-never-be-persisted',
    }),
  );
});

test('promotion covers every selector per checksum and representative provider seam', () => {
  const artifactEvidence = signedArtifactEvidence();
  const evidence = signClaudeReferenceSubscriptionEvidence(
    payload(artifactEvidence.evidenceChecksum),
  );
  const manifest = promoteClaudeReferenceSubscriptionEvidence(
    evidence,
    artifactEvidence,
  );

  assert.deepEqual(manifest.cliPins, ['2.1.207']);
  assert.equal(manifest.artifacts.length, 1);
  assert.equal(manifest.artifacts[0]?.evidenceChecksum, evidence.evidenceChecksum);
  assert.equal(
    manifest.artifacts[0]?.verificationRef,
    `evidence:${evidence.evidenceChecksum}`,
  );
  assert.equal(
    manifest.artifacts[0]?.verifiedAt,
    '2026-07-14T02:00:00.000Z',
  );
  assert.deepEqual(
    manifest.artifacts[0]?.selectors.map((selector) => ({
      id: selector.id,
      providerSeams: selector.providerSeams,
    })),
    [
      { id: SELECTORS[0].id, providerSeams: ['aio', 'boxlite'] },
      { id: SELECTORS[1].id, providerSeams: ['aio', 'boxlite'] },
    ],
  );

  assert.throws(
    () =>
      promoteClaudeReferenceSubscriptionEvidence(
        signClaudeReferenceSubscriptionEvidence(
          payload(`sha256:${'0'.repeat(64)}`),
        ),
        artifactEvidence,
      ),
    /does not match its artifact evidence checksum/,
  );

  const relabeled = payload(artifactEvidence.evidenceChecksum);
  relabeled.catalogs = relabeled.catalogs.map((catalog) => ({
    ...catalog,
    selectors: catalog.selectors.map((selector) => ({
      ...selector,
      displayName: `${selector.displayName} unreviewed`,
    })),
  }));
  assert.throws(
    () =>
      promoteClaudeReferenceSubscriptionEvidence(
        signClaudeReferenceSubscriptionEvidence(relabeled),
        artifactEvidence,
      ),
    /capabilities do not match signed artifact evidence/,
  );
});

test('promotion refuses an untested selector or an unexercised provider seam', () => {
  const artifactEvidence = signedArtifactEvidence();
  const missingSelector = payload();
  missingSelector.runs = missingSelector.runs.filter(
    (item) => item.selector !== SELECTORS[1].id,
  );
  assert.throws(
    () =>
      promoteClaudeReferenceSubscriptionEvidence(
        signClaudeReferenceSubscriptionEvidence(missingSelector),
        artifactEvidence,
      ),
    /lacks artifact launch evidence/,
  );

  const missingSeam = payload();
  missingSeam.runs = missingSeam.runs.filter(
    (item) => item.providerSeam !== 'boxlite',
  );
  assert.throws(
    () =>
      promoteClaudeReferenceSubscriptionEvidence(
        signClaudeReferenceSubscriptionEvidence(missingSeam),
        artifactEvidence,
      ),
    /provider seam lacks a live smoke/,
  );
});
