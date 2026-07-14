import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ARTIFACT_EVIDENCE_ENV = 'TASK_MODEL_CLAUDE_ARTIFACT_EVIDENCE';
const ARTIFACT_MANIFEST_ENV = 'TASK_MODEL_CLAUDE_ARTIFACT_MANIFEST';
const REFERENCE_EVIDENCE_ENV = 'TASK_MODEL_REAL_CREDENTIAL_EVIDENCE';
const FINAL_MANIFEST_ENV = 'TASK_MODEL_REAL_CREDENTIAL_MANIFEST';
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

function requiredPath(env, name, repoRoot) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for offline evidence verification.`);
  return resolve(repoRoot, value);
}

async function readBoundedJson(path, readFileImpl) {
  const raw = await readFileImpl(path);
  if (raw.byteLength > MAX_EVIDENCE_BYTES) {
    throw new Error(`Task-model evidence is oversized: ${path}`);
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error(`Task-model evidence is not valid JSON: ${path}`);
  }
}

async function loadProductionEvidenceModule(repoRoot) {
  const evidence = await import(
    pathToFileURL(
      resolve(
        repoRoot,
        'apps/api/dist/runtime-models/claude-model-capability-evidence.js',
      ),
    ).href
  );
  const manifest = await import(
    pathToFileURL(
      resolve(
        repoRoot,
        'apps/api/dist/runtime-models/claude-model-capability-manifest.js',
      ),
    ).href
  );
  return {
    ...evidence,
    manifestSchema: manifest.ClaudeModelCapabilityManifestSchema,
    checkedManifest: manifest.CHECKED_CLAUDE_MODEL_CAPABILITY_MANIFEST,
  };
}

/**
 * Verify retained live evidence without reading credentials or contacting CAP,
 * a provider, Docker, or a sandbox. The production evidence parsers/promoters
 * remain the only source of truth for coverage and checksum semantics.
 */
export async function verifyTaskModelEvidence({
  env = process.env,
  repoRoot = resolve(import.meta.dirname, '../../..'),
  readFileImpl = readFile,
  production,
} = {}) {
  const artifactEvidencePath = requiredPath(
    env,
    ARTIFACT_EVIDENCE_ENV,
    repoRoot,
  );
  const referenceEvidencePath = requiredPath(
    env,
    REFERENCE_EVIDENCE_ENV,
    repoRoot,
  );
  const finalManifestPath = requiredPath(env, FINAL_MANIFEST_ENV, repoRoot);
  const artifactManifestRaw = env[ARTIFACT_MANIFEST_ENV]?.trim();
  const artifactManifestPath = artifactManifestRaw
    ? resolve(repoRoot, artifactManifestRaw)
    : null;

  const api = production ?? (await loadProductionEvidenceModule(repoRoot));
  const artifactEvidenceInput = await readBoundedJson(
    artifactEvidencePath,
    readFileImpl,
  );
  const referenceEvidenceInput = await readBoundedJson(
    referenceEvidencePath,
    readFileImpl,
  );
  const finalManifestInput = await readBoundedJson(
    finalManifestPath,
    readFileImpl,
  );

  const artifactEvidence = api.parseClaudeArtifactCompatibilityEvidence(
    artifactEvidenceInput,
  );
  const referenceEvidence = api.parseClaudeReferenceSubscriptionEvidence(
    referenceEvidenceInput,
  );
  const promotedArtifactManifest =
    api.promoteClaudeArtifactCompatibilityEvidence(artifactEvidence);
  const promotedFinalManifest =
    api.promoteClaudeReferenceSubscriptionEvidence(
      referenceEvidence,
      artifactEvidence,
    );
  const finalManifest = api.manifestSchema.parse(finalManifestInput);
  const checkedManifest = api.manifestSchema.parse(api.checkedManifest);

  assert.equal(
    api.canonicalEvidenceJson(finalManifest),
    api.canonicalEvidenceJson(promotedFinalManifest),
    'final Claude manifest must be the exact promotion of Phase1 and Phase2 evidence',
  );
  assert.equal(
    api.canonicalEvidenceJson(checkedManifest),
    api.canonicalEvidenceJson(finalManifest),
    'checked Claude manifest must exactly match the verified final manifest',
  );

  if (artifactManifestPath) {
    const artifactManifest = api.manifestSchema.parse(
      await readBoundedJson(artifactManifestPath, readFileImpl),
    );
    assert.equal(
      api.canonicalEvidenceJson(artifactManifest),
      api.canonicalEvidenceJson(promotedArtifactManifest),
      'Phase1 artifact manifest must be the exact promotion of Phase1 evidence',
    );
  }

  return {
    artifactEvidenceChecksum: artifactEvidence.evidenceChecksum,
    referenceEvidenceChecksum: referenceEvidence.evidenceChecksum,
    artifactCount: finalManifest.artifacts.length,
    selectorCount: finalManifest.artifacts.reduce(
      (count, artifact) => count + artifact.selectors.length,
      0,
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  verifyTaskModelEvidence()
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ status: 'passed', ...result })}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `task-model-evidence: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
    });
}
