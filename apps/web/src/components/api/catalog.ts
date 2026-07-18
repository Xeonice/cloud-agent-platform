/**
 * `catalog.ts` — the curated `/v1` endpoint catalog for the in-console API
 * Playground (`/api`, add-api-playground Track 2; epic Track B).
 *
 * The shared `PUBLIC_V1_OPERATIONS` manifest owns the data-operation method/path
 * surface; this module adds only console labels, examples, and editor hints. The
 * playground exposes ONLY those fixed data paths plus the two public docs paths —
 * there is deliberately NO free-form URL field. Path params (`:id`) get a
 * dedicated input and must be filled before the runner receives a request.
 *
 * The catalog is data-only (no React / no window access) so it is trivially
 * SSR-safe and can seed a deterministic default-selected endpoint for the
 * mock-mode pixel baseline (design D6).
 *
 * The SSE `GET /v1/tasks/:id/events` entry is flagged `streaming: true` so the
 * page routes it to the live-tail streaming view (Track 3) instead of the
 * single request/response model (design D5).
 */

import {
  PUBLIC_V1_OPERATIONS,
  type PublicErrorCode,
  type PublicOwnerPolicy,
  type PublicProtocolDifference,
  type PublicResponseExample,
  type PublicV1Operation,
  type PublicV1OperationId,
  type PublicV1OperationShape,
  type Scope,
} from "@cap/contracts";

/** An HTTP method a catalog endpoint can use. */
export type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type { PublicV1OperationId };

export type ApiMcpProjection =
  | {
      readonly status: "mapped";
      readonly tool: string;
      readonly differences: readonly PublicProtocolDifference[];
    }
  | {
      readonly status: "excluded";
      readonly reason: string;
    };

/** A path parameter (e.g. `:id`) that must be filled before the path resolves. */
export interface ApiPathParam {
  /** The param name as it appears in the template (`id` for `:id`). */
  name: string;
  /** A short human label shown next to its input (verbatim copy). */
  label: string;
  /** A placeholder example value (NOT sent unless the operator types one). */
  placeholder: string;
}

/** A default query parameter offered on the Params tab (e.g. `limit`, `cursor`). */
export interface ApiQueryParam {
  /** The query key (e.g. `limit`). */
  name: string;
  /** The default value pre-filled into the Params tab (may be empty). */
  defaultValue: string;
  /** A short hint shown next to the input (verbatim copy). */
  hint: string;
}

/** An optional request header exposed by the curated request editor. */
export interface ApiHeaderParam {
  name: string;
  defaultValue: string;
  hint: string;
}

/** The domain groups, in display order, that the rail buckets endpoints under. */
export type ApiDomain = "任务" | "仓库" | "定时任务" | "文档";

/** One curated `/v1` endpoint the playground can call. */
export interface ApiEndpoint {
  /** A stable id (also the default-selection key + React list key). */
  id: string;
  /** The shared public-operation id, absent only for documentation endpoints. */
  operationId: PublicV1OperationId | null;
  /** Data operations are drift-checked against the shared manifest. */
  kind: "data" | "documentation";
  /** Exact registry policy, absent only for documentation endpoints. */
  requiredScope: Scope | null;
  /** Owner policy from the registry, absent only for documentation endpoints. */
  ownerPolicy: PublicOwnerPolicy | null;
  /** Stable public failures declared by the operation. */
  publicErrors: readonly PublicErrorCode[];
  /** Registry-owned success examples; the Playground never authors a second fixture. */
  responseExamples: Readonly<Record<string, PublicResponseExample>>;
  /** MCP mapping/exclusion metadata projected without affecting rendering. */
  mcpProjection: ApiMcpProjection | null;
  /** The domain group this endpoint is listed under in the rail. */
  domain: ApiDomain;
  /** The HTTP method. */
  method: ApiMethod;
  /**
   * The path TEMPLATE relative to the api `/v1` surface, with `:param`
   * placeholders (e.g. `/v1/tasks/:id`). Resolved against {@link pathParams}
   * before a send — never a free-form, operator-typed URL.
   */
  pathTemplate: string;
  /** A short human title shown in the rail / request bar (verbatim copy). */
  title: string;
  /** Registry-derived operation guidance shown above the request editor. */
  description: string;
  /** Registry-derived success response guidance shown with the operation copy. */
  responseDescription: string;
  /** The path params (in order) the template declares; empty for static paths. */
  pathParams: readonly ApiPathParam[];
  /** Default query params offered on the Params tab; empty when none apply. */
  queryParams: readonly ApiQueryParam[];
  /** Optional protocol headers the operator may set for this operation. */
  headerParams: readonly ApiHeaderParam[];
  /**
   * A pretty-printed JSON sample for body-bearing writes, or `null` otherwise.
   * Seeds the Body tab so a write endpoint renders a deterministic editor (the
   * mock-mode pixel baseline, design D6).
   */
  sampleBody: string | null;
  /**
   * `true` when sending this endpoint mutates server state under the operator's
   * session (create / stop). The request panel raises a lightweight confirm
   * before such a send (tasks 2.3; design "Risks" → destructive-send confirm).
   */
  destructive: boolean;
  /**
   * `true` ONLY for the SSE `GET /v1/tasks/:id/events` entry — the page routes a
   * streaming endpoint to the live-tail view, not the request/response model
   * (design D5). All other endpoints are single request/response.
   */
  streaming: boolean;
}

/**
 * The result shape the response panel renders, mirroring Track 1's
 * `sendApiRequest` return contract (tasks 1.1) so the panels and the runner
 * agree on ONE shape with nothing re-declared at the call site. Declared here —
 * the catalog being this track's shared, dependency-free module — so both the
 * runner (Track 1) and the page (Track 3) import the same type.
 *
 * A network/transport failure resolves to `{ ok: false }` with a populated
 * `body`/`statusText` (NOT a thrown error the page can't render — tasks 1.1),
 * so the response panel always has an honest result to show.
 */
export interface ApiSendResult {
  /** The HTTP status code (0 when the request never reached the api). */
  status: number;
  /** The HTTP status text (or a transport-error message when `status === 0`). */
  statusText: string;
  /** `true` for a 2xx response; `false` for non-2xx OR a transport failure. */
  ok: boolean;
  /** Client-measured round-trip time in milliseconds. */
  durationMs: number;
  /** The response body size in bytes (the byte length of {@link body}). */
  sizeBytes: number;
  /** The response headers, lower-cased keys → values. */
  headers: Record<string, string>;
  /** The raw response body text (always present, possibly empty). */
  body: string;
  /** The parsed body, present ONLY when the response content-type was JSON. */
  json?: unknown;
}

/**
 * Console-only metadata layered over every shared public data operation.
 */
interface ApiEndpointOverlay {
  readonly domain: ApiDomain;
  readonly title: string;
  /** Labels/examples keyed by canonical registry fields; never owns the field set. */
  readonly pathParamHints?: Readonly<
    Record<string, Omit<ApiPathParam, "name">>
  >;
  readonly queryParamHints?: Readonly<
    Record<string, Omit<ApiQueryParam, "name">>
  >;
  readonly headerParamHints?: Readonly<
    Record<string, Omit<ApiHeaderParam, "name">>
  >;
  readonly sampleBody: string | null;
}

const TASK_ID = "00000000-0000-4000-a000-000000000201";
const REPO_ID = "00000000-0000-4000-a000-000000000101";
const SCHEDULE_ID = "00000000-0000-4000-a000-000000000301";

const TASK_ID_PARAM_HINTS = {
  id: { label: "任务 ID", placeholder: TASK_ID },
} as const;
const REPO_ID_PARAM_HINTS = {
  id: { label: "仓库 ID", placeholder: REPO_ID },
} as const;
const SCHEDULE_ID_PARAM_HINTS = {
  id: { label: "定时任务 ID", placeholder: SCHEDULE_ID },
} as const;
const PAGE_QUERY_HINTS = {
  limit: { defaultValue: "50", hint: "每页数量（默认 50，最大 200）" },
  cursor: { defaultValue: "", hint: "分页游标（上一页响应返回）" },
} as const;

const NO_RESPONSE_EXAMPLES = Object.freeze({}) as Readonly<
  Record<string, PublicResponseExample>
>;

const CREATE_TASK_SAMPLE = JSON.stringify(
  {
    repoId: REPO_ID,
    runtime: "codex",
    prompt: "为 /metrics 增加 docker-stats 采样",
  },
  null,
  2,
);

const QUERY_RUNTIME_MODELS_SAMPLE = JSON.stringify(
  {
    runtime: "codex",
  },
  null,
  2,
);

const CREATE_SCHEDULE_SAMPLE = JSON.stringify(
  {
    name: "每小时巡检",
    recurrence: {
      kind: "hourly",
      minuteOfHour: 15,
      timezone: "Asia/Shanghai",
    },
    taskTemplate: {
      repoId: REPO_ID,
      runtime: "codex",
      prompt: "执行每小时仓库巡检",
    },
    enabled: true,
    overlapPolicy: "skip",
    misfirePolicy: "fire-once",
  },
  null,
  2,
);

const UPDATE_SCHEDULE_SAMPLE = JSON.stringify(
  {
    name: "每 15 分钟巡检",
    recurrence: {
      kind: "minuteInterval",
      intervalMinutes: 15,
      timezone: "Asia/Shanghai",
    },
    enabled: true,
  },
  null,
  2,
);

const DISPATCH_SCHEDULE_SAMPLE = JSON.stringify(
  {},
  null,
  2,
);

const ENDPOINT_OVERLAYS = {
  "tasks.create": {
    domain: "任务",
    title: "创建任务",
    headerParamHints: {
      "Idempotency-Key": {
        defaultValue: "",
        hint: "可选；同一调用方重试时复用",
      },
    },
    sampleBody: CREATE_TASK_SAMPLE,
  },
  "runtimeModels.query": {
    domain: "任务",
    title: "运行时模型目录",
    sampleBody: QUERY_RUNTIME_MODELS_SAMPLE,
  },
  "tasks.list": {
    domain: "任务",
    title: "任务列表",
    queryParamHints: PAGE_QUERY_HINTS,
    sampleBody: null,
  },
  "tasks.get": {
    domain: "任务",
    title: "任务详情",
    pathParamHints: TASK_ID_PARAM_HINTS,
    sampleBody: null,
  },
  "tasks.provisioningDiagnostics": {
    domain: "任务",
    title: "任务创建诊断",
    pathParamHints: TASK_ID_PARAM_HINTS,
    queryParamHints: PAGE_QUERY_HINTS,
    sampleBody: null,
  },
  "tasks.stop": {
    domain: "任务",
    title: "停止任务",
    pathParamHints: TASK_ID_PARAM_HINTS,
    sampleBody: null,
  },
  "tasks.transcript": {
    domain: "任务",
    title: "任务记录",
    pathParamHints: TASK_ID_PARAM_HINTS,
    sampleBody: null,
  },
  "tasks.events": {
    domain: "任务",
    title: "事件流 (SSE)",
    pathParamHints: TASK_ID_PARAM_HINTS,
    headerParamHints: {
      "Last-Event-ID": {
        defaultValue: "",
        hint: "可选；从该事件之后恢复",
      },
    },
    sampleBody: null,
  },
  "repos.list": {
    domain: "仓库",
    title: "仓库列表",
    queryParamHints: PAGE_QUERY_HINTS,
    sampleBody: null,
  },
  "repos.get": {
    domain: "仓库",
    title: "仓库详情",
    pathParamHints: REPO_ID_PARAM_HINTS,
    sampleBody: null,
  },
  "schedules.list": {
    domain: "定时任务",
    title: "定时任务列表",
    queryParamHints: PAGE_QUERY_HINTS,
    sampleBody: null,
  },
  "schedules.create": {
    domain: "定时任务",
    title: "创建定时任务",
    sampleBody: CREATE_SCHEDULE_SAMPLE,
  },
  "schedules.get": {
    domain: "定时任务",
    title: "定时任务详情",
    pathParamHints: SCHEDULE_ID_PARAM_HINTS,
    sampleBody: null,
  },
  "schedules.update": {
    domain: "定时任务",
    title: "更新定时任务",
    pathParamHints: SCHEDULE_ID_PARAM_HINTS,
    sampleBody: UPDATE_SCHEDULE_SAMPLE,
  },
  "schedules.pause": {
    domain: "定时任务",
    title: "暂停定时任务",
    pathParamHints: SCHEDULE_ID_PARAM_HINTS,
    sampleBody: null,
  },
  "schedules.resume": {
    domain: "定时任务",
    title: "恢复定时任务",
    pathParamHints: SCHEDULE_ID_PARAM_HINTS,
    sampleBody: null,
  },
  "schedules.dispatch": {
    domain: "定时任务",
    title: "立即执行",
    pathParamHints: SCHEDULE_ID_PARAM_HINTS,
    sampleBody: DISPATCH_SCHEDULE_SAMPLE,
  },
  "schedules.delete": {
    domain: "定时任务",
    title: "删除定时任务",
    pathParamHints: SCHEDULE_ID_PARAM_HINTS,
    sampleBody: null,
  },
  "schedules.runs": {
    domain: "定时任务",
    title: "运行记录",
    pathParamHints: SCHEDULE_ID_PARAM_HINTS,
    queryParamHints: PAGE_QUERY_HINTS,
    sampleBody: null,
  },
} as const satisfies Record<PublicV1OperationId, ApiEndpointOverlay>;

function toApiMethod(method: PublicV1Operation["method"]): ApiMethod {
  return method.toUpperCase() as ApiMethod;
}

function toCatalogPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

function toMcpProjection(
  operation: PublicV1OperationShape,
): ApiMcpProjection {
  if ("tool" in operation.mcp) {
    return {
      status: "mapped",
      tool: operation.mcp.tool,
      differences: operation.mcp.differences,
    };
  }
  return {
    status: "excluded",
    reason: operation.mcp.excluded,
  };
}

function projectCanonicalFields<T extends { readonly name: string }>(
  operation: PublicV1OperationShape,
  source: "params" | "query" | "headers",
  hints: Readonly<Record<string, Omit<T, "name">>> | undefined,
): readonly T[] {
  const canonicalFields = Object.keys(
    operation.input[source]?.wire.shape ?? {},
  );
  const hintsByField = hints ?? {};
  const hintedFields = Object.keys(hintsByField);
  if (
    canonicalFields.length !== hintedFields.length ||
    canonicalFields.some((field) => !Object.hasOwn(hintsByField, field))
  ) {
    throw new TypeError(
      `API Playground ${source} hints must exactly match registry fields for ${operation.id}`,
    );
  }
  return canonicalFields.map(
    (name) => ({ name, ...hintsByField[name]! }) as T,
  );
}

/** Data operations are generated from the shared public `/v1` manifest. */
export const DATA_API_CATALOG: readonly ApiEndpoint[] = PUBLIC_V1_OPERATIONS.map(
  (operation) => {
    const operationShape: PublicV1OperationShape = operation;
    const overlay = ENDPOINT_OVERLAYS[operation.id];
    return {
      id: operation.id,
      operationId: operation.id,
      kind: "data" as const,
      requiredScope: operation.scope,
      ownerPolicy: operation.ownerPolicy,
      publicErrors: operation.errors,
      responseExamples:
        operationShape.responseExamples ?? NO_RESPONSE_EXAMPLES,
      mcpProjection: toMcpProjection(operation),
      domain: overlay.domain,
      method: toApiMethod(operation.method),
      pathTemplate: toCatalogPath(operation.path),
      title: overlay.title,
      description: operation.description,
      responseDescription: operation.responseDescription,
      pathParams: projectCanonicalFields<ApiPathParam>(
        operation,
        "params",
        "pathParamHints" in overlay ? overlay.pathParamHints : undefined,
      ),
      queryParams: projectCanonicalFields<ApiQueryParam>(
        operation,
        "query",
        "queryParamHints" in overlay ? overlay.queryParamHints : undefined,
      ),
      headerParams: projectCanonicalFields<ApiHeaderParam>(
        operation,
        "headers",
        "headerParamHints" in overlay ? overlay.headerParamHints : undefined,
      ),
      sampleBody: overlay.sampleBody,
      destructive: operation.destructive,
      streaming: operation.streaming,
    };
  },
);

const DOCUMENTATION_CATALOG: readonly ApiEndpoint[] = [
  {
    id: "docs.openapi",
    operationId: null,
    kind: "documentation",
    requiredScope: null,
    ownerPolicy: null,
    publicErrors: [],
    responseExamples: NO_RESPONSE_EXAMPLES,
    mcpProjection: null,
    domain: "文档",
    method: "GET",
    pathTemplate: "/v1/openapi.json",
    title: "OpenAPI 规范",
    description: "获取由 Public V1 共享操作清单生成的 OpenAPI 3.1 规范。",
    responseDescription: "OpenAPI 3.1 JSON 文档。",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    sampleBody: null,
    destructive: false,
    streaming: false,
  },
  {
    id: "docs.swagger",
    operationId: null,
    kind: "documentation",
    requiredScope: null,
    ownerPolicy: null,
    publicErrors: [],
    responseExamples: NO_RESPONSE_EXAMPLES,
    mcpProjection: null,
    domain: "文档",
    method: "GET",
    pathTemplate: "/v1/docs",
    title: "Swagger UI",
    description: "打开基于同一份 Public V1 OpenAPI 规范生成的 Swagger UI。",
    responseDescription: "Swagger UI HTML 页面。",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    sampleBody: null,
    destructive: false,
    streaming: false,
  },
];

export const API_CATALOG: readonly ApiEndpoint[] = [
  ...DATA_API_CATALOG,
  ...DOCUMENTATION_CATALOG,
];

/**
 * The deterministic default-selected endpoint (the first catalog entry,
 * `POST /v1/tasks`) — so the page opens on a stable endpoint with a sample body
 * for the mock-mode pixel baseline (design D6). Matches the design's active row.
 */
export const DEFAULT_ENDPOINT_ID: string = API_CATALOG[0]!.id;

/** The domain groups in display order (drives the rail's grouping). */
export const API_DOMAINS: readonly ApiDomain[] = ["任务", "仓库", "定时任务", "文档"];

/** Look up a catalog endpoint by its stable id, or `undefined` if unknown. */
export function findEndpoint(id: string): ApiEndpoint | undefined {
  return API_CATALOG.find((endpoint) => endpoint.id === id);
}

/**
 * Substitute filled path params into an endpoint's template, returning the
 * resolved path (e.g. `/v1/tasks/:id` + `{ id: "task_1" }` → `/v1/tasks/task_1`).
 * A param with no supplied value is left as its `:name` placeholder so the
 * resolved path is visibly incomplete (the request bar shows what is missing)
 * rather than silently targeting a wrong path. Values are URL-encoded so an id
 * can never inject extra path/query segments — the curated path stays the path.
 */
export function resolvePath(
  endpoint: ApiEndpoint,
  params: Record<string, string>,
): string {
  let path = endpoint.pathTemplate;
  for (const param of endpoint.pathParams) {
    const value = params[param.name]?.trim();
    if (value) {
      path = path.replace(`:${param.name}`, encodeURIComponent(value));
    }
  }
  return path;
}
