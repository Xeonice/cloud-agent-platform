import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
  TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES,
  TaskProvisioningDiagnosticsDeploymentAttestationSchema,
  TaskProvisioningDiagnosticsGateResultSchema,
  TaskProvisioningDiagnosticsUnavailableErrorSchema,
  evaluateTaskProvisioningDiagnosticsGate,
} = require(path.join(here, '..', 'dist', 'index.js'));

const NOW = new Date('2026-07-18T00:00:00.000Z');

function attestation() {
  const report = (instanceId, role) => ({
    schemaVersion: 1,
    instanceId,
    role,
    buildIdentity: 'cap-v0.40.0',
    capabilities: [...TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES],
    ready: true,
    reportedAt: '2026-07-17T23:58:00.000Z',
  });
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-task-diagnostics',
    expectedWorkers: [
      { instanceId: 'cap-api', roles: ['api', 'mcp'] },
      { instanceId: 'cap-web', roles: ['web'] },
    ],
    reports: [
      report('cap-api', 'api'),
      report('cap-api', 'mcp'),
      report('cap-web', 'web'),
    ],
    attestedAt: '2026-07-17T23:59:00.000Z',
    expiresAt: '2026-07-18T00:05:00.000Z',
  };
}

test('provisioning diagnostics gate is default closed with a stable retryable error', () => {
  const result = evaluateTaskProvisioningDiagnosticsGate({}, NOW);
  assert.deepEqual(result, {
    capability: TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
    open: false,
    reason: 'disabled',
    missingRoles: [],
    error: {
      code: 'task_provisioning_diagnostics_unavailable',
      message: 'Task provisioning diagnostics are temporarily unavailable.',
      retryable: true,
    },
  });
  assert.doesNotThrow(() =>
    TaskProvisioningDiagnosticsGateResultSchema.parse(result),
  );
  assert.doesNotThrow(() =>
    TaskProvisioningDiagnosticsUnavailableErrorSchema.parse(result.error),
  );
  assert.equal(
    evaluateTaskProvisioningDiagnosticsGate({ enabled: true }, NOW).reason,
    'deployment_attestation_missing',
  );
});

test('an invalid evaluation clock fails closed before any rollout state', () => {
  const invalidNow = new Date(Number.NaN);
  for (const input of [
    {},
    { enabled: true, attestation: attestation() },
  ]) {
    const result = evaluateTaskProvisioningDiagnosticsGate(input, invalidNow);
    assert.equal(result.open, false);
    assert.equal(result.reason, 'deployment_attestation_invalid');
    assert.doesNotThrow(() =>
      TaskProvisioningDiagnosticsGateResultSchema.parse(result),
    );
  }
});

test('only exact complete api/mcp/web membership on one build opens the gate', () => {
  const result = evaluateTaskProvisioningDiagnosticsGate(
    { enabled: true, attestation: attestation() },
    NOW,
  );
  assert.deepEqual(result, {
    capability: TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
    open: true,
    verifiedRoles: ['api', 'mcp', 'web'],
  });
  assert.doesNotThrow(() =>
    TaskProvisioningDiagnosticsGateResultSchema.parse(result),
  );
  for (const ambiguousRoles of [
    ['api', 'mcp', 'mcp'],
    ['web', 'mcp', 'api'],
  ]) {
    assert.equal(
      TaskProvisioningDiagnosticsGateResultSchema.safeParse({
        capability: TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
        open: true,
        verifiedRoles: ambiguousRoles,
      }).success,
      false,
    );
  }

  const incompleteMembership = attestation();
  incompleteMembership.expectedWorkers.pop();
  incompleteMembership.reports.pop();
  assert.deepEqual(
    evaluateTaskProvisioningDiagnosticsGate(
      { enabled: true, attestation: incompleteMembership },
      NOW,
    ),
    {
      capability: TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY,
      open: false,
      reason: 'role_report_missing',
      missingRoles: ['web'],
      error: {
        code: 'task_provisioning_diagnostics_unavailable',
        message: 'Task provisioning diagnostics are temporarily unavailable.',
        retryable: true,
      },
    },
  );

  const missingExpectedReport = attestation();
  missingExpectedReport.reports = missingExpectedReport.reports.filter(
    ({ role }) => role !== 'mcp',
  );
  const missing = evaluateTaskProvisioningDiagnosticsGate(
    { enabled: true, attestation: missingExpectedReport },
    NOW,
  );
  assert.equal(missing.reason, 'role_report_missing');
  assert.deepEqual(missing.missingRoles, ['mcp']);
});

test('every expected role must advertise every required compatibility fact', () => {
  assert.deepEqual(TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES, [
    'task-provisioning-diagnostics-schema-v1',
    'task-provisioning-diagnostics-owner-required-v1',
    'task-provisioning-diagnostics-scope-parser-v1',
    'task-provisioning-diagnostics-registry-v1',
    'task-provisioning-diagnostics-wire-fixture-v1',
  ]);

  for (const capability of TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES) {
    const value = attestation();
    value.reports[2].capabilities = value.reports[2].capabilities.filter(
      (candidate) => candidate !== capability,
    );
    const result = evaluateTaskProvisioningDiagnosticsGate(
      { enabled: true, attestation: value },
      NOW,
    );
    assert.equal(result.reason, 'role_capability_missing', capability);
    assert.deepEqual(result.missingRoles, ['web'], capability);
  }
});

test('unexpected reports, mixed builds, readiness, and expiry fail closed', () => {
  const unexpected = attestation();
  unexpected.reports.push({
    ...unexpected.reports[0],
    instanceId: 'cap-undeclared',
  });
  assert.equal(
    evaluateTaskProvisioningDiagnosticsGate(
      { enabled: true, attestation: unexpected },
      NOW,
    ).reason,
    'role_report_unexpected',
  );

  const mixed = attestation();
  mixed.reports[2].buildIdentity = 'cap-v0.39.0';
  assert.equal(
    evaluateTaskProvisioningDiagnosticsGate(
      { enabled: true, attestation: mixed },
      NOW,
    ).reason,
    'mixed_build_identity',
  );

  const notReady = attestation();
  notReady.reports[1].ready = false;
  assert.equal(
    evaluateTaskProvisioningDiagnosticsGate(
      { enabled: true, attestation: notReady },
      NOW,
    ).reason,
    'role_not_ready',
  );

  assert.equal(
    evaluateTaskProvisioningDiagnosticsGate(
      { enabled: true, attestation: attestation() },
      new Date('2026-07-18T00:05:00.000Z'),
    ).reason,
    'deployment_attestation_expired',
  );
});

test('structurally ambiguous membership and reports are rejected', () => {
  const invalidValues = [];

  const duplicateRole = attestation();
  duplicateRole.expectedWorkers[0].roles = ['api', 'api'];
  invalidValues.push(duplicateRole);

  const duplicateWorker = attestation();
  duplicateWorker.expectedWorkers.push({
    instanceId: 'cap-api',
    roles: ['web'],
  });
  invalidValues.push(duplicateWorker);

  const duplicateReport = attestation();
  duplicateReport.reports.push({ ...duplicateReport.reports[0] });
  invalidValues.push(duplicateReport);

  const duplicateCapability = attestation();
  duplicateCapability.reports[0].capabilities.push(
    duplicateCapability.reports[0].capabilities[0],
  );
  invalidValues.push(duplicateCapability);

  const postdatedReport = attestation();
  postdatedReport.reports[0].reportedAt = '2026-07-18T00:00:00.000Z';
  invalidValues.push(postdatedReport);

  for (const value of invalidValues) {
    assert.equal(
      TaskProvisioningDiagnosticsDeploymentAttestationSchema.safeParse(value)
        .success,
      false,
    );
    assert.equal(
      evaluateTaskProvisioningDiagnosticsGate(
        { enabled: true, attestation: value },
        NOW,
      ).reason,
      'deployment_attestation_invalid',
    );
  }
});
