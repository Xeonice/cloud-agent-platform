import { z, type AnyZodObject, type ZodTypeAny } from 'zod';

import { SessionHistorySchema } from './session-history.js';
import {
  CreateScheduleRequestParseSchema,
  CreateScheduleRequestSchema,
  CreateScheduleRequestWireSchema,
  DispatchScheduleRequestParseSchema,
  DispatchScheduleRequestSchema,
  DispatchScheduleRequestWireSchema,
  ScheduleOwnerRequiredErrorSchema,
  ScheduleResponseSchema,
  UpdateScheduleRequestParseSchema,
  UpdateScheduleRequestSchema,
  UpdateScheduleRequestWireSchema,
  V1ListScheduleRunsResponseSchema,
  V1ListSchedulesResponseSchema,
  V1ScheduleListQuerySchema,
} from './schedule.js';
import { RepoSchema, RuntimeSchema, TaskResponseSchema } from './task.js';
import {
  RuntimeModelCatalogUnavailableErrorSchema,
  RuntimeModelCatalogQuerySchema,
  RuntimeModelCatalogSchema,
  RuntimeModelNotAvailableErrorSchema,
} from './runtime-model.js';
import {
  TaskProvisioningDiagnosticsUnavailableErrorSchema,
} from './task-provisioning-diagnostics-capability.js';
import {
  TaskProvisioningDiagnosticsQuerySchema,
  TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES,
  TaskProvisioningDiagnosticsResponseSchema,
} from './task-provisioning-diagnostics.js';
import type { Scope } from './scope.js';
import {
  V1CreateTaskRequestSchema,
  V1ListQuerySchema,
  V1ListReposResponseSchema,
  V1ListTasksResponseSchema,
  V1TaskEventSchema,
} from './v1.js';

/** HTTP methods used by the public, versioned data API. */
export type PublicV1Method = 'get' | 'post' | 'patch' | 'delete';

/** Operation-specific failures beyond shared validation/auth/not-found errors. */
export type PublicV1AdditionalErrorStatus = 404 | 409 | 422 | 429 | 503;

/** Stable, transport-neutral failures understood by every public adapter. */
export const PUBLIC_ERROR_CODES = [
  'validation_failed',
  'insufficient_scope',
  'owner_required',
  'not_found',
  'conflict',
  'rate_limited',
  'temporarily_unavailable',
  'runtime_model_not_available',
  'runtime_model_catalog_unavailable',
  'task_provisioning_diagnostics_unavailable',
] as const;
export const PublicErrorCodeSchema = z.enum(PUBLIC_ERROR_CODES);
export type PublicErrorCode = z.infer<typeof PublicErrorCodeSchema>;

/**
 * Details that may cross a public boundary. The strict allowlist deliberately
 * has no generic metadata/provider/diagnostic bag, so secrets and stack traces
 * cannot be forwarded by accident.
 */
export const PublicErrorSafeDetailsSchema = z
  .object({
    field: z.string().trim().min(1).max(120).optional(),
    resourceType: z
      .enum(['task', 'repo', 'schedule', 'runtime-model', 'request'])
      .optional(),
    resourceId: z.string().trim().min(1).max(256).optional(),
    operationId: z.string().trim().min(1).max(160).optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type PublicErrorSafeDetails = z.infer<
  typeof PublicErrorSafeDetailsSchema
>;

export const PublicErrorEnvelopeSchema = z
  .object({
    code: PublicErrorCodeSchema,
    message: z.string().trim().min(1).max(1_024),
    retryable: z.boolean(),
    details: PublicErrorSafeDetailsSchema.optional(),
  })
  .strict();
export type PublicErrorEnvelope = z.infer<typeof PublicErrorEnvelopeSchema>;

/** Historical 503 body emitted when the selected runtime is not configured. */
export const RuntimeNotConfiguredErrorSchema = z
  .object({
    reason: z.literal('runtime not configured'),
    runtime: RuntimeSchema,
    message: z.string().trim().min(1),
  })
  .strict();

/** One field-owning object and the runtime parser derived from it. */
export interface PublicSchemaPair<
  Wire extends AnyZodObject = AnyZodObject,
  Parse extends ZodTypeAny = Wire,
> {
  readonly wire: Wire;
  readonly parse: Parse;
  readonly jsonSchemaOverlay?: Readonly<Record<string, unknown>>;
}

export function definePublicSchemaPair<
  const Wire extends AnyZodObject,
  const Parse extends ZodTypeAny,
>(
  wire: Wire,
  parse: Parse,
  jsonSchemaOverlay?: Readonly<Record<string, unknown>>,
): PublicSchemaPair<Wire, Parse> {
  assertPublicSchemaPairLineage(wire, parse);
  return {
    wire,
    parse,
    ...(jsonSchemaOverlay ? { jsonSchemaOverlay } : {}),
  };
}

/**
 * Fail closed if a runtime parser is paired with an independently authored
 * object. Current canonical parse schemas may only be the wire object itself or
 * a chain of refinements/transforms/defaults wrapping that exact object.
 */
export function assertPublicSchemaPairLineage(
  wire: AnyZodObject,
  parse: ZodTypeAny,
): void {
  let candidate: ZodTypeAny = parse;
  const seen = new Set<ZodTypeAny>();
  while (candidate !== wire) {
    if (seen.has(candidate)) {
      throw new TypeError('Public parse schema contains a wrapper cycle.');
    }
    seen.add(candidate);
    if (candidate instanceof z.ZodEffects) {
      candidate = candidate.innerType();
      continue;
    }
    if (candidate instanceof z.ZodDefault) {
      candidate = candidate.removeDefault();
      continue;
    }
    throw new TypeError(
      'Public parse schema must derive from its exact wire schema.',
    );
  }
}

/** Merge canonical field owners without restating their shape in a transport. */
export function composePublicInputWireSchema<A extends AnyZodObject>(
  first: A,
): A;
export function composePublicInputWireSchema<
  A extends AnyZodObject,
  B extends AnyZodObject,
>(first: A, second: B): z.ZodObject<A['shape'] & B['shape']>;
export function composePublicInputWireSchema<
  A extends AnyZodObject,
  B extends AnyZodObject,
  C extends AnyZodObject,
>(
  first: A,
  second: B,
  third: C,
): z.ZodObject<A['shape'] & B['shape'] & C['shape']>;
export function composePublicInputWireSchema(
  first: AnyZodObject,
  ...rest: readonly AnyZodObject[]
): AnyZodObject {
  const fieldNames = new Set(Object.keys(first.shape));
  return rest.reduce((combined, schema) => {
    for (const fieldName of Object.keys(schema.shape)) {
      if (fieldNames.has(fieldName)) {
        throw new Error(
          `Public input projection contains duplicate field: ${fieldName}`,
        );
      }
      fieldNames.add(fieldName);
    }
    return combined.merge(schema);
  }, first);
}

export type PublicInputSource = 'params' | 'query' | 'body';

/** How canonical REST input sections are flattened into one MCP tool object. */
export interface PublicInputProjection {
  readonly sources: readonly PublicInputSource[];
  readonly omittedHeaders?: readonly string[];
}

export interface PublicOutputProjection {
  readonly schema: ZodTypeAny;
  readonly reason: string;
}

export type PublicProtocolDifference =
  | {
      readonly kind: 'rest-only-header';
      readonly field: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'mcp-compatibility-text';
      readonly reason: string;
    }
  | {
      readonly kind: 'success-projection';
      readonly reason: string;
    }
  | {
      readonly kind: 'mcp-description-projection';
      readonly reason: string;
    }
  | {
      readonly kind: 'rate-limit-policy';
      readonly reason: string;
    }
  | {
      /**
       * The MCP SDK currently requires one root Zod object for `outputSchema`.
       * A canonical object union therefore has to advertise a derived, wider
       * object shape while execution still validates canonical structured data.
       */
      readonly kind: 'mcp-output-schema-relaxation';
      readonly reason: string;
    };

/** How a public REST operation is represented on the MCP surface. */
export type PublicV1McpMapping =
  | {
      readonly tool: string;
      /** Transport-specific copy when the HTTP description would mislead MCP clients. */
      readonly description?: string;
      readonly inputProjection: PublicInputProjection;
      readonly outputProjection: 'canonical' | PublicOutputProjection;
      readonly differences: readonly PublicProtocolDifference[];
    }
  | { readonly excluded: string };

export type PublicOwnerPolicy = 'optional' | 'required';

export interface PublicOperationInputSchemas {
  readonly params?: PublicSchemaPair<AnyZodObject, ZodTypeAny>;
  readonly query?: PublicSchemaPair<AnyZodObject, ZodTypeAny>;
  readonly headers?: PublicSchemaPair<AnyZodObject, ZodTypeAny>;
  readonly body?: PublicSchemaPair<AnyZodObject, ZodTypeAny>;
}

export const PUBLIC_REST_ERROR_PROJECTOR_KINDS = [
  'fixed-body',
  'legacy-body',
  'runtime-model-domain-error',
] as const;
export type PublicRestErrorProjectorKind =
  (typeof PUBLIC_REST_ERROR_PROJECTOR_KINDS)[number];

export type PublicRestErrorProjector =
  | {
      /** A registry-owned compatibility body, such as the schedule owner error. */
      readonly kind: 'fixed-body';
      readonly body: unknown;
    }
  | {
      /** Preserve a sanitized legacy HttpException body after schema validation. */
      readonly kind: 'legacy-body';
    }
  | {
      /** Preserve a canonical runtime-model domain error and derive Retry-After. */
      readonly kind: 'runtime-model-domain-error';
      readonly capacityScopes?: readonly ('principal' | 'owner' | 'global')[];
      readonly includeWithoutCapacity?: boolean;
    };

/** An explicit REST compatibility/status projection for one stable error. */
export interface PublicRestErrorProjection {
  readonly code: PublicErrorCode;
  readonly status: number;
  readonly responseSchema: ZodTypeAny;
  readonly headersSchema?: AnyZodObject;
  readonly projector: PublicRestErrorProjector;
  readonly reason: string;
}

/** One JSON response example owned by the canonical operation registry. */
export interface PublicResponseExample {
  readonly summary: string;
  readonly value: unknown;
}

export type PublicRestOutputProjection =
  | { readonly kind: 'canonical' }
  | {
      readonly kind: 'legacy-validated-handler-value';
      readonly reason: string;
    };

/**
 * Existing REST handlers are schema-validated without silently rewriting their
 * already-established bytes. Every operation must opt into this policy (or a
 * future canonical projection) so REST/MCP output asymmetry cannot be implicit.
 */
export const PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION = Object.freeze({
  kind: 'legacy-validated-handler-value',
  reason:
    'Validate the canonical success schema while preserving the established REST handler value.',
} as const satisfies PublicRestOutputProjection);

/** New operations return their canonical validated contract without legacy framing. */
export const PUBLIC_V1_CANONICAL_REST_SUCCESS_PROJECTION = Object.freeze({
  kind: 'canonical',
} as const satisfies PublicRestOutputProjection);

/**
 * One public `/v1` data operation.
 *
 * This manifest is transport-neutral contract metadata. The API projects it into
 * OpenAPI, the console projects it into the API Playground, and MCP uses the
 * explicit mapping to prevent capability drift. Controller implementation remains
 * in `apps/api`; a reflection test compares those real decorators with this list.
 */
export interface PublicV1OperationShape {
  readonly id: string;
  readonly method: PublicV1Method;
  /** OpenAPI-style path template (`{id}`, not Nest's `:id`). */
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly scope: Scope;
  readonly ownerPolicy: PublicOwnerPolicy;
  readonly streaming: boolean;
  readonly destructive: boolean;
  readonly restOutputProjection: PublicRestOutputProjection;
  /** Canonical schema pairs used by every transport projection. */
  readonly input: PublicOperationInputSchemas;
  readonly paramsSchema?: AnyZodObject;
  readonly querySchema?: AnyZodObject;
  readonly headersSchema?: AnyZodObject;
  readonly requestSchema?: ZodTypeAny;
  readonly successStatus: number;
  readonly responseDescription: string;
  /** The complete HTTP response body schema, including transport framing. */
  readonly responseSchema: ZodTypeAny | null;
  /** Canonical examples projected by OpenAPI and the API Playground. */
  readonly responseExamples?: Readonly<Record<string, PublicResponseExample>>;
  readonly responseContentType?: string;
  /** JSON payload carried by each SSE `data:` field, when streaming. */
  readonly streamEventSchema?: ZodTypeAny;
  readonly additionalErrorStatuses?: readonly PublicV1AdditionalErrorStatus[];
  readonly errors: readonly PublicErrorCode[];
  readonly restErrorProjections?: readonly PublicRestErrorProjection[];
  readonly mcp: PublicV1McpMapping;
}

export function assertPublicV1OperationUniqueness(
  operations: readonly PublicV1OperationShape[],
): void {
  const ids = new Set<string>();
  const restRoutes = new Set<string>();
  const mcpTools = new Set<string>();

  for (const operation of operations) {
    if (ids.has(operation.id)) {
      throw new Error(`Duplicate public operation id: ${operation.id}`);
    }
    ids.add(operation.id);

    const restRoute = `${operation.method.toUpperCase()} ${operation.path}`;
    if (restRoutes.has(restRoute)) {
      throw new Error(`Duplicate public REST route: ${restRoute}`);
    }
    restRoutes.add(restRoute);

    const mcpDecision = operation.mcp as PublicV1McpMapping | undefined;
    if (!mcpDecision || typeof mcpDecision !== 'object') {
      throw new Error(
        `Missing MCP protocol decision for public operation: ${operation.id}`,
      );
    }

    if ('tool' in mcpDecision) {
      if (mcpTools.has(mcpDecision.tool)) {
        throw new Error(`Duplicate public MCP tool: ${mcpDecision.tool}`);
      }
      mcpTools.add(mcpDecision.tool);

      const projectedSources = new Set(mcpDecision.inputProjection.sources);
      if (
        projectedSources.size !== mcpDecision.inputProjection.sources.length
      ) {
        throw new Error(
          `Duplicate MCP input source for public operation: ${operation.id}`,
        );
      }
      const canonicalSources = (['params', 'query', 'body'] as const).filter(
        (source) => operation.input[source] !== undefined,
      );
      if (
        canonicalSources.length !== projectedSources.size ||
        canonicalSources.some((source) => !projectedSources.has(source))
      ) {
        throw new Error(
          `Incomplete MCP input projection for public operation: ${operation.id}`,
        );
      }

      const headerFields = Object.keys(operation.input.headers?.wire.shape ?? {});
      const omittedHeaders = mcpDecision.inputProjection.omittedHeaders ?? [];
      if (
        headerFields.length !== omittedHeaders.length ||
        headerFields.some((field) => !omittedHeaders.includes(field))
      ) {
        throw new Error(
          `Incomplete MCP header decision for public operation: ${operation.id}`,
        );
      }

      const successProjectionDifferences = mcpDecision.differences.filter(
        (difference) => difference.kind === 'success-projection',
      );
      const descriptionDifferences = mcpDecision.differences.filter(
        (difference) => difference.kind === 'mcp-description-projection',
      );
      const restOnlyHeaderDifferences = mcpDecision.differences.filter(
        (difference) => difference.kind === 'rest-only-header',
      );
      const outputSchemaRelaxations = mcpDecision.differences.filter(
        (difference) => difference.kind === 'mcp-output-schema-relaxation',
      );
      if (
        (mcpDecision.outputProjection === 'canonical') ===
        (successProjectionDifferences.length > 0)
      ) {
        throw new Error(
          `MCP success projection decision does not match its implementation for public operation: ${operation.id}`,
        );
      }
      if (successProjectionDifferences.length > 1) {
        throw new Error(
          `Duplicate MCP success projection difference for public operation: ${operation.id}`,
        );
      }
      if (
        (mcpDecision.description !== undefined) !==
        (descriptionDifferences.length === 1)
      ) {
        throw new Error(
          `MCP description projection decision does not match its implementation for public operation: ${operation.id}`,
        );
      }
      if (
        mcpDecision.description !== undefined &&
        mcpDecision.description.trim().length === 0
      ) {
        throw new Error(
          `Empty MCP description projection for public operation: ${operation.id}`,
        );
      }
      if (descriptionDifferences.length > 1) {
        throw new Error(
          `Duplicate MCP description projection difference for public operation: ${operation.id}`,
        );
      }
      const projectedOutputSchema =
        mcpDecision.outputProjection === 'canonical'
          ? operation.responseSchema
          : mcpDecision.outputProjection.schema;
      const requiresOutputSchemaRelaxation =
        projectedOutputSchema !== null &&
        !('shape' in projectedOutputSchema && projectedOutputSchema.shape);
      if (
        requiresOutputSchemaRelaxation !==
        (outputSchemaRelaxations.length === 1)
      ) {
        throw new Error(
          `MCP output schema relaxation decision does not match its implementation for public operation: ${operation.id}`,
        );
      }
      if (outputSchemaRelaxations.length > 1) {
        throw new Error(
          `Duplicate MCP output schema relaxation difference for public operation: ${operation.id}`,
        );
      }
      const restOnlyHeaderFields = new Set(
        restOnlyHeaderDifferences.map((difference) => difference.field),
      );
      if (
        restOnlyHeaderFields.size !== restOnlyHeaderDifferences.length ||
        omittedHeaders.length !== restOnlyHeaderFields.size ||
        omittedHeaders.some((field) => !restOnlyHeaderFields.has(field))
      ) {
        throw new Error(
          `MCP REST-only header differences do not match omitted headers for public operation: ${operation.id}`,
        );
      }

      for (const difference of mcpDecision.differences) {
        if (difference.reason.trim().length === 0) {
          throw new Error(
            `Empty protocol-difference reason for public operation: ${operation.id}`,
          );
        }
      }
    } else if ('excluded' in mcpDecision) {
      if (mcpDecision.excluded.trim().length === 0) {
        throw new Error(
          `Empty MCP exclusion reason for public operation: ${operation.id}`,
        );
      }
    } else {
      throw new Error(
        `Missing MCP protocol decision for public operation: ${operation.id}`,
      );
    }

    const declaredErrors = new Set(operation.errors);
    if (declaredErrors.size !== operation.errors.length) {
      throw new Error(
        `Duplicate public error code for public operation: ${operation.id}`,
      );
    }
    for (const requiredCode of [
      'validation_failed',
      'insufficient_scope',
    ] as const) {
      if (!declaredErrors.has(requiredCode)) {
        throw new Error(
          `Missing boundary error ${requiredCode} for public operation: ${operation.id}`,
        );
      }
    }
    if (
      operation.ownerPolicy === 'required' &&
      !declaredErrors.has('owner_required')
    ) {
      throw new Error(
        `Missing boundary error owner_required for public operation: ${operation.id}`,
      );
    }

    const errorProjectionKeys = new Set<string>();
    const errorProjectionsByCode = new Map<
      PublicErrorCode,
      PublicRestErrorProjection[]
    >();
    const restOutputProjection = operation.restOutputProjection as
      | PublicRestOutputProjection
      | undefined;
    if (restOutputProjection === undefined) {
      throw new Error(
        `Missing REST output projection for public operation: ${operation.id}`,
      );
    }
    if (
      restOutputProjection.kind === 'legacy-validated-handler-value' &&
      restOutputProjection.reason.trim().length === 0
    ) {
      throw new Error(
        `Empty REST output projection reason for public operation: ${operation.id}`,
      );
    }
    const responseExamples = operation.responseExamples ?? {};
    if (Object.keys(responseExamples).length > 0 && operation.responseSchema === null) {
      throw new Error(
        `Response examples require a response schema for public operation: ${operation.id}`,
      );
    }
    for (const [name, example] of Object.entries(responseExamples)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
        throw new Error(
          `Invalid response example name for public operation: ${operation.id}/${name}`,
        );
      }
      if (example.summary.trim().length === 0) {
        throw new Error(
          `Empty response example summary for public operation: ${operation.id}/${name}`,
        );
      }
      if (!operation.responseSchema?.safeParse(example.value).success) {
        throw new Error(
          `Invalid response example for public operation: ${operation.id}/${name}`,
        );
      }
      try {
        if (JSON.stringify(example.value) === undefined) {
          throw new TypeError('response example is not JSON serializable');
        }
      } catch {
        throw new Error(
          `Non-JSON response example for public operation: ${operation.id}/${name}`,
        );
      }
    }
    for (const projection of operation.restErrorProjections ?? []) {
      if (!operation.errors.includes(projection.code)) {
        throw new Error(
          `REST error projection uses undeclared code for public operation: ${operation.id}/${projection.code}`,
        );
      }
      if (
        !Number.isInteger(projection.status) ||
        projection.status < 400 ||
        projection.status > 599
      ) {
        throw new Error(
          `Invalid REST error status for public operation: ${operation.id}/${projection.status}`,
        );
      }
      if (projection.reason.trim().length === 0) {
        throw new Error(
          `Empty REST error projection reason for public operation: ${operation.id}/${projection.code}`,
        );
      }
      const key = `${projection.code}:${projection.status}`;
      if (errorProjectionKeys.has(key)) {
        throw new Error(
          `Duplicate REST error projection for public operation: ${operation.id}/${key}`,
        );
      }
      errorProjectionKeys.add(key);

      const sameCode = errorProjectionsByCode.get(projection.code) ?? [];
      sameCode.push(projection);
      errorProjectionsByCode.set(projection.code, sameCode);

      if (!projection.responseSchema?.safeParse) {
        throw new Error(
          `Missing REST error response schema for public operation: ${operation.id}/${projection.code}`,
        );
      }
      switch (projection.projector?.kind) {
        case 'fixed-body': {
          if (!projection.responseSchema.safeParse(projection.projector.body).success) {
            throw new Error(
              `Invalid fixed REST error body for public operation: ${operation.id}/${projection.code}`,
            );
          }
          break;
        }
        case 'legacy-body':
          break;
        case 'runtime-model-domain-error': {
          if (
            projection.code !== 'runtime_model_not_available' &&
            projection.code !== 'runtime_model_catalog_unavailable'
          ) {
            throw new Error(
              `Runtime-model REST projector uses incompatible code for public operation: ${operation.id}/${projection.code}`,
            );
          }
          const scopes = projection.projector.capacityScopes ?? [];
          if (new Set(scopes).size !== scopes.length) {
            throw new Error(
              `Duplicate runtime-model capacity scope for public operation: ${operation.id}/${projection.code}`,
            );
          }
          if (
            projection.code === 'runtime_model_not_available' &&
            (scopes.length > 0 || projection.projector.includeWithoutCapacity)
          ) {
            throw new Error(
              `Runtime-model not-available projector cannot select capacity for public operation: ${operation.id}`,
            );
          }
          break;
        }
        default:
          throw new Error(
            `Missing REST error projector for public operation: ${operation.id}/${projection.code}`,
          );
      }
    }

    if (
      operation.ownerPolicy === 'required' &&
      !(errorProjectionsByCode.get('owner_required') ?? []).some(
        (projection) => projection.projector.kind === 'fixed-body',
      )
    ) {
      throw new Error(
        `Missing registry-owned owner REST projector for public operation: ${operation.id}`,
      );
    }

    for (const code of [
      'runtime_model_not_available',
      'runtime_model_catalog_unavailable',
    ] as const) {
      if (!declaredErrors.has(code)) continue;
      const projections = errorProjectionsByCode.get(code) ?? [];
      if (
        projections.length === 0 ||
        projections.some(
          (projection) =>
            projection.projector.kind !== 'runtime-model-domain-error',
        )
      ) {
        throw new Error(
          `Missing runtime-model REST projector for public operation: ${operation.id}/${code}`,
        );
      }
      if (code === 'runtime_model_not_available') continue;

      const scopes = projections.flatMap((projection) =>
        projection.projector.kind === 'runtime-model-domain-error'
          ? (projection.projector.capacityScopes ?? [])
          : [],
      );
      const expectedScopes = ['principal', 'owner', 'global'] as const;
      const withoutCapacity = projections.filter(
        (projection) =>
          projection.projector.kind === 'runtime-model-domain-error' &&
          projection.projector.includeWithoutCapacity === true,
      );
      if (
        withoutCapacity.length !== 1 ||
        scopes.length !== expectedScopes.length ||
        expectedScopes.some(
          (scope) => scopes.filter((candidate) => candidate === scope).length !== 1,
        )
      ) {
        throw new Error(
          `Incomplete runtime-model catalog REST projection for public operation: ${operation.id}`,
        );
      }
    }
  }
}

export function definePublicV1Operations<
  const Operations extends readonly PublicV1OperationShape[],
>(
  operations: Operations,
): Operations {
  assertPublicV1OperationUniqueness(operations);
  return operations;
}

/** Shared UUID path parameter for all current public by-id operations. */
export const PublicV1IdParamsSchema = z.object({
  id: z.string().uuid().describe('The resource id.'),
});

/** Diagnostics rejects transport-added parameters without changing legacy routes. */
export const TaskProvisioningDiagnosticsParamsSchema =
  PublicV1IdParamsSchema.strict();

/** Optional idempotency key accepted by public task creation. */
export const PublicV1IdempotencyHeadersSchema = z.object({
  'Idempotency-Key': z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Deduplicates retries for the same principal and request body.'),
});

/** Optional SSE resume cursor accepted by the task-event stream. */
export const PublicV1EventHeadersSchema = z.object({
  'Last-Event-ID': z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Resume after the last received lifecycle event id.'),
});

/** Retry delay header used by capacity-aware public error projections. */
export const PublicV1RetryAfterHeadersSchema = z.object({
  'Retry-After': z
    .string()
    .regex(/^\d+$/u)
    .describe('Whole seconds before retrying the request.'),
});

/** Retry-After is present only when the domain failure carries capacity data. */
export const PublicV1OptionalRetryAfterHeadersSchema = z
  .object({
    'Retry-After': z
      .string()
      .regex(/^\d+$/u)
      .optional()
      .describe('Whole seconds before retrying the request.'),
  })
  .strict();

/** Raw HTTP body returned by an SSE operation, including SSE field framing. */
export const PublicV1SseStreamSchema = z
  .string()
  .describe(
    'A text/event-stream body containing repeated `id:` and `data:` fields, ' +
      'blank-line-delimited events, and optional heartbeat comments. Each ' +
      '`data:` value is JSON conforming to the operation stream event schema.',
  );

export const PublicV1DeletionAcknowledgementSchema = z
  .object({
    id: z.string().uuid(),
    deleted: z.literal(true),
  })
  .strict();

export const PublicV1IdParamsSchemaPair = definePublicSchemaPair(
  PublicV1IdParamsSchema,
  PublicV1IdParamsSchema,
);
export const PublicV1IdempotencyHeadersSchemaPair = definePublicSchemaPair(
  PublicV1IdempotencyHeadersSchema,
  PublicV1IdempotencyHeadersSchema,
);
export const PublicV1EventHeadersSchemaPair = definePublicSchemaPair(
  PublicV1EventHeadersSchema,
  PublicV1EventHeadersSchema,
);
export const V1CreateTaskRequestSchemaPair = definePublicSchemaPair(
  V1CreateTaskRequestSchema,
  V1CreateTaskRequestSchema,
);
export const RuntimeModelCatalogQuerySchemaPair = definePublicSchemaPair(
  RuntimeModelCatalogQuerySchema,
  RuntimeModelCatalogQuerySchema,
);
export const V1ListQuerySchemaPair = definePublicSchemaPair(
  V1ListQuerySchema,
  V1ListQuerySchema,
);
export const V1ScheduleListQuerySchemaPair = definePublicSchemaPair(
  V1ScheduleListQuerySchema,
  V1ScheduleListQuerySchema,
);
export const TaskProvisioningDiagnosticsParamsSchemaPair =
  definePublicSchemaPair(
    TaskProvisioningDiagnosticsParamsSchema,
    TaskProvisioningDiagnosticsParamsSchema,
  );
export const TaskProvisioningDiagnosticsQuerySchemaPair =
  definePublicSchemaPair(
    TaskProvisioningDiagnosticsQuerySchema,
    TaskProvisioningDiagnosticsQuerySchema,
  );

export const CreateScheduleRequestSchemaPair = definePublicSchemaPair(
  CreateScheduleRequestWireSchema,
  CreateScheduleRequestParseSchema,
  {
    oneOf: [
      {
        required: ['recurrence'],
        not: { required: ['cronExpression'] },
      },
      {
        required: ['cronExpression'],
        not: { required: ['recurrence'] },
      },
    ],
  },
);
export const UpdateScheduleRequestSchemaPair = definePublicSchemaPair(
  UpdateScheduleRequestWireSchema,
  UpdateScheduleRequestParseSchema,
  {
    oneOf: [
      {
        required: ['recurrence'],
        not: {
          anyOf: [
            { required: ['cronExpression'] },
            { required: ['timezone'] },
          ],
        },
      },
      {
        required: ['cronExpression'],
        not: { required: ['recurrence'] },
      },
      {
        anyOf: [
          { required: ['name'] },
          { required: ['timezone'] },
          { required: ['taskTemplate'] },
          { required: ['enabled'] },
          { required: ['overlapPolicy'] },
          { required: ['misfirePolicy'] },
        ],
        not: {
          anyOf: [
            { required: ['recurrence'] },
            { required: ['cronExpression'] },
          ],
        },
      },
    ],
  },
);
export const DispatchScheduleRequestSchemaPair = definePublicSchemaPair(
  DispatchScheduleRequestWireSchema,
  DispatchScheduleRequestParseSchema,
);

/**
 * Existing REST errors retain Nest's historical body shape. The stable code is
 * the adapter selection key but is intentionally not injected into those
 * legacy bodies by this behavior-preserving refactor.
 */
export const PUBLIC_V1_REST_ERROR_PROJECTION = {
  kind: 'legacy-http-exception-envelope',
  exposesStableCode: false,
  reason:
    'Public V1 predates stable error codes; preserve its existing status/message envelope.',
} as const;

const COMMON_ERRORS = [
  'validation_failed',
  'insufficient_scope',
] as const satisfies readonly PublicErrorCode[];
const READ_BY_ID_ERRORS = [
  ...COMMON_ERRORS,
  'not_found',
] as const satisfies readonly PublicErrorCode[];
const OWNER_READ_BY_ID_ERRORS = [
  ...READ_BY_ID_ERRORS,
  'owner_required',
] as const satisfies readonly PublicErrorCode[];
const OWNER_WRITE_BY_ID_ERRORS = [
  ...OWNER_READ_BY_ID_ERRORS,
] as const satisfies readonly PublicErrorCode[];

const NO_MCP_DIFFERENCES = [] as const;
const BODY_INPUT = { sources: ['body'] } as const;
const QUERY_INPUT = { sources: ['query'] } as const;
const PARAMS_INPUT = { sources: ['params'] } as const;
const PARAMS_AND_BODY_INPUT = {
  sources: ['params', 'body'],
} as const;
const PARAMS_AND_QUERY_INPUT = {
  sources: ['params', 'query'],
} as const;
const SCHEDULE_OWNER_REQUIRED_BODY = Object.freeze({
  error: 'schedule_owner_required',
  message: 'Schedules require an authenticated account owner.',
});
const SCHEDULE_OWNER_REQUIRED_REST_PROJECTION = {
  code: 'owner_required',
  status: 400,
  responseSchema: ScheduleOwnerRequiredErrorSchema,
  projector: {
    kind: 'fixed-body',
    body: SCHEDULE_OWNER_REQUIRED_BODY,
  },
  reason:
    'Ownerless schedule requests keep their established 400 schedule_owner_required body.',
} as const satisfies PublicRestErrorProjection;
const RUNTIME_MODEL_OWNER_REQUIRED_BODY = Object.freeze({
  message: 'Runtime model catalogs require an authenticated account owner',
  error: 'Forbidden',
  statusCode: 403,
});
const RUNTIME_MODEL_OWNER_REQUIRED_REST_PROJECTION = {
  code: 'owner_required',
  status: 403,
  responseSchema: z
    .object({
      message: z.literal(
        'Runtime model catalogs require an authenticated account owner',
      ),
      error: z.literal('Forbidden'),
      statusCode: z.literal(403),
    })
    .strict(),
  projector: {
    kind: 'fixed-body',
    body: RUNTIME_MODEL_OWNER_REQUIRED_BODY,
  },
  reason:
    'Ownerless runtime-model catalog requests keep their established 403 body.',
} as const satisfies PublicRestErrorProjection;
const RUNTIME_NOT_CONFIGURED_REST_PROJECTION = {
  code: 'temporarily_unavailable',
  status: 503,
  responseSchema: RuntimeNotConfiguredErrorSchema,
  projector: { kind: 'legacy-body' },
  reason:
    'Runtime readiness keeps its established runtime-not-configured 503 body.',
} as const satisfies PublicRestErrorProjection;
const RUNTIME_MODEL_NOT_AVAILABLE_REST_PROJECTION = {
  code: 'runtime_model_not_available',
  status: 422,
  responseSchema: RuntimeModelNotAvailableErrorSchema,
  projector: { kind: 'runtime-model-domain-error' },
  reason:
    'Runtime-model selector failures keep their canonical 422 domain body.',
} as const satisfies PublicRestErrorProjection;
const RUNTIME_MODEL_CATALOG_UNAVAILABLE_REST_PROJECTION = {
  code: 'runtime_model_catalog_unavailable',
  status: 503,
  responseSchema: RuntimeModelCatalogUnavailableErrorSchema,
  headersSchema: PublicV1OptionalRetryAfterHeadersSchema,
  projector: {
    kind: 'runtime-model-domain-error',
    capacityScopes: ['principal', 'owner', 'global'],
    includeWithoutCapacity: true,
  },
  reason:
    'Runtime-model catalog failures keep their canonical 503 domain body and capacity Retry-After header.',
} as const satisfies PublicRestErrorProjection;
const RUNTIME_MODEL_CATALOG_PRINCIPAL_THROTTLE_REST_PROJECTION = {
  code: 'runtime_model_catalog_unavailable',
  status: 429,
  responseSchema: RuntimeModelCatalogUnavailableErrorSchema,
  headersSchema: PublicV1RetryAfterHeadersSchema,
  projector: {
    kind: 'runtime-model-domain-error',
    capacityScopes: ['principal'],
  },
  reason:
    'The dedicated Public V1 catalog request throttle keeps its established 429 body and Retry-After header.',
} as const satisfies PublicRestErrorProjection;
const RUNTIME_MODEL_CATALOG_SERVICE_REST_PROJECTION = {
  code: 'runtime_model_catalog_unavailable',
  status: 503,
  responseSchema: RuntimeModelCatalogUnavailableErrorSchema,
  headersSchema: PublicV1OptionalRetryAfterHeadersSchema,
  projector: {
    kind: 'runtime-model-domain-error',
    capacityScopes: ['owner', 'global'],
    includeWithoutCapacity: true,
  },
  reason:
    'Catalog service and probe failures keep their established 503 body and optional capacity Retry-After header.',
} as const satisfies PublicRestErrorProjection;
const TASK_PROVISIONING_DIAGNOSTICS_OWNER_REQUIRED_BODY = Object.freeze({
  code: 'owner_required',
  message:
    'Task provisioning diagnostics require an authenticated account owner.',
  retryable: false,
} as const);
const TASK_PROVISIONING_DIAGNOSTICS_OWNER_REQUIRED_REST_PROJECTION = {
  code: 'owner_required',
  status: 403,
  responseSchema: PublicErrorEnvelopeSchema,
  projector: {
    kind: 'fixed-body',
    body: TASK_PROVISIONING_DIAGNOSTICS_OWNER_REQUIRED_BODY,
  },
  reason:
    'Identity-less principals fail the required owner boundary before any task lookup.',
} as const satisfies PublicRestErrorProjection;
const TASK_PROVISIONING_DIAGNOSTICS_UNAVAILABLE_BODY = Object.freeze({
  code: 'task_provisioning_diagnostics_unavailable',
  message: 'Task provisioning diagnostics are temporarily unavailable.',
  retryable: true,
} as const);
const TASK_PROVISIONING_DIAGNOSTICS_UNAVAILABLE_REST_PROJECTION = {
  code: 'task_provisioning_diagnostics_unavailable',
  status: 503,
  responseSchema: TaskProvisioningDiagnosticsUnavailableErrorSchema,
  projector: {
    kind: 'fixed-body',
    body: TASK_PROVISIONING_DIAGNOSTICS_UNAVAILABLE_BODY,
  },
  reason:
    'Mixed API/MCP/Web deployments remain discoverable but return no diagnostic evidence until attested.',
} as const satisfies PublicRestErrorProjection;

/**
 * Canonical inventory of public `/v1` data operations.
 *
 * Metadata-only routes (`/v1/openapi.json` and `/v1/docs`) and the sandbox-only
 * internal approvals callback (`/internal/sandbox/approvals`) are deliberately
 * outside this data-operation manifest.
 */
export const PUBLIC_V1_OPERATIONS = definePublicV1Operations([
  {
    id: 'tasks.create',
    method: 'post',
    path: '/v1/tasks',
    summary: 'Create a task',
    description:
      'Atomically admit a new task and its durable provisioning work against a ' +
      'repo (`repoId` in the body), then return as soon as that acceptance is ' +
      'committed. Provisioning continues asynchronously through the same path ' +
      'as Console create; poll `tasks.get` for its additive safe progress and ' +
      'structured terminal failure, including deployment dependency failures ' +
      'with the `repair_deployment` action. Accepts an optional `Idempotency-Key` header ' +
      'for safe REST retries.',
    scope: 'tasks:write',
    ownerPolicy: 'optional',
    streaming: false,
    destructive: true,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: {
      headers: PublicV1IdempotencyHeadersSchemaPair,
      body: V1CreateTaskRequestSchemaPair,
    },
    headersSchema: PublicV1IdempotencyHeadersSchema,
    requestSchema: V1CreateTaskRequestSchema,
    successStatus: 201,
    responseDescription:
      'The accepted task with its initial optional/nullable safe provisioning summary.',
    responseSchema: TaskResponseSchema,
    additionalErrorStatuses: [404, 409, 422, 429, 503],
    errors: [
      ...COMMON_ERRORS,
      'not_found',
      'conflict',
      'rate_limited',
      'temporarily_unavailable',
      'runtime_model_not_available',
      'runtime_model_catalog_unavailable',
    ],
    restErrorProjections: [
      RUNTIME_NOT_CONFIGURED_REST_PROJECTION,
      RUNTIME_MODEL_NOT_AVAILABLE_REST_PROJECTION,
      RUNTIME_MODEL_CATALOG_UNAVAILABLE_REST_PROJECTION,
    ],
    mcp: {
      tool: 'create_task',
      description:
        'Create a sandbox task on a repo. Returns the task handle (id + status) ' +
        'immediately; provisioning proceeds asynchronously through the same ' +
        'admission the console uses. Poll get_task to a terminal status, then ' +
        'read get_transcript. Each MCP call is a distinct create: the REST-only ' +
        'Idempotency-Key header is not mapped to a tool argument.',
      inputProjection: {
        ...BODY_INPUT,
        omittedHeaders: ['Idempotency-Key'],
      },
      outputProjection: 'canonical',
      differences: [
        {
          kind: 'rest-only-header',
          field: 'Idempotency-Key',
          reason:
            'Each MCP tool call is already a distinct invocation; HTTP retry deduplication remains REST-only.',
        },
        {
          kind: 'mcp-compatibility-text',
          reason:
            'Preserve the historical MCP text handle while structuredContent remains the canonical task.',
        },
        {
          kind: 'mcp-description-projection',
          reason:
            'Explain asynchronous polling and the HTTP-only idempotency header without claiming MCP accepts that header.',
        },
        {
          kind: 'rate-limit-policy',
          reason:
            'REST keeps its dedicated task-create throttle while MCP remains subject to the MCP transport limiter.',
        },
      ],
    },
  },
  {
    id: 'runtimeModels.query',
    method: 'post',
    path: '/v1/runtime-models/query',
    summary: 'List effective runtime models',
    description:
      'Resolve the authenticated owner\'s effective model catalog for one ' +
      'runtime and omitted, deployment-default, or managed environment context. ' +
      'The request never accepts credentials or a model allowlist.',
    scope: 'tasks:write',
    ownerPolicy: 'required',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { body: RuntimeModelCatalogQuerySchemaPair },
    requestSchema: RuntimeModelCatalogQuerySchema,
    successStatus: 200,
    responseDescription: 'The effective, owner-scoped runtime model catalog.',
    responseSchema: RuntimeModelCatalogSchema,
    additionalErrorStatuses: [429, 503],
    errors: [
      ...COMMON_ERRORS,
      'owner_required',
      'runtime_model_catalog_unavailable',
    ],
    restErrorProjections: [
      RUNTIME_MODEL_OWNER_REQUIRED_REST_PROJECTION,
      RUNTIME_MODEL_CATALOG_PRINCIPAL_THROTTLE_REST_PROJECTION,
      RUNTIME_MODEL_CATALOG_SERVICE_REST_PROJECTION,
    ],
    mcp: {
      tool: 'list_runtime_models',
      inputProjection: BODY_INPUT,
      outputProjection: 'canonical',
      differences: [
        {
          kind: 'rate-limit-policy',
          reason:
            'REST applies a dedicated per-principal catalog throttle while MCP remains subject to the MCP transport limiter; both retain the shared catalog-service capacity controls.',
        },
      ],
    },
  },
  {
    id: 'tasks.list',
    method: 'get',
    path: '/v1/tasks',
    summary: 'List tasks',
    description:
      'Keyset-paginated tasks ordered by `(createdAt, id)`. Each item carries ' +
      'the same additive optional/nullable safe provisioning summary and ' +
      'structured failure projection as task create/get/stop, including the ' +
      'non-retryable deployment dependency variant.',
    scope: 'tasks:read',
    ownerPolicy: 'optional',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { query: V1ListQuerySchemaPair },
    querySchema: V1ListQuerySchema,
    successStatus: 200,
    responseDescription:
      'A page of tasks with safe provisioning/failure projections plus the next-page cursor.',
    responseSchema: V1ListTasksResponseSchema,
    errors: COMMON_ERRORS,
    mcp: {
      tool: 'list_tasks',
      inputProjection: QUERY_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'tasks.get',
    method: 'get',
    path: '/v1/tasks/{id}',
    summary: 'Get a task',
    description:
      'Fetch a single task by id. This polling read is the guaranteed observation ' +
      'floor: every status transition is persisted before the response, including ' +
      'the additive optional/nullable safe provisioning summary and structured ' +
      'failure with its canonical operator action.',
    scope: 'tasks:read',
    ownerPolicy: 'optional',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { params: PublicV1IdParamsSchemaPair },
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription:
      'The task with its current safe provisioning and structured failure projection.',
    responseSchema: TaskResponseSchema,
    errors: READ_BY_ID_ERRORS,
    mcp: {
      tool: 'get_task',
      inputProjection: PARAMS_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'tasks.provisioningDiagnostics',
    method: 'get',
    path: '/v1/tasks/{id}/provisioning-diagnostics',
    summary: 'Get task provisioning diagnostics',
    description:
      'Read one owner-scoped, deployment-gated page of canonical secret-free ' +
      'task provisioning attempt and event evidence. The authenticated account ' +
      'must own the task; ownerless and cross-owner tasks use non-enumerating ' +
      'not-found behavior, with no Public V1 administrator exception.',
    scope: 'tasks:diagnostics',
    ownerPolicy: 'required',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_CANONICAL_REST_SUCCESS_PROJECTION,
    input: {
      params: TaskProvisioningDiagnosticsParamsSchemaPair,
      query: TaskProvisioningDiagnosticsQuerySchemaPair,
    },
    paramsSchema: TaskProvisioningDiagnosticsParamsSchema,
    querySchema: TaskProvisioningDiagnosticsQuerySchema,
    successStatus: 200,
    responseDescription:
      'A canonical page of bounded attempt summaries and ordered diagnostic events with explicit coverage and next cursor.',
    responseSchema: TaskProvisioningDiagnosticsResponseSchema,
    responseExamples: TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES,
    additionalErrorStatuses: [404, 503],
    errors: [
      ...COMMON_ERRORS,
      'owner_required',
      'not_found',
      'task_provisioning_diagnostics_unavailable',
    ],
    restErrorProjections: [
      TASK_PROVISIONING_DIAGNOSTICS_OWNER_REQUIRED_REST_PROJECTION,
      TASK_PROVISIONING_DIAGNOSTICS_UNAVAILABLE_REST_PROJECTION,
    ],
    mcp: {
      tool: 'get_task_provisioning_diagnostics',
      inputProjection: PARAMS_AND_QUERY_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'tasks.stop',
    method: 'post',
    path: '/v1/tasks/{id}/stop',
    summary: 'Stop a task',
    description:
      'Operator-initiated stop; transitions an active task toward `cancelled` ' +
      'and returns the same additive safe provisioning/failure projection and ' +
      'canonical operator action as task reads.',
    scope: 'tasks:write',
    ownerPolicy: 'optional',
    streaming: false,
    destructive: true,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { params: PublicV1IdParamsSchemaPair },
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription:
      'The task transitioned toward its terminal state with safe provisioning/failure data.',
    responseSchema: TaskResponseSchema,
    errors: READ_BY_ID_ERRORS,
    mcp: {
      tool: 'stop_task',
      inputProjection: PARAMS_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'tasks.transcript',
    method: 'get',
    path: '/v1/tasks/{id}/transcript',
    summary: "Get a task's transcript",
    description:
      'Read the task transcript. Active tasks read the live sandbox rollout; ' +
      'terminal tasks read durable storage first with retained-sandbox fallback.',
    scope: 'tasks:read',
    ownerPolicy: 'optional',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { params: PublicV1IdParamsSchemaPair },
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription: 'The recorded transcript.',
    responseSchema: SessionHistorySchema,
    errors: READ_BY_ID_ERRORS,
    mcp: {
      tool: 'get_transcript',
      inputProjection: PARAMS_INPUT,
      outputProjection: 'canonical',
      differences: [
        {
          kind: 'mcp-output-schema-relaxation',
          reason:
            'The MCP SDK high-level registrar accepts only a root object output schema; derive its advertised fields from the canonical SessionHistory discriminated union while validating every structured result against that canonical union.',
        },
      ],
    },
  },
  {
    id: 'tasks.events',
    method: 'get',
    path: '/v1/tasks/{id}/events',
    summary: "Stream a task's lifecycle events",
    description:
      'Server-Sent Events stream of lifecycle transitions sourced from the ' +
      'append-only AuditEvent tail. Each event carries an id for `Last-Event-ID` ' +
      'resume; a heartbeat is emitted at least every 90s; the stream closes after ' +
      'a terminal event. The raw PTY/WebSocket terminal stream is not exposed here.',
    scope: 'tasks:read',
    ownerPolicy: 'optional',
    streaming: true,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: {
      params: PublicV1IdParamsSchemaPair,
      headers: PublicV1EventHeadersSchemaPair,
    },
    paramsSchema: PublicV1IdParamsSchema,
    headersSchema: PublicV1EventHeadersSchema,
    successStatus: 200,
    responseDescription:
      'A framed SSE stream. Each `data:` JSON value conforms to V1TaskEvent.',
    responseSchema: PublicV1SseStreamSchema,
    responseContentType: 'text/event-stream',
    streamEventSchema: V1TaskEventSchema,
    errors: READ_BY_ID_ERRORS,
    mcp: { excluded: 'MCP tools use request/response transport; lifecycle SSE is REST-only.' },
  },
  {
    id: 'repos.list',
    method: 'get',
    path: '/v1/repos',
    summary: 'List repos',
    description:
      'Keyset-paginated repos ordered by `(createdAt, id)`. `defaultBranch` is ' +
      'the persisted verified forge default, preserves arbitrary valid branch names ' +
      'without substituting `main` or `master`, and remains optional/nullable for legacy rows.',
    scope: 'repos:read',
    ownerPolicy: 'optional',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { query: V1ListQuerySchemaPair },
    querySchema: V1ListQuerySchema,
    successStatus: 200,
    responseDescription:
      'A page of repos with verified-or-legacy-null default branches plus the next-page cursor.',
    responseSchema: V1ListReposResponseSchema,
    errors: COMMON_ERRORS,
    mcp: {
      tool: 'list_repos',
      inputProjection: QUERY_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'repos.get',
    method: 'get',
    path: '/v1/repos/{id}',
    summary: 'Get a repo',
    description:
      'Fetch a repo by id. `defaultBranch` is its persisted verified forge ' +
      'default, preserves arbitrary valid branch names without substituting a ' +
      'conventional default, and remains optional/nullable for a legacy unverified row.',
    scope: 'repos:read',
    ownerPolicy: 'optional',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { params: PublicV1IdParamsSchemaPair },
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription:
      'The repo with its verified or legacy optional/nullable default branch.',
    responseSchema: RepoSchema,
    errors: READ_BY_ID_ERRORS,
    mcp: {
      tool: 'get_repo',
      inputProjection: PARAMS_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'schedules.list',
    method: 'get',
    path: '/v1/schedules',
    summary: 'List schedules',
    description:
      'Owner-scoped keyset-paginated list of task schedules. Each latest run ' +
      'preserves its optional canonical `taskFailure`, including deployment ' +
      'dependency failures with the `repair_deployment` action.',
    scope: 'tasks:read',
    ownerPolicy: 'required',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { query: V1ScheduleListQuerySchemaPair },
    querySchema: V1ScheduleListQuerySchema,
    successStatus: 200,
    responseDescription:
      'A page of schedules, including safe latest-run task failures, plus the next-page cursor.',
    responseSchema: V1ListSchedulesResponseSchema,
    errors: [...COMMON_ERRORS, 'owner_required'],
    restErrorProjections: [SCHEDULE_OWNER_REQUIRED_REST_PROJECTION],
    mcp: {
      tool: 'list_schedules',
      inputProjection: QUERY_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'schedules.create',
    method: 'post',
    path: '/v1/schedules',
    summary: 'Create a schedule',
    description:
      'Create an owner-scoped recurring task schedule. Prefer recurrence ' +
      'descriptors such as daily, weekdays, weekly, monthly, hourly, or ' +
      'minuteInterval; cronExpression and timezone remain accepted for ' +
      'compatibility clients. The task template is validated through the same ' +
      'task creation rules, and a returned latest run preserves its canonical ' +
      'optional `taskFailure` and operator action.',
    scope: 'tasks:write',
    ownerPolicy: 'required',
    streaming: false,
    destructive: true,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { body: CreateScheduleRequestSchemaPair },
    requestSchema: CreateScheduleRequestSchema,
    successStatus: 201,
    responseDescription:
      'The created schedule with any safe latest-run task failure preserved.',
    responseSchema: ScheduleResponseSchema,
    additionalErrorStatuses: [404, 422, 503],
    errors: [
      ...COMMON_ERRORS,
      'owner_required',
      'not_found',
      'temporarily_unavailable',
      'runtime_model_not_available',
      'runtime_model_catalog_unavailable',
    ],
    restErrorProjections: [
      SCHEDULE_OWNER_REQUIRED_REST_PROJECTION,
      RUNTIME_NOT_CONFIGURED_REST_PROJECTION,
      RUNTIME_MODEL_NOT_AVAILABLE_REST_PROJECTION,
      RUNTIME_MODEL_CATALOG_UNAVAILABLE_REST_PROJECTION,
    ],
    mcp: {
      tool: 'create_schedule',
      inputProjection: BODY_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'schedules.get',
    method: 'get',
    path: '/v1/schedules/{id}',
    summary: 'Get a schedule',
    description:
      'Fetch an owner-scoped schedule by id, preserving the latest run canonical ' +
      '`taskFailure` and operator action when present.',
    scope: 'tasks:read',
    ownerPolicy: 'required',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { params: PublicV1IdParamsSchemaPair },
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription:
      'The schedule with any safe latest-run task failure preserved.',
    responseSchema: ScheduleResponseSchema,
    errors: OWNER_READ_BY_ID_ERRORS,
    restErrorProjections: [SCHEDULE_OWNER_REQUIRED_REST_PROJECTION],
    mcp: {
      tool: 'get_schedule',
      inputProjection: PARAMS_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'schedules.update',
    method: 'patch',
    path: '/v1/schedules/{id}',
    summary: 'Update a schedule',
    description:
      'Update recurrence, policies, enabled state, or task template. Prefer ' +
      'daily, weekdays, weekly, monthly, hourly, or minuteInterval recurrence ' +
      'descriptors; cronExpression and timezone remain compatibility fields. ' +
      'The response preserves any canonical latest-run `taskFailure` and action.',
    scope: 'tasks:write',
    ownerPolicy: 'required',
    streaming: false,
    destructive: true,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: {
      params: PublicV1IdParamsSchemaPair,
      body: UpdateScheduleRequestSchemaPair,
    },
    paramsSchema: PublicV1IdParamsSchema,
    requestSchema: UpdateScheduleRequestSchema,
    successStatus: 200,
    responseDescription:
      'The updated schedule with any safe latest-run task failure preserved.',
    responseSchema: ScheduleResponseSchema,
    additionalErrorStatuses: [422, 503],
    errors: [
      ...OWNER_WRITE_BY_ID_ERRORS,
      'temporarily_unavailable',
      'runtime_model_not_available',
      'runtime_model_catalog_unavailable',
    ],
    restErrorProjections: [
      SCHEDULE_OWNER_REQUIRED_REST_PROJECTION,
      RUNTIME_NOT_CONFIGURED_REST_PROJECTION,
      RUNTIME_MODEL_NOT_AVAILABLE_REST_PROJECTION,
      RUNTIME_MODEL_CATALOG_UNAVAILABLE_REST_PROJECTION,
    ],
    mcp: {
      tool: 'update_schedule',
      inputProjection: PARAMS_AND_BODY_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'schedules.pause',
    method: 'post',
    path: '/v1/schedules/{id}/pause',
    summary: 'Pause a schedule',
    description:
      'Disable future fires for an owner-scoped schedule while preserving any ' +
      'canonical latest-run `taskFailure` and operator action.',
    scope: 'tasks:write',
    ownerPolicy: 'required',
    streaming: false,
    destructive: true,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { params: PublicV1IdParamsSchemaPair },
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription:
      'The paused schedule with any safe latest-run task failure preserved.',
    responseSchema: ScheduleResponseSchema,
    errors: OWNER_WRITE_BY_ID_ERRORS,
    restErrorProjections: [SCHEDULE_OWNER_REQUIRED_REST_PROJECTION],
    mcp: {
      tool: 'pause_schedule',
      inputProjection: PARAMS_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'schedules.resume',
    method: 'post',
    path: '/v1/schedules/{id}/resume',
    summary: 'Resume a schedule',
    description:
      'Enable a schedule and compute its next future fire time while preserving ' +
      'any canonical latest-run `taskFailure` and operator action.',
    scope: 'tasks:write',
    ownerPolicy: 'required',
    streaming: false,
    destructive: true,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { params: PublicV1IdParamsSchemaPair },
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 200,
    responseDescription:
      'The resumed schedule with any safe latest-run task failure preserved.',
    responseSchema: ScheduleResponseSchema,
    additionalErrorStatuses: [503],
    errors: [
      ...OWNER_WRITE_BY_ID_ERRORS,
      'runtime_model_catalog_unavailable',
    ],
    restErrorProjections: [
      SCHEDULE_OWNER_REQUIRED_REST_PROJECTION,
      RUNTIME_MODEL_CATALOG_UNAVAILABLE_REST_PROJECTION,
    ],
    mcp: {
      tool: 'resume_schedule',
      inputProjection: PARAMS_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'schedules.dispatch',
    method: 'post',
    path: '/v1/schedules/{id}/dispatch',
    summary: 'Dispatch a schedule immediately',
    description:
      'Consume the current schedule period immediately and advance nextRunAt to ' +
      'the next period. expectedPeriodKey can bind a retry to the period observed ' +
      'by the caller. The response preserves any canonical latest-run ' +
      '`taskFailure`, including the deployment-repair action.',
    scope: 'tasks:write',
    ownerPolicy: 'required',
    streaming: false,
    destructive: true,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: {
      params: PublicV1IdParamsSchemaPair,
      body: DispatchScheduleRequestSchemaPair,
    },
    paramsSchema: PublicV1IdParamsSchema,
    requestSchema: DispatchScheduleRequestSchema,
    successStatus: 200,
    responseDescription:
      'The schedule after dispatch with any safe latest-run task failure preserved.',
    responseSchema: ScheduleResponseSchema,
    additionalErrorStatuses: [409, 503],
    errors: [
      ...OWNER_WRITE_BY_ID_ERRORS,
      'conflict',
      'runtime_model_catalog_unavailable',
    ],
    restErrorProjections: [
      SCHEDULE_OWNER_REQUIRED_REST_PROJECTION,
      RUNTIME_MODEL_CATALOG_UNAVAILABLE_REST_PROJECTION,
    ],
    mcp: {
      tool: 'dispatch_schedule',
      inputProjection: PARAMS_AND_BODY_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
  {
    id: 'schedules.delete',
    method: 'delete',
    path: '/v1/schedules/{id}',
    summary: 'Delete a schedule',
    description: 'Delete an owner-scoped schedule and its run ledger.',
    scope: 'tasks:write',
    ownerPolicy: 'required',
    streaming: false,
    destructive: true,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: { params: PublicV1IdParamsSchemaPair },
    paramsSchema: PublicV1IdParamsSchema,
    successStatus: 204,
    responseDescription: 'The schedule was deleted.',
    responseSchema: null,
    errors: OWNER_WRITE_BY_ID_ERRORS,
    restErrorProjections: [SCHEDULE_OWNER_REQUIRED_REST_PROJECTION],
    mcp: {
      tool: 'delete_schedule',
      inputProjection: PARAMS_INPUT,
      outputProjection: {
        schema: PublicV1DeletionAcknowledgementSchema,
        reason:
          'REST returns 204 without a body; MCP returns an explicit deletion acknowledgement.',
      },
      differences: [
        {
          kind: 'success-projection',
          reason:
            'REST returns 204 without a body; MCP requires a structured tool result.',
        },
      ],
    },
  },
  {
    id: 'schedules.runs',
    method: 'get',
    path: '/v1/schedules/{id}/runs',
    summary: "List a schedule's runs",
    description:
      'Owner-scoped keyset-paginated run ledger ordered by scheduled fire time. ' +
      'Each item preserves its optional canonical `taskFailure`, including ' +
      'deployment dependency failures with the `repair_deployment` action.',
    scope: 'tasks:read',
    ownerPolicy: 'required',
    streaming: false,
    destructive: false,
    restOutputProjection: PUBLIC_V1_LEGACY_REST_SUCCESS_PROJECTION,
    input: {
      params: PublicV1IdParamsSchemaPair,
      query: V1ScheduleListQuerySchemaPair,
    },
    paramsSchema: PublicV1IdParamsSchema,
    querySchema: V1ScheduleListQuerySchema,
    successStatus: 200,
    responseDescription:
      'A page of schedule runs with safe task failures plus the next-page cursor.',
    responseSchema: V1ListScheduleRunsResponseSchema,
    errors: OWNER_READ_BY_ID_ERRORS,
    restErrorProjections: [SCHEDULE_OWNER_REQUIRED_REST_PROJECTION],
    mcp: {
      tool: 'list_schedule_runs',
      inputProjection: PARAMS_AND_QUERY_INPUT,
      outputProjection: 'canonical',
      differences: NO_MCP_DIFFERENCES,
    },
  },
] as const);

/** Exact entry union; no field is widened away by the authoring constraint. */
export type PublicV1Operation = (typeof PUBLIC_V1_OPERATIONS)[number];
/** Stable ids accepted by UI overlays and parity maps. */
export type PublicV1OperationId = PublicV1Operation['id'];
export type PublicV1OperationById<Id extends PublicV1OperationId> = Extract<
  PublicV1Operation,
  { readonly id: Id }
>;
export type McpMappedOperation = Extract<
  PublicV1Operation,
  { readonly mcp: { readonly tool: string } }
>;
export type McpMappedOperationId = McpMappedOperation['id'];
