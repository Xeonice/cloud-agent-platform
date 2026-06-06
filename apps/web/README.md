# @cap/web — TanStack Start console

The web console for cloud-agent-platform. Web-only: it talks to the `@cap/api`
backend over an env-configured **cross-origin** contract and is deployed to
Vercel. It reproduces all 10 designed pages (landing, login, workspace, resume,
dashboard, repositories, settings, history, create-task, session).

## Stack

- **TanStack Start** — Vite-native (Vinxi is removed), with the **Nitro** server
  build. Deployed to **Vercel via the Nitro `vercel` preset** (no Next-shaped
  `vercel.json`).
- **React 19**, **TanStack Router** + **TanStack Query v5** (with
  `react-router-ssr-query`).
- **shadcn/ui** components (via `@cap/ui`) + **Tailwind v4**.
- Terminal via `@xterm/xterm`.

> **Vite plugin order is load-bearing** (see `vite.config.ts`):
> `tailwindcss() → tanstackStart({ srcDirectory: 'src' }) → viteReact() → nitro()`.
> Stale Vinxi / `app.config.ts` tutorials will mislead.

## Commands

Run from the repo root.

| Task | Command |
| --- | --- |
| Dev server (port 3000) | `pnpm --filter @cap/web dev` |
| Production build | `pnpm --filter @cap/web build` |
| Run built server | `pnpm --filter @cap/web start` |
| Typecheck | `pnpm --filter @cap/web typecheck` |
| Unit tests | `pnpm --filter @cap/web test` |
| Lint | `pnpm --filter @cap/web lint` |
| Verify everything (root) | `pnpm verify` |

## Data layer: the single real/mock seam

Every page reads data **exclusively** through TanStack Query factories. The
`queryFn` is the **only** place real-vs-mock is decided:

```
if (BACKEND_CAPABILITIES[domain]) return real() else return mock()
```

`BACKEND_CAPABILITIES` (`src/lib/api/capabilities.ts`) is the **single switch**.
Integrating a domain is therefore: implement its `real.ts` function, verify it
against a running api + an allowlisted OAuth session, then flip **one** flag to
`true`. No page is rewritten to "go real"; every page renders today on typed
mocks until its flag flips.

### Current posture (honest)

The backend modules for all of these domains are **implemented**, but
end-to-end REAL wiring also requires the api process running and reachable at
`VITE_API_BASE_URL` **and** an established, allowlisted GitHub-OAuth session
(the OAuth App registration is still pending). So:

| Domain | Flag | Why |
| --- | --- | --- |
| `tasks` | **real** | `GET /tasks`, `GET /tasks/:id` ship on the api today |
| `repos` | **real** | `GET /repos` ships today |
| `createTask` | **real** | `POST /repos/:repoId/tasks` ships today |
| `auth` | mock | `GET /auth/session` — OAuth App registration pending |
| `metrics` | mock | needs a session-gated reachable api |
| `history` | mock | audit query — needs a session-gated reachable api |
| `settings` | mock | settings CRUD + Codex cred — needs a session-gated api |
| `githubImport` | mock | `GET /user/repos` import — needs the OAuth GitHub token |
| `branches` | mock | `Task.branch`/`strategy` read-back — verify with a real task |

## Auth (the load-bearing boundary)

The api runs tasks as **host-root via `docker.sock`**, so console access is a
host-root privilege: **"who can log in" == "who can run as root on the host."**
The target model is **GitHub OAuth + a hard allowlist** keyed on the immutable
numeric GitHub `id` (never the mutable `login`), fail-closed, with allowlist
membership re-confirmed at request time. A legacy shared-`AUTH_TOKEN` operator
path exists behind `AUTH_TOKEN_LEGACY_ENABLED` (default **off**). See the repo
root [`README.md`](../../README.md#auth--the-host-root-boundary).

## Cross-origin deploy

The web (Vercel) and api (Fly / docker-compose) run on **separate origins**.
`src/lib/config.ts` is the single source of the resolved endpoints:

| Env var | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | cross-origin api HTTP origin (e.g. `https://api.example.fly.dev`) |
| `VITE_WS_URL` | cross-origin api WebSocket origin (e.g. `wss://api.example.fly.dev`) |

Only `VITE_`-prefixed vars reach the client bundle. The session cookie is sent
cross-origin with `credentials: include` (the api must CORS-allowlist the web
origin). The terminal WebSocket cannot set headers in the browser, so it
authenticates with a **bearer subprotocol** (`bearer.<token>`), which also
works cross-origin.

> **Migration note:** until the GitHub-OAuth session lands, `config.ts`
> `operatorToken()` still reads `VITE_AUTH_TOKEN` so the existing REST/WS
> clients keep working against the current single-token api. The cross-origin
> contract above is preserved unchanged through that migration.
