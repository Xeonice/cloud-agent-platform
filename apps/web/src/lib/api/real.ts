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
  ListAuditEventsResponseSchema,
  AccountSettingsSchema,
  CodexCredentialSchema,
  CodexDeviceLoginStartResponseSchema,
  CodexDeviceLoginStatusSchema,
  ListAvailableGithubReposResponseSchema,
  DefaultRepoResponseSchema,
  type ListTasksResponse,
  type TaskResponse,
  type ListReposResponse,
  type CreateTaskRequest,
  type AuthSession,
  type AuthSessionResponse,
  type MetricsResponse,
  type TaskResourceResponse,
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
import { RepoResponseSchema } from "@cap/contracts";
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
 * when unauthenticated (a normal `200` with `user: null`, NOT a 401, per the
 * `AuthSessionResponse` contract). Gated by `BACKEND_CAPABILITIES.auth`.
 */
export async function getAuthSession(): Promise<AuthSession> {
  const body: AuthSessionResponse = AuthSessionResponseSchema.parse(
    await request("/auth/session"),
  );
  return body.user;
}

/**
 * `GET /metrics` — semaphore-derived capacity + sampled CPU/memory in one
 * round trip. Gated by `BACKEND_CAPABILITIES.metrics`.
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
