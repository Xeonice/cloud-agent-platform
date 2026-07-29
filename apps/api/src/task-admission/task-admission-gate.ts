import { Injectable } from '@nestjs/common';
import type { TaskAdmissionV2GateResult } from '@cap-console/contracts';
import {
  TASK_ADMISSION_V2_ATTESTATION_ENV,
  TASK_ADMISSION_V2_ENABLED_ENV,
  TaskAdmissionCapabilityService,
  evaluateTaskAdmissionV2Environment,
} from '@/task-admission/task-admission-capability.service';

/** Rollout switch for the durable task-admission acceptance boundary. */
export {
  TASK_ADMISSION_V2_ATTESTATION_ENV,
  TASK_ADMISSION_V2_ENABLED_ENV,
};

export const TASK_ADMISSION_GATE_TOKEN = Symbol('TASK_ADMISSION_GATE');
export const TASK_ADMISSION_WAKE_TOKEN = Symbol('TASK_ADMISSION_WAKE');

/**
 * Read exactly once while preparing one acceptance, then freeze the result.
 *
 * This returns the gate's full result rather than a boolean on purpose. A
 * `isEnabled(): boolean` here destroyed the closed reason before any call site
 * could see it, so the acceptance path could only recover it by reading
 * deployment state a second time — and two reads of one mutable state can
 * disagree. The reason has to travel with the reading that the decision is made
 * from. See `admission-mode-policy.ts`.
 */
export interface TaskAdmissionGatePort {
  evaluate(): TaskAdmissionV2GateResult;
}

/**
 * Process-local gate reader. The explicit rollout switch opens only when the
 * complete deployment attestation is also valid and this API/worker process is
 * one of its matching ready members. The writer freezes this reading before its
 * transaction and never re-reads mutable deployment state inside that boundary.
 */
@Injectable()
export class EnvironmentTaskAdmissionGate implements TaskAdmissionGatePort {
  constructor(private readonly capabilities: TaskAdmissionCapabilityService) {}

  evaluate(): TaskAdmissionV2GateResult {
    return this.capabilities.evaluate();
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
