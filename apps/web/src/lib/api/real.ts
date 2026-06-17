/**
 * Real REST client — the sole real data-access layer (frontend-console spec
 * 13.5/13.6; rebuild-console-tanstack-start D5/D6).
 *
 * Every request targets the env-configured cross-origin {@link apiBaseUrl} and
 * carries the operator bearer token (D12). Response bodies are validated
 * against the `@cap/contracts` schemas so the web app never re-declares the
 * shared shapes — contracts is the single source of truth.
 *
 * Requests are sent with `credentials: "include"` so that, once the backend
 * migrates from the operator bearer token to a GitHub-OAuth session cookie
 * (D1/D6), the httpOnly session cookie rides cross-origin automatically (the
 * api must CORS-allowlist the web origin). The bearer header is still attached
 * while the legacy single-token api is in place.
 *
 * As the backend lands new endpoints, they are added here and switched on by
 * flipping their `BACKEND_CAPABILITIES` flag in `lib/api/capabilities.ts`
 * (the single real/mock seam, D5).
 */
import {
  ListTasksResponseSchema,
  TaskResponseSchema,
  ListReposResponseSchema,
  AuthSessionResponseSchema,
  MetricsResponseSchema,
  TaskResourceResponseSchema,
  SessionHistorySchema,
  ListAuditEventsResponseSchema,
  AccountSettingsSchema,
  CodexCredentialSchema,
  CodexDeviceLoginStartResponseSchema,
  CodexDeviceLoginStatusSchema,
  ListAvailableGithubReposResponseSchema,
  DefaultRepoResponseSchema,
  UpdateStatusSchema,
  type UpdateStatus,
  type ListTasksResponse,
  type TaskResponse,
  type ListReposResponse,
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
  type CodexDeviceLoginStartResponse,
  type CodexDeviceLoginStatus,
  type ListAvailableGithubReposResponse,
  type ImportRepoRequest,
  type RepoResponse,
  type SetDefaultRepoRequest,
  type DefaultRepoResponse,
} from "@cap/contracts";
import { RepoResponseSchema, castEndpointPath } from "@cap/contracts";
import { apiBaseUrl, operatorToken } from "../config";
import { getIncomingCookieHeader } from "../server-cookie";

/** A REST error carrying the HTTP status so callers can branch on 401/404/etc. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = operatorToken();
  // D12: attach the operator bearer token to every REST call (legacy path).
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * Fetch a finished task's `session.cast` (asciicast v2) as RAW TEXT
 * (session-terminal-replay). The endpoint serves `text/plain`, and an empty body
 * is the honest "nothing to replay" signal — so this returns the text verbatim
 * (empty string included). A 404 (unknown task) also degrades to "" so the
 * replay tab shows the empty face rather than throwing.
 */
export async function getSessionCast(id: string): Promise<string> {
  const headers = authHeaders();
  const incomingCookie = await getIncomingCookieHeader();
  if (incomingCookie) headers["Cookie"] = incomingCookie;
  const res = await fetch(`${apiBaseUrl()}/${castEndpointPath(id)}`, {
    credentials: "include",
    headers,
  });
  if (!res.ok) {
    if (res.status === 404) return "";
    throw new ApiError(res.status, res.statusText);
  }
  return res.text();
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = authHeaders(init?.headers as Record<string, string> | undefined);
  // SSR-only: forward the incoming browser request's Cookie header so the
  // server-side fetch carries the same OAuth session cookie the browser would
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
    try {
      detail = (await res.text()) || detail;
    } catch {
      // Ignore body read failures; fall back to the status text.
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined;
  return res.json();
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
 * `POST /repos/:repoId/tasks` — create a task under a repo (new-task form).
 * Returns the created task; 201 on success, 404 when the repo does not exist.
 */
export async function createTask(
  repoId: string,
  body: CreateTaskRequest,
): Promise<TaskResponse> {
  const created = await request(`/repos/${encodeURIComponent(repoId)}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return TaskResponseSchema.parse(created);
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

// ---------------------------------------------------------------------------
// Not-yet-flipped domains (D5).
//
// The backend endpoints below are IMPLEMENTED but their `BACKEND_CAPABILITIES`
// flag is still `false` (mock) pending end-to-end verification against the
// running api + an OAuth session. They live here, fully written, so flipping a
// flag to `true` is the entire integration step — no page rewrite, no new
// function. Each parses against `@cap/contracts` exactly like the four live
// endpoints above and rides the same `credentials: "include"` session-cookie
// transport (D6). Until a flag flips, `queries.ts` simply never calls these.
// ---------------------------------------------------------------------------

/**
 * `GET /auth/session` — the current GitHub-OAuth session identity, or `null`
 * when unauthenticated. Per `multi-user-oauth`, EVERY authenticated endpoint
 * (this one included) answers a missing/expired/revoked/non-allowlisted session
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
    // 401 = unauthenticated (no / expired / revoked / non-allowlisted session);
    // that is "logged out", not a failure — resolve it to `null`.
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
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

/**
 * `POST /settings/codex/device-login` — start the OFFICIAL ChatGPT OAuth
 * device-code login (server runs `codex login --device-auth`); returns the
 * verification URL + one-time code to display.
 */
export async function startCodexDeviceLogin(): Promise<CodexDeviceLoginStartResponse> {
  return CodexDeviceLoginStartResponseSchema.parse(
    await request("/settings/codex/device-login", { method: "POST" }),
  );
}

/** `GET /settings/codex/device-login` — poll the in-flight device login. */
export async function pollCodexDeviceLogin(): Promise<CodexDeviceLoginStatus> {
  return CodexDeviceLoginStatusSchema.parse(
    await request("/settings/codex/device-login"),
  );
}

/** `DELETE /settings/codex/device-login` — cancel + reclaim the in-flight login. */
export async function cancelCodexDeviceLogin(): Promise<void> {
  await request("/settings/codex/device-login", { method: "DELETE" });
}

/**
 * `GET /repos/github/available` — the operator's importable GitHub repositories,
 * sourced server-side via the stored OAuth token (the token never reaches the
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
): Promise<RepoResponse> {
  return RepoResponseSchema.parse(
    await request("/repos/github/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
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
