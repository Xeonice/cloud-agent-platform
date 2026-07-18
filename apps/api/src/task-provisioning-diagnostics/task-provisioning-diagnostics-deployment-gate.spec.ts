import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';

import {
  assertTaskProvisioningDiagnosticsReadOpen,
  assertTaskProvisioningDiagnosticsScopeGrantable,
  CLOSED_TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
  TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
} from './task-provisioning-diagnostics-deployment-gate.port';
import { TaskProvisioningDiagnosticsCapabilityService } from './task-provisioning-diagnostics-capability.service';
import { TaskProvisioningDiagnosticsModule } from './task-provisioning-diagnostics.module';

interface ProviderBinding {
  readonly provide: unknown;
  readonly useValue?: unknown;
  readonly useExisting?: unknown;
}

function moduleMetadata<T>(key: string): readonly T[] {
  return (Reflect.getMetadata(key, TaskProvisioningDiagnosticsModule) ??
    []) as readonly T[];
}

test('default deployment capability gate closes reads and diagnostics grants', () => {
  for (const run of [
    () =>
      assertTaskProvisioningDiagnosticsReadOpen(
        CLOSED_TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
      ),
    () =>
      assertTaskProvisioningDiagnosticsScopeGrantable(
        ['tasks:diagnostics'],
        CLOSED_TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
      ),
  ] as const) {
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

test('ordinary grants bypass capability evaluation while diagnostics uses it', () => {
  let calls = 0;
  const unavailable = {
    assertReadOpen: () => {
      throw new Error('not attested');
    },
    assertScopesGrantable: () => {
      calls += 1;
      throw new Error('not attested');
    },
  };

  assert.doesNotThrow(() =>
    assertTaskProvisioningDiagnosticsScopeGrantable(
      ['tasks:read', 'tasks:write'],
      unavailable,
    ),
  );
  assert.equal(calls, 0);
  assert.throws(() =>
    assertTaskProvisioningDiagnosticsScopeGrantable(
      ['tasks:read', 'tasks:diagnostics'],
      unavailable,
    ),
  );
  assert.equal(calls, 1);
});

test('raw capability failures become bounded read/grant unavailable errors', () => {
  const rawFailureGate = {
    assertReadOpen: () => {
      throw new Error('raw attestation path and secret');
    },
    assertScopesGrantable: () => {
      throw new Error('raw grant evaluator and secret');
    },
  };

  for (const run of [
    () => assertTaskProvisioningDiagnosticsReadOpen(rawFailureGate),
    () =>
      assertTaskProvisioningDiagnosticsScopeGrantable(
        ['tasks:diagnostics'],
        rawFailureGate,
      ),
  ] as const) {
    assert.throws(run, (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.deepEqual(error.getResponse(), {
        code: 'task_provisioning_diagnostics_unavailable',
        message: 'Task provisioning diagnostics are temporarily unavailable.',
        retryable: true,
      });
      assert.equal(JSON.stringify(error.getResponse()).includes('secret'), false);
      return true;
    });
  }
});

test('global diagnostics module binds the shared capability token to the evaluator service', () => {
  const providers = moduleMetadata<unknown>(MODULE_METADATA.PROVIDERS);
  const exports = moduleMetadata<unknown>(MODULE_METADATA.EXPORTS);
  const binding = providers.find(
    (provider): provider is ProviderBinding =>
      provider !== null &&
      typeof provider === 'object' &&
      'provide' in provider &&
      (provider as ProviderBinding).provide ===
        TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE,
  );

  assert.equal(
    binding?.useExisting,
    TaskProvisioningDiagnosticsCapabilityService,
  );
  assert.equal(
    providers.includes(TaskProvisioningDiagnosticsCapabilityService),
    true,
  );
  assert.equal(
    exports.includes(TaskProvisioningDiagnosticsCapabilityService),
    true,
  );
  assert.equal(
    exports.includes(TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE),
    true,
  );
  assert.doesNotThrow(() =>
    CLOSED_TASK_PROVISIONING_DIAGNOSTICS_CAPABILITY_GATE.assertScopesGrantable(
      ['tasks:read', 'repos:read'],
    ),
  );
});
