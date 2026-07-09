import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
// The `z` NAMESPACE (`z.ZodObject`, `z.ZodTypeAny`, `z.infer`, …) for the
// route-table type annotations only. Every such use is type-only and ERASES at
// compile time, so this import contributes NO runtime value and does NOT
// reintroduce the api's CJS zod realm — the runtime instance that builds and
// extends schemas is `contractsZod` (the shared ESM realm) below.
import { z } from 'zod';
import {
  // The SHARED zod instance every `@cap/contracts` schema is built on. Used as the
  // RUNTIME `z` for `extendZodWithOpenApi` and the registry-local route schemas, so
  // EVERY schema fed to the generator (contract DTOs AND the `{ id }` param schema)
  // lives in the one class realm that carries the `.openapi(...)` augmentation. The
  // api's own `import('zod')` value would be a SEPARATE CJS realm — see this
  // module's doc + `@cap/contracts`'s zod-instance for the ESM/CJS split rationale.
  contractsZod,
  RepoSchema,
  TaskResponseSchema,
  // wire-transcript-real-data — the durable session-history read model (turns +
  // per-turn `at`, tool diffstat, audit-sourced system turns, session totals).
  // The /v1 transcript response is documented from THIS exact schema so the doc
  // cannot drift from the enriched wire shape.
  SessionHistorySchema,
  // The `/v1` DTOs are owned by `@cap/contracts` (Track `contracts`) — the SAME
  // schemas the `/v1` controllers validate requests/responses against. The
  // document is generated from THESE exact schemas, so it cannot drift from the
  // wire (D3). Re-exported below under the names the registry spec (task 4.4) and
  // the controllers import, so Integration (4.1) consumes the contract source of
  // truth rather than a parallel re-declaration.
  V1CreateTaskRequestSchema,
  V1ListQuerySchema,
  V1ListTasksResponseSchema,
  V1ListReposResponseSchema,
  V1TaskEventSchema,
  CreateScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  ScheduleResponseSchema,
  V1ListSchedulesResponseSchema,
  V1ListScheduleRunsResponseSchema,
  V1ScheduleListQuerySchema,
  type V1CreateTaskRequest,
  type V1ListQuery,
  type V1ListTasksResponse,
  type V1ListReposResponse,
  type V1ListSchedulesResponse,
  type V1ListScheduleRunsResponse,
} from '@cap/contracts';

/**
 * OpenAPI registry + document generator for the public `/v1` surface
 * (public-v1-api, Track `openapi`, tasks 4.2 / 4.4).
 *
 * ## Why the document cannot drift from the wire (D3)
 *
 * Every `/v1` route is registered here against the SAME `@cap/contracts` zod
 * schemas the `/v1` controllers validate requests/responses against. The
 * generated OpenAPI 3.1 document is therefore a projection of the one source of
 * truth — when a `/v1` schema changes, the document changes with it, and the
 * route↔schema registration diff test (task 4.4) fails the build if a route is
 * ever served without a registered schema (or vice-versa).
 *
 * ## `/v1`-only DTOs are ADDITIVE (D2)
 *
 * The `/v1` request/response shapes are composed HERE from the existing console
 * base schemas (`TaskSchema` / `RepoSchema` / `CreateTaskRequestSchema`) WITHOUT
 * mutating them — `CreateTaskRequestSchema.extend({ repoId })` for the body, and
 * `{ items, nextCursor }` envelopes for the lists. The console contract that
 * `apps/web` imports stays byte-identical (asserted by the contracts-track
 * byte-unchanged test). These composed shapes are exported so the `/v1`
 * controllers validate against the exact schemas registered into the document.
 *
 * ## `extendZodWithOpenApi` ownership (Integration 4.1)
 *
 * `extendZodWithOpenApi(z)` is the once-per-process init the Integration track
 * (4.1) owns on the shared `@cap/contracts` z instance. It is idempotent, so
 * {@link buildV1OpenApiDocument} calls it defensively here too: this module must
 * be able to generate a valid document on its own (the OpenAPI controller + its
 * spec exercise it in isolation, before the AppModule wiring exists). A second
 * idempotent call from Integration is harmless.
 */

/**
 * The OpenAPI `info.version` for the `/v1` surface. This is the API SURFACE
 * version (the `/v1` path prefix), NOT the build version reported by `/version`.
 */
export const V1_OPENAPI_INFO = {
  title: 'Cloud Agent Platform — Public API',
  version: '1.0.0',
  description:
    'The versioned, additive `/v1` REST surface. Endpoints delegate to the ' +
    'same services the console uses (one task-admission path). NOTE: under the ' +
    'shared-pool model any admitted principal may list or stop any task.',
} as const;

// ---------------------------------------------------------------------------
// `/v1`-only DTOs — the SINGLE source of truth lives in `@cap/contracts` (Track
// `contracts`, D2: additive, never mutating the console base schemas). They are
// re-exported here under the registry's public names so the document is provably
// generated from the EXACT schemas the `/v1` controllers validate against (D3),
// and the registry spec (task 4.4) imports them from this module.
// ---------------------------------------------------------------------------

/**
 * `POST /v1/tasks` body: the console create body PLUS `repoId`
 * ({@link V1CreateTaskRequestSchema} in `@cap/contracts`). The console carries
 * `repoId` in the route; the `/v1` surface carries it in the body so there is a
 * single flat create shape. Additive — `CreateTaskRequestSchema` is untouched.
 */
export { V1CreateTaskRequestSchema };
export type { V1CreateTaskRequest };

/**
 * The shared keyset-pagination query for the `/v1` list endpoints
 * ({@link V1ListQuerySchema} in `@cap/contracts`): a `limit` (default 50, max
 * 200) and an optional opaque base64 `cursor` over `(createdAt, id)`.
 */
export { V1ListQuerySchema };
export type { V1ListQuery };

/**
 * `GET /v1/tasks` response: the `{ items, nextCursor }` keyset envelope of tasks
 * ({@link V1ListTasksResponseSchema} in `@cap/contracts`). Re-exported under the
 * registry-local name the spec (4.4) reads.
 */
export const V1TaskListResponseSchema = V1ListTasksResponseSchema;
export type V1TaskListResponse = V1ListTasksResponse;

/**
 * `GET /v1/repos` response: the `{ items, nextCursor }` keyset envelope of repos
 * ({@link V1ListReposResponseSchema} in `@cap/contracts`).
 */
export const V1RepoListResponseSchema = V1ListReposResponseSchema;
export type V1RepoListResponse = V1ListReposResponse;

/**
 * The SSE lifecycle-event shape streamed by `GET /v1/tasks/:id/events`
 * ({@link V1TaskEventSchema} in `@cap/contracts`, Track `sse-observation`): one
 * event per persisted `AuditEvent`-derived task transition. Documented here so
 * the OpenAPI surface covers the event stream's payload even though SSE itself is
 * not a JSON response body.
 */
export const V1LifecycleEventSchema = V1TaskEventSchema;
export type V1LifecycleEvent = z.infer<typeof V1LifecycleEventSchema>;

export const V1ScheduleCreateRequestSchema = CreateScheduleRequestSchema;
export const V1ScheduleUpdateRequestSchema = UpdateScheduleRequestSchema;
export const V1ScheduleResponseSchema = ScheduleResponseSchema;
export const V1ScheduleListResponseSchema = V1ListSchedulesResponseSchema;
export const V1ScheduleRunListResponseSchema = V1ListScheduleRunsResponseSchema;
export const V1ScheduleRunListQuerySchema = V1ScheduleListQuerySchema;
export type V1ScheduleListResponse = V1ListSchedulesResponse;
export type V1ScheduleRunListResponse = V1ListScheduleRunsResponse;

// ---------------------------------------------------------------------------
// Route table — the single declarative list of every `/v1` route. The registry
// builder iterates it, and the route↔schema diff test (4.4) asserts the served
// surface matches it exactly.
// ---------------------------------------------------------------------------

/** An HTTP method the `/v1` surface uses. */
type V1Method = 'get' | 'post' | 'patch' | 'delete';

/** One registered `/v1` route, expressed in terms of `@cap/contracts` schemas. */
interface V1RouteDefinition {
  readonly method: V1Method;
  /** OpenAPI path template (`{id}` style), e.g. `/v1/tasks/{id}`. */
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  /** Optional path params (e.g. `{ id }`). */
  readonly params?: z.ZodObject<z.ZodRawShape>;
  /** Optional query schema (pagination). */
  readonly query?: z.ZodObject<z.ZodRawShape>;
  /** Optional JSON request body schema. */
  readonly requestBody?: z.ZodTypeAny;
  /** The success response: status code + JSON schema (or `null` for no body). */
  readonly response: {
    readonly status: number;
    readonly description: string;
    readonly schema: z.ZodTypeAny | null;
    /** Override the response content type (defaults to `application/json`). */
    readonly contentType?: string;
  };
}

/**
 * The `{ id }` path-param schema reused by the by-id routes. Built on
 * `contractsZod` (the shared ESM realm), NOT the api's CJS `z`, so it carries the
 * same `.openapi(...)` augmentation as the contract DTOs and the generator can
 * inline it as a parameter without `schema.openapi is not a function`.
 */
const IdParamSchema = contractsZod.object({ id: contractsZod.string().uuid() });

/**
 * The complete `/v1` route table. EVERY `/v1` route the controllers serve MUST
 * appear here, and nothing that is not served may appear — the diff test (4.4)
 * holds this invariant.
 */
export const V1_ROUTES: readonly V1RouteDefinition[] = [
  {
    method: 'post',
    path: '/v1/tasks',
    summary: 'Create a task',
    description:
      'Admit a new task against a repo (`repoId` in the body). Goes through the ' +
      'same admission path as the console create. Accepts an optional ' +
      '`Idempotency-Key` header for safe retries.',
    requestBody: V1CreateTaskRequestSchema,
    response: {
      status: 201,
      description: 'The created task with its initial status.',
      schema: TaskResponseSchema,
    },
  },
  {
    method: 'get',
    path: '/v1/tasks',
    summary: 'List tasks',
    description: 'Keyset-paginated list of tasks ordered by `(createdAt, id)`.',
    query: V1ListQuerySchema,
    response: {
      status: 200,
      description: 'A page of tasks plus the next-page cursor.',
      schema: V1TaskListResponseSchema,
    },
  },
  {
    method: 'get',
    path: '/v1/tasks/{id}',
    summary: 'Get a task',
    description:
      'Fetch a single task by id. This polling read is the GUARANTEED ' +
      'observation floor — every status transition is persisted before the ' +
      'response.',
    params: IdParamSchema,
    response: {
      status: 200,
      description: 'The task.',
      schema: TaskResponseSchema,
    },
  },
  {
    method: 'post',
    path: '/v1/tasks/{id}/stop',
    summary: 'Stop a task',
    description: 'Operator-initiated stop; transitions an active task to `cancelled`.',
    params: IdParamSchema,
    response: {
      status: 200,
      description: 'The task transitioned toward its terminal state.',
      schema: TaskResponseSchema,
    },
  },
  {
    method: 'get',
    path: '/v1/tasks/{id}/transcript',
    summary: "Get a task's transcript",
    description: 'The durable, container-independent terminal transcript for the task.',
    params: IdParamSchema,
    response: {
      status: 200,
      description: 'The recorded transcript.',
      // The durable session-history read model (wire-transcript-real-data) —
      // documented from the SAME `SessionHistorySchema` the controller validates
      // against, so the doc reflects the enriched JSON wire shape (turns with
      // per-turn `at` + tool diffstat + audit-sourced system turns + meta totals),
      // not a stale plaintext string.
      schema: SessionHistorySchema,
    },
  },
  {
    method: 'get',
    path: '/v1/tasks/{id}/events',
    summary: "Stream a task's lifecycle events",
    description:
      'Server-Sent Events stream of lifecycle transitions sourced from the ' +
      'append-only AuditEvent tail. Each event carries an id for `Last-Event-ID` ' +
      'resume; a heartbeat is emitted at least every 90s; the stream closes after ' +
      'a terminal event. The raw PTY/WebSocket terminal stream is NOT exposed here.',
    params: IdParamSchema,
    response: {
      status: 200,
      description: 'An event stream of lifecycle events (one `data:` per event).',
      schema: V1LifecycleEventSchema,
      contentType: 'text/event-stream',
    },
  },
  {
    method: 'get',
    path: '/v1/repos',
    summary: 'List repos',
    description: 'Keyset-paginated list of repos ordered by `(createdAt, id)`.',
    query: V1ListQuerySchema,
    response: {
      status: 200,
      description: 'A page of repos plus the next-page cursor.',
      schema: V1RepoListResponseSchema,
    },
  },
  {
    method: 'get',
    path: '/v1/repos/{id}',
    summary: 'Get a repo',
    description: 'Fetch a single repo by id.',
    params: IdParamSchema,
    response: {
      status: 200,
      description: 'The repo.',
      schema: RepoSchema,
    },
  },
  {
    method: 'get',
    path: '/v1/schedules',
    summary: 'List schedules',
    description: 'Owner-scoped keyset-paginated list of task schedules.',
    query: V1ScheduleRunListQuerySchema,
    response: {
      status: 200,
      description: 'A page of schedules plus the next-page cursor.',
      schema: V1ScheduleListResponseSchema,
    },
  },
  {
    method: 'post',
    path: '/v1/schedules',
    summary: 'Create a schedule',
    description:
      'Create an owner-scoped recurring task schedule. Prefer recurrence ' +
      'descriptors such as daily, weekdays, weekly, or monthly; cronExpression ' +
      'and timezone remain accepted for compatibility clients. The task ' +
      'template is validated and normalized through the same task creation rules.',
    requestBody: V1ScheduleCreateRequestSchema,
    response: {
      status: 201,
      description: 'The created schedule.',
      schema: V1ScheduleResponseSchema,
    },
  },
  {
    method: 'get',
    path: '/v1/schedules/{id}',
    summary: 'Get a schedule',
    description: 'Fetch an owner-scoped schedule by id.',
    params: IdParamSchema,
    response: {
      status: 200,
      description: 'The schedule.',
      schema: V1ScheduleResponseSchema,
    },
  },
  {
    method: 'patch',
    path: '/v1/schedules/{id}',
    summary: 'Update a schedule',
    description:
      'Update recurrence, policies, enabled state, or task template. Prefer ' +
      'recurrence descriptors; cronExpression and timezone remain compatibility fields.',
    params: IdParamSchema,
    requestBody: V1ScheduleUpdateRequestSchema,
    response: {
      status: 200,
      description: 'The updated schedule.',
      schema: V1ScheduleResponseSchema,
    },
  },
  {
    method: 'post',
    path: '/v1/schedules/{id}/pause',
    summary: 'Pause a schedule',
    description: 'Disable future fires for an owner-scoped schedule.',
    params: IdParamSchema,
    response: {
      status: 200,
      description: 'The paused schedule.',
      schema: V1ScheduleResponseSchema,
    },
  },
  {
    method: 'post',
    path: '/v1/schedules/{id}/resume',
    summary: 'Resume a schedule',
    description: 'Enable a schedule and compute its next future fire time.',
    params: IdParamSchema,
    response: {
      status: 200,
      description: 'The resumed schedule.',
      schema: V1ScheduleResponseSchema,
    },
  },
  {
    method: 'post',
    path: '/v1/schedules/{id}/dispatch',
    summary: 'Dispatch a schedule immediately',
    description:
      'Create a task from the schedule template immediately and mark the current ' +
      'cycle as completed by advancing nextRunAt before the normal scheduler tick.',
    params: IdParamSchema,
    response: {
      status: 200,
      description: 'The schedule after the immediate dispatch.',
      schema: V1ScheduleResponseSchema,
    },
  },
  {
    method: 'delete',
    path: '/v1/schedules/{id}',
    summary: 'Delete a schedule',
    description: 'Delete an owner-scoped schedule and its run ledger.',
    params: IdParamSchema,
    response: {
      status: 204,
      description: 'The schedule was deleted.',
      schema: null,
    },
  },
  {
    method: 'get',
    path: '/v1/schedules/{id}/runs',
    summary: "List a schedule's runs",
    description:
      'Owner-scoped keyset-paginated run ledger ordered by scheduled fire time.',
    params: IdParamSchema,
    query: V1ScheduleRunListQuerySchema,
    response: {
      status: 200,
      description: 'A page of schedule runs plus the next-page cursor.',
      schema: V1ScheduleRunListResponseSchema,
    },
  },
];

/**
 * The set of `(METHOD, path)` pairs the document covers, derived from
 * {@link V1_ROUTES}. The route↔schema diff test (4.4) compares this against the
 * routes the `/v1` controllers actually serve.
 */
export function v1RouteKeys(): string[] {
  return V1_ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
}

/**
 * Builds a fresh {@link OpenAPIRegistry} with every {@link V1_ROUTES} entry
 * registered. A new registry per call keeps the function pure and side-effect
 * free (no shared mutable module state), which the diff test relies on.
 */
export function buildV1Registry(): OpenAPIRegistry {
  // Idempotent — see the module doc on `extendZodWithOpenApi` ownership. Extends
  // `contractsZod` (the shared ESM realm the contract DTOs are built on), NOT the
  // api's CJS `z`, so the `.openapi(...)` augmentation lands on the exact schema
  // instances registered below.
  extendZodWithOpenApi(contractsZod);

  const registry = new OpenAPIRegistry();

  for (const route of V1_ROUTES) {
    const responseContentType = route.response.contentType ?? 'application/json';
    registry.registerPath({
      method: route.method,
      path: route.path,
      summary: route.summary,
      description: route.description,
      request: {
        ...(route.params ? { params: route.params } : {}),
        ...(route.query ? { query: route.query } : {}),
        ...(route.requestBody
          ? {
              body: {
                content: {
                  'application/json': { schema: route.requestBody },
                },
              },
            }
          : {}),
      },
      responses: {
        [route.response.status]: {
          description: route.response.description,
          ...(route.response.schema
            ? {
                content: {
                  [responseContentType]: { schema: route.response.schema },
                },
              }
            : {}),
        },
      },
    });
  }

  return registry;
}

/** The OpenAPI 3.1 document shape `buildV1OpenApiDocument` returns. */
export type OpenApiDocument = ReturnType<
  OpenApiGeneratorV31['generateDocument']
>;

/**
 * Generates the OpenAPI 3.1 document for the `/v1` surface from the registered
 * `@cap/contracts` schemas. Pure: a fresh registry + generator per call, so the
 * returned document is a snapshot the controller can serve and the diff test can
 * inspect.
 */
export function buildV1OpenApiDocument(): OpenApiDocument {
  const registry = buildV1Registry();
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { ...V1_OPENAPI_INFO },
  });
}

/**
 * A self-contained Swagger UI HTML page that loads the interactive docs and
 * points at the live `GET /v1/openapi.json` spec. Returned by `GET /v1/docs`.
 * Pure (the spec URL is the only input) so it is trivially testable.
 */
export function buildV1DocsHtml(specUrl: string = '/v1/openapi.json'): string {
  // The Swagger-UI asset (Integration 4.1) is loaded from the standard dist
  // bundle; `specUrl` is same-origin and not attacker-controlled.
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
