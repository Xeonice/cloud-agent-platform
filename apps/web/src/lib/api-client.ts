/**
 * Central REST client for the console (frontend-console spec 13.5/13.6).
 *
 * Every request targets the env-configured cross-origin {@link apiBaseUrl} and
 * carries the operator bearer token (D12). Response bodies are validated
 * against the `@cap/contracts` schemas so the web app never re-declares the
 * shared shapes — contracts is the single source of truth.
 */
import {
  ListTasksResponseSchema,
  TaskResponseSchema,
  ListReposResponseSchema,
  type ListTasksResponse,
  type TaskResponse,
  type ListReposResponse,
  type CreateTaskRequest,
} from "@cap/contracts";
import { apiBaseUrl, operatorToken } from "./config.js";

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
  // D12: attach the operator bearer token to every REST call.
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: authHeaders(init?.headers as Record<string, string> | undefined),
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
  const created = await request(
    `/repos/${encodeURIComponent(repoId)}/tasks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return TaskResponseSchema.parse(created);
}
