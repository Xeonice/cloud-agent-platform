import assert from 'node:assert/strict';
import test from 'node:test';

import { ServiceUnavailableException } from '@nestjs/common';
import {
  TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES,
  type TaskProvisioningDiagnosticsDeploymentAttestation,
} from '@cap/contracts';

import {
  TASK_PROVISIONING_DIAGNOSTICS_ATTESTATION_ENV,
  TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED_ENV,
  TaskProvisioningDiagnosticsCapabilityService,
  evaluateTaskProvisioningDiagnosticsEnvironment,
} from './task-provisioning-diagnostics-capability.service';

const NOW = new Date('2026-07-18T08:10:00.000Z');
const INSTANCE_ID = 'diagnostics-api-1';
const WEB_INSTANCE_ID = 'diagnostics-web-1';
const BUILD_IDENTITY = 'build-5-3';

function completeAttestation(): TaskProvisioningDiagnosticsDeploymentAttestation {
  const capabilities = [
    ...TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES,
  ];
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-1',
    expectedWorkers: [
      { instanceId: INSTANCE_ID, roles: ['api', 'mcp'] },
      { instanceId: WEB_INSTANCE_ID, roles: ['web'] },
    ],
    reports: [
      {
        schemaVersion: 1,
        instanceId: INSTANCE_ID,
        role: 'api',
        buildIdentity: BUILD_IDENTITY,
        capabilities,
        ready: true,
        reportedAt: '2026-07-18T08:00:00.000Z',
      },
      {
        schemaVersion: 1,
        instanceId: INSTANCE_ID,
        role: 'mcp',
        buildIdentity: BUILD_IDENTITY,
        capabilities,
        ready: true,
        reportedAt: '2026-07-18T08:00:00.000Z',
      },
      {
        schemaVersion: 1,
        instanceId: WEB_INSTANCE_ID,
        role: 'web',
        buildIdentity: BUILD_IDENTITY,
        capabilities,
        ready: true,
        reportedAt: '2026-07-18T08:00:00.000Z',
      },
    ],
    attestedAt: '2026-07-18T08:05:00.000Z',
    expiresAt: '2099-07-18T09:05:00.000Z',
  };
}

function gateEnv(
  attestation: TaskProvisioningDiagnosticsDeploymentAttestation,
): NodeJS.ProcessEnv {
  return {
    [TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED_ENV]: 'true',
    [TASK_PROVISIONING_DIAGNOSTICS_ATTESTATION_ENV]:
      JSON.stringify(attestation),
  };
}

function withProcessEnvironment<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => T,
): T {
  const keys = [
    TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED_ENV,
    TASK_PROVISIONING_DIAGNOSTICS_ATTESTATION_ENV,
    'CAP_INSTANCE_ID',
    'GIT_SHA',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('diagnostics read/grant gate is default-closed while ordinary scopes bypass it', () => {
  withProcessEnvironment({}, () => {
    const service = new TaskProvisioningDiagnosticsCapabilityService();
    assert.deepEqual(service.evaluate(NOW), {
      capability: 'task-provisioning-diagnostics',
      open: false,
      reason: 'disabled',
      missingRoles: [],
      error: {
        code: 'task_provisioning_diagnostics_unavailable',
        message: 'Task provisioning diagnostics are temporarily unavailable.',
        retryable: true,
      },
    });
    assert.doesNotThrow(() => service.assertScopesGrantable(['tasks:read']));
    for (const run of [
      () => service.assertReadOpen(),
      () => service.assertScopesGrantable(['tasks:diagnostics']),
    ]) {
      assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof ServiceUnavailableException);
        assert.deepEqual(error.getResponse(), {
          code: 'task_provisioning_diagnostics_unavailable',
          message: 'Task provisioning diagnostics are temporarily unavailable.',
          retryable: true,
        });
        return true;
      });
    }
  });
});

test('pure deployment evaluation requires complete ready same-build API/MCP/Web evidence', () => {
  const valid = completeAttestation();
  assert.deepEqual(evaluateTaskProvisioningDiagnosticsEnvironment(gateEnv(valid), NOW), {
    capability: 'task-provisioning-diagnostics',
    open: true,
    verifiedRoles: ['api', 'mcp', 'web'],
  });

  const cases: ReadonlyArray<{
    name: string;
    mutate: (
      value: TaskProvisioningDiagnosticsDeploymentAttestation,
    ) => void;
    reason: string;
  }> = [
    {
      name: 'missing web role',
      mutate: (value) => {
        value.expectedWorkers = value.expectedWorkers.filter(
          (worker) => worker.instanceId !== WEB_INSTANCE_ID,
        );
        value.reports = value.reports.filter(
          (report) => report.instanceId !== WEB_INSTANCE_ID,
        );
      },
      reason: 'role_report_missing',
    },
    {
      name: 'missing capability',
      mutate: (value) => {
        value.reports[2]!.capabilities = value.reports[2]!.capabilities.slice(
          0,
          -1,
        );
      },
      reason: 'role_capability_missing',
    },
    {
      name: 'not ready',
      mutate: (value) => {
        value.reports[1]!.ready = false;
      },
      reason: 'role_not_ready',
    },
    {
      name: 'mixed build',
      mutate: (value) => {
        value.reports[2]!.buildIdentity = 'other-build';
      },
      reason: 'mixed_build_identity',
    },
  ];

  for (const testCase of cases) {
    const attestation = structuredClone(valid);
    testCase.mutate(attestation);
    const result = evaluateTaskProvisioningDiagnosticsEnvironment(
      gateEnv(attestation),
      NOW,
    );
    assert.equal(result.open, false, testCase.name);
    assert.equal(!result.open && result.reason, testCase.reason, testCase.name);
  }
});

test('invalid, missing, and expired attestation inputs stay closed', () => {
  assert.equal(
    evaluateTaskProvisioningDiagnosticsEnvironment(
      { [TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED_ENV]: 'true' },
      NOW,
    ).open,
    false,
  );
  const invalid = evaluateTaskProvisioningDiagnosticsEnvironment(
    {
      [TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED_ENV]: 'true',
      [TASK_PROVISIONING_DIAGNOSTICS_ATTESTATION_ENV]: '{secret-invalid-json',
    },
    NOW,
  );
  assert.equal(!invalid.open && invalid.reason, 'deployment_attestation_invalid');

  const expired = completeAttestation();
  expired.reports.forEach((report) => {
    report.reportedAt = '2025-07-18T08:00:00.000Z';
  });
  expired.attestedAt = '2025-07-18T08:05:00.000Z';
  expired.expiresAt = '2025-07-18T09:05:00.000Z';
  const expiredResult = evaluateTaskProvisioningDiagnosticsEnvironment(
    gateEnv(expired),
    NOW,
  );
  assert.equal(
    !expiredResult.open && expiredResult.reason,
    'deployment_attestation_expired',
  );
});

test('5.3 local API/MCP evidence opens only with the complete external Web attestation', () => {
  const wallClock = new Date();
  const attestation = completeAttestation();
  const reportedAt = new Date(wallClock.getTime() - 120_000).toISOString();
  for (const report of attestation.reports) report.reportedAt = reportedAt;
  attestation.attestedAt = new Date(
    wallClock.getTime() - 60_000,
  ).toISOString();
  attestation.expiresAt = new Date(
    wallClock.getTime() + 300_000,
  ).toISOString();
  withProcessEnvironment(
    {
      ...gateEnv(attestation),
      CAP_INSTANCE_ID: INSTANCE_ID,
      GIT_SHA: BUILD_IDENTITY,
    },
    () => {
      const service = new TaskProvisioningDiagnosticsCapabilityService();
      const reports = service.localRoleReports(wallClock);
      assert.deepEqual(
        reports.map((report) => report.role),
        ['api', 'mcp'],
      );
      assert.deepEqual(reports[0]?.capabilities, [
        ...TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES,
      ]);
      assert.deepEqual(reports[1]?.capabilities, [
        ...TASK_PROVISIONING_DIAGNOSTICS_REQUIRED_CAPABILITIES,
      ]);
      assert.equal(reports[0]?.ready, true);
      assert.equal(reports[1]?.ready, true);
      assert.equal(reports.some((report) => report.role === 'web'), false);

      const result = service.evaluate(wallClock);
      assert.deepEqual(result, {
        capability: 'task-provisioning-diagnostics',
        open: true,
        verifiedRoles: ['api', 'mcp', 'web'],
      });
      assert.doesNotThrow(() => service.assertReadOpen());
      assert.doesNotThrow(() =>
        service.assertScopesGrantable(['tasks:diagnostics']),
      );
    },
  );
});
