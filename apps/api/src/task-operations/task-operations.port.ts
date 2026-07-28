/**
 * What guardrails needs FROM tasks, declared where neither owns it.
 *
 * `guardrails.service.ts` imported `TasksService` directly while
 * `tasks.module.ts` imported `GuardrailsService` back — a source-level cycle.
 * The RUNTIME half was already worked around: guardrails resolves the service
 * lazily in `onModuleInit` via `moduleRef.get(..., { strict: false })` because a
 * constructor-time dependency made `NestFactory.create()` fail. That workaround
 * is documented at the resolution site and stays; what it could not fix is the
 * import.
 *
 * So the surface guardrails actually calls is declared here as a port, with a
 * token to resolve it by. `TasksService` declares `implements TaskOperationsPort`,
 * so the compiler enforces conformance and the port cannot drift from it —
 * without guardrails ever naming the class.
 */
import type {
  TaskProvisioningStage,
  TaskResponse,
  TaskStatus,
} from '@cap/contracts';

import type { RuntimeOutputFailure } from '@/agent-runtime/agent-runtime.port';
import type {
  ProvisioningTaskFailureCode,
  RuntimeTaskFailureCode,
} from '@/task-failure/task-failure';

/** Outcome of an admission-gated status transition. */
export type AdmissionTransitionResult =
  | 'transitioned'
  | 'already-transitioned'
  | 'superseded';

/**
 * Raised when an admission transition's outcome cannot be determined — the
 * write may or may not have landed. Callers must reconcile rather than assume.
 */
export class AdmissionTransitionIndeterminateError extends Error {
  constructor(
    readonly taskId: string,
    readonly next: Extract<TaskStatus, 'queued' | 'running'>,
    readonly transitionToken: string,
    readonly cause?: unknown,
  ) {
    super(`Admission transition outcome is indeterminate: ${taskId} -> ${next}`);
    this.name = 'AdmissionTransitionIndeterminateError';
  }
}

export interface DurableAdmissionCapacityRequest {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly expectedStatus: Extract<TaskStatus, 'pending' | 'queued' | 'running'>;
  readonly expectedLifecycleVersion: number;
  /** Process config used only when the shared singleton row does not exist. */
  readonly fallbackMaxConcurrentTasks: number;
  readonly transitionToken: string;
  readonly userId?: string;
}

export type DurableAdmissionCapacityResult =
  | {
      readonly outcome: 'queued' | 'running';
      readonly status: 'queued' | 'running';
      readonly lifecycleVersion: number;
      readonly transitioned: boolean;
    }
  | { readonly outcome: 'superseded' };

export interface DurableAdmissionFailureRequest {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly attempt: number;
  readonly expectedStatus: Extract<
    TaskStatus,
    'pending' | 'queued' | 'running' | 'awaiting_input'
  >;
  readonly expectedLifecycleVersion: number;
  readonly stage: TaskProvisioningStage;
  readonly causeCode: ProvisioningTaskFailureCode;
}

/** The task operations guardrails drives. */
export interface TaskOperationsPort {
  transition(
    id: string,
    next: TaskStatus,
    userId?: string,
  ): Promise<TaskResponse>;
  transitionForAdmission(
    id: string,
    next: Extract<TaskStatus, 'queued' | 'running'>,
    userId?: string,
    transitionToken?: string,
  ): Promise<AdmissionTransitionResult>;
  reconcileAdmissionTransition(
    id: string,
    next: Extract<TaskStatus, 'queued' | 'running'>,
    transitionToken: string,
    userId?: string,
  ): Promise<AdmissionTransitionResult>;
  isAdmissionTransitionCurrent(
    id: string,
    next: Extract<TaskStatus, 'queued' | 'running'>,
    transitionToken: string,
    lifecycleVersion?: number,
  ): Promise<boolean>;
  failWithRuntimeFailure(
    id: string,
    code: RuntimeTaskFailureCode,
    exitCode?: number | null,
  ): Promise<TaskResponse>;
  failWithProvisioningFailure(
    id: string,
    code: ProvisioningTaskFailureCode,
  ): Promise<TaskResponse>;
  classifyRuntimeOutputFailure(
    id: string,
    output: string,
  ): Promise<RuntimeOutputFailure | null>;
  reserveDurableAdmissionCapacity(
    request: DurableAdmissionCapacityRequest,
  ): Promise<DurableAdmissionCapacityResult>;
  settleDurableAdmissionFailure(
    request: DurableAdmissionFailureRequest,
  ): Promise<boolean>;
}

/** DI token guardrails resolves the port by, without naming the class. */
export const TASK_OPERATIONS = Symbol('TaskOperationsPort');
