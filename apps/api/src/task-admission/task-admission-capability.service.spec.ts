import assert from 'node:assert/strict';
import test from 'node:test';

import { TASK_ADMISSION_V2_CAPABILITY } from '@cap/contracts';
import { EnvironmentTaskAdmissionGate } from '../tasks/task-admission-gate';
import { TaskAdmissionCapabilityController } from './task-admission-capability.controller';
import {
  TASK_ADMISSION_V2_ATTESTATION_ENV,
  TASK_ADMISSION_V2_ENABLED_ENV,
  TaskAdmissionCapabilityService,
  evaluateTaskAdmissionV2Environment,
} from './task-admission-capability.service';

const NOW = new Date('2026-07-16T00:00:00.000Z');

function attestation() {
  const roles = ['api', 'worker'] as const;
  return {
    schemaVersion: 1 as const,
    deploymentId: 'deployment-admission-v2',
    expectedWorkers: [{ instanceId: 'cap-all', roles: [...roles] }],
    reports: roles.map((role) => ({
      schemaVersion: 1 as const,
      instanceId: 'cap-all',
      role,
      buildIdentity: 'cap-v2.0.0',
      capabilities: [TASK_ADMISSION_V2_CAPABILITY],
      ready: true,
      reportedAt: '2026-07-14T23:59:00.000Z',
    })),
    attestedAt: '2026-07-15T23:59:30.000Z',
    expiresAt: '2099-07-16T00:05:00.000Z',
  };
}

async function withGateEnv(
  values: Record<string, string | undefined>,
  run: () => void | Promise<void>,
): Promise<void> {
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

function closedReason(
  result: ReturnType<typeof evaluateTaskAdmissionV2Environment>,
): string {
  if (result.open) throw new Error('expected admission-v2 gate to be closed');
  return result.reason;
}

test('environment evaluator is default closed and malformed/oversized JSON fails closed', () => {
  assert.equal(closedReason(evaluateTaskAdmissionV2Environment({}, NOW)), 'disabled');
  assert.equal(
    closedReason(
      evaluateTaskAdmissionV2Environment(
        { [TASK_ADMISSION_V2_ENABLED_ENV]: 'true' },
        NOW,
      ),
    ),
    'deployment_attestation_missing',
  );
  for (const raw of ['{not-json', `{"padding":"${'x'.repeat(256 * 1024)}"}`]) {
    const result = evaluateTaskAdmissionV2Environment(
      {
        [TASK_ADMISSION_V2_ENABLED_ENV]: 'true',
        [TASK_ADMISSION_V2_ATTESTATION_ENV]: raw,
      },
      NOW,
    );
    assert.equal(result.open, false);
    assert.equal(result.reason, 'deployment_attestation_invalid');
  }
});

test('environment evaluator rejects mixed builds and structurally invalid roles', () => {
  const mixed = attestation();
  mixed.reports[1].buildIdentity = 'cap-v1.9.0';
  assert.equal(
    closedReason(
      evaluateTaskAdmissionV2Environment(
        {
          [TASK_ADMISSION_V2_ENABLED_ENV]: '1',
          [TASK_ADMISSION_V2_ATTESTATION_ENV]: JSON.stringify(mixed),
        },
        NOW,
      ),
    ),
    'mixed_build_identity',
  );

  const invalid = attestation() as unknown as {
    expectedWorkers: Array<{ instanceId: string; roles: string[] }>;
  };
  invalid.expectedWorkers[0]!.roles = ['api', 'unknown-worker'];
  assert.equal(
    closedReason(
      evaluateTaskAdmissionV2Environment(
        {
          [TASK_ADMISSION_V2_ENABLED_ENV]: '1',
          [TASK_ADMISSION_V2_ATTESTATION_ENV]: JSON.stringify(invalid),
        },
        NOW,
      ),
    ),
    'deployment_attestation_invalid',
  );
});

test('EnvironmentTaskAdmissionGate opens only for full attestation plus local identity', async () => {
  await withGateEnv(
    {
      [TASK_ADMISSION_V2_ENABLED_ENV]: 'true',
      [TASK_ADMISSION_V2_ATTESTATION_ENV]: undefined,
      CAP_INSTANCE_ID: 'cap-all',
      GIT_SHA: 'cap-v2.0.0',
    },
    () => {
      const service = new TaskAdmissionCapabilityService();
      assert.equal(new EnvironmentTaskAdmissionGate(service).isEnabled(), false);
    },
  );

  await withGateEnv(
    {
      [TASK_ADMISSION_V2_ENABLED_ENV]: 'true',
      [TASK_ADMISSION_V2_ATTESTATION_ENV]: JSON.stringify(attestation()),
      CAP_INSTANCE_ID: 'cap-all',
      GIT_SHA: 'cap-v2.0.0',
    },
    () => {
      const service = new TaskAdmissionCapabilityService();
      assert.equal(service.evaluate(NOW).open, true);
      assert.equal(new EnvironmentTaskAdmissionGate(service).isEnabled(), true);
      assert.deepEqual(
        service.localRoleReports(NOW).map((report) => report.role),
        ['api', 'worker'],
      );
    },
  );
});

test('local build/membership mismatch closes the service even when global evidence passes', async () => {
  for (const values of [
    { CAP_INSTANCE_ID: 'different-instance', GIT_SHA: 'cap-v2.0.0' },
    { CAP_INSTANCE_ID: 'cap-all', GIT_SHA: 'different-build' },
  ]) {
    await withGateEnv(
      {
        [TASK_ADMISSION_V2_ENABLED_ENV]: 'true',
        [TASK_ADMISSION_V2_ATTESTATION_ENV]: JSON.stringify(attestation()),
        ...values,
      },
      () => {
        const service = new TaskAdmissionCapabilityService();
        assert.equal(service.evaluate(NOW).open, false);
      },
    );
  }
});

test('read-only capability status is schema-validated and does not expose raw attestation', async () => {
  await withGateEnv(
    {
      [TASK_ADMISSION_V2_ENABLED_ENV]: 'true',
      [TASK_ADMISSION_V2_ATTESTATION_ENV]: JSON.stringify(attestation()),
      CAP_INSTANCE_ID: 'cap-all',
      GIT_SHA: 'cap-v2.0.0',
      CAP_SECRET_CANARY: 'must-never-be-returned',
    },
    () => {
      const service = new TaskAdmissionCapabilityService();
      const status = new TaskAdmissionCapabilityController(service).status();
      assert.equal(status.capability, TASK_ADMISSION_V2_CAPABILITY);
      assert.equal(status.gate.open, true);
      assert.equal(status.localReports.length, 2);

      const serialized = JSON.stringify(status);
      for (const forbidden of [
        'expectedWorkers',
        'deployment-admission-v2',
        TASK_ADMISSION_V2_ATTESTATION_ENV,
        'must-never-be-returned',
      ]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
    },
  );
});
