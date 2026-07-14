import {
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  PublicErrorCodeSchema,
  PublicErrorEnvelopeSchema,
  PublicErrorSafeDetailsSchema,
  RuntimeModelErrorSchema,
  type PublicErrorCode,
  type PublicErrorEnvelope,
  type PublicErrorSafeDetails,
  type PublicRestErrorProjection,
  type PublicV1OperationShape,
  type RuntimeModelError,
} from '@cap/contracts';
import { ZodError } from 'zod';
import {
  MCP_PUBLIC_ERROR_MAP,
  PUBLIC_ERROR_SEMANTICS,
  REST_PUBLIC_ERROR_MAP,
} from './public-error-mappings';

const MAX_LEGACY_DEPTH = 8;
const MAX_LEGACY_COLLECTION_SIZE = 200;

const FORBIDDEN_PUBLIC_KEYS = new Set([
  'apikey',
  'authorization',
  'cause',
  'cookie',
  'credential',
  'credentials',
  'diagnostic',
  'diagnostics',
  'input',
  'internalerror',
  'password',
  'providerdiagnostic',
  'providerdiagnostics',
  'providerresponse',
  'rawproviderresponse',
  'secret',
  'stack',
  'stacktrace',
  'token',
  'upstreamresponse',
]);

const SENSITIVE_TEXT_PATTERNS = [
  /(?:^|\n)\s*at\s+(?:async\s+)?\S+\s*\(/i,
  /(?:^|\n)(?:error|typeerror|rangeerror|referenceerror):[^\n]*(?:\n|$)/i,
  /\b(?:api[_ -]?key|authorization|password|secret|token)\s*[:=]\s*\S+/i,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /\b(?:provider diagnostic|raw provider response|upstream response body)\b/i,
] as const;

export interface LegacyRestErrorProjection {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface PublicSurfaceErrorInit {
  readonly code: PublicErrorCode;
  readonly message?: string;
  readonly details?: unknown;
  readonly legacyRest?: LegacyRestErrorProjection;
  readonly internalCause?: unknown;
}

/**
 * Transport-neutral error selected by a stable public code.
 *
 * Details are parsed through the contracts allowlist. The internal cause is
 * deliberately non-enumerable and every transport projection below rebuilds a
 * safe payload instead of serializing this Error instance.
 */
export class PublicSurfaceError extends Error {
  readonly code: PublicErrorCode;
  readonly retryable: boolean;
  readonly details?: PublicErrorSafeDetails;
  readonly legacyRest?: LegacyRestErrorProjection;
  declare readonly internalCause?: unknown;

  constructor(init: PublicSurfaceErrorInit) {
    const semantics = PUBLIC_ERROR_SEMANTICS[init.code];
    const message = assertSafePublicText(
      init.message ?? semantics.defaultMessage,
      'public error message',
    );
    super(message);
    this.name = 'PublicSurfaceError';
    this.code = init.code;
    this.retryable = semantics.retryable;

    if (init.details !== undefined) {
      const parsed = PublicErrorSafeDetailsSchema.safeParse(init.details);
      if (!parsed.success) {
        throw new TypeError('Public error details contain non-allowlisted fields.');
      }
      this.details = Object.freeze(parsed.data);
    }

    if (init.legacyRest !== undefined) {
      this.legacyRest = freezeLegacyProjection(init.legacyRest);
    }

    if (init.internalCause !== undefined) {
      Object.defineProperty(this, 'internalCause', {
        configurable: false,
        enumerable: false,
        value: init.internalCause,
        writable: false,
      });
    }
  }
}

export interface NormalizePublicSurfaceFailureOptions {
  /** Explicitly disambiguates failures such as owner-vs-scope authorization. */
  readonly code?: PublicErrorCode;
  readonly message?: string;
  readonly details?: unknown;
  readonly legacyRest?: LegacyRestErrorProjection;
}

/**
 * Normalize current Nest/Zod/domain failures at a public adapter boundary.
 * Unknown failures fail closed to a generic unavailable error; their original
 * message, stack, and provider payload are retained only as a non-enumerable
 * internal cause.
 */
export function normalizePublicSurfaceFailure(
  failure: unknown,
  options: NormalizePublicSurfaceFailureOptions = {},
): PublicSurfaceError {
  if (failure instanceof PublicSurfaceError) {
    if (noOverrides(options)) return failure;
    return new PublicSurfaceError({
      code: options.code ?? failure.code,
      message: options.message ?? failure.message,
      ...(options.details !== undefined
        ? { details: options.details }
        : failure.details !== undefined
          ? { details: failure.details }
          : {}),
      ...(options.legacyRest !== undefined
        ? { legacyRest: options.legacyRest }
        : failure.legacyRest !== undefined
          ? { legacyRest: failure.legacyRest }
          : {}),
      internalCause: failure.internalCause ?? failure,
    });
  }

  const observed = observeFailure(failure);
  const code = options.code ?? inferPublicErrorCode(observed);
  const fallbackMessage = PUBLIC_ERROR_SEMANTICS[code].defaultMessage;
  const message = safeTextOrFallback(
    options.message ?? observed.message,
    fallbackMessage,
  );
  const legacyRest =
    options.legacyRest ?? safeObservedLegacyProjection(observed, code);

  return new PublicSurfaceError({
    code,
    message,
    ...(options.details !== undefined ? { details: options.details } : {}),
    ...(legacyRest !== undefined ? { legacyRest } : {}),
    internalCause: failure,
  });
}

export interface RestPublicErrorResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly projection: (typeof REST_PUBLIC_ERROR_MAP)[PublicErrorCode]['projection'];
}

/** Project a normalized error without adding its stable code to legacy REST. */
export function projectPublicSurfaceErrorToRest(
  error: PublicSurfaceError,
): RestPublicErrorResponse {
  const mapping = REST_PUBLIC_ERROR_MAP[error.code];
  if (error.legacyRest !== undefined) {
    return {
      status: error.legacyRest.status,
      body: error.legacyRest.body,
      headers: error.legacyRest.headers ?? Object.freeze({}),
      projection: mapping.projection,
    };
  }

  const headers = retryAfterHeaders(error.details);
  return {
    status: mapping.status,
    body: Object.freeze({
      message: error.message,
      error: mapping.error,
      statusCode: mapping.status,
    }),
    headers,
    projection: mapping.projection,
  };
}

/**
 * Project a REST failure through the exact operation registry entry.
 *
 * Explicit compatibility variants own their status, body projector, and
 * response/header schemas. A normalized legacy response cannot silently pick a
 * different status, undeclared header, or body shape. This function is the one
 * REST error boundary used by Public V1 guards, interceptors, and route-specific
 * framework guards.
 */
export function projectPublicV1SurfaceErrorToRest(
  operation: PublicV1OperationShape,
  error: PublicSurfaceError,
): RestPublicErrorResponse {
  if (!operation.errors.includes(error.code)) {
    throw new TypeError(
      `Undeclared public error for ${operation.id}: ${error.code}`,
    );
  }

  const candidates = (operation.restErrorProjections ?? []).filter(
    (projection) => projection.code === error.code,
  );
  if (candidates.length === 0) {
    const projected = projectPublicSurfaceErrorToRest(error);
    const expectedStatus = REST_PUBLIC_ERROR_MAP[error.code].status;
    if (projected.status !== expectedStatus) {
      throw new TypeError(
        `Undeclared REST error status for ${operation.id}/${error.code}: ${projected.status}`,
      );
    }
    return projected;
  }

  const runtimeModelError = runtimeModelDomainError(error);
  const matches = candidates.filter((projection) =>
    restProjectionMatches(projection, runtimeModelError),
  );
  if (matches.length !== 1) {
    throw new TypeError(
      `REST error projector selection failed for ${operation.id}/${error.code}`,
    );
  }

  const projection = matches[0]!;
  const projected = applyRestErrorProjector(
    projection,
    error,
    runtimeModelError,
  );
  if (!projection.responseSchema.safeParse(projected.body).success) {
    throw new TypeError(
      `REST error body failed its registry schema for ${operation.id}/${error.code}`,
    );
  }
  if (projection.headersSchema) {
    if (!projection.headersSchema.safeParse(projected.headers).success) {
      throw new TypeError(
        `REST error headers failed their registry schema for ${operation.id}/${error.code}`,
      );
    }
  } else if (Object.keys(projected.headers).length > 0) {
    throw new TypeError(
      `Undeclared REST error headers for ${operation.id}/${error.code}`,
    );
  }

  return {
    ...projected,
    projection: REST_PUBLIC_ERROR_MAP[error.code].projection,
  };
}

function restProjectionMatches(
  projection: PublicRestErrorProjection,
  runtimeModelError: RuntimeModelError | undefined,
): boolean {
  if (projection.projector.kind !== 'runtime-model-domain-error') {
    return true;
  }
  if (runtimeModelError?.code !== projection.code) return false;
  if (runtimeModelError.code === 'runtime_model_not_available') return true;
  if (runtimeModelError.capacity === undefined) {
    return projection.projector.includeWithoutCapacity === true;
  }
  return (projection.projector.capacityScopes ?? []).includes(
    runtimeModelError.capacity.scope,
  );
}

function applyRestErrorProjector(
  projection: PublicRestErrorProjection,
  error: PublicSurfaceError,
  runtimeModelError: RuntimeModelError | undefined,
): Omit<RestPublicErrorResponse, 'projection'> {
  switch (projection.projector.kind) {
    case 'fixed-body': {
      const fixed = freezeLegacyProjection({
        status: projection.status,
        body: projection.projector.body,
      });
      return {
        status: projection.status,
        body: fixed.body,
        headers: Object.freeze({}),
      };
    }
    case 'legacy-body': {
      if (error.legacyRest === undefined) {
        throw new TypeError(
          `REST legacy-body projector requires a normalized legacy response for ${projection.code}`,
        );
      }
      return {
        status: projection.status,
        body: error.legacyRest.body,
        headers: error.legacyRest.headers ?? Object.freeze({}),
      };
    }
    case 'runtime-model-domain-error': {
      if (runtimeModelError === undefined) {
        throw new TypeError(
          `REST runtime-model projector requires a canonical domain error for ${projection.code}`,
        );
      }
      return {
        status: projection.status,
        body: error.legacyRest?.body ?? runtimeModelError,
        headers: runtimeModelRetryAfterHeaders(runtimeModelError),
      };
    }
  }
}

function runtimeModelDomainError(
  error: PublicSurfaceError,
): RuntimeModelError | undefined {
  if (
    error.code !== 'runtime_model_not_available' &&
    error.code !== 'runtime_model_catalog_unavailable'
  ) {
    return undefined;
  }
  const parsed = RuntimeModelErrorSchema.safeParse(error.legacyRest?.body);
  return parsed.success ? parsed.data : undefined;
}

function runtimeModelRetryAfterHeaders(
  error: RuntimeModelError,
): Readonly<Record<string, string>> {
  if (
    error.code !== 'runtime_model_catalog_unavailable' ||
    error.capacity === undefined
  ) {
    return Object.freeze({});
  }
  return Object.freeze({
    'Retry-After': String(
      Math.max(1, Math.ceil(error.capacity.retryAfterMs / 1_000)),
    ),
  });
}

export interface McpPublicErrorResponse {
  readonly jsonRpcCode: number;
  readonly message: string;
  readonly data: PublicErrorEnvelope;
}

/** MCP exposes the stable code only in its declared safe data envelope. */
export function projectPublicSurfaceErrorToMcp(
  error: PublicSurfaceError,
): McpPublicErrorResponse {
  const mapping = MCP_PUBLIC_ERROR_MAP[error.code];
  const data = PublicErrorEnvelopeSchema.parse({
    code: error.code,
    message: error.message,
    retryable: mapping.retryable,
    ...(error.details !== undefined ? { details: error.details } : {}),
  });
  return Object.freeze({
    jsonRpcCode: mapping.jsonRpcCode,
    message: error.message,
    data: Object.freeze(data),
  });
}

interface ObservedFailure {
  readonly status?: number;
  readonly response?: unknown;
  readonly message?: string;
  readonly declaredCode?: PublicErrorCode;
}

function observeFailure(failure: unknown): ObservedFailure {
  const zodIssues = observedZodIssues(failure);
  if (zodIssues !== undefined) {
    const message = publicZodIssueMessage(zodIssues[0]);
    return {
      status: HttpStatus.BAD_REQUEST,
      response: {
        message: 'Validation failed',
        issues: zodIssues,
      },
      // A complete ZodError message can contain deeply nested union diagnostics
      // and user input. Public transports only need one stable validation
      // verdict; the normalizer below still applies the shared length and
      // sensitive-text checks before exposing this summary.
      message,
      declaredCode: 'validation_failed',
    };
  }

  if (failure instanceof HttpException) {
    const response = failure.getResponse();
    return {
      status: failure.getStatus(),
      response,
      message: responseMessage(response),
      declaredCode: responsePublicCode(response),
    };
  }

  const domainError = recordValue(failure, 'domainError');
  const domainCode = responsePublicCode(domainError);
  if (domainCode !== undefined) {
    return {
      status: REST_PUBLIC_ERROR_MAP[domainCode].status,
      response: domainError,
      message: responseMessage(domainError),
      declaredCode: domainCode,
    };
  }

  const directCode = responsePublicCode(failure);
  if (directCode !== undefined) {
    return {
      status: REST_PUBLIC_ERROR_MAP[directCode].status,
      response: failure,
      message: responseMessage(failure),
      declaredCode: directCode,
    };
  }

  return {};
}

/**
 * Contract schemas can be loaded through a different workspace copy of Zod
 * than the API package. Keep the fast nominal check, then accept only Zod's
 * narrow public error shape so validation failures normalize consistently
 * across package boundaries without treating arbitrary errors as safe input.
 */
function observedZodIssues(
  failure: unknown,
): ReadonlyArray<{
  readonly message?: unknown;
  readonly path?: unknown;
}> | undefined {
  if (failure instanceof ZodError) return failure.issues;
  if (failure === null || typeof failure !== 'object') return undefined;

  const candidate = failure as { readonly name?: unknown; readonly issues?: unknown };
  if (candidate.name !== 'ZodError' || !Array.isArray(candidate.issues)) {
    return undefined;
  }
  return candidate.issues as ReadonlyArray<{
    readonly message?: unknown;
    readonly path?: unknown;
  }>;
}

function publicZodIssueMessage(issue: {
  readonly message?: unknown;
  readonly path?: unknown;
} | undefined): string {
  const message =
    typeof issue?.message === 'string' && issue.message.trim().length > 0
      ? issue.message
      : 'Validation failed';
  if (message !== 'Invalid input' || !Array.isArray(issue?.path)) {
    return message;
  }

  const field = [...issue.path]
    .reverse()
    .find(
      (segment): segment is string =>
        typeof segment === 'string' &&
        /^[A-Za-z][A-Za-z0-9_-]{0,119}$/u.test(segment),
    );
  return field ? `${field}: ${message}` : message;
}

function inferPublicErrorCode(observed: ObservedFailure): PublicErrorCode {
  switch (observed.status) {
    case HttpStatus.BAD_REQUEST:
      return 'validation_failed';
    case HttpStatus.UNAUTHORIZED:
    case HttpStatus.FORBIDDEN:
      return isOwnerFailure(observed.response)
        ? 'owner_required'
        : 'insufficient_scope';
    case HttpStatus.NOT_FOUND:
      return 'not_found';
    case HttpStatus.CONFLICT:
      return 'conflict';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'rate_limited';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return observed.declaredCode === 'runtime_model_not_available'
        ? observed.declaredCode
        : 'validation_failed';
    case HttpStatus.BAD_GATEWAY:
    case HttpStatus.SERVICE_UNAVAILABLE:
    case HttpStatus.GATEWAY_TIMEOUT:
      return observed.declaredCode === 'runtime_model_catalog_unavailable'
        ? observed.declaredCode
        : 'temporarily_unavailable';
    default:
      return observed.declaredCode ?? 'temporarily_unavailable';
  }
}

function safeObservedLegacyProjection(
  observed: ObservedFailure,
  code: PublicErrorCode,
): LegacyRestErrorProjection | undefined {
  if (observed.status === undefined || observed.response === undefined) {
    return undefined;
  }

  try {
    return freezeLegacyProjection({
      status: observed.status,
      body: observed.response,
      ...(code === 'rate_limited' ? retryAfterFromResponse(observed.response) : {}),
    });
  } catch {
    // Unsafe legacy bodies are not forwarded. The caller receives the stable,
    // generic default projection while the original failure remains internal.
    return undefined;
  }
}

function freezeLegacyProjection(
  projection: LegacyRestErrorProjection,
): LegacyRestErrorProjection {
  if (!Number.isInteger(projection.status) || projection.status < 400 || projection.status > 599) {
    throw new TypeError('Legacy REST error status must be an HTTP error status.');
  }

  const headers = projection.headers
    ? sanitizeHeaders(projection.headers)
    : undefined;
  const frozen = {
    status: projection.status,
    body: sanitizeLegacyValue(projection.body, 0),
    ...(headers !== undefined ? { headers } : {}),
  };
  return Object.freeze(frozen);
}

function sanitizeLegacyValue(value: unknown, depth: number): unknown {
  if (depth > MAX_LEGACY_DEPTH) {
    throw new TypeError('Legacy REST body is too deeply nested.');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return assertSafePublicText(value, 'legacy REST body text');
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LEGACY_COLLECTION_SIZE) {
      throw new TypeError('Legacy REST body collection is too large.');
    }
    return Object.freeze(
      value.map((entry) => sanitizeLegacyValue(entry, depth + 1)),
    );
  }
  if (!isPlainRecord(value)) {
    throw new TypeError('Legacy REST body contains a non-JSON value.');
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_LEGACY_COLLECTION_SIZE) {
    throw new TypeError('Legacy REST body object is too large.');
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (FORBIDDEN_PUBLIC_KEYS.has(normalizeKey(key))) {
      throw new TypeError(`Legacy REST body contains forbidden field: ${key}`);
    }
    result[key] = sanitizeLegacyValue(entry, depth + 1);
  }
  return Object.freeze(result);
}

function sanitizeHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (normalized !== 'retry-after') {
      throw new TypeError(`Legacy REST error header is not allowlisted: ${name}`);
    }
    if (/[\r\n]/.test(value)) {
      throw new TypeError('Legacy REST error header contains a line break.');
    }
    result['Retry-After'] = assertSafePublicText(value, 'Retry-After header');
  }
  return Object.freeze(result);
}

function retryAfterHeaders(
  details: PublicErrorSafeDetails | undefined,
): Readonly<Record<string, string>> {
  if (details?.retryAfterSeconds === undefined) return Object.freeze({});
  return Object.freeze({
    'Retry-After': String(details.retryAfterSeconds),
  });
}

function retryAfterFromResponse(
  response: unknown,
): Pick<LegacyRestErrorProjection, 'headers'> | undefined {
  const retryAfterSeconds = recordNumber(response, 'retryAfterSeconds');
  if (retryAfterSeconds === undefined || retryAfterSeconds < 0) return undefined;
  return {
    headers: Object.freeze({
      'Retry-After': String(Math.ceil(retryAfterSeconds)),
    }),
  };
}

function responsePublicCode(value: unknown): PublicErrorCode | undefined {
  const code = recordValue(value, 'code');
  const parsed = PublicErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : undefined;
}

function responseMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const message = recordValue(value, 'message');
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    const first = message.find((entry): entry is string => typeof entry === 'string');
    return first;
  }
  return undefined;
}

function isOwnerFailure(value: unknown): boolean {
  const error = recordValue(value, 'error');
  const message = responseMessage(value);
  return (
    error === 'schedule_owner_required' ||
    (typeof message === 'string' && /\bowner\b.*\brequired\b/i.test(message))
  );
}

function safeTextOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try {
    return assertSafePublicText(value, 'public error message');
  } catch {
    return fallback;
  }
}

function assertSafePublicText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || value.length > 1_024) {
    throw new TypeError(`${label} must contain 1-1024 characters.`);
  }
  if (SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new TypeError(`${label} contains private diagnostic material.`);
  }
  return value;
}

function noOverrides(options: NormalizePublicSurfaceFailureOptions): boolean {
  return (
    options.code === undefined &&
    options.message === undefined &&
    options.details === undefined &&
    options.legacyRest === undefined
  );
}

function recordValue(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function recordNumber(value: unknown, key: string): number | undefined {
  const candidate = recordValue(value, key);
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}
