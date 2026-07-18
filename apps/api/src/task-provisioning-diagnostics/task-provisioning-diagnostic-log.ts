import {
  TaskProvisioningDiagnosticEventSchema,
  type TaskProvisioningDiagnosticEvent,
} from '@cap/contracts';

export const TASK_PROVISIONING_DIAGNOSTIC_LOG_EVENT =
  'task_provisioning_diagnostic_event' as const;

type DiagnosticTerminalEvent = Exclude<
  TaskProvisioningDiagnosticEvent,
  { readonly outcome: 'started' }
>;

interface TaskProvisioningDiagnosticLogIdentity {
  readonly event: typeof TASK_PROVISIONING_DIAGNOSTIC_LOG_EVENT;
  readonly schemaVersion: TaskProvisioningDiagnosticEvent['schemaVersion'];
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly operationId: string;
  readonly admissionMode: TaskProvisioningDiagnosticEvent['admissionMode'];
  readonly providerFamily: TaskProvisioningDiagnosticEvent['providerFamily'];
  readonly stage: TaskProvisioningDiagnosticEvent['stage'];
  readonly operation: TaskProvisioningDiagnosticEvent['operation'];
  readonly channel: TaskProvisioningDiagnosticEvent['channel'];
  readonly commandKind: TaskProvisioningDiagnosticEvent['commandKind'] | null;
  readonly observedAt: string;
}

export type TaskProvisioningDiagnosticLogRecord = Readonly<
  TaskProvisioningDiagnosticLogIdentity &
    (
      | { readonly outcome: 'started' }
      | {
          readonly outcome: DiagnosticTerminalEvent['outcome'];
          readonly durationMs?: DiagnosticTerminalEvent['durationMs'];
          readonly cause: DiagnosticTerminalEvent['cause'];
          readonly retryable: DiagnosticTerminalEvent['retryable'];
          readonly httpStatusClass?:
            DiagnosticTerminalEvent['httpStatusClass'];
          readonly nativeState?: DiagnosticTerminalEvent['nativeState'];
          readonly anomaly?: DiagnosticTerminalEvent['anomaly'];
          readonly exitCode?: DiagnosticTerminalEvent['exitCode'];
          readonly timeoutMs?: DiagnosticTerminalEvent['timeoutMs'];
        }
    )
>;

/**
 * Projects an already provider-neutral diagnostic into the only shape allowed
 * on structured stdout. Validation happens again at this boundary so a caller
 * cannot smuggle arbitrary provider or payload fields into Pino.
 */
export function toTaskProvisioningDiagnosticLogRecord(
  candidate: unknown,
): TaskProvisioningDiagnosticLogRecord {
  const parsed = TaskProvisioningDiagnosticEventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TypeError('Invalid task provisioning diagnostic log event');
  }

  const diagnosticEvent = parsed.data;
  const identity: TaskProvisioningDiagnosticLogIdentity = {
    event: TASK_PROVISIONING_DIAGNOSTIC_LOG_EVENT,
    schemaVersion: diagnosticEvent.schemaVersion,
    eventId: diagnosticEvent.eventId,
    idempotencyKey: diagnosticEvent.idempotencyKey,
    taskId: diagnosticEvent.taskId,
    attemptId: diagnosticEvent.attemptId,
    attempt: diagnosticEvent.attempt,
    sequence: diagnosticEvent.sequence,
    operationId: diagnosticEvent.operationId,
    admissionMode: diagnosticEvent.admissionMode,
    providerFamily: diagnosticEvent.providerFamily,
    stage: diagnosticEvent.stage,
    operation: diagnosticEvent.operation,
    channel: diagnosticEvent.channel,
    commandKind: diagnosticEvent.commandKind ?? null,
    observedAt: diagnosticEvent.observedAt.toISOString(),
  };

  if (diagnosticEvent.outcome === 'started') {
    return Object.freeze({
      ...identity,
      outcome: diagnosticEvent.outcome,
    });
  }

  return Object.freeze({
    ...identity,
    outcome: diagnosticEvent.outcome,
    ...(diagnosticEvent.durationMs === undefined
      ? {}
      : { durationMs: diagnosticEvent.durationMs }),
    cause: diagnosticEvent.cause,
    retryable: diagnosticEvent.retryable,
    ...(diagnosticEvent.httpStatusClass === undefined
      ? {}
      : { httpStatusClass: diagnosticEvent.httpStatusClass }),
    ...(diagnosticEvent.nativeState === undefined
      ? {}
      : { nativeState: diagnosticEvent.nativeState }),
    ...(diagnosticEvent.anomaly === undefined
      ? {}
      : { anomaly: diagnosticEvent.anomaly }),
    ...(diagnosticEvent.exitCode === undefined
      ? {}
      : { exitCode: diagnosticEvent.exitCode }),
    ...(diagnosticEvent.timeoutMs === undefined
      ? {}
      : { timeoutMs: diagnosticEvent.timeoutMs }),
  });
}
