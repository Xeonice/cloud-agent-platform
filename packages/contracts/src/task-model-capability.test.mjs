import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  TASK_MODEL_SELECTION_CAPABILITY,
  TaskModelSelectionGateConfigSchema,
  TaskModelSelectionGateResultSchema,
  evaluateTaskModelSelectionGate,
} = require(path.join(here, '..', 'dist', 'index.js'));

const now = new Date('2026-07-14T00:00:00.000Z');

function attestation() {
  const roles = ['api', 'admission', 'scheduler', 'runtime'];
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-1',
    expectedWorkers: roles.map((role) => ({
      instanceId: `worker-${role}`,
      roles: [role],
    })),
    reports: roles.map((role) => ({
      schemaVersion: 1,
      instanceId: `worker-${role}`,
      role,
      buildIdentity: 'cap-v1.2.3',
      capabilities: [TASK_MODEL_SELECTION_CAPABILITY],
      ready: true,
      reportedAt: '2026-07-13T23:59:00.000Z',
    })),
    databaseMigrationComplete: true,
    writeIngressClosedDuringCutover: true,
    mcpWritersDisabledDuringCutover: true,
    legacyWorkersRemoved: true,
    compatibilityChecksPassed: true,
    attestedAt: '2026-07-13T23:59:00.000Z',
    expiresAt: '2026-07-14T00:05:00.000Z',
  };
}

test('task model selection deployment gate is closed by default', () => {
  assert.equal(TaskModelSelectionGateConfigSchema.parse({}).enabled, false);
  const result = evaluateTaskModelSelectionGate({}, now);
  assert.equal(result.open, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(result.error.retryable, true);
  assert.doesNotThrow(() => TaskModelSelectionGateResultSchema.parse(result));
});

test('an enabled N gate cannot replace the mandatory N-1 maintenance cutover', () => {
  const value = attestation();
  value.legacyWorkersRemoved = false;
  const result = evaluateTaskModelSelectionGate(
    { enabled: true, attestation: value },
    now,
  );
  assert.equal(result.open, false);
  assert.equal(result.reason, 'legacy_workers_present');
});

test('every expected worker-role must report capability and readiness', () => {
  const value = attestation();
  value.reports = value.reports.filter((report) => report.role !== 'scheduler');
  const missing = evaluateTaskModelSelectionGate(
    { enabled: true, attestation: value },
    now,
  );
  assert.equal(missing.open, false);
  assert.equal(missing.reason, 'worker_report_missing');
  assert.deepEqual(missing.missingRoles, ['scheduler']);

  const incompatible = attestation();
  incompatible.reports.find((report) => report.role === 'runtime').capabilities = [];
  assert.equal(
    evaluateTaskModelSelectionGate(
      { enabled: true, attestation: incompatible },
      now,
    ).reason,
    'worker_capability_missing',
  );
});

test('a complete, unexpired four-role deployment attestation opens the gate', () => {
  const result = evaluateTaskModelSelectionGate(
    { enabled: true, attestation: attestation() },
    now,
  );
  assert.deepEqual(result, {
    capability: TASK_MODEL_SELECTION_CAPABILITY,
    open: true,
    verifiedRoles: ['api', 'admission', 'scheduler', 'runtime'],
  });
  assert.doesNotThrow(() => TaskModelSelectionGateResultSchema.parse(result));
});
