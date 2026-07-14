import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runRealCredentialE2e } from './task-model-real-credential-e2e.mjs';
import { runClaudeArtifactEvidence } from './claude-model-artifact-evidence.mjs';
import { verifyTaskModelEvidence } from './task-model-evidence-offline.mjs';
import {
  canonicalEvidenceJson,
  parseClaudeArtifactCompatibilityEvidence,
  parseClaudeReferenceSubscriptionEvidence,
  promoteClaudeArtifactCompatibilityEvidence,
  promoteClaudeReferenceSubscriptionEvidence,
  signClaudeArtifactCompatibilityEvidence,
  signClaudeReferenceSubscriptionEvidence,
} from '../dist/runtime-models/claude-model-capability-evidence.js';
import { ClaudeModelCapabilityManifestSchema } from '../dist/runtime-models/claude-model-capability-manifest.js';

const checksum = (character) => `sha256:${character.repeat(64)}`;

function fixtureEvidence() {
  const selector = {
    id: 'sonnet',
    displayName: 'Sonnet',
    provenance: 'https://code.claude.com/docs/en/model-config',
  };
  const cliVersion = '2.1.207';
  const cliArtifactChecksum = checksum('c');
  const artifactEvidence = signClaudeArtifactCompatibilityEvidence({
    schemaVersion: 1,
    kind: 'claude-artifact-reference-subscription-e2e',
    gate: 'explicit-operator-opt-in',
    gatedReferenceSubscription: true,
    entitlementClaim: 'cli-compatibility-only',
    generatedAt: '2026-07-14T08:00:00.000Z',
    selectors: [selector],
    images: [
      {
        providerSeam: 'aio',
        imageIdentity: checksum('a'),
        cliVersion,
        cliArtifactChecksum,
      },
      {
        providerSeam: 'boxlite',
        imageIdentity: checksum('b'),
        cliVersion,
        cliArtifactChecksum,
      },
    ],
    runs: [
      {
        providerSeam: 'aio',
        imageIdentity: checksum('a'),
        cliVersion,
        cliArtifactChecksum,
        selector: selector.id,
        requestedModel: selector.id,
        actualModel: 'claude-sonnet-fixture',
        requestedVsActual: 'different',
        structuredOutput: 'claude-stream-json',
        result: 'success',
        resultDigest: checksum('d'),
        completedAt: '2026-07-14T08:01:00.000Z',
      },
      {
        providerSeam: 'boxlite',
        imageIdentity: checksum('b'),
        cliVersion,
        cliArtifactChecksum,
        selector: selector.id,
        requestedModel: selector.id,
        actualModel: null,
        requestedVsActual: 'unknown',
        structuredOutput: 'claude-stream-json',
        result: 'success',
        resultDigest: checksum('e'),
        completedAt: '2026-07-14T08:02:00.000Z',
      },
    ],
  });
  const artifactManifest =
    promoteClaudeArtifactCompatibilityEvidence(artifactEvidence);
  const referenceEvidence = signClaudeReferenceSubscriptionEvidence({
    schemaVersion: 1,
    kind: 'claude-reference-subscription-e2e',
    gate: 'explicit-operator-opt-in',
    gatedReferenceSubscription: true,
    entitlementClaim: 'cli-compatibility-only',
    artifactEvidenceChecksum: artifactEvidence.evidenceChecksum,
    generatedAt: '2026-07-14T09:00:00.000Z',
    catalogs: [
      {
        providerSeam: 'aio',
        sandboxEnvironmentId: null,
        environmentFingerprint: 'aio-fixture',
        cliVersion,
        cliArtifactChecksum,
        catalogRevision: 'aio-revision',
        source: 'versioned-cli-capabilities',
        completeness: 'supported-subset',
        availabilityEvidence: 'cli-version-verified',
        selectors: [selector],
      },
      {
        providerSeam: 'boxlite',
        sandboxEnvironmentId: '22222222-2222-4222-8222-222222222222',
        environmentFingerprint: 'boxlite-fixture',
        cliVersion,
        cliArtifactChecksum,
        catalogRevision: 'boxlite-revision',
        source: 'versioned-cli-capabilities',
        completeness: 'supported-subset',
        availabilityEvidence: 'cli-version-verified',
        selectors: [selector],
      },
    ],
    runs: [
      {
        providerSeam: 'aio',
        environmentFingerprint: 'aio-fixture',
        cliVersion,
        cliArtifactChecksum,
        catalogRevision: 'aio-revision',
        selector: selector.id,
        requestedModel: selector.id,
        actualModel: 'claude-sonnet-fixture',
        requestedVsActual: 'different',
        requestSurface: 'public-v1',
        executionMode: 'headless-exec',
        taskId: '11111111-1111-4111-8111-111111111111',
        taskStatus: 'completed',
        transcriptStatus: 'available',
        transcriptDigest: checksum('f'),
        completedAt: '2026-07-14T09:01:00.000Z',
      },
      {
        providerSeam: 'boxlite',
        environmentFingerprint: 'boxlite-fixture',
        cliVersion,
        cliArtifactChecksum,
        catalogRevision: 'boxlite-revision',
        selector: selector.id,
        requestedModel: selector.id,
        actualModel: null,
        requestedVsActual: 'unknown',
        requestSurface: 'public-v1',
        executionMode: 'headless-exec',
        taskId: '33333333-3333-4333-8333-333333333333',
        taskStatus: 'completed',
        transcriptStatus: 'available',
        transcriptDigest: checksum('1'),
        completedAt: '2026-07-14T09:02:00.000Z',
      },
    ],
  });
  const finalManifest = promoteClaudeReferenceSubscriptionEvidence(
    referenceEvidence,
    artifactEvidence,
  );
  return {
    artifactEvidence,
    artifactManifest,
    referenceEvidence,
    finalManifest,
  };
}

const productionEvidenceApi = (checkedManifest) => ({
  canonicalEvidenceJson,
  parseClaudeArtifactCompatibilityEvidence,
  parseClaudeReferenceSubscriptionEvidence,
  promoteClaudeArtifactCompatibilityEvidence,
  promoteClaudeReferenceSubscriptionEvidence,
  manifestSchema: ClaudeModelCapabilityManifestSchema,
  checkedManifest,
});

test('real-credential runner refuses to inspect config, network, or credentials without the explicit gate', async () => {
  const key = 'CAP_TASK_MODEL_REAL_CREDENTIAL_E2E';
  const previous = process.env[key];
  const previousFetch = globalThis.fetch;
  delete process.env[key];
  globalThis.fetch = async () => {
    throw new Error('network must not be reached');
  };
  try {
    await assert.rejects(
      runRealCredentialE2e(),
      /Refusing real-credential E2E/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('raw Claude artifact runner has the same explicit credential gate', async () => {
  const key = 'CAP_TASK_MODEL_REAL_CREDENTIAL_E2E';
  const previous = process.env[key];
  delete process.env[key];
  try {
    await assert.rejects(
      runClaudeArtifactEvidence(),
      /Refusing real-credential E2E/,
    );
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('offline verifier checks Phase1/Phase2 evidence and exact checked-manifest parity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cap-task-model-evidence-'));
  try {
    const fixture = fixtureEvidence();
    const paths = {
      artifactEvidence: join(directory, 'artifact-evidence.json'),
      artifactManifest: join(directory, 'artifact-manifest.json'),
      referenceEvidence: join(directory, 'reference-evidence.json'),
      finalManifest: join(directory, 'final-manifest.json'),
    };
    await Promise.all(
      Object.entries({
        [paths.artifactEvidence]: fixture.artifactEvidence,
        [paths.artifactManifest]: fixture.artifactManifest,
        [paths.referenceEvidence]: fixture.referenceEvidence,
        [paths.finalManifest]: fixture.finalManifest,
      }).map(([path, value]) =>
        writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        }),
      ),
    );
    const env = {
      TASK_MODEL_CLAUDE_ARTIFACT_EVIDENCE: paths.artifactEvidence,
      TASK_MODEL_CLAUDE_ARTIFACT_MANIFEST: paths.artifactManifest,
      TASK_MODEL_REAL_CREDENTIAL_EVIDENCE: paths.referenceEvidence,
      TASK_MODEL_REAL_CREDENTIAL_MANIFEST: paths.finalManifest,
    };

    const result = await verifyTaskModelEvidence({
      env,
      repoRoot: directory,
      production: productionEvidenceApi(fixture.finalManifest),
    });
    assert.equal(
      result.artifactEvidenceChecksum,
      fixture.artifactEvidence.evidenceChecksum,
    );
    assert.equal(
      result.referenceEvidenceChecksum,
      fixture.referenceEvidence.evidenceChecksum,
    );
    assert.equal(result.artifactCount, 1);
    assert.equal(result.selectorCount, 1);

    await assert.rejects(
      verifyTaskModelEvidence({
        env,
        repoRoot: directory,
        production: productionEvidenceApi(fixture.artifactManifest),
      }),
      /checked Claude manifest must exactly match/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
