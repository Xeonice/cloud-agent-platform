import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  TASK_ADMISSION_V2_CAPABILITY,
  TaskAdmissionV2DeploymentAttestationSchema,
  TaskAdmissionV2GateResultSchema,
  evaluateTaskAdmissionV2Gate,
} = require(path.join(here, '..', 'dist', 'index.js'));

const NOW = new Date('2026-07-16T00:00:00.000Z');

function attestation() {
  const roles = ['api', 'worker'];
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-admission-v2',
    expectedWorkers: [{ instanceId: 'cap-all', roles }],
    reports: roles.map((role) => ({
      schemaVersion: 1,
      instanceId: 'cap-all',
      role,
      buildIdentity: 'cap-v2.0.0',
      capabilities: [TASK_ADMISSION_V2_CAPABILITY],
      ready: true,
      reportedAt: '2026-07-15T23:59:00.000Z',
    })),
    attestedAt: '2026-07-15T23:59:30.000Z',
    expiresAt: '2026-07-16T00:05:00.000Z',
  };
}

test('admission-v2 is default closed and requires an attestation when enabled', () => {
  assert.deepEqual(evaluateTaskAdmissionV2Gate({}, NOW), {
    capability: TASK_ADMISSION_V2_CAPABILITY,
    open: false,
    reason: 'disabled',
    missingRoles: [],
  });
  assert.equal(
    evaluateTaskAdmissionV2Gate({ enabled: true }, NOW).reason,
    'deployment_attestation_missing',
  );
});

test('only complete exact api/worker membership opens admission-v2', () => {
  const result = evaluateTaskAdmissionV2Gate(
    { enabled: true, attestation: attestation() },
    NOW,
  );
  assert.deepEqual(result, {
    capability: TASK_ADMISSION_V2_CAPABILITY,
    open: true,
    verifiedRoles: ['api', 'worker'],
  });
  assert.doesNotThrow(() => TaskAdmissionV2GateResultSchema.parse(result));

  const noWorkerRole = attestation();
  noWorkerRole.expectedWorkers[0].roles = ['api'];
  noWorkerRole.reports = noWorkerRole.reports.filter(
    (report) => report.role !== 'worker',
  );
  const missingRole = evaluateTaskAdmissionV2Gate(
    { enabled: true, attestation: noWorkerRole },
    NOW,
  );
  assert.equal(missingRole.reason, 'worker_report_missing');
  assert.deepEqual(missingRole.missingRoles, ['worker']);

  const noWorkerReport = attestation();
  noWorkerReport.reports = noWorkerReport.reports.filter(
    (report) => report.role !== 'worker',
  );
  assert.equal(
    evaluateTaskAdmissionV2Gate(
      { enabled: true, attestation: noWorkerReport },
      NOW,
    ).reason,
    'worker_report_missing',
  );
});

test('mixed builds, missing capability, not-ready, and expiry fail closed', () => {
  const mixed = attestation();
  mixed.reports[1].buildIdentity = 'cap-v1.9.0';
  assert.equal(
    evaluateTaskAdmissionV2Gate({ enabled: true, attestation: mixed }, NOW).reason,
    'mixed_build_identity',
  );

  const missingCapability = attestation();
  missingCapability.reports[1].capabilities = [];
  assert.equal(
    evaluateTaskAdmissionV2Gate(
      { enabled: true, attestation: missingCapability },
      NOW,
    ).reason,
    'worker_capability_missing',
  );

  const notReady = attestation();
  notReady.reports[0].ready = false;
  assert.equal(
    evaluateTaskAdmissionV2Gate(
      { enabled: true, attestation: notReady },
      NOW,
    ).reason,
    'worker_not_ready',
  );

  assert.equal(
    evaluateTaskAdmissionV2Gate(
      { enabled: true, attestation: attestation() },
      new Date('2026-07-16T00:05:00.000Z'),
    ).reason,
    'deployment_attestation_expired',
  );
});

test('duplicate or unknown roles and duplicate membership are structurally invalid', () => {
  const invalidValues = [];

  const duplicateRole = attestation();
  duplicateRole.expectedWorkers[0].roles = ['api', 'api'];
  invalidValues.push(duplicateRole);

  const unknownRole = attestation();
  unknownRole.expectedWorkers[0].roles = ['api', 'provisioner'];
  invalidValues.push(unknownRole);

  const duplicateWorker = attestation();
  duplicateWorker.expectedWorkers.push({
    ...duplicateWorker.expectedWorkers[0],
    roles: [...duplicateWorker.expectedWorkers[0].roles],
  });
  invalidValues.push(duplicateWorker);

  const duplicateReport = attestation();
  duplicateReport.reports.push({ ...duplicateReport.reports[0] });
  invalidValues.push(duplicateReport);

  for (const value of invalidValues) {
    assert.equal(
      TaskAdmissionV2DeploymentAttestationSchema.safeParse(value).success,
      false,
    );
    assert.equal(
      evaluateTaskAdmissionV2Gate({ enabled: true, attestation: value }, NOW)
        .reason,
      'deployment_attestation_invalid',
    );
  }
});

test('a valid but undeclared instance-role report is rejected', () => {
  const value = attestation();
  value.reports.push({
    ...value.reports[0],
    instanceId: 'not-in-expected-membership',
  });
  const result = evaluateTaskAdmissionV2Gate(
    { enabled: true, attestation: value },
    NOW,
  );
  assert.equal(result.reason, 'worker_report_unexpected');
});
