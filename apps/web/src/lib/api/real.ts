/**
 * Real REST client — the sole real data-access layer (frontend-console spec
 * 13.5/13.6; rebuild-console-tanstack-start D5/D6).
 *
 * Every request targets the env-configured cross-origin {@link apiBaseUrl} and
 * carries the operator bearer token (D12). Response bodies are validated
 * against the `@cap/contracts` schemas so the web app never re-declares the
 * shared shapes — contracts is the single source of truth.
 *
 * Requests are sent with `credentials: "include"` so the httpOnly session cookie
 * rides cross-origin automatically (the api must CORS-allowlist the web origin).
 * The bearer header is still attached for the optional legacy shared-token path.
 *
 * As the backend lands new endpoints, they are added here and switched on by
 * flipping their `BACKEND_CAPABILITIES` flag in `lib/api/capabilities.ts`
 * (the single real/mock seam, D5).
 */
import {
  ListTasksResponseSchema,
  TaskResponseSchema,
  ListReposResponseSchema,
  RepoResponseSchema,
  AuthSessionResponseSchema,
  AuthCapabilitiesSchema,
  type AuthCapabilities,
  AdminAccountListResponseSchema,
  AdminAccountListItemSchema,
  type AdminAccountListResponse,
  type AdminAccountListItem,
  type AdminCreateAccountRequest,
  type Role,
  MetricsResponseSchema,
  TaskResourceResponseSchema,
  SessionHistorySchema,
  ListAuditEventsResponseSchema,
  AccountSettingsSchema,
  CodexCredentialSchema,
  ClaudeCredentialSchema,
  CodexDeviceLoginStartResponseSchema,
  CodexDeviceLoginStatusSchema,
  ListAvailableGithubReposResponseSchema,
  DefaultRepoResponseSchema,
  VerifiedRepoImportResponseSchema,
  UpdateStatusSchema,
  DiscoverModelsResponseSchema,
  ListSandboxEnvironmentsResponseSchema,
  ValidateSandboxEnvironmentResponseSchema,
  SandboxEnvironmentResponseSchema,
  ListSandboxEnvironmentValidationsResponseSchema,
  ListSchedulesResponseSchema,
  ListScheduleRunsResponseSchema,
  ScheduleResponseSchema,
  RuntimeModelCatalogQuerySchema,
  RuntimeModelCatalogSchema,
  RuntimeModelErrorSchema,
  RepoImportFailureSchema,
  type DiscoverModelsRequest,
  type DiscoverModelsResponse,
  type UpdateStatus,
  type ListTasksResponse,
  type TaskResponse,
  type ListReposResponse,
  type RepoResponse,
  type CreateTaskRequest,
  type AuthSession,
  type AuthSessionResponse,
  type MetricsResponse,
  type TaskResourceResponse,
  type SessionHistory,
  type ListAuditEventsResponse,
  type AuditQuery,
  type AccountSettings,
  type UpdateSettingsRequest,
  type CodexCredential,
  type SaveCodexCredentialRequest,
  type ClaudeCredential,
  type SaveClaudeCredentialRequest,
  type CodexDeviceLoginSessionId,
  type CodexDeviceLoginStartResponse,
  type CodexDeviceLoginStatus,
  type ListAvailableGithubReposResponse,
  type ImportRepoRequest,
  type VerifiedRepoImportResponse,
  type SetDefaultRepoRequest,
  type DefaultRepoResponse,
  type ListSandboxEnvironmentsResponse,
  type ValidateSandboxEnvironmentResponse,
  type SandboxEnvironmentResponse,
  type ListSandboxEnvironmentValidationsResponse,
  type CreateSandboxEnvironmentRequest,
  type CreateScheduleRequest,
  type DispatchScheduleRequest,
  type UpdateScheduleRequest,
  type ListSchedulesResponse,
  type ListScheduleRunsResponse,
  type ScheduleResponse,
  type RuntimeModelCatalogQuery,
  type RuntimeModelCatalog,
  type RuntimeModelError,
  type RepoImportFailure,
} from "@cap/contracts";
import { createParser } from "eventsource-parser";
import {
  ListAvailableForgeReposResponseSchema,
  ListForgeCredentialsResponseSchema,
  ForgeCredentialSchema,
  type ListAvailableForgeReposResponse,
  type ListForgeCredentialsResponse,
  type ForgeCredential,
  type ConnectForgeCredentialRequest,
  type CreateRepoRequest,
  type ForgeKind,
} from "@cap/contracts";
import {
  ApiKeyMintResponseSchema,
  ApiKeyListResponseSchema,
  ApiKeyRevokeResponseSchema,
  type ApiKeyMintRequest,
  type ApiKeyMintResponse,
  type ApiKeyListResponse,
  type ApiKeyRevokeResponse,
} from "@cap/contracts";
import { apiBaseUrl, operatorToken } from "../config";
import { getIncomingCookieHeader } from "../server-cookie";

// ---------------------------------------------------------------------------
// Agent runtime selection (add-claude-code-runtime) — LOCAL web types
//
// The `runtime` selector (`claude-code` | `codex`) and the `/runtimes` readiness
// shape are owned by the contracts track of this same change; they are mirrored
// here as LOCAL web types DELIBERATELY (the `SelfUpdateRequest` precedent): a
// shared `@cap/contracts` schema would be a cross-track shared file (tasks.md
// NOTE). The api does the load-bearing validation server-side (the create body's
// `runtime` is validated against the shared enum; `/runtimes` reports booleans
// only, never a token). Once the contracts schema lands, these collapse onto it
// with no call-site change.
// ---------------------------------------------------------------------------

/** The agent runtime a task runs under. Default `codex` (omitted ⇒ codex). */
export type RuntimeId = "claude-code" | "codex";

/** Readiness of a single runtime (booleans only — never a secret). */
export interface RuntimeReadiness {
  /** The runtime id this readiness describes. */
  id: RuntimeId;
  /** Whether the runtime is configured/ready to run a task right now. */
  ready: boolean;
}

/** `GET /runtimes` response — per-runtime readiness, no secrets. */
export type RuntimesResponse = readonly RuntimeReadiness[];

/**
 * The create-task body extended with the optional `runtime` selector. Sent on
 * `POST /repos/:repoId/tasks`; omitted ⇒ the api defaults to `codex`. Typed as a
 * local intersection so the web compiles ahead of the contracts-track enum
 * landing on `CreateTaskRequest` (at which point this alias collapses onto it).
 */
export type CreateTaskBody = CreateTaskRequest & { runtime?: RuntimeId };

/** A REST error carrying the HTTP status so callers can branch on 401/404/etc. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Parse only the canonical secret-free runtime-model error body. */
export function runtimeModelErrorFromApiError(
  error: unknown,
): RuntimeModelError | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = RuntimeModelErrorSchema.safeParse(error.body);
  return parsed.success ? parsed.data : null;
}

/** Parse only the stable, secret-free Console repository-import error body. */
export function repoImportFailureFromApiError(
  error: unknown,
): RepoImportFailure | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = RepoImportFailureSchema.safeParse(error.body);
  return parsed.success ? parsed.data : null;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = operatorToken();
  // D12: attach the operator bearer token to every REST call (legacy path).
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = authHeaders(init?.headers as Record<string, string> | undefined);
  // SSR-only: forward the incoming browser request's Cookie header so the
  // server-side fetch carries the same session cookie the browser would
  // send. On the client this is a no-op ("") — the browser attaches the cookie
  // to fetch itself via `credentials: "include"` below. Never throws.
  const incomingCookie = await getIncomingCookieHeader();
  if (incomingCookie) headers["Cookie"] = incomingCookie;
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    // D6: carry the (future) httpOnly session cookie cross-origin.
    credentials: "include",
    headers,
  });
  if (!res.ok) {
    let detail = res.statusText;
    let body: unknown;
    try {
      const text = await res.text();
      detail = text || detail;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          // Plain-text errors remain available through `message`.
        }
      }
    } catch {
      // Ignore body read failures; fall back to the status text.
    }
    throw new ApiError(res.status, detail, body);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

/**
 * Like {@link request} but returns the raw response BODY TEXT rather than
 * decoding JSON — for endpoints that serve `text/plain` (e.g. the finished-task
 * asciicast at `GET /tasks/:id/cast`, session-terminal-replay). Reuses the same
 * operator-bearer + SSR cookie-forwarding discipline and the same `ApiError`
 * branch on non-2xx. A 204/empty body resolves to an empty string.
 */
async function requestText(path: string, init?: RequestInit): Promise<string> {
  const headers = authHeaders(init?.headers as Record<string, string> | undefined);
  const incomingCookie = await getIncomingCookieHeader();
  if (incomingCookie) headers["Cookie"] = incomingCookie;
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.text()) || detail;
    } catch {
      // Ignore body read failures; fall back to the status text.
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return "";
  return res.text();
}

// ---------------------------------------------------------------------------
// Generic API Playground runner (add-api-playground D3) — REAL-only
//
// The endpoint-specific helpers below each target ONE path and parse against a
// fixed `@cap/contracts` schema. The in-console API Playground needs the
// opposite: ONE generic runner that can send ANY catalog `/v1` request and
// surface the RAW response (status/timing/size/headers/body) for inspection —
// it deliberately does NOT Zod-validate (the playground shows whatever the api
// returned, including errors). It reuses the SAME transport discipline as
// `request()` (cross-origin {@link apiBaseUrl} + `credentials: "include"` +
// operator-bearer + SSR cookie forwarding), so a send is signed by the
// operator's console session with no token to paste (design D1).
//
// SECURITY: this runs raw fetches against the playground's CURATED `/v1`
// catalog only — the page exposes no free-form URL field (spec "no open fetch
// box"). The runner itself is path-agnostic; the catalog (catalog-and-panels
// track) is what constrains the reachable surface.
// ---------------------------------------------------------------------------

/** A single playground request to execute (built by the request editor). */
export interface SendApiRequestInput {
  /** HTTP method (e.g. `GET`, `POST`). */
  method: string;
  /** The fully-resolved path (path params already substituted), e.g. `/v1/tasks/abc`. */
  path: string;
  /** Optional query params appended as a query string (blank/undefined values skipped). */
  query?: Record<string, string | undefined>;
  /** Optional extra request headers (merged over the auto-injected auth/content-type). */
  headers?: Record<string, string>;
  /** Optional request body for writes — JSON-encoded when present. */
  body?: unknown;
}

/**
 * The result of a playground send. A NON-2xx status is a normal result here
 * (`ok: false`) — NOT an {@link ApiError} throw — because the playground's whole
 * job is to display whatever the api returned. A genuine transport failure
 * (network unreachable, CORS) also resolves to this shape via the
 * {@link SendApiErrorResult} variant so the response panel can render it instead
 * of crashing the page (spec "a failed send renders the error, not a crash").
 */
export interface SendApiResponseResult {
  /** Discriminator: a real HTTP round-trip completed (any status). */
  kind: "response";
  /** HTTP status code. */
  status: number;
  /** HTTP status text (e.g. `Created`). */
  statusText: string;
  /** `true` for a 2xx status. */
  ok: boolean;
  /** Client-measured elapsed wall time in milliseconds. */
  durationMs: number;
  /** Byte length of the raw response body (UTF-8). */
  sizeBytes: number;
  /** Response headers as a plain object (lower-cased keys, per `Headers`). */
  headers: Record<string, string>;
  /** The raw response body text (always present; empty string for a 204/empty body). */
  body: string;
  /** The parsed body — present ONLY when the response content-type is JSON and parses. */
  json?: unknown;
}

/**
 * The transport-failure variant: the fetch itself rejected (network down, DNS,
 * CORS, abort) so there is no HTTP status to show. Resolved, never thrown, so
 * the page renders an honest error state.
 */
export interface SendApiErrorResult {
  /** Discriminator: the request never reached an HTTP response. */
  kind: "error";
  /** A human-readable failure message (the rejected fetch's message). */
  message: string;
  /** Client-measured elapsed wall time before the failure, in milliseconds. */
  durationMs: number;
}

/** The discriminated outcome of {@link sendApiRequest} — a response or a transport error. */
export type SendApiResult = SendApiResponseResult | SendApiErrorResult;

export interface ApiSseEvent {
  id?: string;
  event?: string;
  data: string;
}

export interface StreamApiEventsInput {
  /** Curated SSE path with all path parameters already resolved. */
  path: string;
  /** Optional public resume cursor sent as the `Last-Event-ID` header. */
  lastEventId?: string;
  signal?: AbortSignal;
  onOpen?: () => void;
  onEvent: (event: ApiSseEvent) => void;
}

/**
 * Open a session-authenticated public SSE stream with full header control.
 * Native EventSource cannot set `Last-Event-ID`, so the playground uses fetch
 * plus the standards-compliant eventsource-parser and exposes the real resume
 * contract instead of silently omitting it.
 */
export async function streamApiEvents(
  input: StreamApiEventsInput,
): Promise<void> {
  const headers = authHeaders();
  const lastEventId = input.lastEventId?.trim();
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;
  const incomingCookie = await getIncomingCookieHeader();
  if (incomingCookie) headers["Cookie"] = incomingCookie;

  const response = await fetch(`${apiBaseUrl()}${input.path}`, {
    method: "GET",
    credentials: "include",
    headers,
    signal: input.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new ApiError(response.status, detail || response.statusText);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    throw new Error(`Expected text/event-stream, received ${contentType || "no content type"}`);
  }
  if (!response.body) {
    throw new Error("SSE response body is unavailable");
  }

  let parseFailure: Error | null = null;
  const parser = createParser({
    maxBufferSize: 1024 * 1024,
    onEvent: (event) => input.onEvent(event),
    onError: (error) => {
      parseFailure = error;
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  input.onOpen?.();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      if (parseFailure) throw parseFailure;
    }
    parser.feed(decoder.decode());
    parser.reset({ consume: true });
    if (parseFailure) throw parseFailure;
  } finally {
    reader.releaseLock();
  }
}

/** Build a query string from a params map, skipping blank/undefined values. */
function buildQueryString(query?: Record<string, string | undefined>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** True when a content-type names a JSON media type (`application/json`, `*+json`). */
function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/**
 * The generic API Playground runner (add-api-playground D3). Sends ONE raw,
 * session-authed request to the cross-origin api and resolves to the RAW
 * outcome for inspection — it does NOT parse against `@cap/contracts` and does
 * NOT throw on a non-2xx (a `4xx`/`5xx` is a normal `kind: "response"` result).
 * A transport failure resolves to a `kind: "error"` result so the response panel
 * renders honestly instead of crashing (spec). Reuses the same base URL +
 * `credentials: "include"` + operator-bearer + SSR cookie-forwarding discipline
 * as {@link request}, so the send is signed by the operator's console session.
 */
export async function sendApiRequest(
  input: SendApiRequestInput,
): Promise<SendApiResult> {
  const method = input.method.toUpperCase();
  const url = `${apiBaseUrl()}${input.path}${buildQueryString(input.query)}`;

  // Only attach a JSON body for methods that carry one (and only when supplied).
  const hasBody =
    input.body !== undefined && method !== "GET" && method !== "HEAD";
  const extra: Record<string, string> = { ...input.headers };
  if (hasBody && extra["Content-Type"] == null) {
    extra["Content-Type"] = "application/json";
  }
  const headers = authHeaders(extra);
  const incomingCookie = await getIncomingCookieHeader();
  if (incomingCookie) headers["Cookie"] = incomingCookie;

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "include",
      headers,
      body: hasBody ? JSON.stringify(input.body) : undefined,
    });
  } catch (err) {
    // Transport failure (network/DNS/CORS/abort) — resolve, never throw.
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }

  // Read the raw body text even on a non-2xx; the playground shows it verbatim.
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }
  const durationMs = Date.now() - startedAt;

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  let json: unknown;
  if (isJsonContentType(res.headers.get("content-type")) && bodyText) {
    try {
      json = JSON.parse(bodyText);
    } catch {
      // A malformed JSON body still shows as raw text; just no parsed view.
      json = undefined;
    }
  }

  return {
    kind: "response",
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
    durationMs,
    // Byte length of the raw payload (UTF-8), not the JS string length.
    sizeBytes: new TextEncoder().encode(bodyText).length,
    headers: responseHeaders,
    body: bodyText,
    json,
  };
}

/** `GET /tasks` — the fleet dashboard list. */
export async function listTasks(): Promise<ListTasksResponse> {
  return ListTasksResponseSchema.parse(await request("/tasks"));
}

/** `GET /tasks/:id` — a single task (session page). */
export async function getTask(id: string): Promise<TaskResponse> {
  return TaskResponseSchema.parse(await request(`/tasks/${encodeURIComponent(id)}`));
}

/** `GET /repos` — registered repos for the new-task form. */
export async function listRepos(): Promise<ListReposResponse> {
  return ListReposResponseSchema.parse(await request("/repos"));
}

/**
 * `POST /repos/:repoId/refresh-default-branch` — re-verify one existing
 * repository's symbolic HEAD with the current Console session. The endpoint
 * accepts no client branch (and therefore no JSON body); the canonical Repo
 * response is the only value callers may publish into the query cache.
 */
export async function refreshRepoDefaultBranch(
  repoId: string,
): Promise<RepoResponse> {
  const refreshed = RepoResponseSchema.parse(
    await request(
      `/repos/${encodeURIComponent(repoId)}/refresh-default-branch`,
      { method: "POST" },
    ),
  );
  if (refreshed.id !== repoId) {
    throw new ApiError(
      502,
      "Repository refresh returned a mismatched repository identity.",
    );
  }
  return refreshed;
}

/**
 * `POST /repos/:repoId/tasks` — create a task under a repo (new-task form).
 * Returns the created task; 201 on success, 404 when the repo does not exist.
 */
export async function createTask(
  repoId: string,
  body: CreateTaskBody,
): Promise<TaskResponse> {
  const created = await request(`/repos/${encodeURIComponent(repoId)}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return TaskResponseSchema.parse(created);
}

/**
 * `GET /runtimes` — per-runtime readiness for the create-task dialog selector
 * (add-claude-code-runtime, agent-runtime spec "Runtime readiness endpoint").
 * The api reports, per runtime id, only a boolean `ready` (e.g. is a credential
 * configured) and NEVER a secret, so the dialog can disable an unconfigured
 * runtime up front instead of letting the task fail at launch. The response is
 * normalized into a `Map<RuntimeId, boolean>` so an UNKNOWN/MISSING runtime id
 * reads as not-ready (fail-safe: never offer a runtime the api did not vouch for).
 * The wire shape is validated structurally here (local web type — see the runtime
 * types note above); a malformed entry is dropped rather than crashing the dialog.
 */
export async function getRuntimes(): Promise<RuntimesResponse> {
  const body = await request("/runtimes");
  // The api wraps the list as `{ runtimes: [...] }` (runtimes.service.ts); tolerate
  // a bare array too so the dialog never silently reads `[]` on a shape change.
  const entries = Array.isArray(body)
    ? body
    : Array.isArray((body as { runtimes?: unknown } | null)?.runtimes)
      ? (body as { runtimes: unknown[] }).runtimes
      : [];
  const out: RuntimeReadiness[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const { id, ready } = raw as { id?: unknown; ready?: unknown };
    if ((id === "claude-code" || id === "codex") && typeof ready === "boolean") {
      out.push({ id, ready });
    }
  }
  return out;
}

/**
 * Query the owner-scoped model catalog for the exact runtime/environment
 * context that will be used by task admission. The three environment intents
 * (omitted, null, UUID) are preserved on the wire.
 */
export async function queryRuntimeModels(
  body: RuntimeModelCatalogQuery,
): Promise<RuntimeModelCatalog> {
  const query = RuntimeModelCatalogQuerySchema.parse(body);
  return RuntimeModelCatalogSchema.parse(
    await request("/v1/runtime-models/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    }),
  );
}

/**
 * `POST /tasks/:taskId/stop` — operator-initiated stop (task-guardrail-controls).
 * Transitions an active task to `cancelled`, tearing down its sandbox and freeing
 * its concurrency slot. Idempotent: a task already in a terminal state is returned
 * unchanged. Returns the resulting task (200); 404 when the task does not exist.
 */
export async function stopTask(taskId: string): Promise<TaskResponse> {
  const stopped = await request(`/tasks/${encodeURIComponent(taskId)}/stop`, {
    method: "POST",
  });
  return TaskResponseSchema.parse(stopped);
}

/** `GET /schedules` — owner-scoped recurring task schedules. */
export async function listSchedules(): Promise<ListSchedulesResponse> {
  return ListSchedulesResponseSchema.parse(await request("/schedules"));
}

/** `POST /schedules` — create an owner-scoped recurring task schedule. */
export async function createSchedule(
  body: CreateScheduleRequest,
): Promise<ScheduleResponse> {
  return ScheduleResponseSchema.parse(
    await request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `PATCH /schedules/:id` — update recurrence, policy, or task template. */
export async function updateSchedule(
  id: string,
  body: UpdateScheduleRequest,
): Promise<ScheduleResponse> {
  return ScheduleResponseSchema.parse(
    await request(`/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `POST /schedules/:id/pause` — pause future fires. */
export async function pauseSchedule(id: string): Promise<ScheduleResponse> {
  return ScheduleResponseSchema.parse(
    await request(`/schedules/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    }),
  );
}

/** `POST /schedules/:id/resume` — resume and compute a future next run. */
export async function resumeSchedule(id: string): Promise<ScheduleResponse> {
  return ScheduleResponseSchema.parse(
    await request(`/schedules/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    }),
  );
}

/** `POST /schedules/:id/dispatch` — consume the expected current schedule period. */
export async function dispatchSchedule(
  id: string,
  expectedPeriodKey?: DispatchScheduleRequest["expectedPeriodKey"],
): Promise<ScheduleResponse> {
  return ScheduleResponseSchema.parse(
    await request(`/schedules/${encodeURIComponent(id)}/dispatch`, {
      method: "POST",
      ...(expectedPeriodKey
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedPeriodKey }),
          }
        : {}),
    }),
  );
}

/** `DELETE /schedules/:id` — delete a schedule. */
export async function deleteSchedule(id: string): Promise<void> {
  await request(`/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** `GET /schedules/:id/runs` — recent run ledger for one schedule. */
export async function listScheduleRuns(
  id: string,
): Promise<ListScheduleRunsResponse> {
  return ListScheduleRunsResponseSchema.parse(
    await request(`/schedules/${encodeURIComponent(id)}/runs`),
  );
}

// ---------------------------------------------------------------------------
// Real domains behind capability flags.
//
// The backend endpoints below are IMPLEMENTED but their `BACKEND_CAPABILITIES`
// flag may still be `false` (mock) pending end-to-end verification against the
// running api + a session. They live here, fully written, so flipping a
// flag to `true` is the entire integration step — no page rewrite, no new
// function. Each parses against `@cap/contracts` exactly like the four live
// endpoints above and rides the same `credentials: "include"` session-cookie
// transport (D6). Until a flag flips, `queries.ts` simply never calls these.
// ---------------------------------------------------------------------------

/**
 * `GET /auth/session` — the current console session identity, or `null`
 * when unauthenticated. EVERY authenticated endpoint
 * (this one included) answers a missing/expired/revoked/disabled-account session
 * with HTTP 401 — there is NO `200 { user: null }` body. So a 401 here is the
 * normal "logged out" signal, NOT an error: we map it to `null` (a resolved
 * `AuthSession`) so the auth gate and session-aware UI treat it as logged out
 * and redirect, instead of rejecting into an error boundary. Genuine failures
 * (network, 5xx) still propagate. Gated by `BACKEND_CAPABILITIES.auth`.
 */
export async function getAuthSession(): Promise<AuthSession> {
  try {
    const body: AuthSessionResponse = AuthSessionResponseSchema.parse(
      await request("/auth/session"),
    );
    return body.user;
  } catch (err) {
    // 401 = unauthenticated (no / expired / revoked / disabled-account session);
    // that is "logged out", not a failure — resolve it to `null`.
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/**
 * Reads the unauthenticated auth-method capability flags
 * (add-private-account-identity, D11) the login modal renders from. The backend
 * surfaces `capabilities` on `GET /auth/session` for BOTH the authenticated (200)
 * and logged-out (401) bodies, so this hits that endpoint with a RAW fetch (not
 * {@link request}, which throws away the 401 body) and extracts the block from
 * whichever status comes back. Returns `null` when the flags are absent or
 * unparseable so the caller can fall back to a safe default. Client-only use (the
 * login page); never throws.
 */
export async function getAuthCapabilities(): Promise<AuthCapabilities | null> {
  try {
    const res = await fetch(`${apiBaseUrl()}/auth/session`, {
      credentials: "include",
      headers: authHeaders(),
    });
    const body: unknown = await res.json().catch(() => null);
    const caps = (body as { capabilities?: unknown } | null)?.capabilities;
    const parsed = AuthCapabilitiesSchema.safeParse(caps);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * `GET /metrics` — semaphore-derived capacity + sampled CPU/memory in one
 * round trip. The sampled block ALSO carries the per-task process-scope
 * section (`resources.taskSamples`, console-design-pixel-merge): each running
 * task's LATEST frame keyed by `taskId`, with server-computed
 * `cpuPercent`/`memoryPercent`, the shared `scope` discriminator (`process`,
 * falling back to `container`), and `sampledAt`/`ageMs`/`stale` freshness —
 * so the pool panel's per-runner rows render from this ONE poll instead of a
 * per-task fan-out. The section rides the SAME shared
 * `MetricsResponseSchema` from `@cap/contracts` (no web-side re-declaration),
 * so this client validates it with no shape of its own to drift. Gated by
 * `BACKEND_CAPABILITIES.metrics`.
 */
export async function getMetrics(): Promise<MetricsResponse> {
  return MetricsResponseSchema.parse(await request("/metrics"));
}

/**
 * `GET /tasks/:taskId/metrics` — this task's own sampled CPU/memory (real-time,
 * from the latest sampler snapshot), or a `not-running` state when the task has
 * no live sampled container. Gated by `BACKEND_CAPABILITIES.metrics` (same as
 * `getMetrics`).
 */
export async function getTaskResource(
  taskId: string,
): Promise<TaskResourceResponse> {
  return TaskResourceResponseSchema.parse(
    await request(`/tasks/${encodeURIComponent(taskId)}/metrics`),
  );
}

/**
 * `GET /tasks/:id/session-history` — the parsed, read-only codex transcript of a
 * FINISHED task (or an honest empty/expired state), read from its settled
 * retained sandbox (session-sandbox-retention). The wire shape is the
 * discriminated `SessionHistorySchema` from `@cap/contracts` — validated here so
 * no malformed transcript reaches the replay UI. Gated by
 * `BACKEND_CAPABILITIES.sessionHistory`.
 */
export async function getSessionHistory(
  taskId: string,
): Promise<SessionHistory> {
  return SessionHistorySchema.parse(
    await request(`/tasks/${encodeURIComponent(taskId)}/session-history`),
  );
}

/**
 * `GET /history` — recent audit events, most-recent-first, with optional
 * `level` / `status` / `limit` filters (server-side; the client filter in
 * `use-client-filter` is a separate, additive view concern). Gated by
 * `BACKEND_CAPABILITIES.history`.
 */
export async function listAuditEvents(
  query?: Partial<AuditQuery>,
): Promise<ListAuditEventsResponse> {
  const params = new URLSearchParams();
  if (query?.level) params.set("level", query.level);
  if (query?.status) params.set("status", query.status);
  if (query?.limit != null) params.set("limit", String(query.limit));
  const qs = params.toString();
  return ListAuditEventsResponseSchema.parse(
    await request(`/audit/events${qs ? `?${qs}` : ""}`),
  );
}

/** `GET /settings` — account preferences. Gated by `BACKEND_CAPABILITIES.settings`. */
export async function getSettings(): Promise<AccountSettings> {
  return AccountSettingsSchema.parse(await request("/settings"));
}

/** `PATCH /settings` — update writable account preferences. */
export async function saveSettings(
  body: UpdateSettingsRequest,
): Promise<AccountSettings> {
  return AccountSettingsSchema.parse(
    await request("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `GET /settings/codex` — the Codex execution credential (never the key). */
export async function getCodexCredential(): Promise<CodexCredential> {
  return CodexCredentialSchema.parse(await request("/settings/codex"));
}

/** `PUT /settings/codex` — save the Codex credential (apiKey is write-only). */
export async function saveCodexCredential(
  body: SaveCodexCredentialRequest,
): Promise<CodexCredential> {
  return CodexCredentialSchema.parse(
    await request("/settings/codex", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `GET /settings/claude` — the Claude Code credential (never the secret). */
export async function getClaudeCredential(): Promise<ClaudeCredential> {
  return ClaudeCredentialSchema.parse(await request("/settings/claude"));
}

/** `PUT /settings/claude` — save the Claude credential (secrets are write-only). */
export async function saveClaudeCredential(
  body: SaveClaudeCredentialRequest,
): Promise<ClaudeCredential> {
  return ClaudeCredentialSchema.parse(
    await request("/settings/claude", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * `POST /settings/codex/models` — probe a CANDIDATE compatible provider for its
 * available model ids, validating the operator-supplied `{baseUrl, apiKey}`
 * BEFORE anything is persisted (nothing is stored by this call). The request and
 * response shapes are the shared `@cap/contracts` discovery schemas (the same
 * `DiscoverModelsRequestSchema` the api controller's pipe validates), so the web
 * app and api share one shape with nothing re-declared web-side.
 *
 * The response is the discriminated outcome: `{ ok: true, models }` on success, or
 * `{ ok: false, error, message }` with a distinguishable error class
 * (`provider_auth_failed` / `provider_unreachable` / `provider_bad_response`) so
 * the dialog can reflect the REAL outcome — auth-failure vs unreachable vs a
 * malformed model list — instead of a client-side non-empty-field check. The
 * api-side SSRF guard + timeout + body bound keep the operator-supplied Base URL
 * from being a fetch-anything channel. A non-2xx HTTP status (e.g. the request
 * body failed the api's Zod pipe) still throws an {@link ApiError}; the
 * `{ ok: false }` body is the provider-level outcome, not a transport error.
 */
export async function discoverCodexModels(
  body: DiscoverModelsRequest,
): Promise<DiscoverModelsResponse> {
  return DiscoverModelsResponseSchema.parse(
    await request("/settings/codex/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * `GET /tasks/:id/cast` — the finished task's `session.cast` (asciicast v2 JSONL)
 * served as raw `text/plain` (session-terminal-replay). Returns the body text
 * for the read-only timing player to parse; a missing/absent cast surfaces as an
 * {@link ApiError} (the player renders an empty/"no recording" state).
 */
export async function getSessionCast(taskId: string): Promise<string> {
  return requestText(`/tasks/${encodeURIComponent(taskId)}/cast`);
}

/** Start an asynchronous, account-scoped official Codex login session. */
export async function startCodexDeviceLogin(): Promise<CodexDeviceLoginStartResponse> {
  return CodexDeviceLoginStartResponseSchema.parse(
    await request("/settings/codex/device-login", { method: "POST" }),
  );
}

/** Poll one exact login attempt; callers may abort an obsolete request. */
export async function pollCodexDeviceLogin(
  sessionId: CodexDeviceLoginSessionId,
  signal?: AbortSignal,
): Promise<CodexDeviceLoginStatus> {
  const status = CodexDeviceLoginStatusSchema.parse(
    await request(
      `/settings/codex/device-login/${encodeURIComponent(sessionId)}`,
      { signal },
    ),
  );
  if (status.sessionId !== sessionId) {
    throw new Error("设备登录会话响应不匹配，请重试。");
  }
  return status;
}

/** Cancel and reclaim one exact login attempt. The endpoint is idempotent. */
export async function cancelCodexDeviceLogin(
  sessionId: CodexDeviceLoginSessionId,
): Promise<void> {
  await request(
    `/settings/codex/device-login/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

/**
 * `GET /repos/github/available` — the operator's importable GitHub repositories,
 * sourced server-side via the connected GitHub PAT (the token never reaches the
 * browser). Gated by `BACKEND_CAPABILITIES.githubImport`.
 */
export async function listGithubRepos(): Promise<ListAvailableGithubReposResponse> {
  return ListAvailableGithubReposResponseSchema.parse(
    await request("/repos/github/available"),
  );
}

/** `POST /repos/github/import` — import a GitHub repo into the platform as a `Repo`. */
export async function importRepo(
  body: ImportRepoRequest,
): Promise<VerifiedRepoImportResponse> {
  return VerifiedRepoImportResponseSchema.parse(
    await request("/repos/github/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * `GET /settings/forges/repos?kind=…` — the import picker listing for a connected
 * forge (add-multi-forge-task-delivery). A trusted server-side call to the
 * operator's own forge; the token never reaches the browser.
 */
export async function listAvailableForgeRepos(
  kind: ForgeKind,
): Promise<ListAvailableForgeReposResponse> {
  return ListAvailableForgeReposResponseSchema.parse(
    await request(`/settings/forges/repos?kind=${encodeURIComponent(kind)}`),
  );
}

/**
 * `POST /repos` — register a repo by gitSource + forge (the GitLab/Gitee picker
 * and by-URL import path; GitHub keeps its dedicated `/repos/github/import`).
 */
export async function createRepo(
  body: CreateRepoRequest,
): Promise<VerifiedRepoImportResponse> {
  return VerifiedRepoImportResponseSchema.parse(
    await request("/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `GET /settings/forges` — the operator's connected forges (secret-free). */
export async function listForgeCredentials(): Promise<ListForgeCredentialsResponse> {
  return ListForgeCredentialsResponseSchema.parse(await request("/settings/forges"));
}

/** `PUT /settings/forges` — connect a forge by pasting a PAT (validated server-side). */
export async function connectForge(
  body: ConnectForgeCredentialRequest,
): Promise<ForgeCredential> {
  return ForgeCredentialSchema.parse(
    await request("/settings/forges", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `DELETE /settings/forges?kind=&host=` — disconnect a forge credential. */
export async function disconnectForge(
  kind: ForgeKind,
  host: string,
): Promise<void> {
  await request(
    `/settings/forges?kind=${encodeURIComponent(kind)}&host=${encodeURIComponent(host)}`,
    { method: "DELETE" },
  );
}

/** `GET /repos/github/default` — the current default repo, or `null` when unset. */
export async function getDefaultRepo(): Promise<DefaultRepoResponse> {
  return DefaultRepoResponseSchema.parse(await request("/repos/github/default"));
}

/** `POST /repos/github/default` — designate one imported repo as the default. */
export async function setDefaultRepo(
  body: SetDefaultRepoRequest,
): Promise<DefaultRepoResponse> {
  return DefaultRepoResponseSchema.parse(
    await request("/repos/github/default", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `GET /sandbox-environments` — admin managed sandbox environments. */
export async function listSandboxEnvironments(): Promise<ListSandboxEnvironmentsResponse> {
  return ListSandboxEnvironmentsResponseSchema.parse(
    await request("/sandbox-environments"),
  );
}

/** `POST /sandbox-environments` — create/import an environment descriptor. */
export async function createSandboxEnvironment(
  body: CreateSandboxEnvironmentRequest,
): Promise<SandboxEnvironmentResponse> {
  return SandboxEnvironmentResponseSchema.parse(
    await request("/sandbox-environments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `POST /sandbox-environments/:id/validate` — run provider validation. */
export async function validateSandboxEnvironment(
  id: string,
): Promise<ValidateSandboxEnvironmentResponse> {
  return ValidateSandboxEnvironmentResponseSchema.parse(
    await request(`/sandbox-environments/${encodeURIComponent(id)}/validate`, {
      method: "POST",
    }),
  );
}

/** `PATCH /sandbox-environments/:id/default` — set a ready environment as default. */
export async function setDefaultSandboxEnvironment(
  id: string,
): Promise<SandboxEnvironmentResponse> {
  return SandboxEnvironmentResponseSchema.parse(
    await request(`/sandbox-environments/${encodeURIComponent(id)}/default`, {
      method: "PATCH",
    }),
  );
}

/** `PATCH /sandbox-environments/:id/retire` — retire an environment from selection. */
export async function retireSandboxEnvironment(
  id: string,
): Promise<SandboxEnvironmentResponse> {
  return SandboxEnvironmentResponseSchema.parse(
    await request(`/sandbox-environments/${encodeURIComponent(id)}/retire`, {
      method: "PATCH",
    }),
  );
}

/** `GET /sandbox-environments/:id/validations` — validation history. */
export async function listSandboxEnvironmentValidations(
  id: string,
): Promise<ListSandboxEnvironmentValidationsResponse> {
  return ListSandboxEnvironmentValidationsResponseSchema.parse(
    await request(`/sandbox-environments/${encodeURIComponent(id)}/validations`),
  );
}

/**
 * `GET /update-status` — the cached, server-side update check
 * (update-availability-check, Phase 2). The api does ONE TTL'd GitHub-Release
 * fetch shared across all browsers and returns the discriminated, honest
 * `UpdateStatus` `{ currentVersion, latestVersion, updateAvailable, releaseUrl,
 * releaseName, checkedAt }` — `updateAvailable` is true ONLY when the current
 * version is known AND a newer Release exists; otherwise it degrades to `false`
 * with `latestVersion: null` (source build / no releases / fetch failure), never
 * a fabricated prompt. Validated against the shared `@cap/contracts`
 * `UpdateStatusSchema` so no shape is re-declared web-side. The endpoint is
 * operator-guarded (like `/metrics`); this rides the same session-cookie
 * transport. Gated by `BACKEND_CAPABILITIES.updateCheck`.
 */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  return UpdateStatusSchema.parse(await request("/update-status"));
}

// ---------------------------------------------------------------------------
// MCP server tokens (remote-mcp-server) — LOCAL request/response shapes
//
// DELIBERATELY LOCAL web types, NOT `@cap/contracts` schemas (the
// `SelfUpdateRequest` / `RuntimeId` precedent above): the MCP-token DTOs are
// owned by the contracts track of this same change, and a shared schema imported
// by both api + web would be a cross-track shared file (tasks.md NOTE). The api
// does the load-bearing validation server-side (mint scopes against the shared
// `ScopeSchema`, hash + show-once discipline, owner-scoping); these mirror the
// non-secret read shape so the settings card compiles ahead of the contracts
// schema landing, at which point these collapse onto it with no call-site change.
//
// SECURITY: the raw `mcp_` token is present ONLY in {@link MintMcpTokenResponse}
// (the server's one-time mint reply) and NEVER on a list row — exactly the
// show-once discipline the spec mandates. The web app never fabricates it.
// ---------------------------------------------------------------------------

/** A scope an MCP token may carry (validated against the shared enum server-side). */
export type McpTokenScope =
  | "tasks:read"
  | "tasks:write"
  | "repos:read";

/** A non-secret MCP-token list row — prefix + last4 only, NEVER the raw/hash. */
export interface McpTokenSummary {
  /** Token id (the revoke handle). */
  id: string;
  /** Operator-supplied label. */
  name: string;
  /** Granted scopes. */
  scopes: McpTokenScope[];
  /** The `mcp_` prefix shown to disambiguate rows (non-secret). */
  prefix: string;
  /** Last 4 chars of the raw token, for recognition only (non-secret). */
  last4: string;
  /** Last time the token authenticated, or null if never used. ISO-8601. */
  lastUsedAt: string | null;
  /** Expiry, or null when the token never expires. ISO-8601. */
  expiresAt: string | null;
  /** Revocation time, or null while the token is active. ISO-8601. */
  revokedAt: string | null;
}

/** `GET /mcp-tokens` response — the operator's non-secret MCP-token list. */
export type ListMcpTokensResponse = readonly McpTokenSummary[];

/** `POST /mcp-tokens` body — mint a new MCP token. */
export interface MintMcpTokenRequest {
  /** Operator-supplied label. */
  name: string;
  /** Scopes to grant the token. */
  scopes: McpTokenScope[];
  /** Optional expiry (ISO-8601); omit for a non-expiring token. */
  expiresAt?: string | null;
}

/**
 * `POST /mcp-tokens` response — the show-once mint reply. The `token` field
 * carries the raw `mcp_…` value EXACTLY ONCE (the only time it is ever
 * transmitted); every subsequent read returns only the {@link McpTokenSummary}
 * projection. The card surfaces `token` transiently in its show-once dialog and
 * never writes it to a list row.
 */
export interface MintMcpTokenResponse extends McpTokenSummary {
  /** The raw `mcp_…` token — shown ONCE, never re-fetchable. */
  token: string;
}

/**
 * `GET /mcp-tokens` — the operator's MCP tokens (session-authenticated; a machine
 * credential cannot list). The wire shape is validated structurally here (local
 * web type — see the MCP-token types note above); a malformed entry is dropped
 * rather than crashing the card. Gated by `BACKEND_CAPABILITIES.mcpServer`.
 */
export async function listMcpTokens(): Promise<ListMcpTokensResponse> {
  const body = await request("/mcp-tokens");
  const entries = Array.isArray(body)
    ? body
    : Array.isArray((body as { tokens?: unknown } | null)?.tokens)
      ? (body as { tokens: unknown[] }).tokens
      : [];
  const out: McpTokenSummary[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.name !== "string") continue;
    out.push({
      id: e.id,
      name: e.name,
      scopes: Array.isArray(e.scopes)
        ? (e.scopes.filter((s) => typeof s === "string") as McpTokenScope[])
        : [],
      prefix: typeof e.prefix === "string" ? e.prefix : "",
      last4: typeof e.last4 === "string" ? e.last4 : "",
      lastUsedAt: typeof e.lastUsedAt === "string" ? e.lastUsedAt : null,
      expiresAt: typeof e.expiresAt === "string" ? e.expiresAt : null,
      revokedAt: typeof e.revokedAt === "string" ? e.revokedAt : null,
    });
  }
  return out;
}

/**
 * `POST /mcp-tokens` — mint an MCP token (session-authenticated only). Returns the
 * show-once mint reply whose `token` carries the raw `mcp_…` value exactly once;
 * the card reads it transiently into its show-once dialog. The api hashes + stores
 * only the hash, so this raw value is never re-fetchable.
 */
export async function mintMcpToken(
  body: MintMcpTokenRequest,
): Promise<MintMcpTokenResponse> {
  const minted = (await request("/mcp-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as Record<string, unknown>;
  return {
    token: typeof minted.token === "string" ? minted.token : "",
    id: typeof minted.id === "string" ? minted.id : "",
    name: typeof minted.name === "string" ? minted.name : body.name,
    scopes: Array.isArray(minted.scopes)
      ? (minted.scopes.filter((s) => typeof s === "string") as McpTokenScope[])
      : body.scopes,
    prefix: typeof minted.prefix === "string" ? minted.prefix : "",
    last4: typeof minted.last4 === "string" ? minted.last4 : "",
    lastUsedAt: typeof minted.lastUsedAt === "string" ? minted.lastUsedAt : null,
    expiresAt: typeof minted.expiresAt === "string" ? minted.expiresAt : null,
    revokedAt: typeof minted.revokedAt === "string" ? minted.revokedAt : null,
  };
}

/** `DELETE /mcp-tokens/:id` — revoke an MCP token (idempotent). */
export async function revokeMcpToken(id: string): Promise<void> {
  await request(`/mcp-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * `GET /settings/mcp-server` — the system-wide `mcpServerEnabled` flag (default
 * false). Admin-gated on WRITE only; any authenticated operator may read the
 * current state so the card renders honestly. Gated by
 * `BACKEND_CAPABILITIES.mcpServer`.
 */
export async function getMcpServerEnabled(): Promise<boolean> {
  const body = (await request("/settings/mcp-server")) as
    | { mcpServerEnabled?: unknown }
    | null;
  return body?.mcpServerEnabled === true;
}

/**
 * `PUT /settings/mcp-server` — flip `mcpServerEnabled` (admin-gated server-side;
 * a non-admin gets a 403 even if the UI affordance is forced). Returns the
 * resulting flag. The verb matches the api's `@Put('mcp-server')` settings route.
 */
export async function setMcpServerEnabled(enabled: boolean): Promise<boolean> {
  const body = (await request("/settings/mcp-server", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mcpServerEnabled: enabled }),
  })) as { mcpServerEnabled?: unknown } | null;
  return body?.mcpServerEnabled === true;
}

// ---------------------------------------------------------------------------
// Account administration (account-administration) — admin-only account lifecycle.
// All routes are admin-gated server-side (a non-admin gets 403 regardless of the
// UI); the page is also admin-guarded in its `beforeLoad`. Mutations return the
// updated row, but the page re-reads the list (invalidate) as the source of truth.
// ---------------------------------------------------------------------------

/** `GET /accounts` — every account as non-secret rows. */
export async function listAdminAccounts(): Promise<AdminAccountListResponse> {
  return AdminAccountListResponseSchema.parse(await request("/accounts"));
}

/** `POST /accounts` — create a local account (admin-only). */
export async function createAdminAccount(
  body: AdminCreateAccountRequest,
): Promise<AdminAccountListItem> {
  return AdminAccountListItemSchema.parse(
    await request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `PATCH /accounts/:id/enabled` — enable/disable any account (sets `allowed`). */
export async function setAdminAccountEnabled(
  id: string,
  allowed: boolean,
): Promise<AdminAccountListItem> {
  return AdminAccountListItemSchema.parse(
    await request(`/accounts/${encodeURIComponent(id)}/enabled`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowed }),
    }),
  );
}

/** `PATCH /accounts/:id/password` — reset a LOCAL account's password. */
export async function resetAdminAccountPassword(
  id: string,
  password: string,
): Promise<AdminAccountListItem> {
  return AdminAccountListItemSchema.parse(
    await request(`/accounts/${encodeURIComponent(id)}/password`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  );
}

/** `PATCH /accounts/:id/role` — assign an account's role. */
export async function setAdminAccountRole(
  id: string,
  role: Role,
): Promise<AdminAccountListItem> {
  return AdminAccountListItemSchema.parse(
    await request(`/accounts/${encodeURIComponent(id)}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    }),
  );
}

// ---------------------------------------------------------------------------
// API keys (api-key-machine-identity) — session-minted machine credentials
// ---------------------------------------------------------------------------

/**
 * `POST /api-keys` — mint a session-owned machine credential. Session-gated
 * server-side (a machine principal is 403'd), so this rides the same session
 * transport as the other settings reads. The response carries the raw `cap_sk_…`
 * key EXACTLY ONCE (the server persists only its SHA-256 hash); validated against
 * the shared contract schema. Gated by `BACKEND_CAPABILITIES.apiKeys`.
 */
export async function mintApiKey(
  body: ApiKeyMintRequest,
): Promise<ApiKeyMintResponse> {
  return ApiKeyMintResponseSchema.parse(
    await request("/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** `GET /api-keys` — the caller's own keys (non-secret metadata only). */
export async function listApiKeys(): Promise<ApiKeyListResponse> {
  return ApiKeyListResponseSchema.parse(await request("/api-keys"));
}

/**
 * `DELETE /api-keys/:id` — revoke one of the caller's own keys (idempotent).
 * Returns the revoked key's post-revocation list view.
 */
export async function revokeApiKey(id: string): Promise<ApiKeyRevokeResponse> {
  return ApiKeyRevokeResponseSchema.parse(
    await request(`/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

// ---------------------------------------------------------------------------
// Self-update (self-update-action, Phase 3) — LOCAL request/response shape
// ---------------------------------------------------------------------------

/**
 * `POST /self-update` request — the bounded upgrade target.
 *
 * DELIBERATELY a LOCAL web type, NOT a `@cap/contracts` schema: a shared contract
 * would be imported by both api + web and become a cross-track shared file
 * (tasks.md NOTE). The shape is intentionally minimal — just the `target` version
 * tag the banner already reads from `UpdateStatus.latestVersion`. The api does the
 * load-bearing validation server-side (the target MUST be a semver tag matching the
 * cached `/update-status` latest; cap GHCR namespace + cap services only), so this
 * is never an arbitrary image/tag/command channel (design D3).
 */
export interface SelfUpdateRequest {
  /** The validated target version tag to upgrade to (e.g. `v0.4.0`). */
  target: string;
}

/**
 * `POST /self-update` acknowledgement — "update started", returned BEFORE the api
 * goes down to recreate itself via the detached updater (design D4). The console
 * then shows an "updating… reconnecting" state and resumes over the existing WS
 * auto-reconnect once the new api is up. Local web type (see {@link SelfUpdateRequest}).
 */
export interface SelfUpdateAck {
  /** `true` once the api has launched the detached updater (acked before restart). */
  started: boolean;
  /** The target version the updater is pulling/recreating to. */
  target: string;
}

/**
 * `POST /self-update` — trigger the gated, bounded, admin-only host-root upgrade
 * (self-update-action). The api is operator-guarded AND admin-gated AND refuses
 * unless `SELF_UPDATE_ENABLED=true` (403/404 otherwise — the change ships inert,
 * design D1/D2). On a valid request it acks "update started" then launches a
 * DETACHED updater that pulls the target cap image set and recreates the cap
 * services, outliving its own restart; running tasks survive via
 * survive-api-redeploy and the console reconnects over the existing WS. Gated by
 * `BACKEND_CAPABILITIES.selfUpdate` — never called until an operator activates it.
 */
export async function postSelfUpdate(
  body: SelfUpdateRequest,
): Promise<SelfUpdateAck> {
  const ack = (await request("/self-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as Partial<SelfUpdateAck> | undefined;
  // The api acks before going down; normalize a possibly-empty/204 body into the
  // local ack shape (the target is echoed from the request when the api omits it).
  return {
    started: ack?.started ?? true,
    target: ack?.target ?? body.target,
  };
}

// ---------------------------------------------------------------------------
// SMTP configuration (add-smtp-config-ui) — LOCAL request/response shapes
//
// DELIBERATELY LOCAL web types, NOT `@cap/contracts` schemas (the
// `SelfUpdateRequest` / `RuntimeId` / `McpTokenSummary` precedent above): the
// SMTP DTOs are owned by the CONTRACTS track of this same change, and a shared
// schema imported by both api + web would be a cross-track shared file (tasks.md
// NOTE). The api does the load-bearing validation server-side (the save body is
// validated against the shared schema; the read projection is masked + the
// password is encrypted at rest, never echoed); these mirror the non-secret read
// shape so the settings card compiles ahead of the contracts schema landing, at
// which point they collapse onto it with no call-site change.
//
// SECURITY: the masked read NEVER carries the plaintext password — only a
// `passLast4` suffix + a `hasPassword` flag. The plaintext API Key is present
// ONLY on the write ({@link SaveSmtpConfigRequest}) and the test send, never on a
// read. The host/port/username are the fixed Resend tuple (`smtp.resend.com` /
// `465` / `resend`), stored alongside the non-secret fields.
// ---------------------------------------------------------------------------

/**
 * `GET /settings/smtp` response — the MASKED SMTP config projection. Carries the
 * non-secret host/port/user/from plus a `passLast4` suffix + a `hasPassword`
 * flag; NEVER the plaintext password (`pass` is write-only).
 */
export interface SmtpConfigRead {
  /** SMTP host (the fixed `smtp.resend.com` for Resend). */
  host: string;
  /** SMTP port (the fixed `465` for Resend implicit-TLS). */
  port: number;
  /** SMTP username (the fixed literal `resend` for Resend). */
  user: string;
  /** Sender (from) address, e.g. `no-reply@auth.example.com`. */
  from: string;
  /** The masked last-4 of the stored password, or null when none is stored. */
  passLast4: string | null;
  /** Whether a password (API Key) is stored — drives the "已配置" status. */
  hasPassword: boolean;
}

/**
 * `PUT /settings/smtp` body — save the SMTP config. The `pass` (= the Resend API
 * Key) is WRITE-ONLY and present ONLY here: omitted/empty means "keep the
 * existing key" (the server preserves the stored ciphertext). The host/port/user
 * are the fixed Resend tuple; the card always submits them so the stored row
 * carries the full tuple.
 */
export interface SaveSmtpConfigRequest {
  host: string;
  port: number;
  user: string;
  from: string;
  /** The plaintext API Key (SMTP password). Omit/empty to keep the existing one. */
  pass?: string;
}

/**
 * `POST /settings/smtp/test` body — the candidate config to verify. Like the
 * save, `pass` is omitted/empty to test the already-saved key; otherwise the
 * submitted key is used WITHOUT persisting (the probe never writes on failure).
 */
export type TestSmtpConfigRequest = SaveSmtpConfigRequest;

/**
 * `POST /settings/smtp/test` response — the discriminated test-send outcome.
 * `ok` is whether the test email reached the requesting admin's own session
 * email; `message` is a human-readable success/failure detail. NEVER carries the
 * password.
 */
export interface TestSmtpConfigResponse {
  /** Whether the test email was sent successfully. */
  ok: boolean;
  /** A human-readable success/failure message (never the password). */
  message: string;
}

/**
 * Structurally validate a `GET /settings/smtp` body into {@link SmtpConfigRead}
 * (local web type — no `@cap/contracts` schema; see the SMTP types note above).
 * Coerces missing/odd fields into safe defaults so a shape drift never crashes
 * the card, and DROPS any plaintext `pass` the server must never send.
 */
function parseSmtpConfigRead(body: unknown): SmtpConfigRead {
  const e = (body ?? {}) as Record<string, unknown>;
  const last4 = typeof e.passLast4 === "string" ? e.passLast4 : null;
  return {
    host: typeof e.host === "string" ? e.host : "",
    port: typeof e.port === "number" ? e.port : Number(e.port) || 0,
    user: typeof e.user === "string" ? e.user : "",
    from: typeof e.from === "string" ? e.from : "",
    passLast4: last4,
    hasPassword:
      typeof e.hasPassword === "boolean" ? e.hasPassword : last4 != null,
  };
}

/**
 * `GET /settings/smtp` — the admin-only MASKED SMTP config (never the plaintext
 * password). Admin-gated server-side (a non-admin is 403'd regardless of the UI).
 * Gated by `BACKEND_CAPABILITIES.settings` (the SMTP config rides the settings
 * surface). The wire shape is validated structurally here (local web type).
 */
export async function getSmtpConfig(): Promise<SmtpConfigRead> {
  return parseSmtpConfigRead(await request("/settings/smtp"));
}

/**
 * `PUT /settings/smtp` — save the SMTP config (admin-gated server-side). The
 * `pass` is write-only; the server encrypts it at rest and returns the MASKED
 * projection (never the plaintext). An empty/omitted `pass` keeps the stored key.
 */
export async function saveSmtpConfig(
  body: SaveSmtpConfigRequest,
): Promise<SmtpConfigRead> {
  return parseSmtpConfigRead(
    await request("/settings/smtp", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * `POST /settings/smtp/test` — send a test email to the requesting admin's own
 * session email using the submitted (or saved) config, to verify connectivity
 * BEFORE/independent of saving (admin-gated server-side; nothing is persisted on
 * failure). Returns the discriminated `{ ok, message }` outcome — never the
 * password. The wire shape is validated structurally here (local web type).
 */
export async function testSmtpConfig(
  body: TestSmtpConfigRequest,
): Promise<TestSmtpConfigResponse> {
  const res = (await request("/settings/smtp/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as Record<string, unknown> | null;
  return {
    ok: res?.ok === true,
    message: typeof res?.message === "string" ? res.message : "",
  };
}
