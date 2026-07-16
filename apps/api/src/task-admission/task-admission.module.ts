import { Module } from '@nestjs/common';
import { TASK_ADMISSION_WAKE_TOKEN } from '../tasks/task-admission-gate';
import { PrismaTaskAdmissionStore } from './prisma-task-admission.store';
import {
  DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
  RandomTaskAdmissionLeaseTokenFactory,
  SystemTaskAdmissionClock,
  SystemTaskAdmissionScheduler,
  TaskAdmissionClock,
  TaskAdmissionLeaseTokenFactory,
  TaskAdmissionScheduler,
  TASK_ADMISSION_WORKER_OPTIONS,
} from './task-admission-runtime';
import {
  SafeTaskAdmissionWorkerErrorReporter,
  TaskAdmissionWorker,
  TASK_ADMISSION_WORKER_ERROR_REPORTER,
} from './task-admission.worker';
import { FencedTaskAdmissionProcessor } from './fenced-task-admission.processor';
import {
  TASK_ADMISSION_CANCELLATION_TOKEN,
  TASK_ADMISSION_PROCESSOR_TOKEN,
  TaskAdmissionStore,
} from './task-admission.types';
import { TaskAdmissionCapabilityController } from './task-admission-capability.controller';
import { TaskAdmissionCapabilityService } from './task-admission-capability.service';

/**
 * Independent durable-admission coordination boundary. The worker is exported
 * but intentionally not started here: TasksService owns the ordered bootstrap
 * coordinator. The production processor is the fenced Guardrails/provider
 * implementation; the unbound fallback remains available only in isolation.
 */
@Module({
  controllers: [TaskAdmissionCapabilityController],
  providers: [
    TaskAdmissionCapabilityService,
    PrismaTaskAdmissionStore,
    {
      provide: TaskAdmissionStore,
      useExisting: PrismaTaskAdmissionStore,
    },
    SystemTaskAdmissionScheduler,
    {
      provide: TaskAdmissionScheduler,
      useExisting: SystemTaskAdmissionScheduler,
    },
    SystemTaskAdmissionClock,
    {
      provide: TaskAdmissionClock,
      useExisting: SystemTaskAdmissionClock,
    },
    RandomTaskAdmissionLeaseTokenFactory,
    {
      provide: TaskAdmissionLeaseTokenFactory,
      useExisting: RandomTaskAdmissionLeaseTokenFactory,
    },
    {
      provide: TASK_ADMISSION_WORKER_OPTIONS,
      useValue: DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
    },
    FencedTaskAdmissionProcessor,
    {
      provide: TASK_ADMISSION_PROCESSOR_TOKEN,
      useExisting: FencedTaskAdmissionProcessor,
    },
    SafeTaskAdmissionWorkerErrorReporter,
    {
      provide: TASK_ADMISSION_WORKER_ERROR_REPORTER,
      useExisting: SafeTaskAdmissionWorkerErrorReporter,
    },
    TaskAdmissionWorker,
    {
      provide: TASK_ADMISSION_CANCELLATION_TOKEN,
      useExisting: TaskAdmissionWorker,
    },
    {
      provide: TASK_ADMISSION_WAKE_TOKEN,
      useExisting: TaskAdmissionWorker,
    },
  ],
  exports: [
    TaskAdmissionCapabilityService,
    TaskAdmissionWorker,
    TaskAdmissionStore,
    TASK_ADMISSION_WAKE_TOKEN,
    TASK_ADMISSION_CANCELLATION_TOKEN,
    TASK_ADMISSION_PROCESSOR_TOKEN,
  ],
})
export class TaskAdmissionModule {}
