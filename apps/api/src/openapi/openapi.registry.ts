import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
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
  type V1CreateTaskRequest,
  type V1ListQuery,
  type V1ListReposResponse,
  type V1ListScheduleRunsResponse,
  type V1ListSchedulesResponse,
  type V1ListTasksResponse,
  type PublicV1Operation,
} from '@cap/contracts';

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
export const V1_ROUTES = PUBLIC_V1_OPERATIONS;

/** Sorted `(METHOD, path)` keys for the canonical public data operations. */
export function v1RouteKeys(): string[] {
  return PUBLIC_V1_OPERATIONS.map(
    (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
  ).sort();
}

const ERROR_DESCRIPTIONS = {
  400: 'Bad Request: path, query, header, or JSON body validation failed.',
  404: 'Not Found: the referenced task, repository, or schedule does not exist.',
  409: 'Conflict: the request conflicts with existing state or idempotency history.',
  429: 'Too Many Requests: the caller exceeded the task-create rate limit.',
} as const;

function operationErrorResponses(
  operation: PublicV1Operation,
): Record<number, { description: string }> {
  const statuses = new Set<number>([400]);
  if (operation.paramsSchema) statuses.add(404);
  for (const status of operation.additionalErrorStatuses ?? []) {
    statuses.add(status);
  }
  return Object.fromEntries(
    [...statuses].sort((a, b) => a - b).map((status) => [
      status,
      { description: ERROR_DESCRIPTIONS[status as keyof typeof ERROR_DESCRIPTIONS] },
    ]),
  );
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

  for (const operation of PUBLIC_V1_OPERATIONS) {
    const streamEventComponentName = operation.streamEventSchema
      ? `StreamEvent_${operation.id.replaceAll('.', '_')}`
      : null;
    if (streamEventComponentName && operation.streamEventSchema) {
      registry.register(streamEventComponentName, operation.streamEventSchema);
    }
    const responseContentType =
      operation.responseContentType ?? 'application/json';
    const hasRequest = Boolean(
      operation.paramsSchema ||
        operation.querySchema ||
        operation.headersSchema ||
        operation.requestSchema,
    );

    registry.registerPath({
      method: operation.method,
      path: operation.path,
      operationId: operation.id,
      summary: operation.summary,
      description: operation.description,
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      'x-cap-required-scope': operation.scope,
      'x-cap-streaming': operation.streaming,
      'x-cap-destructive': operation.destructive,
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
              ...(operation.paramsSchema
                ? { params: operation.paramsSchema }
                : {}),
              ...(operation.querySchema
                ? { query: operation.querySchema }
                : {}),
              ...(operation.headersSchema
                ? { headers: operation.headersSchema }
                : {}),
              ...(operation.requestSchema
                ? {
                    body: {
                      required: !operation.requestSchema.safeParse(undefined)
                        .success,
                      content: {
                        'application/json': {
                          schema: operation.requestSchema,
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
