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
  /**
   * `GET /tasks/:id/session-history` — the parsed, read-only codex transcript of
   * a FINISHED task. As of `persist-session-transcripts` the endpoint resolves
   * DURABLE-FIRST: it reads the gzipped raw rollout archived on the workspace
   * volume (indexed in `SessionTranscript`), falling back to the retained
   * container only when no archive exists, so the transcript survives container
   * reaping. Live as of `persist-session-transcripts`; the live e2e against a
   * retained-then-reaped sandbox (deploy/DEPLOY.md §9) is still TO BE CONFIRMED
   * on the deployed env post-release.
   */
  sessionHistory: boolean;
  /**
   * `GET /update-status` — the cached, server-side update check that compares the
   * running `CAP_VERSION` against the latest GitHub Release for the configured
   * repo (update-availability-check, Phase 2 of the OSS self-update epic). When
   * `false` the "update available" banner reads the typed `mockUpdateStatus` via
   * the standard seam — and that mock is MODE-AWARE: it degrades to
   * `updateAvailable: false` in normal source-build prod (so the change ships
   * INERT — no fabricated banner, integration task 4.1) and only surfaces an
   * available update under the `VITE_FORCE_MOCK=1` visual harness. It flips to
   * `true` after the live endpoint is verified against a public repo with a
   * published Release (Phase 1 activation), repointing the read at the real api.
   * The banner is hidden in every case until `updateAvailable` is genuinely
   * `true`, so flipping the flag never fabricates a prompt.
   */
  updateCheck: boolean;
  /**
   * `POST /self-update` — the one-click, host-root upgrade action
   * (self-update-action, Phase 3 of the OSS self-update epic). When `false`
   * (the DEFAULT, and the shipped posture) the console upgrade action is ABSENT
   * entirely — the banner stays notify-only (Phase 2 behavior) and `postSelfUpdate`
   * is never called, so deploying the change adds NO live host-root button
   * (design D1/D5; spec "ships INERT"). It flips to `true` ONLY as a deliberate
   * operator activation step, in lockstep with the api's `SELF_UPDATE_ENABLED`
   * env gate and a published GHCR release (Phase 1 activation). Even then the
   * action is additionally gated, inside the banner, on the operator being an
   * admin AND an update being genuinely available — so flipping this flag alone
   * never surfaces an unconfirmed upgrade trigger.
   */
  selfUpdate: boolean;
}

/**
 * The live flag map — ALL real.
 *
 * Every domain reads from the running api. The four core endpoints
 * (`tasks` / `repos` / `createTask`) plus the session-gated domains
 * (`auth` / `metrics` / `history` / `settings` / `githubImport` / `branches`)
 * were verified end-to-end (2026-06-06) against the compose api with a real
 * GitHub-OAuth session: OAuth login → allowlist admit → cross-origin session
 * cookie (SameSite=None+Secure) → real `/auth/session`, `/metrics`, `/settings`,
 * `/audit/events`, `/repos/github/*`, and `Task.branch/strategy` read-back, on
 * both client navigation and SSR first paint (the SSR loader forwards the
 * browser cookie — see `lib/server-cookie.ts`).
 *
 * DEPLOY NOTE: with these `true`, the app targets the real api on every surface,
 * so a deployment MUST have the api reachable (`VITE_API_BASE_URL`/`VITE_WS_URL`)
 * and, for the gated domains, an established allowlisted OAuth session. To render
 * on typed mocks instead (e.g. a backend-less preview), flip a domain to `false`.
 */
export const BACKEND_CAPABILITIES: BackendCapabilities = {
  // Core REST endpoints the api ships.
  tasks: true,
  repos: true,
  createTask: true,

  // Session-gated domains — verified e2e against the running api + OAuth session.
  auth: true, // GET /auth/session — OAuth login + allowlist gate.
  metrics: true, // GET /metrics — semaphore capacity + docker-stats sampling.
  history: true, // GET /audit/events — audit timeline.
  settings: true, // /settings + /settings/codex — per-account, GitHub-identity session.
  githubImport: true, // /repos/github/* — import via the operator's OAuth token.
  branches: true, // Task.branch/strategy read-back on the real task read.

  // Durable-first session-history (persist-session-transcripts): the rollout is
  // archived on the workspace volume + indexed in Postgres, so the read path
  // survives container reaping. Shipped LIVE per operator decision; the live e2e
  // against a retained-then-reaped sandbox (deploy/DEPLOY.md §9) is TO BE
  // CONFIRMED on the deployed env post-release (task 5.1).
  sessionHistory: true, // GET /tasks/:id/session-history — durable-first codex transcript.

  // Update-availability check (update-availability-check, Phase 2). Initially
  // `false`: the banner reads the mode-aware `mockUpdateStatus`, which is INERT
  // (`updateAvailable: false`) in normal source-build prod and only surfaces an
  // available update under the `VITE_FORCE_MOCK=1` visual harness, until the live
  // `GET /update-status` is verified against a public repo with a published
  // Release (Phase 1 activation), then this flips to `true`.
  updateCheck: false, // GET /update-status — cached server-side GitHub-Release compare.

  // Self-update action (self-update-action, Phase 3). Default `false`: the
  // host-root one-click upgrade is the most dangerous surface in the epic, so the
  // change ships INERT — with this off the console upgrade action is absent and
  // `POST /self-update` is never invoked, so deploying it adds no live upgrade
  // button (design D1/D5). Flips to `true` ONLY as a deliberate operator
  // activation step, paired with the api's `SELF_UPDATE_ENABLED` env gate and a
  // published GHCR release set.
  selfUpdate: false, // POST /self-update — gated, confirmed, admin-only host-root upgrade.
};

/**
 * Mock data mode — `VITE_FORCE_MOCK=1` pins EVERY domain to its typed mock,
 * overriding the flag map above without editing it. This is the deterministic
 * data mode the visual-verification harness (console-design-pixel-merge task
 * 8.1, `apps/web/e2e/visual/`) runs the app under: fixed fixtures, no live
 * backend, no nondeterministic data in screenshots. It is read from the
 * environment at build/dev-serve time and is OFF in every normal deployment
 * (the variable is simply unset), so the shipped real/mock posture is
 * unchanged.
 */
export function forceMock(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  return env.VITE_FORCE_MOCK === "1";
}

/** True when the named domain reads from the real api rather than typed mocks. */
export function isCapable(domain: keyof BackendCapabilities): boolean {
  if (forceMock()) return false;
  return BACKEND_CAPABILITIES[domain];
}
