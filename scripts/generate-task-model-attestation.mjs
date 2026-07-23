#!/usr/bin/env node
// Release-time generator for the task-model-selection deployment attestation
// asset (automate-task-model-attestation-in-ci, design D1-D4).
//
// CI attests ONLY what it can witness:
//   - `buildIdentity` — the GIT_SHA build-arg baked into the released cap-api
//     image (the value `GET /version` reports as `gitSha`). Callers MUST pass
//     the exact build-arg value, never a separately-resolved SHA context.
//   - `compatibilityChecksPassed` — set exclusively from the verified-compat
//     input, which the release workflow derives from the release commit's
//     "task model N-1 compatibility" check-run conclusion. When that input is
//     anything but a verified pass, this generator FAILS instead of emitting
//     an attestation that claims compatibility passed.
//
// The four deployment-time booleans (`databaseMigrationComplete`,
// `writeIngressClosedDuringCutover`, `mcpWritersDisabledDuringCutover`,
// `legacyWorkersRemoved`) are NOT inputs and can never be set from the CLI or
// the programmatic options: they are carried as the codified single-instance
// convention whose honesty is enforced by the consumer seams (upgrade.sh /
// self-update) running local single-instance preconditions BEFORE any env
// writeback — structurally true for a stop-the-world compose upgrade of one
// `cap-api-1` instance, and never claimed as CI-witnessed facts.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeReleaseAsset, normalizeVersion } from './release-image-assets.mjs';

/** Codified single-instance convention (design D3): the sole instance id. */
export const TASK_MODEL_ATTESTATION_INSTANCE_ID = 'cap-api-1';
/** All four worker roles the single all-role instance carries. */
export const TASK_MODEL_ATTESTATION_ROLES = ['api', 'admission', 'scheduler', 'runtime'];
/** Capability the attestation opens (matches the contracts literal). */
export const TASK_MODEL_SELECTION_CAPABILITY = 'task-model-selection-v1';
/**
 * Generous validity horizon (design D2): real invalidation comes from the
 * buildIdentity match — every release invalidates old attestations and ships a
 * fresh one — so the wall clock must comfortably outlive any upgrade cadence.
 */
export const TASK_MODEL_ATTESTATION_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function attestationAssetName(version) {
  return `cap-task-model-attestation-${normalizeVersion(version)}.json`;
}

export function attestationChecksumAssetName(version) {
  return `${attestationAssetName(version)}.sha256`;
}

function normalizeGitSha(gitSha) {
  const value = String(gitSha ?? '').trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(value)) {
    throw new Error(
      `gitSha must be the full 40-hex commit GIT_SHA baked into the cap-api image, received: ${JSON.stringify(gitSha)}`,
    );
  }
  return value;
}

function assertVerifiedCompat(compatVerified) {
  if (compatVerified !== true) {
    throw new Error(
      'refusing to generate an attestation: the verified-compat input is not true. ' +
        'The release workflow must verify the release commit\'s "task model N-1 compatibility" ' +
        'check-run concluded successfully before invoking this generator.',
    );
  }
}

const ALLOWED_BUILD_OPTIONS = new Set(['version', 'gitSha', 'compatVerified', 'now']);

/**
 * Pure attestation construction. Only `compatibilityChecksPassed` is derived
 * from input (and only ever as a verified `true`); the deployment-time
 * booleans are the hardcoded single-instance convention and any attempt to
 * pass them (or any other unknown option) is rejected loudly.
 */
export function buildAttestation(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('buildAttestation requires an options object');
  }
  for (const key of Object.keys(options)) {
    if (!ALLOWED_BUILD_OPTIONS.has(key)) {
      throw new Error(
        `unknown attestation option: ${key} (deployment-time facts are not generator inputs)`,
      );
    }
  }
  const { version, gitSha, compatVerified, now = new Date() } = options;
  const tag = normalizeVersion(version);
  const buildIdentity = normalizeGitSha(gitSha);
  assertVerifiedCompat(compatVerified);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('now must be a valid Date');
  }
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TASK_MODEL_ATTESTATION_VALIDITY_MS).toISOString();
  return {
    schemaVersion: 1,
    deploymentId: `cap-single-instance-${tag}`,
    expectedWorkers: [
      {
        instanceId: TASK_MODEL_ATTESTATION_INSTANCE_ID,
        roles: [...TASK_MODEL_ATTESTATION_ROLES],
      },
    ],
    reports: TASK_MODEL_ATTESTATION_ROLES.map((role) => ({
      schemaVersion: 1,
      instanceId: TASK_MODEL_ATTESTATION_INSTANCE_ID,
      buildIdentity,
      capabilities: [TASK_MODEL_SELECTION_CAPABILITY],
      ready: true,
      reportedAt: issuedAt,
      role,
    })),
    // Single-instance convention (design D1/D3): NEVER settable from input.
    // Honesty is enforced by consumer-side local preconditions before writeback.
    databaseMigrationComplete: true,
    writeIngressClosedDuringCutover: true,
    mcpWritersDisabledDuringCutover: true,
    legacyWorkersRemoved: true,
    // The ONLY boolean derived from input, and only after assertVerifiedCompat.
    compatibilityChecksPassed: true,
    attestedAt: issuedAt,
    expiresAt,
  };
}

const CONTRACTS_SCHEMA_PATH = new URL(
  '../packages/contracts/dist/task-model-capability.js',
  import.meta.url,
);

async function loadContractsModule() {
  try {
    return await import(CONTRACTS_SCHEMA_PATH.href);
  } catch (error) {
    throw new Error(
      'could not load the contracts attestation schema from packages/contracts/dist — ' +
        'build it first (pnpm --filter @cap/contracts build): ' +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Validates a generated attestation against the UNCHANGED contracts schema
 * (packages/contracts/src/task-model-capability.ts) and proves the gate
 * actually opens for it at generation time.
 */
export async function validateAttestation(attestation) {
  const contracts = await loadContractsModule();
  const parsed = contracts.TaskModelSelectionDeploymentAttestationSchema.parse(attestation);
  const gate = contracts.evaluateTaskModelSelectionGate({ enabled: true, attestation: parsed });
  if (!gate.open) {
    throw new Error(`generated attestation does not open the gate: ${gate.reason}`);
  }
  return parsed;
}

/**
 * Builds, schema-validates, and writes the attestation asset plus its
 * `.sha256` companion into `outDir`, following the existing
 * release-image-assets naming/checksum discipline (atomic tmp+rename writes,
 * `<digest>  <asset>` checksum lines).
 */
export async function writeAttestationAsset({ version, gitSha, compatVerified, outDir, now }) {
  if (!outDir) throw new Error('outDir is required');
  const attestation = buildAttestation({
    version,
    gitSha,
    compatVerified,
    ...(now === undefined ? {} : { now }),
  });
  await validateAttestation(attestation);
  const asset = attestationAssetName(version);
  const resolvedOutDir = resolve(outDir);
  // release.yml passes a fresh `dist/...` path that no earlier step creates;
  // the v0.44.0 release run died here on ENOENT for the .captmp temp file.
  mkdirSync(resolvedOutDir, { recursive: true });
  const assetPath = join(resolvedOutDir, asset);
  const tempPath = `${assetPath}.captmp`;
  rmSync(tempPath, { force: true });
  // Compact single-line JSON: consumers write the verbatim asset content into
  // a KEY=VALUE .env entry, where a multi-line document cannot survive.
  writeFileSync(tempPath, `${JSON.stringify(attestation)}\n`, 'utf8');
  renameSync(tempPath, assetPath);
  const finalized = finalizeReleaseAsset(assetPath);
  return { ...finalized, attestation, assetPath };
}

const KNOWN_FLAGS = new Set(['version', 'git-sha', 'compat-verified', 'out', 'help']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`);
    const key = value.slice(2);
    if (!KNOWN_FLAGS.has(key)) {
      throw new Error(
        `unknown flag: --${key} (deployment-time attestation facts are not CLI inputs)`,
      );
    }
    if (key === 'help') {
      args.help = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`--${key} requires a value`);
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function usage() {
  return [
    'usage:',
    '  node scripts/generate-task-model-attestation.mjs \\',
    '    --version vX.Y.Z --git-sha <40-hex GIT_SHA build-arg> \\',
    '    --compat-verified true --out <dir>',
    '',
    'GIT_SHA may also be provided via the GIT_SHA environment variable.',
    '--compat-verified must be exactly "true" (the workflow-verified N-1',
    'compatibility check-run conclusion); anything else fails closed.',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) {
    console.log(usage());
    return;
  }
  const version = args.version;
  if (!version) throw new Error(`--version is required\n${usage()}`);
  const gitSha = args['git-sha'] ?? process.env.GIT_SHA;
  if (!gitSha) throw new Error(`--git-sha (or env GIT_SHA) is required\n${usage()}`);
  const outDir = args.out;
  if (!outDir) throw new Error(`--out is required\n${usage()}`);
  const compatVerified = args['compat-verified'];
  const result = await writeAttestationAsset({
    version,
    gitSha,
    compatVerified: compatVerified === 'true',
    outDir,
  });
  console.log(result.asset);
  console.log(result.checksumAsset);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
