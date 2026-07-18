import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PUBLIC_ERROR_CODES,
  PUBLIC_V1_OPERATIONS,
  type PublicErrorCode,
  type PublicRestErrorProjection,
  type PublicV1OperationShape,
} from '@cap/contracts';
import { z } from 'zod';
import {
  assertPublicErrorMappingComplete,
  MCP_PUBLIC_ERROR_MAP,
  PUBLIC_ERROR_SEMANTICS,
  REST_PUBLIC_ERROR_MAP,
} from './public-error-mappings';
import {
  normalizePublicSurfaceFailure,
  projectPublicSurfaceErrorToMcp,
  projectPublicSurfaceErrorToRest,
  projectPublicV1SurfaceErrorToRest,
  PublicSurfaceError,
} from './public-surface-error';
import { RuntimeModelPreflightError } from '../runtime-models/runtime-model-preflight.error';

test('REST and MCP maps are exact and share retryability semantics', () => {
  const expected = [...PUBLIC_ERROR_CODES].sort();
  assert.deepEqual(Object.keys(REST_PUBLIC_ERROR_MAP).sort(), expected);
  assert.deepEqual(Object.keys(MCP_PUBLIC_ERROR_MAP).sort(), expected);

  for (const code of PUBLIC_ERROR_CODES) {
    assert.equal(
      REST_PUBLIC_ERROR_MAP[code].retryable,
      PUBLIC_ERROR_SEMANTICS[code].retryable,
      `REST retryability drifted for ${code}`,
    );
    assert.equal(
      MCP_PUBLIC_ERROR_MAP[code].retryable,
      PUBLIC_ERROR_SEMANTICS[code].retryable,
      `MCP retryability drifted for ${code}`,
    );
  }

  assert.throws(
    () =>
      assertPublicErrorMappingComplete(
        [...PUBLIC_ERROR_CODES, 'future_public_failure'],
        REST_PUBLIC_ERROR_MAP,
        'REST fixture',
      ),
    /missing: future_public_failure/,
  );
  assert.throws(
    () =>
      assertPublicErrorMappingComplete(
        PUBLIC_ERROR_CODES,
        { ...MCP_PUBLIC_ERROR_MAP, stale_failure: {} },
        'MCP fixture',
      ),
    /extra: stale_failure/,
  );

  const omittedCode = PUBLIC_ERROR_CODES[0];
  const missingMapping: Record<string, unknown> = {
    ...REST_PUBLIC_ERROR_MAP,
  };
  delete missingMapping[omittedCode];
  assert.throws(
    () =>
      assertPublicErrorMappingComplete(
        PUBLIC_ERROR_CODES,
        missingMapping,
        'removed mapping mutation',
      ),
    new RegExp(`missing: ${omittedCode}`, 'u'),
  );
});

test('normalized Nest failures keep legacy REST status and message bodies', () => {
  const validation = new BadRequestException({
    message: 'Validation failed',
    issues: [
      {
        code: 'invalid_type',
        path: ['prompt'],
        message: 'Required',
      },
    ],
  });
  const scope = new ForbiddenException(
    'Insufficient scope: tasks:write required',
  );
  const owner = new ForbiddenException({
    error: 'schedule_owner_required',
    message: 'An account owner is required',
  });
  const notFound = new NotFoundException('Task not found');
  const conflict = new ConflictException('Idempotency key conflicts');
  const rateLimit = new HttpException('Too many task create requests', 429);
  const unavailable = new ServiceUnavailableException(
    'Task execution is temporarily unavailable',
  );

  const cases: ReadonlyArray<{
    readonly failure: HttpException;
    readonly code: PublicErrorCode;
  }> = [
    { failure: validation, code: 'validation_failed' },
    { failure: scope, code: 'insufficient_scope' },
    { failure: owner, code: 'owner_required' },
    { failure: notFound, code: 'not_found' },
    { failure: conflict, code: 'conflict' },
    { failure: rateLimit, code: 'rate_limited' },
    { failure: unavailable, code: 'temporarily_unavailable' },
  ];

  for (const entry of cases) {
    const normalized = normalizePublicSurfaceFailure(entry.failure);
    const rest = projectPublicSurfaceErrorToRest(normalized);
    assert.equal(normalized.code, entry.code);
    assert.equal(rest.status, entry.failure.getStatus());
    assert.deepEqual(rest.body, entry.failure.getResponse());
    if (isRecord(rest.body)) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(rest.body, 'code'),
        false,
        `${entry.code} must not add a stable code to a legacy REST body`,
      );
    }
    assert.equal(rest.projection.exposesStableCode, false);
  }
});

test('Zod and runtime-model domain failures normalize without transport coupling', () => {
  const parsed = z.object({ prompt: z.string().min(1) }).safeParse({});
  assert.equal(parsed.success, false);
  if (parsed.success) throw new Error('expected validation fixture to fail');

  const validation = normalizePublicSurfaceFailure(parsed.error);
  assert.equal(validation.code, 'validation_failed');
  assert.equal(validation.message, 'Required');
  assert.equal(projectPublicSurfaceErrorToRest(validation).status, 400);

  const nestedUnion = z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('daily'), time: z.string() }),
      z.object({ kind: z.literal('interval'), minutes: z.literal(5) }),
    ])
    .safeParse({ kind: 'interval', minutes: 7 });
  assert.equal(nestedUnion.success, false);
  if (nestedUnion.success) throw new Error('expected union fixture to fail');
  const nestedValidation = normalizePublicSurfaceFailure(nestedUnion.error);
  assert.equal(nestedValidation.code, 'validation_failed');
  assert.equal(nestedValidation.message, 'Invalid literal value, expected 5');

  const fieldUnion = z
    .object({ intervalMinutes: z.union([z.literal(5), z.literal(10)]) })
    .safeParse({ intervalMinutes: 7 });
  assert.equal(fieldUnion.success, false);
  if (fieldUnion.success) throw new Error('expected field union fixture to fail');
  assert.equal(
    normalizePublicSurfaceFailure(fieldUnion.error).message,
    'intervalMinutes: Invalid input',
  );

  const modelUnavailableBody = {
    code: 'runtime_model_not_available',
    message: 'The requested runtime model is not available.',
    retryable: false,
  } as const;
  const modelUnavailable = normalizePublicSurfaceFailure({
    domainError: modelUnavailableBody,
  });
  assert.equal(modelUnavailable.code, 'runtime_model_not_available');
  assert.equal(projectPublicSurfaceErrorToRest(modelUnavailable).status, 422);
  assert.deepEqual(
    projectPublicSurfaceErrorToRest(modelUnavailable).body,
    modelUnavailableBody,
  );

  const classWrappedModelUnavailable = normalizePublicSurfaceFailure(
    new RuntimeModelPreflightError(modelUnavailableBody),
  );
  assert.equal(
    classWrappedModelUnavailable.code,
    'runtime_model_not_available',
  );

  const catalogUnavailable = normalizePublicSurfaceFailure({
    domainError: {
      code: 'runtime_model_catalog_unavailable',
      message: 'Runtime model catalog is temporarily unavailable.',
      retryable: true,
      capacity: { scope: 'owner', retryAfterMs: 1_500 },
    },
  });
  assert.equal(catalogUnavailable.code, 'runtime_model_catalog_unavailable');
  assert.equal(projectPublicSurfaceErrorToRest(catalogUnavailable).status, 503);

  const diagnosticsUnavailable = normalizePublicSurfaceFailure(
    new ServiceUnavailableException({
      code: 'task_provisioning_diagnostics_unavailable',
      message: 'Task provisioning diagnostics are temporarily unavailable.',
      retryable: true,
    }),
  );
  assert.equal(
    diagnosticsUnavailable.code,
    'task_provisioning_diagnostics_unavailable',
  );
  assert.equal(
    projectPublicSurfaceErrorToRest(diagnosticsUnavailable).status,
    503,
  );
  assert.equal(
    projectPublicSurfaceErrorToMcp(diagnosticsUnavailable).data.retryable,
    true,
  );
});

test('every registry REST error projector validates its live status, body, and headers', () => {
  for (const exactOperation of PUBLIC_V1_OPERATIONS) {
    const operation: PublicV1OperationShape = exactOperation;
    for (const projection of operation.restErrorProjections ?? []) {
      const error = errorForProjection(projection);
      const projected = projectPublicV1SurfaceErrorToRest(operation, error);
      assert.equal(
        projected.status,
        projection.status,
        `${operation.id}/${projection.code} status`,
      );
      assert.equal(
        projection.responseSchema.safeParse(projected.body).success,
        true,
        `${operation.id}/${projection.code} body`,
      );
      if (projection.headersSchema) {
        assert.equal(
          projection.headersSchema.safeParse(projected.headers).success,
          true,
          `${operation.id}/${projection.code} headers`,
        );
      } else {
        assert.deepEqual(projected.headers, {});
      }
    }
  }
});

test('operation-aware REST projection separates principal 429 from service 503 and fails closed', () => {
  const operation = operationById('runtimeModels.query');

  const principal = normalizePublicSurfaceFailure(
    new RuntimeModelPreflightError({
      code: 'runtime_model_catalog_unavailable',
      message: 'Runtime model catalog request capacity is temporarily exhausted.',
      retryable: true,
      capacity: { scope: 'principal', retryAfterMs: 1_501 },
    }),
  );
  const principalRest = projectPublicV1SurfaceErrorToRest(
    operation,
    principal,
  );
  assert.equal(principalRest.status, 429);
  assert.deepEqual(principalRest.headers, { 'Retry-After': '2' });

  const owner = normalizePublicSurfaceFailure(
    new RuntimeModelPreflightError({
      code: 'runtime_model_catalog_unavailable',
      message: 'Runtime model catalog is temporarily unavailable.',
      retryable: true,
      capacity: { scope: 'owner', retryAfterMs: 2_001 },
    }),
  );
  const ownerRest = projectPublicV1SurfaceErrorToRest(operation, owner);
  assert.equal(ownerRest.status, 503);
  assert.deepEqual(ownerRest.headers, { 'Retry-After': '3' });

  const service = normalizePublicSurfaceFailure(
    new RuntimeModelPreflightError({
      code: 'runtime_model_catalog_unavailable',
      message: 'Runtime model catalog is temporarily unavailable.',
      retryable: true,
    }),
  );
  assert.equal(
    projectPublicV1SurfaceErrorToRest(operation, service).status,
    503,
  );

  assert.throws(
    () =>
      projectPublicV1SurfaceErrorToRest(
        operationById('tasks.get'),
        owner,
      ),
    /Undeclared public error/u,
  );

  const driftedLegacyStatus = normalizePublicSurfaceFailure(
    new HttpException(
      { message: 'Task not found', error: 'Not Found', statusCode: 404 },
      418,
    ),
    { code: 'not_found' },
  );
  assert.throws(
    () =>
      projectPublicV1SurfaceErrorToRest(
        operationById('tasks.get'),
        driftedLegacyStatus,
      ),
    /Undeclared REST error status/u,
  );
});

test('REST keeps stable codes internal while MCP emits the safe envelope', () => {
  const error = new PublicSurfaceError({
    code: 'rate_limited',
    message: 'Try again shortly.',
    details: {
      operationId: 'tasks.create',
      retryAfterSeconds: 7,
      limit: 10,
    },
  });

  assert.equal(error.retryable, true);
  const rest = projectPublicSurfaceErrorToRest(error);
  assert.equal(rest.status, 429);
  assert.deepEqual(rest.headers, { 'Retry-After': '7' });
  assert.deepEqual(rest.body, {
    message: 'Try again shortly.',
    error: 'Too Many Requests',
    statusCode: 429,
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(rest.body as object, 'code'),
    false,
  );

  const mcp = projectPublicSurfaceErrorToMcp(error);
  assert.equal(mcp.jsonRpcCode, MCP_PUBLIC_ERROR_MAP.rate_limited.jsonRpcCode);
  assert.deepEqual(mcp.data, {
    code: 'rate_limited',
    message: 'Try again shortly.',
    retryable: true,
    details: {
      operationId: 'tasks.create',
      retryAfterSeconds: 7,
      limit: 10,
    },
  });
});

test('safe-detail allowlist rejects stacks, secrets, and provider diagnostics', () => {
  for (const details of [
    { stack: 'Error: database failure' },
    { credential: 'mcp_secret_value' },
    { providerDiagnostic: 'raw upstream payload' },
    { authorization: 'Bearer secret-token' },
  ]) {
    assert.throws(
      () =>
        new PublicSurfaceError({
          code: 'temporarily_unavailable',
          details,
        }),
      /non-allowlisted fields/,
    );
  }

  for (const message of [
    'Error: provider failed\n    at Provider.call (/private/provider.ts:42:3)',
    'api_key=sk-private-value',
    'Authorization: Bearer private-token-value',
    'Raw provider response body: internal details',
  ]) {
    assert.throws(
      () =>
        new PublicSurfaceError({
          code: 'temporarily_unavailable',
          message,
        }),
      /private diagnostic material/,
    );
  }

  assert.throws(
    () =>
      new PublicSurfaceError({
        code: 'temporarily_unavailable',
        legacyRest: {
          status: 503,
          body: {
            message: 'Provider unavailable',
            providerDiagnostic: 'upstream request id and response body',
          },
        },
      }),
    /forbidden field/,
  );
});

test('unsafe operational failures downgrade to generic public projections', () => {
  const unsafe = new ServiceUnavailableException({
    message: 'Authorization: Bearer private-token-value',
    providerDiagnostic: 'Raw provider response body',
    stack: 'Error: upstream failed\n    at Provider.call (/private/provider.ts:42:3)',
  });
  const normalized = normalizePublicSurfaceFailure(unsafe);
  const rest = projectPublicSurfaceErrorToRest(normalized);
  const mcp = projectPublicSurfaceErrorToMcp(normalized);
  const serialized = JSON.stringify({ rest, mcp });

  assert.equal(normalized.code, 'temporarily_unavailable');
  assert.equal(
    normalized.message,
    PUBLIC_ERROR_SEMANTICS.temporarily_unavailable.defaultMessage,
  );
  assert.deepEqual(rest.body, {
    message: PUBLIC_ERROR_SEMANTICS.temporarily_unavailable.defaultMessage,
    error: 'Service Unavailable',
    statusCode: 503,
  });
  assert.doesNotMatch(serialized, /private-token|providerDiagnostic|stack|upstream failed/i);
  assert.equal(Object.keys(normalized).includes('internalCause'), false);

  const unknown = normalizePublicSurfaceFailure(
    new Error('secret=private-value\n    at internal (/private/file.ts:1:1)'),
  );
  assert.equal(
    unknown.message,
    PUBLIC_ERROR_SEMANTICS.temporarily_unavailable.defaultMessage,
  );
  assert.doesNotMatch(
    JSON.stringify({
      rest: projectPublicSurfaceErrorToRest(unknown),
      mcp: projectPublicSurfaceErrorToMcp(unknown),
    }),
    /private-value|private\/file/,
  );
});

function errorForProjection(
  projection: PublicRestErrorProjection,
): PublicSurfaceError {
  switch (projection.projector.kind) {
    case 'fixed-body':
      return new PublicSurfaceError({ code: projection.code });
    case 'legacy-body':
      return new PublicSurfaceError({
        code: projection.code,
        legacyRest: {
          status: projection.status,
          body: {
            reason: 'runtime not configured',
            runtime: 'claude-code',
            message: 'runtime "claude-code" is not configured',
          },
        },
      });
    case 'runtime-model-domain-error': {
      if (projection.code === 'runtime_model_not_available') {
        return normalizePublicSurfaceFailure(
          new RuntimeModelPreflightError({
            code: 'runtime_model_not_available',
            message: 'The requested runtime model is not available.',
            retryable: false,
          }),
        );
      }
      const capacityScope = projection.projector.capacityScopes?.[0];
      return normalizePublicSurfaceFailure(
        new RuntimeModelPreflightError({
          code: 'runtime_model_catalog_unavailable',
          message: 'Runtime model catalog is temporarily unavailable.',
          retryable: true,
          ...(capacityScope
            ? {
                capacity: {
                  scope: capacityScope,
                  retryAfterMs: 1_501,
                },
              }
            : {}),
        }),
      );
    }
  }
}

function operationById(id: string): PublicV1OperationShape {
  const operation = PUBLIC_V1_OPERATIONS.find((entry) => entry.id === id);
  assert.ok(operation, `missing operation ${id}`);
  return operation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
