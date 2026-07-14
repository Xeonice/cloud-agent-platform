import {
  PUBLIC_ERROR_CODES,
  PUBLIC_V1_REST_ERROR_PROJECTION,
  type PublicErrorCode,
} from '@cap/contracts';

export interface PublicErrorSemantics<Retryable extends boolean = boolean> {
  readonly retryable: Retryable;
  readonly defaultMessage: string;
}

/**
 * Transport-neutral behavior for every stable public error code.
 *
 * Keep retryability here so REST and MCP cannot independently reinterpret the
 * same failure. The mapped types below require both transports to use the exact
 * boolean literal declared for each code.
 */
export const PUBLIC_ERROR_SEMANTICS = {
  validation_failed: {
    retryable: false,
    defaultMessage: 'Validation failed.',
  },
  insufficient_scope: {
    retryable: false,
    defaultMessage: 'The caller does not have the required scope.',
  },
  owner_required: {
    retryable: false,
    defaultMessage: 'An account owner is required.',
  },
  not_found: {
    retryable: false,
    defaultMessage: 'The requested resource was not found.',
  },
  conflict: {
    retryable: false,
    defaultMessage: 'The request conflicts with the current resource state.',
  },
  rate_limited: {
    retryable: true,
    defaultMessage: 'Request capacity is temporarily exhausted.',
  },
  temporarily_unavailable: {
    retryable: true,
    defaultMessage: 'The service is temporarily unavailable.',
  },
  runtime_model_not_available: {
    retryable: false,
    defaultMessage: 'The requested runtime model is not available.',
  },
  runtime_model_catalog_unavailable: {
    retryable: true,
    defaultMessage: 'The runtime model catalog is temporarily unavailable.',
  },
} as const satisfies Record<PublicErrorCode, PublicErrorSemantics>;

export type PublicErrorRetryable<Code extends PublicErrorCode> =
  (typeof PUBLIC_ERROR_SEMANTICS)[Code]['retryable'];

export interface RestPublicErrorMapping<
  Retryable extends boolean = boolean,
> {
  readonly status: number;
  readonly error: string;
  readonly retryable: Retryable;
  readonly projection: typeof PUBLIC_V1_REST_ERROR_PROJECTION;
}

type RestPublicErrorMap = {
  readonly [Code in PublicErrorCode]: RestPublicErrorMapping<
    PublicErrorRetryable<Code>
  >;
};

/**
 * REST selects status and the legacy Nest-style status/message projection by
 * stable code. The stable code remains an internal selection key and is not
 * added to a historical response body by this mapping.
 */
export const REST_PUBLIC_ERROR_MAP = {
  validation_failed: {
    status: 400,
    error: 'Bad Request',
    retryable: false,
    projection: PUBLIC_V1_REST_ERROR_PROJECTION,
  },
  insufficient_scope: {
    status: 403,
    error: 'Forbidden',
    retryable: false,
    projection: PUBLIC_V1_REST_ERROR_PROJECTION,
  },
  owner_required: {
    status: 403,
    error: 'Forbidden',
    retryable: false,
    projection: PUBLIC_V1_REST_ERROR_PROJECTION,
  },
  not_found: {
    status: 404,
    error: 'Not Found',
    retryable: false,
    projection: PUBLIC_V1_REST_ERROR_PROJECTION,
  },
  conflict: {
    status: 409,
    error: 'Conflict',
    retryable: false,
    projection: PUBLIC_V1_REST_ERROR_PROJECTION,
  },
  rate_limited: {
    status: 429,
    error: 'Too Many Requests',
    retryable: true,
    projection: PUBLIC_V1_REST_ERROR_PROJECTION,
  },
  temporarily_unavailable: {
    status: 503,
    error: 'Service Unavailable',
    retryable: true,
    projection: PUBLIC_V1_REST_ERROR_PROJECTION,
  },
  runtime_model_not_available: {
    status: 422,
    error: 'Unprocessable Entity',
    retryable: false,
    projection: PUBLIC_V1_REST_ERROR_PROJECTION,
  },
  runtime_model_catalog_unavailable: {
    status: 503,
    error: 'Service Unavailable',
    retryable: true,
    projection: PUBLIC_V1_REST_ERROR_PROJECTION,
  },
} as const satisfies Record<PublicErrorCode, RestPublicErrorMapping> &
  RestPublicErrorMap;

export interface McpPublicErrorMapping<
  Retryable extends boolean = boolean,
> {
  readonly jsonRpcCode: number;
  readonly retryable: Retryable;
}

type McpPublicErrorMap = {
  readonly [Code in PublicErrorCode]: McpPublicErrorMapping<
    PublicErrorRetryable<Code>
  >;
};

/**
 * JSON-RPC uses the standard invalid-params code and server-reserved codes for
 * application failures. Stable semantic identity is carried separately in the
 * safe MCP data envelope.
 */
export const MCP_PUBLIC_ERROR_MAP = {
  validation_failed: { jsonRpcCode: -32602, retryable: false },
  insufficient_scope: { jsonRpcCode: -32001, retryable: false },
  owner_required: { jsonRpcCode: -32002, retryable: false },
  not_found: { jsonRpcCode: -32004, retryable: false },
  conflict: { jsonRpcCode: -32009, retryable: false },
  rate_limited: { jsonRpcCode: -32029, retryable: true },
  temporarily_unavailable: { jsonRpcCode: -32053, retryable: true },
  runtime_model_not_available: { jsonRpcCode: -32022, retryable: false },
  runtime_model_catalog_unavailable: {
    jsonRpcCode: -32053,
    retryable: true,
  },
} as const satisfies Record<PublicErrorCode, McpPublicErrorMapping> &
  McpPublicErrorMap;

/** Runtime assertion used by parity tests and dynamic registry verification. */
export function assertPublicErrorMappingComplete(
  codes: readonly string[],
  mapping: Readonly<Record<string, unknown>>,
  mappingName: string,
): void {
  const expected = new Set(codes);
  const actual = new Set(Object.keys(mapping));
  const missing = codes.filter((code) => !actual.has(code));
  const extra = [...actual].filter((code) => !expected.has(code));

  if (missing.length === 0 && extra.length === 0) return;

  const parts = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
    extra.length > 0 ? `extra: ${extra.join(', ')}` : '',
  ].filter(Boolean);
  throw new Error(`${mappingName} public error mapping is incomplete (${parts.join('; ')})`);
}

assertPublicErrorMappingComplete(
  PUBLIC_ERROR_CODES,
  REST_PUBLIC_ERROR_MAP,
  'REST',
);
assertPublicErrorMappingComplete(
  PUBLIC_ERROR_CODES,
  MCP_PUBLIC_ERROR_MAP,
  'MCP',
);
