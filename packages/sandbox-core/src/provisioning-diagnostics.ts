import { randomUUID } from 'node:crypto';

import { SandboxCoreError } from './errors.js';

/**
 * Provider-neutral diagnostic vocabulary.
 *
 * These constants intentionally mirror the shared wire contract without
 * importing it. sandbox-core is the provider boundary and must stay free of
 * Zod, persistence, logging, and API projection dependencies.
 */
export const SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT = 64 as const;
export const SANDBOX_PROVISIONING_DIAGNOSTIC_SAFE_TEXT_MAX_LENGTH = 160 as const;

export const SANDBOX_PROVISIONING_DIAGNOSTIC_ADMISSION_MODES = [
  'legacy',
  'durable',
] as const;
export type SandboxProvisioningDiagnosticAdmissionMode =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_ADMISSION_MODES)[number];

export const SANDBOX_PROVISIONING_DIAGNOSTIC_PROVIDER_FAMILIES = [
  'aio',
  'cloud-http',
  'boxlite',
  'unknown',
] as const;
export type SandboxProvisioningDiagnosticProviderFamily =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_PROVIDER_FAMILIES)[number];

export const SANDBOX_PROVISIONING_DIAGNOSTIC_STAGES = [
  'accepted',
  'sandbox_creation',
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_setup',
  'readiness',
  'agent_launch',
  'complete',
  'provider_selection',
  'sandbox_start',
  'sandbox_inspect',
  'native_execution',
  'settlement',
  'cleanup',
] as const;
export type SandboxProvisioningDiagnosticStage =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_STAGES)[number];

export const SANDBOX_PROVISIONING_DIAGNOSTIC_OPERATIONS = [
  'provider_select',
  'sandbox_create',
  'sandbox_start',
  'sandbox_inspect',
  'workspace_materialize',
  'credential_setup',
  'remote_ref_resolve',
  'repository_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_preflight',
  'runtime_setup',
  'native_exec_start',
  'native_exec_poll',
  'native_exec_attach',
  'native_exec_settlement',
  'agent_launch',
  'sandbox_delete',
  'sandbox_absence_confirm',
] as const;
export type SandboxProvisioningDiagnosticOperation =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_OPERATIONS)[number];

/**
 * Closed logical keys whose operation identity must survive an in-attempt
 * workspace replay. The key is observer-local and never enters an event.
 */
export const SANDBOX_PROVISIONING_DIAGNOSTIC_REPLAY_KEYS = [
  'workspace.credential_setup',
  'workspace.remote_ref_resolution',
  'workspace.workspace_transfer',
  'workspace.checkout',
  'workspace.submodules',
  'workspace.credential_cleanup',
] as const;
export type SandboxProvisioningDiagnosticReplayKey =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_REPLAY_KEYS)[number];

export const SANDBOX_PROVISIONING_DIAGNOSTIC_CHANNELS = [
  'primary',
  'cleanup',
  'coordination',
] as const;
export type SandboxProvisioningDiagnosticChannel =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_CHANNELS)[number];

export const SANDBOX_PROVISIONING_DIAGNOSTIC_OUTCOMES = [
  'started',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'degraded',
  'indeterminate',
] as const;
export type SandboxProvisioningDiagnosticOutcome =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_OUTCOMES)[number];
export type SandboxProvisioningDiagnosticTerminalOutcome = Exclude<
  SandboxProvisioningDiagnosticOutcome,
  'started'
>;

export const SANDBOX_PROVISIONING_DIAGNOSTIC_CAUSES = [
  'capacity_exhausted',
  'authentication_failed',
  'access_denied',
  'tls_network_failed',
  'ref_not_found',
  'workspace_timeout',
  'transport_failed',
  'protocol_failed',
  'provider_unavailable',
  'settlement_unknown',
  'missing_exit_code',
  'command_failed',
  'cancelled',
  'superseded',
  'cleanup_failed',
  'cleanup_unconfirmed',
  'coordination_failed',
  'diagnostic_write_failed',
  'unknown',
] as const;
export type SandboxProvisioningDiagnosticCause =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_CAUSES)[number];

export const SANDBOX_PROVISIONING_DIAGNOSTIC_COMMAND_KINDS = [
  'git_remote_ref',
  'git_clone',
  'git_checkout',
  'git_submodules',
  'credential_setup',
  'credential_cleanup',
  'runtime_preflight',
  'runtime_setup',
  'agent_launch',
  'sandbox_cleanup',
] as const;
export type SandboxProvisioningDiagnosticCommandKind =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_COMMAND_KINDS)[number];

export const SANDBOX_PROVISIONING_DIAGNOSTIC_NATIVE_STATES = [
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
  'timed_out',
  'unknown',
] as const;
export type SandboxProvisioningDiagnosticNativeState =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_NATIVE_STATES)[number];

export const SANDBOX_PROVISIONING_DIAGNOSTIC_ANOMALIES = [
  'missing_exit_code',
  'invalid_poll_settlement',
  'poll_timeout',
  'poll_transport_failure',
  'attach_degraded',
] as const;
export type SandboxProvisioningDiagnosticAnomaly =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_ANOMALIES)[number];

export const SANDBOX_PROVISIONING_DIAGNOSTIC_HTTP_STATUS_CLASSES = [
  '1xx',
  '2xx',
  '3xx',
  '4xx',
  '5xx',
] as const;
export type SandboxProvisioningDiagnosticHttpStatusClass =
  (typeof SANDBOX_PROVISIONING_DIAGNOSTIC_HTTP_STATUS_CLASSES)[number];

/** The only attempt identity that provider packages are allowed to receive. */
export interface SandboxProvisioningDiagnosticAttemptContext {
  readonly schemaVersion: typeof SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION;
  readonly taskId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly admissionMode: SandboxProvisioningDiagnosticAdmissionMode;
  readonly providerFamily: SandboxProvisioningDiagnosticProviderFamily;
}

interface SandboxProvisioningDiagnosticFactBase {
  readonly operationId: string;
  readonly stage: SandboxProvisioningDiagnosticStage;
  readonly operation: SandboxProvisioningDiagnosticOperation;
  readonly channel: SandboxProvisioningDiagnosticChannel;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind | null;

  /** Correlation and timestamps are injected by the attempt-scoped emitter. */
  readonly schemaVersion?: never;
  readonly eventId?: never;
  readonly idempotencyKey?: never;
  readonly taskId?: never;
  readonly attemptId?: never;
  readonly attempt?: never;
  readonly sequence?: never;
  readonly admissionMode?: never;
  readonly providerFamily?: never;
  readonly observedAt?: never;
}

export interface SandboxProvisioningDiagnosticStartedFact
  extends SandboxProvisioningDiagnosticFactBase {
  readonly outcome: 'started';
  readonly durationMs?: never;
  readonly cause?: never;
  readonly retryable?: never;
  readonly httpStatusClass?: never;
  readonly nativeState?: never;
  readonly anomaly?: never;
  readonly exitCode?: never;
  readonly timeoutMs?: never;
}

export interface SandboxProvisioningDiagnosticTerminalFact
  extends SandboxProvisioningDiagnosticFactBase {
  readonly outcome: SandboxProvisioningDiagnosticTerminalOutcome;
  readonly durationMs?: number;
  readonly cause: SandboxProvisioningDiagnosticCause | null;
  readonly retryable: boolean;
  readonly httpStatusClass?: SandboxProvisioningDiagnosticHttpStatusClass | null;
  readonly nativeState?: SandboxProvisioningDiagnosticNativeState | null;
  readonly anomaly?: SandboxProvisioningDiagnosticAnomaly | null;
  readonly exitCode?: number | null;
  readonly timeoutMs?: number | null;
}

/** Strict provider fact accepted by both task and taskless observers. */
export type SandboxProvisioningDiagnosticFact =
  | SandboxProvisioningDiagnosticStartedFact
  | SandboxProvisioningDiagnosticTerminalFact;

interface SandboxProvisioningDiagnosticEventIdentity {
  readonly schemaVersion: typeof SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly operationId: string;
  readonly admissionMode: SandboxProvisioningDiagnosticAdmissionMode;
  readonly providerFamily: SandboxProvisioningDiagnosticProviderFamily;
  readonly stage: SandboxProvisioningDiagnosticStage;
  readonly operation: SandboxProvisioningDiagnosticOperation;
  readonly channel: SandboxProvisioningDiagnosticChannel;
  readonly commandKind?: SandboxProvisioningDiagnosticCommandKind | null;
  readonly observedAt: Date;
}

export interface SandboxProvisioningDiagnosticStartedEvent
  extends SandboxProvisioningDiagnosticEventIdentity {
  readonly outcome: 'started';
}

export interface SandboxProvisioningDiagnosticTerminalEvent
  extends SandboxProvisioningDiagnosticEventIdentity {
  readonly outcome: SandboxProvisioningDiagnosticTerminalOutcome;
  readonly durationMs?: number;
  readonly cause: SandboxProvisioningDiagnosticCause | null;
  readonly retryable: boolean;
  readonly httpStatusClass?: SandboxProvisioningDiagnosticHttpStatusClass | null;
  readonly nativeState?: SandboxProvisioningDiagnosticNativeState | null;
  readonly anomaly?: SandboxProvisioningDiagnosticAnomaly | null;
  readonly exitCode?: number | null;
  readonly timeoutMs?: number | null;
}

/** Full strict event supplied only to the orchestration-owned recorder. */
export type SandboxProvisioningDiagnosticEvent =
  | SandboxProvisioningDiagnosticStartedEvent
  | SandboxProvisioningDiagnosticTerminalEvent;

export type SandboxProvisioningDiagnosticRecordResult =
  | {
      readonly kind: 'recorded';
      /** Canonical sequence persisted for this new event. */
      readonly sequence: number;
    }
  | {
      readonly kind: 'duplicate';
      /** Canonical sequence of the immutable event already in the ledger. */
      readonly sequence: number;
    };

export type SandboxProvisioningDiagnosticRecorder = (
  event: SandboxProvisioningDiagnosticEvent,
) => Promise<SandboxProvisioningDiagnosticRecordResult>;

export class SandboxProvisioningDiagnosticValidationError extends SandboxCoreError {
  constructor() {
    // Never interpolate the invalid field, value, or provider exception here.
    super(
      'Sandbox provisioning diagnostic input is invalid',
      'sandbox_provisioning_diagnostic_validation_error',
    );
  }
}

/** Shared observer shape used by task-scoped and explicitly taskless calls. */
export interface SandboxProvisioningDiagnosticObserver {
  readonly mode: 'task' | 'non-persisting';
  /** A closed replay key reuses one CAP id within this observer/attempt only. */
  createOperationId(replayKey?: SandboxProvisioningDiagnosticReplayKey): string;
  emit(fact: SandboxProvisioningDiagnosticFact): Promise<void>;
  /**
   * Wait until every fact accepted before this call has finished its recorder
   * attempt. Diagnostic persistence is evidence rather than execution
   * authority, so this barrier always resolves even when an emit was rejected.
   */
  flush(): Promise<void>;
}

/** Explicit taskless observer: it validates facts but has no attempt or recorder. */
export interface NonPersistingSandboxProvisioningDiagnosticObserver
  extends SandboxProvisioningDiagnosticObserver {
  readonly mode: 'non-persisting';
}

export interface SandboxProvisioningDiagnosticEmitter
  extends SandboxProvisioningDiagnosticObserver {
  readonly mode: 'task';
  readonly attemptContext: SandboxProvisioningDiagnosticAttemptContext;
  /** Provider selection may bind the initial `unknown` family exactly once. */
  bindProviderFamily(
    providerFamily: SandboxProvisioningDiagnosticProviderFamily,
  ): void;
}

export interface SandboxProvisioningDiagnosticEmitterOptions {
  readonly attemptContext: SandboxProvisioningDiagnosticAttemptContext;
  readonly record: SandboxProvisioningDiagnosticRecorder;
  /** Highest sequence already retained when continuing an existing attempt. */
  readonly initialSequence?: number;
  readonly createEventId?: () => string;
  readonly createOperationId?: () => string;
  readonly now?: () => Date;
}

/**
 * Create the task-attempt emitter owned by orchestration.
 *
 * Provider facts contain no persistence or logger handle. The emitter injects
 * every task/attempt/event identity, a stable operation-phase idempotency key,
 * attempt-local sequence, and server observation time before calling the
 * orchestration-owned recorder. Emissions are serialized so concurrent provider
 * callbacks cannot race one sequence number.
 */
export function createSandboxProvisioningDiagnosticEmitter(
  options: SandboxProvisioningDiagnosticEmitterOptions,
): SandboxProvisioningDiagnosticEmitter {
  const initialContext = validateSandboxProvisioningDiagnosticAttemptContext(
    options.attemptContext,
  );
  if (typeof options.record !== 'function') failValidation();
  const initialSequence = options.initialSequence ?? 0;
  if (
    !Number.isSafeInteger(initialSequence) ||
    initialSequence < 0 ||
    initialSequence > SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT
  ) {
    failValidation();
  }

  const createEventId = options.createEventId ?? randomUUID;
  const createOperationId = options.createOperationId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  let providerFamily = initialContext.providerFamily;
  let sequence = initialSequence;
  let tail: Promise<void> = Promise.resolve();
  const acceptedFacts = new Map<string, string>();
  const operationShapes = new Map<string, string>();
  const reservedTerminalOperations = new Set<string>();
  const replayOperationIds = new Map<
    SandboxProvisioningDiagnosticReplayKey,
    string
  >();

  const emitter: SandboxProvisioningDiagnosticEmitter = {
    mode: 'task',
    get attemptContext() {
      return Object.freeze({ ...initialContext, providerFamily });
    },
    createOperationId(replayKey) {
      if (replayKey === undefined) return validateUuid(createOperationId());
      const key = validateEnum(
        replayKey,
        SANDBOX_PROVISIONING_DIAGNOSTIC_REPLAY_KEYS,
      );
      const retained = replayOperationIds.get(key);
      if (retained !== undefined) return retained;
      const created = validateUuid(createOperationId());
      replayOperationIds.set(key, created);
      return created;
    },
    bindProviderFamily(nextProviderFamily) {
      const validated = validateEnum(
        nextProviderFamily,
        SANDBOX_PROVISIONING_DIAGNOSTIC_PROVIDER_FAMILIES,
      );
      if (
        providerFamily !== 'unknown' &&
        validated !== providerFamily
      ) {
        failValidation();
      }
      if (providerFamily === 'unknown' && validated !== 'unknown') {
        providerFamily = validated;
      }
    },
    async emit(fact) {
      const validated = validateSandboxProvisioningDiagnosticFact(fact);
      const run = tail.then(async () => {
        const idempotencyKey = diagnosticIdempotencyKey(validated);
        const fingerprint = diagnosticFactFingerprint(validated);
        const previousFingerprint = acceptedFacts.get(idempotencyKey);
        if (previousFingerprint !== undefined) {
          if (previousFingerprint !== fingerprint) failValidation();
          return;
        }
        assertStableDiagnosticOperationShape(operationShapes, validated);
        // A newly accepted start owns one of the remaining slots for its
        // terminal phase. An unrelated fact cannot consume that reservation,
        // while recorder failure leaves it intact for an exact terminal retry.
        assertDiagnosticEventCapacity(
          sequence,
          reservedTerminalOperations,
          validated,
        );
        const candidateSequence = sequence + 1;

        const event = buildDiagnosticEvent({
          context: { ...initialContext, providerFamily },
          fact: validated,
          eventId: validateUuid(createEventId()),
          idempotencyKey,
          sequence: candidateSequence,
          observedAt: validateObservedAt(now()),
        });
        const result = await options.record(event);
        if (
          (result?.kind !== 'recorded' && result?.kind !== 'duplicate') ||
          !Number.isSafeInteger(result.sequence) ||
          result.sequence <= 0 ||
          result.sequence > candidateSequence
        ) {
          failValidation();
        }
        if (
          result.kind === 'recorded' &&
          (sequence >=
            SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT ||
            result.sequence !== candidateSequence)
        ) {
          failValidation();
        }
        acceptedFacts.set(idempotencyKey, fingerprint);
        operationShapes.set(
          validated.operationId,
          diagnosticOperationShapeFingerprint(validated),
        );
        if (validated.outcome === 'started') {
          if (
            !acceptedFacts.has(
              `${validated.operationId.toLowerCase()}:terminal`,
            )
          ) {
            reservedTerminalOperations.add(validated.operationId.toLowerCase());
          }
        } else {
          reservedTerminalOperations.delete(validated.operationId.toLowerCase());
        }
        sequence = Math.max(sequence, result.sequence);
      });
      tail = run.catch(() => undefined);
      await run;
    },
    async flush() {
      // `tail` is deliberately the non-rejecting serialization tail. Callers
      // may await persistence before a destructive boundary without allowing a
      // recorder failure to become provider/admission authority.
      await tail;
    },
  };
  return Object.freeze(emitter);
}

export interface NonPersistingSandboxProvisioningDiagnosticObserverOptions {
  readonly createOperationId?: () => string;
}

/**
 * Validate taskless environment/health observations without manufacturing a
 * task, attempt, sequence, timestamp, or persistence write.
 */
export function createNonPersistingSandboxProvisioningDiagnosticObserver(
  options: NonPersistingSandboxProvisioningDiagnosticObserverOptions = {},
): NonPersistingSandboxProvisioningDiagnosticObserver {
  const createOperationId = options.createOperationId ?? randomUUID;
  const acceptedFacts = new Map<string, string>();
  const operationShapes = new Map<string, string>();
  const reservedTerminalOperations = new Set<string>();
  const replayOperationIds = new Map<
    SandboxProvisioningDiagnosticReplayKey,
    string
  >();
  return Object.freeze({
    mode: 'non-persisting' as const,
    createOperationId(replayKey?: SandboxProvisioningDiagnosticReplayKey) {
      if (replayKey === undefined) return validateUuid(createOperationId());
      const key = validateEnum(
        replayKey,
        SANDBOX_PROVISIONING_DIAGNOSTIC_REPLAY_KEYS,
      );
      const retained = replayOperationIds.get(key);
      if (retained !== undefined) return retained;
      const created = validateUuid(createOperationId());
      replayOperationIds.set(key, created);
      return created;
    },
    async emit(fact: SandboxProvisioningDiagnosticFact) {
      const validated = validateSandboxProvisioningDiagnosticFact(fact);
      const idempotencyKey = diagnosticIdempotencyKey(validated);
      const fingerprint = diagnosticFactFingerprint(validated);
      const previousFingerprint = acceptedFacts.get(idempotencyKey);
      if (previousFingerprint !== undefined) {
        if (previousFingerprint !== fingerprint) failValidation();
        return;
      }
      assertStableDiagnosticOperationShape(operationShapes, validated);
      assertDiagnosticEventCapacity(
        acceptedFacts.size,
        reservedTerminalOperations,
        validated,
      );
      acceptedFacts.set(idempotencyKey, fingerprint);
      operationShapes.set(
        validated.operationId,
        diagnosticOperationShapeFingerprint(validated),
      );
      if (validated.outcome === 'started') {
        if (
          !acceptedFacts.has(
            `${validated.operationId.toLowerCase()}:terminal`,
          )
        ) {
          reservedTerminalOperations.add(validated.operationId.toLowerCase());
        }
      } else {
        reservedTerminalOperations.delete(validated.operationId.toLowerCase());
      }
    },
    async flush() {
      // Taskless observers have no recorder and therefore no pending durable
      // evidence. Keep the same awaitable boundary for wrapper transparency.
    },
  });
}

/** Dependency-free fail-closed validator for provider-authored safe facts. */
export function validateSandboxProvisioningDiagnosticFact(
  value: unknown,
): SandboxProvisioningDiagnosticFact {
  const input = validatePlainObject(value);
  const outcome = validateEnum(
    requireKey(input, 'outcome'),
    SANDBOX_PROVISIONING_DIAGNOSTIC_OUTCOMES,
  );
  const allowedKeys =
    outcome === 'started' ? STARTED_FACT_KEYS : TERMINAL_FACT_KEYS;
  validateExactKeys(input, allowedKeys);

  const common = {
    operationId: validateUuid(requireKey(input, 'operationId')),
    stage: validateEnum(
      requireKey(input, 'stage'),
      SANDBOX_PROVISIONING_DIAGNOSTIC_STAGES,
    ),
    operation: validateEnum(
      requireKey(input, 'operation'),
      SANDBOX_PROVISIONING_DIAGNOSTIC_OPERATIONS,
    ),
    channel: validateEnum(
      requireKey(input, 'channel'),
      SANDBOX_PROVISIONING_DIAGNOSTIC_CHANNELS,
    ),
    ...optionalNullableEnum(
      input,
      'commandKind',
      SANDBOX_PROVISIONING_DIAGNOSTIC_COMMAND_KINDS,
    ),
  };

  if (outcome === 'started') {
    return Object.freeze({ ...common, outcome });
  }

  const causeValue = requireKey(input, 'cause');
  const retryable = requireKey(input, 'retryable');
  if (typeof retryable !== 'boolean') failValidation();
  return Object.freeze({
    ...common,
    outcome,
    ...optionalNonNegativeInteger(input, 'durationMs'),
    cause:
      causeValue === null
        ? null
        : validateEnum(causeValue, SANDBOX_PROVISIONING_DIAGNOSTIC_CAUSES),
    retryable,
    ...optionalNullableEnum(
      input,
      'httpStatusClass',
      SANDBOX_PROVISIONING_DIAGNOSTIC_HTTP_STATUS_CLASSES,
    ),
    ...optionalNullableEnum(
      input,
      'nativeState',
      SANDBOX_PROVISIONING_DIAGNOSTIC_NATIVE_STATES,
    ),
    ...optionalNullableEnum(
      input,
      'anomaly',
      SANDBOX_PROVISIONING_DIAGNOSTIC_ANOMALIES,
    ),
    ...optionalNullableInteger(input, 'exitCode'),
    ...optionalNullablePositiveInteger(input, 'timeoutMs'),
  });
}

/** Dependency-free fail-closed validator for orchestration attempt identity. */
export function validateSandboxProvisioningDiagnosticAttemptContext(
  value: unknown,
): SandboxProvisioningDiagnosticAttemptContext {
  const input = validatePlainObject(value);
  validateExactKeys(input, ATTEMPT_CONTEXT_KEYS);
  if (
    requireKey(input, 'schemaVersion') !==
    SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION
  ) {
    failValidation();
  }
  const attempt = requireKey(input, 'attempt');
  if (!Number.isSafeInteger(attempt) || (attempt as number) <= 0) {
    failValidation();
  }
  return Object.freeze({
    schemaVersion: SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
    taskId: validateUuid(requireKey(input, 'taskId')),
    attemptId: validateUuid(requireKey(input, 'attemptId')),
    attempt: attempt as number,
    admissionMode: validateEnum(
      requireKey(input, 'admissionMode'),
      SANDBOX_PROVISIONING_DIAGNOSTIC_ADMISSION_MODES,
    ),
    providerFamily: validateEnum(
      requireKey(input, 'providerFamily'),
      SANDBOX_PROVISIONING_DIAGNOSTIC_PROVIDER_FAMILIES,
    ),
  });
}

const ATTEMPT_CONTEXT_KEYS = new Set([
  'schemaVersion',
  'taskId',
  'attemptId',
  'attempt',
  'admissionMode',
  'providerFamily',
]);
const STARTED_FACT_KEYS = new Set([
  'operationId',
  'stage',
  'operation',
  'channel',
  'commandKind',
  'outcome',
]);
const TERMINAL_FACT_KEYS = new Set([
  ...STARTED_FACT_KEYS,
  'durationMs',
  'cause',
  'retryable',
  'httpStatusClass',
  'nativeState',
  'anomaly',
  'exitCode',
  'timeoutMs',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type PlainObject = Record<string, unknown>;

function failValidation(): never {
  throw new SandboxProvisioningDiagnosticValidationError();
}

function validatePlainObject(value: unknown): PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failValidation();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) failValidation();
  return value as PlainObject;
}

function validateExactKeys(value: PlainObject, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failValidation();
  }
}

function requireKey(value: PlainObject, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) failValidation();
  return value[key];
}

function validateEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) failValidation();
  return value as T[number];
}

function validateUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) failValidation();
  return value;
}

function optionalNullableEnum<
  const TKey extends string,
  const TValues extends readonly string[],
>(
  value: PlainObject,
  key: TKey,
  allowed: TValues,
): { readonly [K in TKey]?: TValues[number] | null } {
  if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
    return {};
  }
  if (value[key] === null) return { [key]: null } as {
    readonly [K in TKey]?: TValues[number] | null;
  };
  return { [key]: validateEnum(value[key], allowed) } as {
    readonly [K in TKey]?: TValues[number] | null;
  };
}

function optionalNonNegativeInteger<const TKey extends string>(
  value: PlainObject,
  key: TKey,
): { readonly [K in TKey]?: number } {
  if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
    return {};
  }
  if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
    failValidation();
  }
  return { [key]: value[key] } as { readonly [K in TKey]?: number };
}

function optionalNullableInteger<const TKey extends string>(
  value: PlainObject,
  key: TKey,
): { readonly [K in TKey]?: number | null } {
  if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
    return {};
  }
  if (value[key] === null) return { [key]: null } as {
    readonly [K in TKey]?: number | null;
  };
  if (!Number.isSafeInteger(value[key])) failValidation();
  return { [key]: value[key] } as { readonly [K in TKey]?: number | null };
}

function optionalNullablePositiveInteger<const TKey extends string>(
  value: PlainObject,
  key: TKey,
): { readonly [K in TKey]?: number | null } {
  const result = optionalNullableInteger(value, key);
  const parsed = result[key];
  if (parsed !== undefined && parsed !== null && parsed <= 0) failValidation();
  return result;
}

function validateObservedAt(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    failValidation();
  }
  return new Date(value.getTime());
}

function diagnosticIdempotencyKey(
  fact: SandboxProvisioningDiagnosticFact,
): string {
  const phase = fact.outcome === 'started' ? 'started' : 'terminal';
  // A validated UUID plus either fixed suffix is lowercase-safe and at most
  // 45 characters, well below the shared 160-character ledger bound.
  return `${fact.operationId.toLowerCase()}:${phase}`;
}

function diagnosticFactFingerprint(
  fact: SandboxProvisioningDiagnosticFact,
): string {
  return JSON.stringify(fact);
}

function diagnosticOperationShapeFingerprint(
  fact: SandboxProvisioningDiagnosticFact,
): string {
  return JSON.stringify({
    stage: fact.stage,
    operation: fact.operation,
    channel: fact.channel,
    commandKind: fact.commandKind ?? null,
  });
}

function assertStableDiagnosticOperationShape(
  operationShapes: ReadonlyMap<string, string>,
  fact: SandboxProvisioningDiagnosticFact,
): void {
  const retained = operationShapes.get(fact.operationId);
  if (
    retained !== undefined &&
    retained !== diagnosticOperationShapeFingerprint(fact)
  ) {
    failValidation();
  }
}

function assertDiagnosticEventCapacity(
  acceptedCount: number,
  reservedTerminalOperations: ReadonlySet<string>,
  fact: SandboxProvisioningDiagnosticFact,
): void {
  const terminalConsumesReservation =
    fact.outcome !== 'started' &&
    reservedTerminalOperations.has(fact.operationId.toLowerCase());
  if (terminalConsumesReservation) {
    return;
  }

  const requiredUnreservedSlots = fact.outcome === 'started' ? 2 : 1;
  if (
    acceptedCount +
      reservedTerminalOperations.size +
      requiredUnreservedSlots >
    SANDBOX_PROVISIONING_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT
  ) {
    failValidation();
  }
}

function buildDiagnosticEvent(args: {
  readonly context: SandboxProvisioningDiagnosticAttemptContext;
  readonly fact: SandboxProvisioningDiagnosticFact;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly sequence: number;
  readonly observedAt: Date;
}): SandboxProvisioningDiagnosticEvent {
  const identity = {
    schemaVersion: SANDBOX_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
    eventId: args.eventId,
    idempotencyKey: args.idempotencyKey,
    taskId: args.context.taskId,
    attemptId: args.context.attemptId,
    attempt: args.context.attempt,
    sequence: args.sequence,
    operationId: args.fact.operationId,
    admissionMode: args.context.admissionMode,
    providerFamily: args.context.providerFamily,
    stage: args.fact.stage,
    operation: args.fact.operation,
    channel: args.fact.channel,
    ...(args.fact.commandKind === undefined
      ? {}
      : { commandKind: args.fact.commandKind }),
    observedAt: args.observedAt,
  };
  if (args.fact.outcome === 'started') {
    return Object.freeze({ ...identity, outcome: args.fact.outcome });
  }
  return Object.freeze({
    ...identity,
    outcome: args.fact.outcome,
    ...(args.fact.durationMs === undefined
      ? {}
      : { durationMs: args.fact.durationMs }),
    cause: args.fact.cause,
    retryable: args.fact.retryable,
    ...(args.fact.httpStatusClass === undefined
      ? {}
      : { httpStatusClass: args.fact.httpStatusClass }),
    ...(args.fact.nativeState === undefined
      ? {}
      : { nativeState: args.fact.nativeState }),
    ...(args.fact.anomaly === undefined
      ? {}
      : { anomaly: args.fact.anomaly }),
    ...(args.fact.exitCode === undefined
      ? {}
      : { exitCode: args.fact.exitCode }),
    ...(args.fact.timeoutMs === undefined
      ? {}
      : { timeoutMs: args.fact.timeoutMs }),
  });
}
