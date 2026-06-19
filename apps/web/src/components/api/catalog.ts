/**
 * `catalog.ts` — the curated `/v1` endpoint catalog for the in-console API
 * Playground (`/api`, add-api-playground Track 2; epic Track B).
 *
 * This is the SINGLE source of truth the rail + request + response panels render
 * against. Per the api-playground spec ("The catalog is the curated, real /v1
 * surface") and design D2, the playground exposes ONLY these fixed, real `/v1`
 * paths — there is deliberately NO free-form URL field, so the page can never be
 * turned into an SSRF-style arbitrary-request tool. Path params (`:id`) get a
 * dedicated input that is substituted into the path before sending; the runner
 * (Track 1's `sendApiRequest`) never receives an operator-typed host/path.
 *
 * The catalog is data-only (no React / no window access) so it is trivially
 * SSR-safe and can seed a deterministic default-selected endpoint for the
 * mock-mode pixel baseline (design D6).
 *
 * The SSE `GET /v1/tasks/:id/events` entry is flagged `streaming: true` so the
 * page routes it to the live-tail streaming view (Track 3) instead of the
 * single request/response model (design D5).
 */

/** An HTTP method a catalog endpoint can use. */
export type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";

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

/** The domain groups, in display order, that the rail buckets endpoints under. */
export type ApiDomain = "任务" | "仓库" | "文档";

/** One curated `/v1` endpoint the playground can call. */
export interface ApiEndpoint {
  /** A stable id (also the default-selection key + React list key). */
  id: string;
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
  /**
   * A pretty-printed JSON sample body for write endpoints, or `null` for reads.
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
 * The curated catalog, grouped by domain in display order. This is the EXACT
 * applied `/v1` surface the spec enumerates (tasks lifecycle + transcript +
 * repos read + openapi.json + the SSE events stream) — nothing more.
 */
export const API_CATALOG: readonly ApiEndpoint[] = [
  // ---- 任务 ----------------------------------------------------------------
  {
    id: "create-task",
    domain: "任务",
    method: "POST",
    pathTemplate: "/v1/tasks",
    title: "创建任务",
    pathParams: [],
    queryParams: [],
    sampleBody: [
      "{",
      '  "repo": "tanghehui/cloud-agent-platform",',
      '  "branch": "main",',
      '  "runtime": "codex",',
      '  "prompt": "为 /metrics 增加 docker-stats 采样"',
      "}",
    ].join("\n"),
    destructive: true,
    streaming: false,
  },
  {
    id: "list-tasks",
    domain: "任务",
    method: "GET",
    pathTemplate: "/v1/tasks",
    title: "任务列表",
    pathParams: [],
    queryParams: [
      { name: "limit", defaultValue: "20", hint: "每页数量（默认 20）" },
      { name: "cursor", defaultValue: "", hint: "分页游标（上一页响应返回）" },
    ],
    sampleBody: null,
    destructive: false,
    streaming: false,
  },
  {
    id: "get-task",
    domain: "任务",
    method: "GET",
    pathTemplate: "/v1/tasks/:id",
    title: "任务详情",
    pathParams: [
      { name: "id", label: "任务 ID", placeholder: "task_f8a2" },
    ],
    queryParams: [],
    sampleBody: null,
    destructive: false,
    streaming: false,
  },
  {
    id: "stop-task",
    domain: "任务",
    method: "POST",
    pathTemplate: "/v1/tasks/:id/stop",
    title: "停止任务",
    pathParams: [
      { name: "id", label: "任务 ID", placeholder: "task_f8a2" },
    ],
    queryParams: [],
    sampleBody: null,
    destructive: true,
    streaming: false,
  },
  {
    id: "task-transcript",
    domain: "任务",
    method: "GET",
    pathTemplate: "/v1/tasks/:id/transcript",
    title: "任务记录",
    pathParams: [
      { name: "id", label: "任务 ID", placeholder: "task_f8a2" },
    ],
    queryParams: [],
    sampleBody: null,
    destructive: false,
    streaming: false,
  },
  {
    id: "task-events",
    domain: "任务",
    method: "GET",
    pathTemplate: "/v1/tasks/:id/events",
    title: "事件流 (SSE)",
    pathParams: [
      { name: "id", label: "任务 ID", placeholder: "task_f8a2" },
    ],
    queryParams: [],
    sampleBody: null,
    destructive: false,
    streaming: true,
  },
  // ---- 仓库 ----------------------------------------------------------------
  {
    id: "list-repos",
    domain: "仓库",
    method: "GET",
    pathTemplate: "/v1/repos",
    title: "仓库列表",
    pathParams: [],
    queryParams: [
      { name: "limit", defaultValue: "20", hint: "每页数量（默认 20）" },
      { name: "cursor", defaultValue: "", hint: "分页游标（上一页响应返回）" },
    ],
    sampleBody: null,
    destructive: false,
    streaming: false,
  },
  {
    id: "get-repo",
    domain: "仓库",
    method: "GET",
    pathTemplate: "/v1/repos/:id",
    title: "仓库详情",
    pathParams: [
      { name: "id", label: "仓库 ID", placeholder: "repo_3c1d" },
    ],
    queryParams: [],
    sampleBody: null,
    destructive: false,
    streaming: false,
  },
  // ---- 文档 ----------------------------------------------------------------
  {
    id: "openapi",
    domain: "文档",
    method: "GET",
    pathTemplate: "/v1/openapi.json",
    title: "OpenAPI 规范",
    pathParams: [],
    queryParams: [],
    sampleBody: null,
    destructive: false,
    streaming: false,
  },
];

/**
 * The deterministic default-selected endpoint (the first catalog entry,
 * `POST /v1/tasks`) — so the page opens on a stable endpoint with a sample body
 * for the mock-mode pixel baseline (design D6). Matches the design's active row.
 */
export const DEFAULT_ENDPOINT_ID: string = API_CATALOG[0]!.id;

/** The domain groups in display order (drives the rail's grouping). */
export const API_DOMAINS: readonly ApiDomain[] = ["任务", "仓库", "文档"];

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
