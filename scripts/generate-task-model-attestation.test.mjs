import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TASK_MODEL_ATTESTATION_INSTANCE_ID,
  TASK_MODEL_ATTESTATION_ROLES,
  TASK_MODEL_ATTESTATION_VALIDITY_MS,
  TASK_MODEL_SELECTION_CAPABILITY,
  attestationAssetName,
  attestationChecksumAssetName,
  buildAttestation,
  validateAttestation,
  writeAttestationAsset,
} from './generate-task-model-attestation.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatorScript = join(repoRoot, 'scripts', 'generate-task-model-attestation.mjs');
const contractsDistModule = join(
  repoRoot,
  'packages/contracts/dist/task-model-capability.js',
);

const version = 'v9.9.9';
const gitSha = 'a'.repeat(40);
const now = new Date('2026-07-21T00:00:00.000Z');

// The generator validates against the REAL contracts schema; build it when the
// dist output is absent (CI runs this after `pnpm turbo build`, so this is a
// no-op there).
if (!existsSync(contractsDistModule)) {
  const build = spawnSync('pnpm', ['--filter', '@cap/contracts', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  assert.equal(build.status, 0, 'could not build @cap/contracts for schema validation');
}
const contracts = await import(new URL(contractsDistModule, 'file://').href);

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-task-model-attestation-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('asset names follow the release naming discipline', () => {
  assert.equal(attestationAssetName(version), `cap-task-model-attestation-${version}.json`);
  assert.equal(
    attestationChecksumAssetName(version),
    `cap-task-model-attestation-${version}.json.sha256`,
  );
  assert.throws(() => attestationAssetName('1.2.3'), /v-prefixed semver/);
});

test('built attestation is the codified single-instance shape and validates against the unchanged contracts schema', async () => {
  const attestation = buildAttestation({ version, gitSha, compatVerified: true, now });
  const parsed =
    contracts.TaskModelSelectionDeploymentAttestationSchema.parse(attestation);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.expectedWorkers.length, 1);
  assert.equal(parsed.expectedWorkers[0].instanceId, TASK_MODEL_ATTESTATION_INSTANCE_ID);
  assert.deepEqual(parsed.expectedWorkers[0].roles, [...TASK_MODEL_ATTESTATION_ROLES]);
  assert.equal(parsed.reports.length, 4);
  assert.deepEqual(
    parsed.reports.map((report) => report.role).sort(),
    ['admission', 'api', 'runtime', 'scheduler'],
  );
  for (const report of parsed.reports) {
    assert.equal(report.instanceId, TASK_MODEL_ATTESTATION_INSTANCE_ID);
    assert.equal(report.ready, true);
    assert.deepEqual(report.capabilities, [TASK_MODEL_SELECTION_CAPABILITY]);
    assert.equal(report.reportedAt, now.toISOString());
  }
  assert.equal(parsed.attestedAt, now.toISOString());
  assert.equal(
    Date.parse(parsed.expiresAt) - Date.parse(parsed.attestedAt),
    TASK_MODEL_ATTESTATION_VALIDITY_MS,
  );
  // The gate itself must open for the generated document.
  const gate = contracts.evaluateTaskModelSelectionGate(
    { enabled: true, attestation: parsed },
    now,
  );
  assert.equal(gate.open, true);
  assert.deepEqual(gate.verifiedRoles, ['api', 'admission', 'scheduler', 'runtime']);
  // validateAttestation performs the same schema+gate proof internally.
  await validateAttestation(attestation);
});

test('buildIdentity binds every report to the exact input GIT_SHA', () => {
  const attestation = buildAttestation({ version, gitSha, compatVerified: true, now });
  for (const report of attestation.reports) {
    assert.equal(report.buildIdentity, gitSha);
  }
  // Not a full 40-hex image build-arg value -> refused, so a drifting SHA
  // context (short sha, "unknown", branch name) can never become the identity.
  for (const bad of ['abc123', 'unknown', `${'a'.repeat(39)}Z`, '', undefined]) {
    assert.throws(
      () => buildAttestation({ version, gitSha: bad, compatVerified: true, now }),
      /40-hex commit GIT_SHA/,
    );
  }
});

test('deployment-time booleans are the hardcoded convention, never generator inputs', () => {
  const attestation = buildAttestation({ version, gitSha, compatVerified: true, now });
  // Present as the single-instance convention required by the unchanged
  // strict schema; honesty is enforced consumer-side, not claimed from input.
  assert.equal(attestation.databaseMigrationComplete, true);
  assert.equal(attestation.writeIngressClosedDuringCutover, true);
  assert.equal(attestation.mcpWritersDisabledDuringCutover, true);
  assert.equal(attestation.legacyWorkersRemoved, true);
  // There is no input surface for them: any attempt is rejected loudly.
  for (const key of [
    'databaseMigrationComplete',
    'writeIngressClosedDuringCutover',
    'mcpWritersDisabledDuringCutover',
    'legacyWorkersRemoved',
  ]) {
    assert.throws(
      () => buildAttestation({ version, gitSha, compatVerified: true, now, [key]: false }),
      /unknown attestation option/,
    );
  }
});

test('compatibilityChecksPassed comes only from a verified-true input; anything else fails closed', () => {
  const attestation = buildAttestation({ version, gitSha, compatVerified: true, now });
  assert.equal(attestation.compatibilityChecksPassed, true);
  for (const bad of [false, undefined, 'true', 1]) {
    assert.throws(
      () => buildAttestation({ version, gitSha, compatVerified: bad, now }),
      /verified-compat input is not true/,
    );
  }
});

test('reportedAt and attestedAt are build-time stamps, never in the future', () => {
  const before = Date.now();
  const attestation = buildAttestation({ version, gitSha, compatVerified: true });
  const after = Date.now();
  for (const stamp of [attestation.attestedAt, ...attestation.reports.map((r) => r.reportedAt)]) {
    const parsed = Date.parse(stamp);
    assert.ok(parsed >= before && parsed <= after, `${stamp} must be the generation time`);
  }
  assert.ok(Date.parse(attestation.expiresAt) > Date.parse(attestation.attestedAt));
});

test('writeAttestationAsset emits the asset plus a byte-correct .sha256 companion', async () => {
  const outDir = tempDir();
  const result = await writeAttestationAsset({
    version,
    gitSha,
    compatVerified: true,
    outDir,
    now,
  });
  assert.equal(result.asset, attestationAssetName(version));
  assert.equal(result.checksumAsset, attestationChecksumAssetName(version));

  const assetPath = join(outDir, result.asset);
  const raw = readFileSync(assetPath, 'utf8');
  // Compact single-line JSON so consumers can persist verbatim content into a
  // KEY=VALUE .env entry.
  assert.match(raw, /^\{.*\}\n$/s);
  assert.equal(raw.indexOf('\n'), raw.length - 1);
  const parsed = contracts.TaskModelSelectionDeploymentAttestationSchema.parse(
    JSON.parse(raw),
  );
  assert.equal(parsed.reports[0].buildIdentity, gitSha);

  const digest = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
  assert.equal(result.sha256, digest);
  const checksumLine = readFileSync(join(outDir, result.checksumAsset), 'utf8');
  assert.equal(checksumLine, `${digest}  ${result.asset}\n`);
});

test('CLI generates a valid asset pair end to end', async () => {
  const outDir = tempDir();
  const run = spawnSync(
    process.execPath,
    [
      generatorScript,
      '--version', version,
      '--git-sha', gitSha,
      '--compat-verified', 'true',
      '--out', outDir,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), [
    attestationAssetName(version),
    attestationChecksumAssetName(version),
  ]);
  const raw = readFileSync(join(outDir, attestationAssetName(version)), 'utf8');
  contracts.TaskModelSelectionDeploymentAttestationSchema.parse(JSON.parse(raw));
  const digest = createHash('sha256')
    .update(readFileSync(join(outDir, attestationAssetName(version))))
    .digest('hex');
  assert.equal(
    readFileSync(join(outDir, attestationChecksumAssetName(version)), 'utf8'),
    `${digest}  ${attestationAssetName(version)}\n`,
  );
});

test('CLI fails closed and writes nothing when compat is unverified or flags are unknown', () => {
  const outDir = tempDir();
  const unverified = spawnSync(
    process.execPath,
    [
      generatorScript,
      '--version', version,
      '--git-sha', gitSha,
      '--compat-verified', 'false',
      '--out', outDir,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(unverified.status, 0);
  assert.match(unverified.stderr, /verified-compat input is not true/);

  const smuggled = spawnSync(
    process.execPath,
    [
      generatorScript,
      '--version', version,
      '--git-sha', gitSha,
      '--compat-verified', 'true',
      '--database-migration-complete', 'false',
      '--out', outDir,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(smuggled.status, 0);
  assert.match(smuggled.stderr, /unknown flag: --database-migration-complete/);

  assert.deepEqual(readdirSync(outDir), []);
});
