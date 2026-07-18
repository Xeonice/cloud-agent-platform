import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import type { AnyZodObject, ZodTypeAny } from 'zod';
import {
  contractsZod,
  PUBLIC_V1_OPERATIONS,
  CreateScheduleRequestSchema,
  ScheduleResponseSchema,
  UpdateScheduleRequestSchema,
  V1CreateTaskRequestSchema,
  V1ListQuerySchema,
  V1ListReposResponseSchema,
  V1ListScheduleRunsResponseSchema,
  V1ListSchedulesResponseSchema,
  V1ListTasksResponseSchema,
  V1ScheduleListQuerySchema,
  V1TaskEventSchema,
  RuntimeModelCatalogUnavailableErrorSchema,
  RuntimeModelNotAvailableErrorSchema,
  type PublicErrorCode,
  type PublicRestErrorProjection,
  type V1CreateTaskRequest,
  type V1ListQuery,
  type V1ListReposResponse,
  type V1ListScheduleRunsResponse,
  type V1ListSchedulesResponse,
  type V1ListTasksResponse,
  type PublicV1OperationShape,
} from '@cap/contracts';
import {
  PUBLIC_ERROR_SEMANTICS,
  REST_PUBLIC_ERROR_MAP,
} from '../public-surface/public-error-mappings';

/** The public API surface version, independent of the deployed build version. */
export const V1_OPENAPI_INFO = {
  title: 'Cloud Agent Platform — Public API',
  version: '1.0.0',
  description:
    'The versioned, additive `/v1` REST surface. Endpoints delegate to the ' +
    'same services the console uses. Under the shared-pool model any admitted ' +
    'principal may list or stop any task.',
} as const;

// Compatibility exports retained for controller/tests that historically imported
// the public DTO aliases from this module. The schema authority remains contracts.
export { V1CreateTaskRequestSchema, V1ListQuerySchema };
export type { V1CreateTaskRequest, V1ListQuery };

export const V1TaskListResponseSchema = V1ListTasksResponseSchema;
export type V1TaskListResponse = V1ListTasksResponse;

export const V1RepoListResponseSchema = V1ListReposResponseSchema;
export type V1RepoListResponse = V1ListReposResponse;

export const V1LifecycleEventSchema = V1TaskEventSchema;

export const V1ScheduleCreateRequestSchema = CreateScheduleRequestSchema;
export const V1ScheduleUpdateRequestSchema = UpdateScheduleRequestSchema;
export const V1ScheduleResponseSchema = ScheduleResponseSchema;
export const V1ScheduleListResponseSchema = V1ListSchedulesResponseSchema;
export const V1ScheduleRunListResponseSchema = V1ListScheduleRunsResponseSchema;
export const V1ScheduleRunListQuerySchema = V1ScheduleListQuerySchema;
export type V1ScheduleListResponse = V1ListSchedulesResponse;
export type V1ScheduleRunListResponse = V1ListScheduleRunsResponse;

/**
 * Backward-compatible registry name. The route inventory itself now lives in
 * `@cap/contracts`, where OpenAPI, Web, and MCP can consume the same manifest.
 */
export const V1_ROUTES: readonly PublicV1OperationShape[] =
  PUBLIC_V1_OPERATIONS;

/** Sorted `(METHOD, path)` keys for the canonical public data operations. */
export function v1RouteKeys(): string[] {
  return PUBLIC_V1_OPERATIONS.map(
    (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
  ).sort();
}

const STRUCTURED_LEGACY_ERROR_SCHEMAS = {
  runtime_model_not_available: RuntimeModelNotAvailableErrorSchema,
  runtime_model_catalog_unavailable:
    RuntimeModelCatalogUnavailableErrorSchema,
} satisfies Partial<Record<PublicErrorCode, ZodTypeAny>>;

function operationErrorResponses(
  operation: PublicV1OperationShape,
): Record<
  number,
  {
    description: string;
    content?: {
      'application/json': {
        schema: ZodTypeAny;
        examples?: Readonly<
          Record<string, { readonly summary: string; readonly value: unknown }>
        >;
      };
    };
    headers?: AnyZodObject;
  }
> {
  const errorsByStatus = new Map<number, ErrorResponseCandidate[]>();
  for (const code of operation.errors) {
    const status = REST_PUBLIC_ERROR_MAP[code].status;
    const candidates = errorsByStatus.get(status) ?? [];
    candidates.push({ code });
    errorsByStatus.set(status, candidates);
  }
  for (const projection of operation.restErrorProjections ?? []) {
    const candidates = errorsByStatus.get(projection.status) ?? [];
    candidates.push({ code: projection.code, projection });
    errorsByStatus.set(projection.status, candidates);
  }

  return Object.fromEntries(
    [...errorsByStatus.entries()].sort(([a], [b]) => a - b).map(
      ([status, candidates]) => {
        const schema = structuredLegacyErrorSchema(candidates);
        const headers = candidates.find(
          (candidate) => candidate.projection?.headersSchema,
        )?.projection?.headersSchema;
        const examples = fixedBodyErrorExamples(candidates);
        return [
          status,
          {
            description: publicErrorDescription(
              operation,
              status,
              candidates.map((candidate) => candidate.code),
            ),
            ...(schema
              ? {
                  content: {
                    'application/json': {
                      schema,
                      ...(examples ? { examples } : {}),
                    },
                  },
                }
              : {}),
            ...(headers ? { headers } : {}),
          },
        ];
      },
    ),
  );
}

function fixedBodyErrorExamples(
  candidates: readonly ErrorResponseCandidate[],
):
  | Readonly<
      Record<string, { readonly summary: string; readonly value: unknown }>
    >
  | undefined {
  const examples = Object.fromEntries(
    candidates.flatMap((candidate) => {
      const projector = candidate.projection?.projector;
      if (projector?.kind !== 'fixed-body') return [];
      return [
        [
          candidate.code,
          {
            summary: PUBLIC_ERROR_SEMANTICS[candidate.code].defaultMessage,
            value: projector.body,
          },
        ],
      ];
    }),
  );
  return Object.keys(examples).length > 0 ? examples : undefined;
}

interface ErrorResponseCandidate {
  readonly code: PublicErrorCode;
  readonly projection?: PublicRestErrorProjection;
}

function structuredLegacyErrorSchema(
  candidates: readonly ErrorResponseCandidate[],
): ZodTypeAny | undefined {
  const schemas = candidates.flatMap((candidate) => {
    if (candidate.projection?.responseSchema) {
      return [candidate.projection.responseSchema];
    }
    if (candidate.code in STRUCTURED_LEGACY_ERROR_SCHEMAS) {
      return [
        STRUCTURED_LEGACY_ERROR_SCHEMAS[
          candidate.code as keyof typeof STRUCTURED_LEGACY_ERROR_SCHEMAS
        ],
      ];
    }
    return [];
  });
  const uniqueSchemas = [...new Set(schemas)];
  if (uniqueSchemas.length === 0) return undefined;
  if (uniqueSchemas.length === 1) return uniqueSchemas[0];
  return contractsZod.union([
    uniqueSchemas[0]!,
    uniqueSchemas[1]!,
    ...uniqueSchemas.slice(2),
  ]);
}

function publicErrorDescription(
  operation: PublicV1OperationShape,
  status: number,
  codes: readonly PublicErrorCode[],
): string {
  const labels = [
    ...new Set(
      codes.map((code) => publicErrorStatusLabel(code, status)),
    ),
  ];
  const messages = [
    ...new Set(
      codes.map((code) =>
        code === 'insufficient_scope'
          ? `The caller requires the \`${operation.scope}\` scope.`
          : PUBLIC_ERROR_SEMANTICS[code].defaultMessage,
      ),
    ),
  ];
  return `${labels.join(' / ')}: ${messages.join(' ')}`;
}

function publicErrorStatusLabel(
  code: PublicErrorCode,
  status: number,
): string {
  const defaultMapping = REST_PUBLIC_ERROR_MAP[code];
  if (defaultMapping.status === status) return defaultMapping.error;
  return (
    Object.values(REST_PUBLIC_ERROR_MAP).find(
      (mapping) => mapping.status === status,
    )?.error ?? defaultMapping.error
  );
}

function publicRestErrorProjections(operation: PublicV1OperationShape) {
  return (operation.restErrorProjections ?? []).map((projection) => ({
    code: projection.code,
    status: projection.status,
    projector: projection.projector.kind,
    reason: projection.reason,
    responseSchema: projection.responseSchema ? 'declared' : 'default',
    headers: projection.headersSchema
      ? Object.keys(projection.headersSchema.shape)
      : [],
  }));
}

function publicMcpProjection(operation: PublicV1OperationShape) {
  if ('tool' in operation.mcp) {
    return {
      status: 'mapped' as const,
      tool: operation.mcp.tool,
      differences: operation.mcp.differences,
    };
  }
  return {
    status: 'excluded' as const,
    reason: operation.mcp.excluded,
  };
}

/**
 * Zod refinements remain the runtime authority, but zod-to-openapi cannot infer
 * cross-field refinements. Attach their JSON Schema equivalents to the same Zod
 * instances when projecting them into OpenAPI so generated clients see the
 * recurrence/cron compatibility boundary too.
 */
function requestSchemaForOpenApi(operation: PublicV1OperationShape) {
  const pair = operation.input.body;
  if (!pair) return undefined;
  return pair.jsonSchemaOverlay
    ? pair.wire.openapi(pair.jsonSchemaOverlay)
    : pair.wire;
}

/** Build a fresh OpenAPI registry from the canonical operation manifest. */
export function buildV1Registry(): OpenAPIRegistry {
  // Contracts are ESM while the API is CJS. Extend the exact zod realm that
  // created the shared schemas so zod-to-openapi sees `.openapi()` everywhere.
  extendZodWithOpenApi(contractsZod);

  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'CAP API key, MCP token, or optional legacy operator token',
    description:
      'Send a `cap_sk_` API key, `mcp_` token, or an unprefixed legacy ' +
      '`AUTH_TOKEN` (only when legacy auth is enabled) as ' +
      '`Authorization: Bearer <token>`.',
  });
  registry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: 'cap_session',
    description: 'Opaque operator session cookie issued by the login flow.',
  });

  for (const exactOperation of PUBLIC_V1_OPERATIONS) {
    // Keep the exported registry exact. This projection intentionally consumes
    // the broad authoring contract so optional transport sections can be read
    // without widening the canonical tuple itself.
    const operation: PublicV1OperationShape = exactOperation;
    const streamEventComponentName = operation.streamEventSchema
      ? `StreamEvent_${operation.id.replaceAll('.', '_')}`
      : null;
    if (streamEventComponentName && operation.streamEventSchema) {
      registry.register(streamEventComponentName, operation.streamEventSchema);
    }
    const responseContentType =
      operation.responseContentType ?? 'application/json';
    const requestSchema = requestSchemaForOpenApi(operation);
    const hasRequest = Boolean(
      operation.input.params ||
        operation.input.query ||
        operation.input.headers ||
        requestSchema,
    );

    registry.registerPath({
      method: operation.method,
      path: operation.path,
      operationId: operation.id,
      summary: operation.summary,
      description: operation.description,
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      'x-cap-required-scope': operation.scope,
      'x-cap-owner-policy': operation.ownerPolicy,
      'x-cap-streaming': operation.streaming,
      'x-cap-destructive': operation.destructive,
      'x-cap-public-error-codes': operation.errors,
      'x-cap-rest-error-projection':
        REST_PUBLIC_ERROR_MAP.validation_failed.projection,
      'x-cap-rest-success-projection': operation.restOutputProjection,
      'x-cap-rest-error-projections': publicRestErrorProjections(operation),
      'x-cap-mcp': publicMcpProjection(operation),
      ...(streamEventComponentName
        ? {
            'x-cap-sse-data-schema': {
              $ref: `#/components/schemas/${streamEventComponentName}`,
            },
          }
        : {}),
      ...(hasRequest
        ? {
            request: {
              ...(operation.input.params
                ? { params: operation.input.params.wire }
                : {}),
              ...(operation.input.query
                ? { query: operation.input.query.wire }
                : {}),
              ...(operation.input.headers
                ? { headers: operation.input.headers.wire }
                : {}),
              ...(requestSchema
                ? {
                    body: {
                      required: !operation.input.body?.parse.safeParse(undefined)
                        .success,
                      content: {
                        'application/json': {
                          schema: requestSchema,
                        },
                      },
                    },
                  }
                : {}),
            },
          }
        : {}),
      responses: {
        [operation.successStatus]: {
          description: operation.responseDescription,
          ...(operation.responseSchema
            ? {
                content: {
                  [responseContentType]: {
                    schema: operation.responseSchema,
                    ...(operation.responseExamples
                      ? { examples: operation.responseExamples }
                      : {}),
                  },
                },
              }
            : {}),
        },
        401: {
          description: 'Unauthorized: the bearer credential is missing or invalid.',
        },
        403: {
          description:
            `Forbidden: the authenticated principal lacks the required ` +
            `\`${operation.scope}\` scope or account ownership.`,
        },
        ...operationErrorResponses(operation),
      },
    });
  }

  return registry;
}

/** OpenAPI 3.1 document generated from the canonical manifest and contracts. */
export type OpenApiDocument = ReturnType<
  OpenApiGeneratorV31['generateDocument']
>;

export function buildV1OpenApiDocument(): OpenApiDocument {
  const registry = buildV1Registry();
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { ...V1_OPENAPI_INFO },
  });
}

/** Swagger UI shell served by `GET /v1/docs`. */
export function buildV1DocsHtml(specUrl: string = '/v1/openapi.json'): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${V1_OPENAPI_INFO.title} — API docs</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.addEventListener('load', function () {
        window.ui = SwaggerUIBundle({
          url: ${JSON.stringify(specUrl)},
          dom_id: '#swagger-ui',
        });
      });
    </script>
  </body>
</html>
`;
}
