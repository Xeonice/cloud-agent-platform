/**
 * Backend capability flags — the SINGLE real/mock switch point
 * (rebuild-console-tanstack-start D5; tasks 10.1).
 *
 * Every page reads data EXCLUSIVELY through TanStack Query, and the queryFn is
 * the only place real-vs-mock is chosen: `if (BACKEND_CAPABILITIES[domain])
 * return real() else return mock()`. Flipping ONE flag here is therefore the
 * entire integration step for a domain — implement its `real.ts` function, flip
 * the flag to `true`, done. No page is rewritten to "go real".
 *
 * Current posture (2026-06): the backend NOW implements
 * auth / metrics / history(audit) / settings / githubImport / branch+strategy
 * persistence — those backend tracks have shipped. But end-to-end REAL wiring
 * additionally requires (a) the api process running and reachable at
 * `VITE_API_BASE_URL`, and (b) an established, allowlisted GitHub-OAuth SESSION
 * (the OAuth App registration is still pending). Until BOTH are verified against
 * the running api, these domains default to `false` (mock) so all 10 pages
 * render today on typed mocks. Each flag flips to `true` the moment its real
 * path is verified against the running api + a live session — that is the
 * "render today on mock, flip one flag to go real" seam.
 */

/** The data domains the console reads, each independently real-or-mock gated. */
export interface BackendCapabilities {
  /** `GET /tasks`, `GET /tasks/:id` — the live task list + single task. */
  tasks: boolean;
  /** `GET /repos` — registered platform repos for the new-task form. */
  repos: boolean;
  /** `POST /repos/:repoId/tasks` — create a task under a repo. */
  createTask: boolean;
  /** `GET /auth/session` — the GitHub-OAuth session identity + allowlist gate. */
  auth: boolean;
  /** `GET /metrics` — semaphore-derived capacity + sampled CPU/memory. */
  metrics: boolean;
  /** Audit/history event recording + query (`GET /history` family). */
  history: boolean;
  /** Account settings CRUD + Codex credential read/write. */
  settings: boolean;
  /** GitHub repository import (`GET /user/repos`, import, set-default). */
  githubImport: boolean;
  /**
   * `Task.branch` / `Task.strategy` persistence + read-back. Gates the session
   * task-context read path: when `false`, the context strip falls back to
   * `mockTaskContexts`; when `true`, branch/strategy come back from the real
   * task read (closing the "sendable but unreadable" trap, D5.5).
   */
  branches: boolean;
}

/**
 * The live flag map.
 *
 * `tasks` / `repos` / `createTask` are `true`: these four REST endpoints exist
 * on the running api today and are the verified real path.
 *
 * `auth` / `metrics` / `history` / `settings` / `githubImport` / `branches` are
 * `false`: their backend endpoints are IMPLEMENTED, but real wiring is not yet
 * verified end-to-end because it needs the running api + an established
 * allowlisted OAuth session (OAuth App registration pending). Each flips to
 * `true` independently once its real path is confirmed against the running api.
 */
export const BACKEND_CAPABILITIES: BackendCapabilities = {
  // Verified real: the four endpoints the api ships today.
  tasks: true,
  repos: true,
  createTask: true,

  // Implemented backend, NOT yet verified end-to-end (needs running api + OAuth
  // session). Flip to `true` per-domain once the real path is confirmed.
  auth: false, // GET /auth/session — OAuth App registration pending.
  metrics: false, // GET /metrics — needs a session-gated reachable api.
  history: false, // audit query — needs a session-gated reachable api.
  settings: false, // settings CRUD + Codex cred — needs a session-gated api.
  githubImport: false, // GET /user/repos import — needs the OAuth GitHub token.
  branches: false, // Task.branch/strategy read-back — verify with a real task.
};

/** True when the named domain reads from the real api rather than typed mocks. */
export function isCapable(domain: keyof BackendCapabilities): boolean {
  return BACKEND_CAPABILITIES[domain];
}
