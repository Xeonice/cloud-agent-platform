import { SandboxCoreError } from './errors.js';
import {
  SANDBOX_PROVISIONING_DIAGNOSTIC_COMMAND_KINDS,
  type SandboxProvisioningDiagnosticCommandKind,
  type SandboxProvisioningDiagnosticTerminalFact,
} from './provisioning-diagnostics.js';

export interface SandboxCommandExecutionRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /**
   * Safe runtime-plan metadata propagated only to provider diagnostics. It is
   * never inferred from command text and provider transports must not serialize
   * it as part of a command request.
   */
  readonly diagnosticDescriptor?: SandboxRuntimeCommandDescriptor;
  /**
   * Cooperative cancellation for adapters that can prove the guest process has
   * stopped before resolving. A transport abort by itself is not that proof.
   */
  readonly signal?: AbortSignal;
  /**
   * Ordinary execution is command-only. Provider setup needing structured
   * non-secret input must define a narrower allowlisted request instead of a
   * generic env/stdin/argv escape hatch.
   */
  readonly env?: never;
  readonly stdin?: never;
  readonly argv?: never;
  readonly authHeader?: never;
  readonly credential?: never;
  readonly secret?: never;
}

/**
 * Workspace Git commands are stricter than general provider setup commands:
 * credentials must already have become a temporary file path, so no generic
 * environment/stdin/argv escape hatch is accepted at this boundary.
 */
export type SandboxWorkspaceCommandExecutionRequest =
  SandboxCommandExecutionRequest;

/**
 * A resolved command result proves both process settlement and complete drain
 * of every promised stdout/stderr source. Empty strings therefore mean proven
 * zero-byte output, never an output channel that is still pending or degraded.
 * Providers that cannot prove output settlement must reject instead of
 * returning a partial result.
 */
export interface SandboxCommandExecutionResult {
  readonly exitCode: number;
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export const SANDBOX_RUNTIME_PREFLIGHT_COMMAND_KINDS = [
  'runtime_preflight',
] as const satisfies readonly SandboxProvisioningDiagnosticCommandKind[];

export const SANDBOX_RUNTIME_SETUP_COMMAND_KINDS = [
  'credential_setup',
  'runtime_setup',
] as const satisfies readonly SandboxProvisioningDiagnosticCommandKind[];

export interface SandboxRuntimeCommandDescriptor<
  TKind extends SandboxProvisioningDiagnosticCommandKind = SandboxProvisioningDiagnosticCommandKind,
> {
  /** Declared by the runtime plan; never inferred from shell text. */
  readonly commandKind: TKind;
  /** One-based position in the declared preflight or setup plan. */
  readonly ordinal: number;
  readonly command?: never;
  readonly argv?: never;
  readonly stdout?: never;
  readonly stderr?: never;
  readonly output?: never;
  readonly prompt?: never;
  readonly path?: never;
  readonly body?: never;
  readonly rawError?: never;
}

export type SandboxRuntimePreflightCommandDescriptor =
  SandboxRuntimeCommandDescriptor<
    (typeof SANDBOX_RUNTIME_PREFLIGHT_COMMAND_KINDS)[number]
  >;

export type SandboxRuntimeSetupCommandDescriptor =
  SandboxRuntimeCommandDescriptor<
    (typeof SANDBOX_RUNTIME_SETUP_COMMAND_KINDS)[number]
  >;

export type SandboxCommandSettlementKind =
  | 'exit'
  | 'failed_without_exit'
  | 'timeout'
  | 'transport'
  | 'protocol'
  | 'cancellation'
  | 'indeterminate';

export type SandboxCommandExecutionClassification =
  | {
      readonly settlement: 'exit';
      readonly outcome: 'succeeded' | 'failed';
      readonly cause: null | 'command_failed';
      readonly retryable: false;
      readonly exitCode: number;
    }
  | {
      readonly settlement: 'failed_without_exit';
      readonly outcome: 'failed';
      readonly cause: 'missing_exit_code';
      readonly retryable: false;
      readonly exitCode: null;
      readonly anomaly: 'missing_exit_code';
    }
  | {
      readonly settlement: 'timeout';
      readonly outcome: 'timed_out';
      readonly cause: 'settlement_unknown';
      readonly retryable: true;
      readonly exitCode: null;
    }
  | {
      readonly settlement: 'transport';
      readonly outcome: 'failed';
      readonly cause: 'transport_failed';
      readonly retryable: true;
      readonly exitCode: null;
    }
  | {
      readonly settlement: 'protocol';
      readonly outcome: 'failed';
      readonly cause: 'protocol_failed';
      readonly retryable: false;
      readonly exitCode: null;
    }
  | {
      readonly settlement: 'cancellation';
      readonly outcome: 'cancelled';
      readonly cause: 'cancelled';
      readonly retryable: false;
      readonly exitCode: null;
    }
  | {
      readonly settlement: 'indeterminate';
      readonly outcome: 'indeterminate';
      readonly cause: 'settlement_unknown';
      readonly retryable: true;
      readonly exitCode: null;
    };

export type SandboxCommandExecutionDiagnosticFields = Pick<
  SandboxProvisioningDiagnosticTerminalFact,
  'outcome' | 'cause' | 'retryable' | 'exitCode' | 'anomaly'
>;

type SandboxCommandNonExitSettlement = Exclude<
  SandboxCommandSettlementKind,
  'exit'
>;

export type SandboxCommandOutputSettlementFailure =
  | 'transport'
  | 'protocol'
  | 'timeout'
  | 'cancellation';

/**
 * Provider adapters use this fixed-shape error when they can safely identify a
 * non-exit settlement. The raw provider error is deliberately not retained.
 */
export class SandboxCommandSettlementError extends SandboxCoreError {
  constructor(readonly settlement: SandboxCommandNonExitSettlement) {
    super(
      `Sandbox command settlement is ${settlement}`,
      'sandbox_command_settlement_error',
    );
    if (!SANDBOX_COMMAND_NON_EXIT_SETTLEMENTS.includes(settlement)) {
      throw new SandboxCommandClassificationError();
    }
  }
}

/**
 * Provider adapters use this fixed-shape rejection when process settlement may
 * already be known but promised command output did not settle. Known process
 * facts remain on the provider's bounded diagnostic channel; this error retains
 * neither those facts nor command, output, provider identity, or raw failures.
 */
export class SandboxCommandOutputSettlementError extends SandboxCoreError {
  constructor(readonly settlement: SandboxCommandOutputSettlementFailure) {
    super(
      `Sandbox command output settlement is ${settlement}`,
      'sandbox_command_output_settlement_error',
    );
    if (!SANDBOX_COMMAND_OUTPUT_SETTLEMENT_FAILURES.includes(settlement)) {
      throw new SandboxCommandClassificationError();
    }
    Object.freeze(this);
  }
}

/** Safe runtime-plan failure that never retains command, output, or raw error. */
export class SandboxRuntimeCommandExecutionError extends SandboxCoreError {
  readonly descriptor: SandboxRuntimeCommandDescriptor;
  readonly classification: SandboxCommandExecutionClassification;

  constructor(
    descriptor: SandboxRuntimeCommandDescriptor,
    classification: SandboxCommandExecutionClassification,
  ) {
    const safeDescriptor = validateSandboxRuntimeCommandDescriptor(descriptor);
    const safeClassification = validateSandboxCommandExecutionClassification(
      classification,
    );
    super(
      `Sandbox runtime command ${safeDescriptor.commandKind} #${safeDescriptor.ordinal} settled as ${safeClassification.settlement}`,
      'sandbox_runtime_command_execution_error',
    );
    this.descriptor = safeDescriptor;
    this.classification = safeClassification;
  }
}

export class SandboxCommandClassificationError extends SandboxCoreError {
  constructor() {
    super(
      'Sandbox command diagnostic classification is invalid',
      'sandbox_command_classification_error',
    );
  }
}

export interface SandboxCommandExecutor {
  exec(
    request: SandboxCommandExecutionRequest,
  ): Promise<SandboxCommandExecutionResult>;
}

export interface SandboxWorkspaceCommandExecutor {
  exec(
    request: SandboxWorkspaceCommandExecutionRequest,
  ): Promise<SandboxCommandExecutionResult>;
}

export type SandboxCommandRunner = (
  request: SandboxCommandExecutionRequest,
) => Promise<unknown>;

export type SandboxWorkspaceCommandRunner = (
  request: SandboxWorkspaceCommandExecutionRequest,
) => Promise<unknown>;

export interface NormalizeSandboxCommandResultOptions {
  readonly scrubOutput?: boolean;
}

export function createSandboxCommandExecutor(
  run: SandboxCommandRunner,
  options: NormalizeSandboxCommandResultOptions = {},
): SandboxCommandExecutor {
  return {
    async exec(request) {
      return normalizeSandboxCommandResult(await run(request), options);
    },
  };
}

export function createSandboxWorkspaceCommandExecutor(
  run: SandboxWorkspaceCommandRunner,
  options: NormalizeSandboxCommandResultOptions = {},
): SandboxWorkspaceCommandExecutor {
  return {
    async exec(request) {
      return normalizeSandboxCommandResult(await run(request), options);
    },
  };
}

/**
 * Execute one host-runtime plan entry and discard every unsafe execution value
 * after deriving a closed safe classification. Callers receive no command
 * output or provider exception to accidentally log or persist.
 */
export async function classifySandboxRuntimeCommandExecution(args: {
  readonly executor: SandboxCommandExecutor;
  readonly request: SandboxCommandExecutionRequest;
  readonly descriptor: SandboxRuntimeCommandDescriptor;
}): Promise<SandboxCommandExecutionClassification> {
  const descriptor = validateSandboxRuntimeCommandDescriptor(args.descriptor);
  try {
    return classifySandboxCommandExecutionResult(
      await args.executor.exec({
        ...args.request,
        diagnosticDescriptor: descriptor,
      }),
    );
  } catch (error) {
    return classifySandboxCommandExecutionRejection(error, args.request.signal);
  }
}

export function classifySandboxCommandExecutionResult(
  result: SandboxCommandExecutionResult,
): SandboxCommandExecutionClassification {
  if (result.timedOut) {
    return freezeClassification({
      settlement: 'timeout',
      outcome: 'timed_out',
      cause: 'settlement_unknown',
      retryable: true,
      exitCode: null,
    });
  }
  if (!Number.isSafeInteger(result.exitCode)) {
    return freezeClassification({
      settlement: 'indeterminate',
      outcome: 'indeterminate',
      cause: 'settlement_unknown',
      retryable: true,
      exitCode: null,
    });
  }
  if (result.exitCode === 0) {
    return freezeClassification({
      settlement: 'exit',
      outcome: 'succeeded',
      cause: null,
      retryable: false,
      exitCode: 0,
    });
  }
  return freezeClassification({
    settlement: 'exit',
    outcome: 'failed',
    cause: 'command_failed',
    retryable: false,
    exitCode: result.exitCode,
  });
}

export function classifySandboxCommandExecutionRejection(
  error: unknown,
  cancellationSignal?: AbortSignal,
): SandboxCommandExecutionClassification {
  const outputSettlement = sandboxCommandOutputSettlementFromError(error);
  if (outputSettlement) return classificationForSettlement(outputSettlement);
  const typedSettlement = sandboxCommandSettlementFromError(error);
  if (typedSettlement) return classificationForSettlement(typedSettlement);
  if (cancellationSignal?.aborted || errorHasNameOrCode(error, 'AbortError', 'ABORT_ERR')) {
    return classificationForSettlement('cancellation');
  }
  if (
    errorHasNameOrCode(error, 'TimeoutError', 'ERR_TIMEOUT') ||
    errorHasCode(error, 'ETIMEDOUT')
  ) {
    return classificationForSettlement('timeout');
  }
  // An untyped executor rejection means the command transport did not return a
  // settlement. Its value may contain provider-private material and is dropped.
  return classificationForSettlement('transport');
}

/** Exact safe subset that can be spread into a strict terminal operation fact. */
export function sandboxCommandExecutionDiagnosticFields(
  classification: SandboxCommandExecutionClassification,
): SandboxCommandExecutionDiagnosticFields {
  const safe = validateSandboxCommandExecutionClassification(classification);
  const anomaly = 'anomaly' in safe ? safe.anomaly : undefined;
  return Object.freeze({
    outcome: safe.outcome,
    cause: safe.cause,
    retryable: safe.retryable,
    exitCode: safe.exitCode,
    ...(anomaly === undefined ? {} : { anomaly }),
  });
}

export function validateSandboxRuntimeCommandDescriptor<
  TKind extends SandboxProvisioningDiagnosticCommandKind,
>(
  value: SandboxRuntimeCommandDescriptor<TKind>,
): SandboxRuntimeCommandDescriptor<TKind> {
  if (!isPlainRecord(value)) throw new SandboxCommandClassificationError();
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('commandKind') ||
    !keys.includes('ordinal') ||
    typeof value.commandKind !== 'string' ||
    !SANDBOX_PROVISIONING_DIAGNOSTIC_COMMAND_KINDS.includes(
      value.commandKind,
    ) ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal <= 0
  ) {
    throw new SandboxCommandClassificationError();
  }
  return Object.freeze({
    commandKind: value.commandKind,
    ordinal: value.ordinal,
  }) as SandboxRuntimeCommandDescriptor<TKind>;
}

export function validateSandboxRuntimePreflightCommandDescriptor(
  value: SandboxRuntimePreflightCommandDescriptor,
  expectedOrdinal?: number,
): SandboxRuntimePreflightCommandDescriptor {
  const descriptor = validateSandboxRuntimeCommandDescriptor(value);
  if (
    descriptor.commandKind !== 'runtime_preflight' ||
    (expectedOrdinal !== undefined && descriptor.ordinal !== expectedOrdinal)
  ) {
    throw new SandboxCommandClassificationError();
  }
  return descriptor as SandboxRuntimePreflightCommandDescriptor;
}

export function validateSandboxRuntimeSetupCommandDescriptor(
  value: SandboxRuntimeSetupCommandDescriptor,
  expectedOrdinal?: number,
): SandboxRuntimeSetupCommandDescriptor {
  const descriptor = validateSandboxRuntimeCommandDescriptor(value);
  if (
    !SANDBOX_RUNTIME_SETUP_COMMAND_KINDS.includes(descriptor.commandKind) ||
    (expectedOrdinal !== undefined && descriptor.ordinal !== expectedOrdinal)
  ) {
    throw new SandboxCommandClassificationError();
  }
  return descriptor as SandboxRuntimeSetupCommandDescriptor;
}

export function isSandboxRuntimeCommandExecutionError(
  error: unknown,
): error is SandboxRuntimeCommandExecutionError {
  if (
    !isObjectRecord(error) ||
    error.code !== 'sandbox_runtime_command_execution_error'
  ) {
    return false;
  }
  try {
    validateSandboxRuntimeCommandDescriptor(
      error.descriptor as SandboxRuntimeCommandDescriptor,
    );
    validateSandboxCommandExecutionClassification(
      error.classification as SandboxCommandExecutionClassification,
    );
    return true;
  } catch {
    return false;
  }
}

export function normalizeSandboxCommandResult(
  raw: unknown,
  options: NormalizeSandboxCommandResultOptions = {},
): SandboxCommandExecutionResult {
  const top = (raw ?? {}) as Record<string, unknown>;
  const data = (top.data ?? top) as Record<string, unknown>;
  const stdout = stringValue(data.stdout);
  const stderr = stringValue(data.stderr);
  const rawOutput = stringValue(data.output) || stderr || stdout;
  const output = options.scrubOutput
    ? scrubSandboxCommandOutput(rawOutput)
    : rawOutput;
  return {
    exitCode: coerceExitCode(data.exit_code ?? data.exitCode ?? data.code),
    output,
    stdout: options.scrubOutput ? scrubSandboxCommandOutput(stdout) : stdout,
    stderr: options.scrubOutput ? scrubSandboxCommandOutput(stderr) : stderr,
    timedOut:
      data.timedOut === true ||
      data.timeout === true ||
      data.timed_out === true,
  };
}

export function buildSandboxCommandLine(
  request: SandboxCommandExecutionRequest,
): string {
  return request.cwd
    ? `cd ${shellQuote(request.cwd)} && ${request.command}`
    : request.command;
}

export function scrubSandboxCommandOutput(output: string): string {
  return output
    .replace(/https:\/\/[^@\s/]+:[^@\s/]+@/g, 'https://***:***@')
    .replace(/(Authorization:\s*Basic\s+)\S+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function coerceExitCode(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

const SANDBOX_COMMAND_NON_EXIT_SETTLEMENTS = [
  'failed_without_exit',
  'timeout',
  'transport',
  'protocol',
  'cancellation',
  'indeterminate',
] as const satisfies readonly SandboxCommandNonExitSettlement[];

const SANDBOX_COMMAND_OUTPUT_SETTLEMENT_FAILURES = [
  'transport',
  'protocol',
  'timeout',
  'cancellation',
] as const satisfies readonly SandboxCommandOutputSettlementFailure[];

function classificationForSettlement(
  settlement: SandboxCommandNonExitSettlement,
): SandboxCommandExecutionClassification {
  switch (settlement) {
    case 'failed_without_exit':
      return freezeClassification({
        settlement,
        outcome: 'failed',
        cause: 'missing_exit_code',
        retryable: false,
        exitCode: null,
        anomaly: 'missing_exit_code',
      });
    case 'timeout':
      return freezeClassification({
        settlement,
        outcome: 'timed_out',
        cause: 'settlement_unknown',
        retryable: true,
        exitCode: null,
      });
    case 'transport':
      return freezeClassification({
        settlement,
        outcome: 'failed',
        cause: 'transport_failed',
        retryable: true,
        exitCode: null,
      });
    case 'protocol':
      return freezeClassification({
        settlement,
        outcome: 'failed',
        cause: 'protocol_failed',
        retryable: false,
        exitCode: null,
      });
    case 'cancellation':
      return freezeClassification({
        settlement,
        outcome: 'cancelled',
        cause: 'cancelled',
        retryable: false,
        exitCode: null,
      });
    case 'indeterminate':
      return freezeClassification({
        settlement,
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
        exitCode: null,
      });
  }
}

function sandboxCommandSettlementFromError(
  error: unknown,
): SandboxCommandNonExitSettlement | null {
  if (
    !isObjectRecord(error) ||
    error.code !== 'sandbox_command_settlement_error' ||
    typeof error.settlement !== 'string' ||
    !SANDBOX_COMMAND_NON_EXIT_SETTLEMENTS.includes(
      error.settlement as SandboxCommandNonExitSettlement,
    )
  ) {
    return null;
  }
  return error.settlement as SandboxCommandNonExitSettlement;
}

function sandboxCommandOutputSettlementFromError(
  error: unknown,
): SandboxCommandOutputSettlementFailure | null {
  if (
    !isObjectRecord(error) ||
    error.code !== 'sandbox_command_output_settlement_error' ||
    typeof error.settlement !== 'string' ||
    !SANDBOX_COMMAND_OUTPUT_SETTLEMENT_FAILURES.includes(
      error.settlement as SandboxCommandOutputSettlementFailure,
    )
  ) {
    return null;
  }
  return error.settlement as SandboxCommandOutputSettlementFailure;
}

function validateSandboxCommandExecutionClassification(
  value: SandboxCommandExecutionClassification,
): SandboxCommandExecutionClassification {
  if (!isPlainRecord(value)) throw new SandboxCommandClassificationError();
  const settlement = value.settlement;
  if (settlement === 'exit') {
    const expectedCause = value.exitCode === 0 ? null : 'command_failed';
    const expectedOutcome = value.exitCode === 0 ? 'succeeded' : 'failed';
    if (
      Object.keys(value).length !== 5 ||
      !Number.isSafeInteger(value.exitCode) ||
      value.outcome !== expectedOutcome ||
      value.cause !== expectedCause ||
      value.retryable !== false
    ) {
      throw new SandboxCommandClassificationError();
    }
    return freezeClassification(value);
  }
  if (
    typeof settlement !== 'string' ||
    !SANDBOX_COMMAND_NON_EXIT_SETTLEMENTS.includes(
      settlement as SandboxCommandNonExitSettlement,
    )
  ) {
    throw new SandboxCommandClassificationError();
  }
  const canonical = classificationForSettlement(
    settlement as SandboxCommandNonExitSettlement,
  );
  const canonicalAnomaly =
    'anomaly' in canonical ? canonical.anomaly : undefined;
  const valueAnomaly = 'anomaly' in value ? value.anomaly : undefined;
  if (
    Object.keys(value).length !== Object.keys(canonical).length ||
    value.outcome !== canonical.outcome ||
    value.cause !== canonical.cause ||
    value.retryable !== canonical.retryable ||
    value.exitCode !== canonical.exitCode ||
    valueAnomaly !== canonicalAnomaly
  ) {
    throw new SandboxCommandClassificationError();
  }
  return canonical;
}

function freezeClassification<T extends SandboxCommandExecutionClassification>(
  classification: T,
): T {
  return Object.freeze({ ...classification });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorHasNameOrCode(
  error: unknown,
  name: string,
  code: string,
): boolean {
  return (
    isObjectRecord(error) &&
    (error.name === name || error.code === code)
  );
}

function errorHasCode(error: unknown, code: string): boolean {
  return isObjectRecord(error) && error.code === code;
}

function singleQuoteValue(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function shellQuote(value: string): string {
  return `'${singleQuoteValue(value)}'`;
}
