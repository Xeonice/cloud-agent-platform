import {
  SandboxCoreError,
  isSandboxCleanupCoordinationPendingError,
} from './errors.js';

/** Closed, secret-free physical cleanup outcomes shared by every provider. */
export const SANDBOX_PHYSICAL_CLEANUP_OUTCOMES = [
  'succeeded',
  'failed',
  'indeterminate',
] as const;

export type SandboxPhysicalCleanupOutcome =
  (typeof SANDBOX_PHYSICAL_CLEANUP_OUTCOMES)[number];

export const SANDBOX_PHYSICAL_CLEANUP_PROOFS = [
  'found-and-cleaned',
  'already-absent',
] as const;

export type SandboxPhysicalCleanupProof =
  (typeof SANDBOX_PHYSICAL_CLEANUP_PROOFS)[number];

/** Prisma `Int` and PostgreSQL `INTEGER` share this upper bound. */
export const SANDBOX_CLEANUP_ATTEMPT_MAX = 2_147_483_647 as const;

/**
 * Provider-neutral result of one physical cleanup attempt.
 *
 * This shape deliberately cannot carry an exception, message, provider id,
 * endpoint, command, output, body, or arbitrary metadata. A successful result
 * requires affirmative provider proof; an acknowledgement without proof is
 * indeterminate rather than success.
 */
export type SandboxPhysicalCleanupResult =
  | {
      readonly outcome: 'succeeded';
      readonly proof: SandboxPhysicalCleanupProof;
      readonly cause: null;
      readonly retryable: false;
    }
  | {
      readonly outcome: 'failed';
      readonly proof: null;
      readonly cause: 'cleanup_failed';
      readonly retryable: boolean;
    }
  | {
      readonly outcome: 'indeterminate';
      readonly proof: null;
      readonly cause: 'cleanup_unconfirmed';
      readonly retryable: true;
    };

/** Bounded latest-attempt evidence persisted next to the cleanup authority. */
export interface SandboxCleanupAttemptEvidence {
  /** CAP-generated correlation identity; never a provider resource id. */
  readonly attemptId: string;
  /** One-based identity inside one SandboxRun cleanup lineage. */
  readonly attempt: number;
  readonly outcome: SandboxPhysicalCleanupOutcome;
  readonly proof: SandboxPhysicalCleanupProof | null;
  readonly cause: 'cleanup_failed' | 'cleanup_unconfirmed' | null;
  readonly retryable: boolean;
  readonly observedAt: Date;
}

export type SettleSandboxCleanupAttemptResult =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'replayed' }
  | { readonly kind: 'stale' | 'conflict' };

/** @deprecated Use SettleSandboxCleanupAttemptResult. */
export type RecordSandboxCleanupAttemptResult =
  SettleSandboxCleanupAttemptResult;

export type BeginSandboxCleanupAttemptResult =
  | {
      /** This caller exclusively owns the physical action for this identity. */
      readonly kind: 'allocated';
      readonly evidence: SandboxCleanupAttemptEvidence;
    }
  | {
      /** The same allocator response was replayed; do not repeat the action. */
      readonly kind: 'replayed';
      readonly evidence: SandboxCleanupAttemptEvidence;
    }
  | {
      /** Another attempt identity already owns the physical action. */
      readonly kind: 'in-flight';
      readonly evidence: SandboxCleanupAttemptEvidence;
    }
  | { readonly kind: 'stale' | 'conflict' };

/** Existing adapters use this proof-only shape during the additive rollout. */
export type LegacySandboxTeardownProof =
  | { readonly kind: 'found-and-cleaned' }
  | { readonly kind: 'already-absent' };

export class SandboxCleanupResultValidationError extends SandboxCoreError {
  constructor() {
    super(
      'Sandbox cleanup result is invalid',
      'sandbox_cleanup_result_validation_error',
    );
  }
}

/**
 * Execute only the provider's physical action and reduce every rejection to a
 * fixed safe result. Ownership/store calls must remain outside this helper so a
 * coordination failure cannot be mislabeled as a provider cleanup failure.
 */
export async function runSandboxPhysicalCleanup(
  action: () => Promise<
    void | LegacySandboxTeardownProof | SandboxPhysicalCleanupResult
  >,
): Promise<SandboxPhysicalCleanupResult> {
  try {
    return normalizeSandboxPhysicalCleanupResult(await action());
  } catch (error) {
    // Remote generation fences and provider-internal owner acknowledgements are
    // orchestration authority. Preserve the typed control signal so callers
    // retain their durable lease/slot instead of persisting it as an ordinary
    // physical `indeterminate` observation.
    if (isSandboxCleanupCoordinationPendingError(error)) throw error;
    return classifySandboxPhysicalCleanupRejection(error);
  }
}

/**
 * Keep the primary value and secondary cleanup result in separate immutable
 * slots. In particular, callers rethrow `primary` after recording `cleanup`;
 * no cleanup exception can replace it.
 */
export function preserveSandboxPrimaryWithCleanup<TPrimary>(
  primary: TPrimary,
  cleanup: SandboxPhysicalCleanupResult,
): Readonly<{
  readonly primary: TPrimary;
  readonly cleanup: SandboxPhysicalCleanupResult;
}> {
  return Object.freeze({
    primary,
    cleanup: validateSandboxPhysicalCleanupResult(cleanup),
  });
}

export function sandboxCleanupAttemptEvidence(
  attempt: number,
  attemptId: string,
  result: SandboxPhysicalCleanupResult,
  observedAt: Date = new Date(),
): SandboxCleanupAttemptEvidence {
  validateCleanupAttempt(attempt);
  validateSandboxCleanupAttemptId(attemptId);
  const cleanup = validateSandboxPhysicalCleanupResult(result);
  const timestamp = cloneValidDate(observedAt);
  return Object.freeze({
    attemptId,
    attempt,
    outcome: cleanup.outcome,
    proof: cleanup.proof,
    cause: cleanup.cause,
    retryable: cleanup.retryable,
    observedAt: timestamp,
  });
}

/** Durable placeholder written atomically before the provider action starts. */
export function sandboxCleanupAttemptPlaceholder(
  attempt: number,
  attemptId: string,
  observedAt: Date = new Date(),
): SandboxCleanupAttemptEvidence {
  return sandboxCleanupAttemptEvidence(
    attempt,
    attemptId,
    indeterminateCleanup(),
    observedAt,
  );
}

/** Rebuild the strict physical result from fixed durable evidence. */
export function sandboxPhysicalCleanupResultFromEvidence(
  evidence: SandboxCleanupAttemptEvidence,
): SandboxPhysicalCleanupResult {
  const candidate = validateSandboxCleanupAttemptEvidence(evidence);
  return validateSandboxPhysicalCleanupResult({
    outcome: candidate.outcome,
    proof: candidate.proof,
    cause: candidate.cause,
    retryable: candidate.retryable,
  } as SandboxPhysicalCleanupResult);
}

export function validateSandboxCleanupAttemptEvidence(
  value: SandboxCleanupAttemptEvidence,
): SandboxCleanupAttemptEvidence {
  const input = requirePlainRecord(value);
  requireExactKeys(input, [
    'attemptId',
    'attempt',
    'outcome',
    'proof',
    'cause',
    'retryable',
    'observedAt',
  ]);
  validateCleanupAttempt(input.attempt);
  validateSandboxCleanupAttemptId(input.attemptId);
  const cleanup = validateSandboxPhysicalCleanupResult({
    outcome: input.outcome,
    proof: input.proof,
    cause: input.cause,
    retryable: input.retryable,
  } as SandboxPhysicalCleanupResult);
  return Object.freeze({
    attemptId: input.attemptId as string,
    attempt: Number(input.attempt),
    outcome: cleanup.outcome,
    proof: cleanup.proof,
    cause: cleanup.cause,
    retryable: cleanup.retryable,
    observedAt: cloneValidDate(input.observedAt),
  });
}

export function validateSandboxPhysicalCleanupResult(
  value: SandboxPhysicalCleanupResult,
): SandboxPhysicalCleanupResult {
  const input = requirePlainRecord(value);
  requireExactKeys(input, ['outcome', 'proof', 'cause', 'retryable']);
  switch (input.outcome) {
    case 'succeeded':
      if (
        typeof input.proof !== 'string' ||
        !SANDBOX_PHYSICAL_CLEANUP_PROOFS.includes(
          input.proof as SandboxPhysicalCleanupProof,
        ) ||
        input.cause !== null ||
        input.retryable !== false
      ) {
        failValidation();
      }
      return confirmedCleanup(input.proof as SandboxPhysicalCleanupProof);
    case 'failed':
      if (
        input.proof !== null ||
        input.cause !== 'cleanup_failed' ||
        typeof input.retryable !== 'boolean'
      ) {
        failValidation();
      }
      return failedCleanup(input.retryable);
    case 'indeterminate':
      if (
        input.proof !== null ||
        input.cause !== 'cleanup_unconfirmed' ||
        input.retryable !== true
      ) {
        failValidation();
      }
      return indeterminateCleanup();
    default:
      return failValidation();
  }
}

/**
 * Additive adapter for the existing proof-only provider return. `undefined` or
 * a malformed response is not proof and therefore remains indeterminate.
 */
export function normalizeSandboxPhysicalCleanupResult(
  value: void | LegacySandboxTeardownProof | SandboxPhysicalCleanupResult,
): SandboxPhysicalCleanupResult {
  if (value === undefined) return indeterminateCleanup();
  if (isExactLegacyProof(value, 'found-and-cleaned')) {
    return confirmedCleanup('found-and-cleaned');
  }
  if (isExactLegacyProof(value, 'already-absent')) {
    return confirmedCleanup('already-absent');
  }
  try {
    return validateSandboxPhysicalCleanupResult(
      value as SandboxPhysicalCleanupResult,
    );
  } catch {
    return indeterminateCleanup();
  }
}

export function classifySandboxPhysicalCleanupRejection(
  error: unknown,
): SandboxPhysicalCleanupResult {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'sandbox_cleanup_pending'
  ) {
    return indeterminateCleanup();
  }
  // A transport/provider rejection is not proof that the resource still
  // exists, nor proof that deletion happened. Drop its private value and keep
  // the result indeterminate. Providers may return the explicit typed `failed`
  // variant only when they have definitive safe failure evidence.
  return indeterminateCleanup();
}

function confirmedCleanup(
  proof: SandboxPhysicalCleanupProof,
): SandboxPhysicalCleanupResult {
  return Object.freeze({
    outcome: 'succeeded' as const,
    proof,
    cause: null,
    retryable: false as const,
  });
}

function failedCleanup(retryable: boolean): SandboxPhysicalCleanupResult {
  return Object.freeze({
    outcome: 'failed' as const,
    proof: null,
    cause: 'cleanup_failed' as const,
    retryable,
  });
}

function indeterminateCleanup(): SandboxPhysicalCleanupResult {
  return Object.freeze({
    outcome: 'indeterminate' as const,
    proof: null,
    cause: 'cleanup_unconfirmed' as const,
    retryable: true as const,
  });
}

function isExactLegacyProof(
  value: unknown,
  kind: LegacySandboxTeardownProof['kind'],
): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'kind' && value.kind === kind;
}

function requirePlainRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) failValidation();
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    failValidation();
  }
}

function cloneValidDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    failValidation();
  }
  return new Date(value.getTime());
}

function validateCleanupAttempt(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) <= 0 ||
    Number(value) > SANDBOX_CLEANUP_ATTEMPT_MAX
  ) {
    failValidation();
  }
}

export function validateSandboxCleanupAttemptId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    failValidation();
  }
  return value;
}

function failValidation(): never {
  throw new SandboxCleanupResultValidationError();
}
