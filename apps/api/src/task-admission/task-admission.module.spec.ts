import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_METADATA } from '@nestjs/common/constants';
import {
  EnvironmentTaskAdmissionGate,
  TASK_ADMISSION_WAKE_TOKEN,
} from '../tasks/task-admission-gate';
import { TasksModule } from '../tasks/tasks.module';
import {
  DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
  TASK_ADMISSION_WORKER_OPTIONS,
} from './task-admission-runtime';
import { TaskAdmissionModule } from './task-admission.module';
import { FencedTaskAdmissionProcessor } from './fenced-task-admission.processor';
import { TaskAdmissionWorker } from './task-admission.worker';
import { TASK_ADMISSION_PROCESSOR_TOKEN } from './task-admission.types';
import { TaskAdmissionCapabilityController } from './task-admission-capability.controller';
import { TaskAdmissionCapabilityService } from './task-admission-capability.service';

interface ProviderBinding {
  readonly provide: unknown;
  readonly useExisting?: unknown;
  readonly useValue?: unknown;
}

function moduleMetadata<T>(key: string, target: object): readonly T[] {
  return (Reflect.getMetadata(key, target) ?? []) as readonly T[];
}

function bindingFor(token: unknown): ProviderBinding | undefined {
  return moduleMetadata<unknown>(
    MODULE_METADATA.PROVIDERS,
    TaskAdmissionModule,
  ).find(
    (provider): provider is ProviderBinding =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      (provider as ProviderBinding).provide === token,
  );
}

test('task admission module binds the shared wake token to the durable worker', () => {
  assert.equal(
    bindingFor(TASK_ADMISSION_WAKE_TOKEN)?.useExisting,
    TaskAdmissionWorker,
  );
  assert.equal(
    moduleMetadata<unknown>(MODULE_METADATA.EXPORTS, TaskAdmissionModule).includes(
      TASK_ADMISSION_WAKE_TOKEN,
    ),
    true,
  );
  assert.equal(
    moduleMetadata<unknown>(MODULE_METADATA.IMPORTS, TasksModule).includes(
      TaskAdmissionModule,
    ),
    true,
  );
});

test('admission capability service owns the gate and safe read-only endpoint wiring', () => {
  assert.equal(
    moduleMetadata<unknown>(MODULE_METADATA.PROVIDERS, TaskAdmissionModule).includes(
      TaskAdmissionCapabilityService,
    ),
    true,
  );
  assert.equal(
    moduleMetadata<unknown>(MODULE_METADATA.EXPORTS, TaskAdmissionModule).includes(
      TaskAdmissionCapabilityService,
    ),
    true,
  );
  assert.equal(
    moduleMetadata<unknown>(
      MODULE_METADATA.CONTROLLERS,
      TaskAdmissionModule,
    ).includes(TaskAdmissionCapabilityController),
    true,
  );
  assert.deepEqual(
    Reflect.getMetadata('design:paramtypes', EnvironmentTaskAdmissionGate),
    [TaskAdmissionCapabilityService],
  );
});

test('5.4 module binds the fenced processor while TasksService owns bootstrap ordering', () => {
  assert.equal(
    bindingFor(TASK_ADMISSION_PROCESSOR_TOKEN)?.useExisting,
    FencedTaskAdmissionProcessor,
  );
  assert.equal(
    'onApplicationBootstrap' in TaskAdmissionWorker.prototype,
    false,
  );
  assert.equal(typeof TaskAdmissionWorker.prototype.start, 'function');
  assert.equal(typeof TaskAdmissionWorker.prototype.stop, 'function');
  assert.deepEqual(
    bindingFor(TASK_ADMISSION_WORKER_OPTIONS)?.useValue,
    DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
  );
  assert.equal(DEFAULT_TASK_ADMISSION_WORKER_OPTIONS.maxInFlight, 5);
});
