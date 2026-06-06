## Why

The current `apps/web` is a thin Next.js shell that wires only 4 real endpoints (`/tasks`,
`/repos`, create-task, terminal WS) while the approved 10-page design needs login, a launcher,
a workbench, repository import, history/audit, and settings — so today 7/10 designed pages would
be pure mock. This change rebuilds the console on TanStack Start to faithfully reproduce all 10
pages AND extends the backend so those pages render real data, while replacing the single shared
operator token with GitHub OAuth + a hard allowlist — a load-bearing security boundary because the
backend runs tasks as host-root via `docker.sock`, so "who can log in" equals "who can run as root
on the host".

## What Changes

- **BREAKING — frontend framework replacement:** rebuild `apps/web` from Next.js to **TanStack
  Start** (Vite-native, no Vinxi), deployed to Vercel via the Nitro `vercel` preset. All 10
  prototype pages reproduced (direction B) on shadcn/ui + Tailwind v4 with tokens ported from the
  prototype CSS. Next config / `next-env.d.ts` / Next-shaped `vercel.json` removed.
- **BREAKING — auth model:** replace single-user shared-`AUTH_TOKEN` operator auth with **multi-user
  GitHub OAuth identity gated by a hard allowlist**. A successfully-authenticated GitHub user who is
  NOT on the allowlist is denied console access and cannot reach any task-running surface. Session
  (cookie) becomes the auth source for both REST and WebSocket.
- Add backend endpoints so designed pages stop being mock: GitHub OAuth start/callback + session +
  users + allowlist; settings CRUD + encrypted Codex credential storage; audit/history event
  recording + query; resource metrics (guardrails-semaphore counters blended with real CPU/memory
  via `docker stats`/cgroup sampling, exposed through a `/metrics` aggregation endpoint);
  GitHub repository import (`/user/repos`) + repo GitHub-import metadata; approvals pending-list read.
- Persist task **branch** and **execution strategy** (Prisma fields) and **read them back** on task
  detail / session / history — today they are accepted on create then silently dropped.
- Preserve the single data-access seam (`lib/api/{real,mock,capabilities,queries}.ts` +
  `BACKEND_CAPABILITIES` flags) so any endpoint not yet shipped falls back to typed mock by flipping
  one flag; genuinely-static marketing copy on `/` stays static intentionally.
- Reuse existing assets unchanged: `@cap/contracts` (Task/Repo/TaskStatus + WS frames), `@cap/ui`
  (Button/Card/Badge/**Terminal**), `ws-client.ts` (`TerminalSocket`), `config.ts`. Keep all Chinese
  UI copy from the prototype.

## Capabilities

### New Capabilities
- `multi-user-oauth`: GitHub OAuth login, session lifecycle, user records, and a hard allowlist gate
  that admits only allowlisted GitHub identities to the host-root task-running console.
- `github-repository-import`: import repositories from a user's GitHub account (`/user/repos`) and
  persist GitHub-import metadata (description, default branch, branch count, updated-at) on `Repo`.
- `resource-metrics`: a `/metrics` endpoint aggregating guardrails-semaphore state (active tasks /
  free slots / queue / slot table) with real CPU/memory sampled from `docker stats` / cgroups.
- `audit-history`: record audit/history events (task lifecycle, approvals, settings, login) and
  expose a filterable query endpoint for the history timeline.
- `account-settings`: settings CRUD (allowed account, default repo, retention, write-confirm) plus
  encrypted-at-rest Codex credential storage (official + compatible-provider), masked in responses.

### Modified Capabilities
- `frontend-console`: full TanStack Start rebuild reproducing all 10 pages on shadcn/Tailwind v4 with
  the app-shell layout, the data-access capability seam, and the live terminal session.
- `single-user-auth`: REMOVED/migrated into `multi-user-oauth` — the single shared operator token is
  superseded by per-user OAuth sessions and the allowlist gate.
- `repo-and-task-management`: `Task` gains persisted `branch` and `strategy` fields read back on
  detail/session/history; `Repo` gains GitHub-import metadata fields.

## Impact

- **`apps/web` rebuilt** — Next.js removed; TanStack Start (Vite + Nitro), shadcn/ui, Tailwind v4
  token contract in `src/styles/app.css`, 10 routes under `__root` / standalone / pathless `_app`.
- **`apps/api` extended** — new modules for OAuth/session/allowlist, GitHub import, `/metrics`
  (with a `docker stats`/cgroup sampler), audit/history, settings + encrypted Codex credentials,
  branch/strategy persistence, approvals pending-list read.
- **`packages/contracts`** — new shared types/schemas (session/user, GitHub repo import, metrics,
  audit event, settings, Codex credential) plus task branch/strategy fields.
- **Prisma migrations** — `User`/session + allowlist; `Repo` GitHub-import metadata; `Task` branch +
  strategy; audit/history table; encrypted Codex credential storage.
- **`packages/ui`** — `styles.css` migrated v3 → v4 to share the single token contract.
- **Ops / deploy** — `docker stats`/cgroup sampling on the host; Vercel deploy via Nitro `vercel`
  preset replacing the Next-shaped `vercel.json`; cross-origin `API_BASE_URL`/`WS_URL` preserved;
  GitHub OAuth client + session secret + Codex-credential encryption key added to config.
- **Specs** — `single-user-auth` removed/migrated; deltas to `frontend-console` and
  `repo-and-task-management`; new specs `multi-user-oauth`, `github-repository-import`,
  `resource-metrics`, `audit-history`, `account-settings`.
