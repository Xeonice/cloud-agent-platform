import { Injectable } from '@nestjs/common';
import {
  TASK_ADMISSION_V2_ATTESTATION_ENV,
  TASK_ADMISSION_V2_ENABLED_ENV,
  TaskAdmissionCapabilityService,
  evaluateTaskAdmissionV2Environment,
} from '../task-admission/task-admission-capability.service';

/** Rollout switch for the durable task-admission acceptance boundary. */
export {
  TASK_ADMISSION_V2_ATTESTATION_ENV,
  TASK_ADMISSION_V2_ENABLED_ENV,
};

export const TASK_ADMISSION_GATE_TOKEN = Symbol('TASK_ADMISSION_GATE');
export const TASK_ADMISSION_WAKE_TOKEN = Symbol('TASK_ADMISSION_WAKE');

/** Read exactly once while preparing one acceptance, then freeze the result. */
export interface TaskAdmissionGatePort {
  isEnabled(): boolean;
}

/**
 * Process-local gate reader. The explicit rollout switch opens only when the
 * complete deployment attestation is also valid and this API/worker process is
 * one of its matching ready members. The writer freezes this boolean before its
 * transaction and never re-reads mutable deployment state inside that boundary.
 */
@Injectable()
export class EnvironmentTaskAdmissionGate implements TaskAdmissionGatePort {
  constructor(private readonly capabilities: TaskAdmissionCapabilityService) {}

  isEnabled(): boolean {
    return this.capabilities.isOpen();
  }
}

/** Optional low-latency signal; durable database polling remains authoritative. */
export interface TaskAdmissionWakePort {
  wake(taskId: string): void;
  /**
   * Bootstrap is coordinated by TasksService so durable polling starts only
   * after provider readoption, orphan reconciliation, ceiling restore, and the
   * legacy FIFO re-offer have reached a consistent boundary.
   */
  start?(): void;
  /** Awaitable shutdown keeps an active leased processor from outliving Nest. */
  stop?(): Promise<void>;
}

export function taskAdmissionV2Enabled(env: NodeJS.ProcessEnv): boolean {
  return evaluateTaskAdmissionV2Environment(env).open;
}
