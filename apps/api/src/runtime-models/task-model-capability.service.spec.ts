import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TASK_MODEL_SELECTION_CAPABILITY,
  type TaskModelSelectionDeploymentAttestation,
} from '@cap/contracts';
import { RuntimeModelPreflightError } from './runtime-model-preflight.error';
import {
  TASK_MODEL_SELECTION_ATTESTATION_ENV,
  TASK_MODEL_SELECTION_ENABLED_ENV,
  TaskModelCapabilityService,
} from './task-model-capability.service';

function attestation(): TaskModelSelectionDeploymentAttestation {
  const roles = ['api', 'admission', 'scheduler', 'runtime'] as const;
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-test',
    expectedWorkers: [{ instanceId: 'worker-all', roles: [...roles] }],
    reports: roles.map((role) => ({
      schemaVersion: 1,
      instanceId: 'worker-all',
      role,
      buildIdentity: 'cap-test',
      capabilities: [TASK_MODEL_SELECTION_CAPABILITY],
      ready: true,
      reportedAt: '2026-07-14T00:00:00.000Z',
    })),
    databaseMigrationComplete: true,
    writeIngressClosedDuringCutover: true,
    mcpWritersDisabledDuringCutover: true,
    legacyWorkersRemoved: true,
    compatibilityChecksPassed: true,
    attestedAt: '2026-07-14T00:00:00.000Z',
    expiresAt: '2026-07-15T00:00:00.000Z',
  };
}

async function withGateEnv(
  values: Record<string, string | undefined>,
  run: () => void | Promise<void>,
) {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('deployment model gate is default closed and malformed input fails closed', async () => {
  await withGateEnv(
    {
      [TASK_MODEL_SELECTION_ENABLED_ENV]: undefined,
      [TASK_MODEL_SELECTION_ATTESTATION_ENV]: undefined,
    },
    () => {
      const service = new TaskModelCapabilityService();
      assert.equal(service.evaluate().open, false);
      assert.throws(() => service.assertOpen(), RuntimeModelPreflightError);
    },
  );
  await withGateEnv(
    {
      [TASK_MODEL_SELECTION_ENABLED_ENV]: 'true',
      [TASK_MODEL_SELECTION_ATTESTATION_ENV]: '{not-json',
    },
    () => {
      const service = new TaskModelCapabilityService();
      const result = service.evaluate();
      assert.equal(result.open, false);
      if (!result.open) {
        assert.equal(result.reason, 'deployment_attestation_invalid');
      }
    },
  );
});

test('only a complete unexpired operator attestation opens the gate', async () => {
  await withGateEnv(
    {
      [TASK_MODEL_SELECTION_ENABLED_ENV]: '1',
      [TASK_MODEL_SELECTION_ATTESTATION_ENV]: JSON.stringify(attestation()),
      CAP_INSTANCE_ID: 'worker-all',
      GIT_SHA: 'cap-test',
    },
    () => {
      const service = new TaskModelCapabilityService();
      const result = service.evaluate(new Date('2026-07-14T12:00:00.000Z'));
      assert.equal(result.open, true);
      service.assertOpen(new Date('2026-07-14T12:00:00.000Z'));
      assert.equal(
        service.localRoleReports(new Date('2026-07-14T12:00:00.000Z')).length,
        4,
      );
    },
  );
});
