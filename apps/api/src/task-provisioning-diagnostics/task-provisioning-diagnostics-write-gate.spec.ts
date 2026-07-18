import assert from 'node:assert/strict';
import test from 'node:test';

import { MODULE_METADATA } from '@nestjs/common/constants';

import {
  TASK_ADMISSION_GATE_TOKEN,
  TASK_ADMISSION_V2_ENABLED_ENV,
} from '../tasks/task-admission-gate';
import { TaskProvisioningDiagnosticsModule } from './task-provisioning-diagnostics.module';
import {
  EnvironmentTaskProvisioningDiagnosticsWriteGate,
  TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
  TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV,
  taskProvisioningDiagnosticsWritesEnabled,
  type TaskProvisioningDiagnosticsWriteGatePort,
} from './task-provisioning-diagnostics-write-gate.port';

interface ProviderBinding {
  readonly provide: unknown;
  readonly useExisting?: unknown;
}

function moduleMetadata<T>(key: string): readonly T[] {
  return (Reflect.getMetadata(key, TaskProvisioningDiagnosticsModule) ??
    []) as readonly T[];
}

function withWriteGateEnvironment<T>(
  value: string | undefined,
  run: () => T,
): T {
  const previous =
    process.env[TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV];
  try {
    if (value === undefined) {
      delete process.env[TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV];
    } else {
      process.env[TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV] = value;
    }
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV];
    } else {
      process.env[TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV] = previous;
    }
  }
}

test('diagnostic writes are default closed and invalid values fail closed', () => {
  for (const value of [
    undefined,
    '',
    '0',
    'false',
    'yes',
    'TRUE',
    ' true',
    'true ',
  ]) {
    const env: NodeJS.ProcessEnv = {};
    if (value !== undefined) {
      env[TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV] = value;
    }
    assert.equal(taskProvisioningDiagnosticsWritesEnabled(env), false);
  }
});

test('only exact 1 and true enable diagnostic writes', () => {
  for (const value of ['1', 'true']) {
    assert.equal(
      taskProvisioningDiagnosticsWritesEnabled({
        [TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV]: value,
      }),
      true,
    );
  }
});

test('admission-v2 enablement alone cannot open the diagnostic write gate', () => {
  assert.equal(
    taskProvisioningDiagnosticsWritesEnabled({
      [TASK_ADMISSION_V2_ENABLED_ENV]: 'true',
    }),
    false,
  );
  assert.notEqual(
    TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
    TASK_ADMISSION_GATE_TOKEN,
  );
});

test('environment gate snapshots one boolean and exposes no environment or raw value', () => {
  withWriteGateEnvironment('true', () => {
    const gate: TaskProvisioningDiagnosticsWriteGatePort =
      new EnvironmentTaskProvisioningDiagnosticsWriteGate();

    process.env[TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV] = 'false';
    assert.equal(gate.isEnabled(), true);
    assert.deepEqual(Object.keys(gate), []);
    assert.equal(JSON.stringify(gate), '{}');
    assert.equal('env' in gate, false);
    assert.equal('raw' in gate, false);
  });

  withWriteGateEnvironment(undefined, () => {
    const gate = new EnvironmentTaskProvisioningDiagnosticsWriteGate();
    process.env[TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED_ENV] = '1';
    assert.equal(gate.isEnabled(), false);
  });
});

test('global diagnostics module exports the production write-gate binding', () => {
  const providers = moduleMetadata<unknown>(MODULE_METADATA.PROVIDERS);
  const exports = moduleMetadata<unknown>(MODULE_METADATA.EXPORTS);
  const binding = providers.find(
    (provider): provider is ProviderBinding =>
      provider !== null &&
      typeof provider === 'object' &&
      'provide' in provider &&
      (provider as ProviderBinding).provide ===
        TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE,
  );

  assert.equal(
    providers.includes(EnvironmentTaskProvisioningDiagnosticsWriteGate),
    true,
  );
  assert.equal(
    binding?.useExisting,
    EnvironmentTaskProvisioningDiagnosticsWriteGate,
  );
  assert.equal(
    exports.includes(EnvironmentTaskProvisioningDiagnosticsWriteGate),
    true,
  );
  assert.equal(exports.includes(TASK_PROVISIONING_DIAGNOSTICS_WRITE_GATE), true);
});
