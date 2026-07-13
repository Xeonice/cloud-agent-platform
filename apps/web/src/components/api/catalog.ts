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

import { PUBLIC_V1_OPERATIONS } from "@cap/contracts";

/** An HTTP method a catalog endpoint can use. */
export type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";

type PublicV1Operation = (typeof PUBLIC_V1_OPERATIONS)[number];
export type PublicV1OperationId = PublicV1Operation["id"];

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
  readonly pathParams: readonly ApiPathParam[];
  readonly queryParams: readonly ApiQueryParam[];
  readonly headerParams?: readonly ApiHeaderParam[];
  readonly sampleBody: string | null;
}

const TASK_ID = "00000000-0000-4000-a000-000000000201";
const REPO_ID = "00000000-0000-4000-a000-000000000101";
const SCHEDULE_ID = "00000000-0000-4000-a000-000000000301";

const TASK_ID_PARAM: readonly ApiPathParam[] = [
  { name: "id", label: "任务 ID", placeholder: TASK_ID },
];
const REPO_ID_PARAM: readonly ApiPathParam[] = [
  { name: "id", label: "仓库 ID", placeholder: REPO_ID },
];
const SCHEDULE_ID_PARAM: readonly ApiPathParam[] = [
  { name: "id", label: "定时任务 ID", placeholder: SCHEDULE_ID },
];
const PAGE_QUERY: readonly ApiQueryParam[] = [
  { name: "limit", defaultValue: "50", hint: "每页数量（默认 50，最大 200）" },
  { name: "cursor", defaultValue: "", hint: "分页游标（上一页响应返回）" },
];

const CREATE_TASK_SAMPLE = JSON.stringify(
  {
    repoId: REPO_ID,
    branch: "main",
    runtime: "codex",
    prompt: "为 /metrics 增加 docker-stats 采样",
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
    pathParams: [],
    queryParams: [],
    headerParams: [
      {
        name: "Idempotency-Key",
        defaultValue: "",
        hint: "可选；同一调用方重试时复用",
      },
    ],
    sampleBody: CREATE_TASK_SAMPLE,
  },
  "tasks.list": {
    domain: "任务",
    title: "任务列表",
    pathParams: [],
    queryParams: PAGE_QUERY,
    sampleBody: null,
  },
  "tasks.get": {
    domain: "任务",
    title: "任务详情",
    pathParams: TASK_ID_PARAM,
    queryParams: [],
    sampleBody: null,
  },
  "tasks.stop": {
    domain: "任务",
    title: "停止任务",
    pathParams: TASK_ID_PARAM,
    queryParams: [],
    sampleBody: null,
  },
  "tasks.transcript": {
    domain: "任务",
    title: "任务记录",
    pathParams: TASK_ID_PARAM,
    queryParams: [],
    sampleBody: null,
  },
  "tasks.events": {
    domain: "任务",
    title: "事件流 (SSE)",
    pathParams: TASK_ID_PARAM,
    queryParams: [],
    headerParams: [
      {
        name: "Last-Event-ID",
        defaultValue: "",
        hint: "可选；从该事件之后恢复",
      },
    ],
    sampleBody: null,
  },
  "repos.list": {
    domain: "仓库",
    title: "仓库列表",
    pathParams: [],
    queryParams: PAGE_QUERY,
    sampleBody: null,
  },
  "repos.get": {
    domain: "仓库",
    title: "仓库详情",
    pathParams: REPO_ID_PARAM,
    queryParams: [],
    sampleBody: null,
  },
  "schedules.list": {
    domain: "定时任务",
    title: "定时任务列表",
    pathParams: [],
    queryParams: PAGE_QUERY,
    sampleBody: null,
  },
  "schedules.create": {
    domain: "定时任务",
    title: "创建定时任务",
    pathParams: [],
    queryParams: [],
    sampleBody: CREATE_SCHEDULE_SAMPLE,
  },
  "schedules.get": {
    domain: "定时任务",
    title: "定时任务详情",
    pathParams: SCHEDULE_ID_PARAM,
    queryParams: [],
    sampleBody: null,
  },
  "schedules.update": {
    domain: "定时任务",
    title: "更新定时任务",
    pathParams: SCHEDULE_ID_PARAM,
    queryParams: [],
    sampleBody: UPDATE_SCHEDULE_SAMPLE,
  },
  "schedules.pause": {
    domain: "定时任务",
    title: "暂停定时任务",
    pathParams: SCHEDULE_ID_PARAM,
    queryParams: [],
    sampleBody: null,
  },
  "schedules.resume": {
    domain: "定时任务",
    title: "恢复定时任务",
    pathParams: SCHEDULE_ID_PARAM,
    queryParams: [],
    sampleBody: null,
  },
  "schedules.dispatch": {
    domain: "定时任务",
    title: "立即执行",
    pathParams: SCHEDULE_ID_PARAM,
    queryParams: [],
    sampleBody: DISPATCH_SCHEDULE_SAMPLE,
  },
  "schedules.delete": {
    domain: "定时任务",
    title: "删除定时任务",
    pathParams: SCHEDULE_ID_PARAM,
    queryParams: [],
    sampleBody: null,
  },
  "schedules.runs": {
    domain: "定时任务",
    title: "运行记录",
    pathParams: SCHEDULE_ID_PARAM,
    queryParams: PAGE_QUERY,
    sampleBody: null,
  },
} as const satisfies Record<PublicV1OperationId, ApiEndpointOverlay>;

function toApiMethod(method: PublicV1Operation["method"]): ApiMethod {
  return method.toUpperCase() as ApiMethod;
}

function toCatalogPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/** Data operations are generated from the shared public `/v1` manifest. */
export const DATA_API_CATALOG: readonly ApiEndpoint[] = PUBLIC_V1_OPERATIONS.map(
  (operation) => {
    const overlay = ENDPOINT_OVERLAYS[operation.id];
    return {
      id: operation.id,
      operationId: operation.id,
      kind: "data" as const,
      domain: overlay.domain,
      method: toApiMethod(operation.method),
      pathTemplate: toCatalogPath(operation.path),
      title: overlay.title,
      pathParams: overlay.pathParams,
      queryParams: overlay.queryParams,
      headerParams: "headerParams" in overlay ? overlay.headerParams : [],
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
    domain: "文档",
    method: "GET",
    pathTemplate: "/v1/openapi.json",
    title: "OpenAPI 规范",
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
    domain: "文档",
    method: "GET",
    pathTemplate: "/v1/docs",
    title: "Swagger UI",
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
