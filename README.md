# cloud-agent-platform

A self-hostable control plane that drives the real interactive Codex CLI and
streams its byte-identical terminal to a browser. The platform runs each task
in a container on the host and surfaces task launch, a live workbench/terminal,
repository import, history/audit, metrics, and settings through a web console.

> **Security note up front:** the backend runs tasks as host-root via the
> Docker socket (`docker.sock`). Console access is therefore a host-root
> privilege. See [Auth & the host-root boundary](#auth--the-host-root-boundary)
> before deploying.

## Monorepo layout

This is a pnpm + Turborepo workspace.

```
apps/
├── web/            # @cap/web — TanStack Start console (Vite + Nitro), deployed to Vercel
├── api/            # @cap/api — NestJS backend: OAuth/session/allowlist, tasks, repos,
│                   #   metrics, audit/history, settings, GitHub import, terminal WS gateway
├── runner/         # task runner
└── sandbox-hooks/  # sandbox lifecycle hooks
packages/
├── contracts/      # @cap/contracts — shared Task/Repo/TaskStatus types, WS frames, schemas
└── ui/             # @cap/ui — shared shadcn-derived components (Button/Card/Badge/Terminal)
docs/               # contributor-facing orientation docs (see docs/repo-layout.md)
openspec/           # spec content: specs, changes, schema fork
```

For the openspec / `.claude` two-bucket model and the change/spec conventions,
see [`docs/repo-layout.md`](docs/repo-layout.md).

## The web console (TanStack Start)

`apps/web` was rebuilt from Next.js to **TanStack Start** — Vite-native (no
Vinxi), with the **Nitro** server build, and deployed to **Vercel via the Nitro
`vercel` preset** (the old Next-shaped `vercel.json` is gone). It reproduces all
10 designed pages (landing, login, workspace, resume, dashboard, repositories,
settings, history, create-task, session) on shadcn/ui + Tailwind v4.

See [`apps/web/README.md`](apps/web/README.md) for the app-level detail
(data-access seam, capability flags, cross-origin contract).

## Commands

Node/pnpm are workspace-managed (pnpm 10, Node ≥ 22). Run from the repo root.

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Verify everything | `pnpm verify` (= `turbo typecheck lint build`) |
| Web dev server | `pnpm --filter @cap/web dev` (port 3000) |
| Web production build | `pnpm --filter @cap/web build` |
| Web typecheck | `pnpm --filter @cap/web typecheck` |
| Web unit tests | `pnpm --filter @cap/web test` |
| Build all | `turbo build` |
| Typecheck all | `turbo typecheck` |
| Lint all | `turbo lint` |

## Local one-command start

A freshly-cloned repo goes from zero to a running, **login-able** backend with a
single command (requires Docker + a host `docker.sock`):

```bash
make up        # bootstrap apps/api/.env (if absent) + build & start the full stack,
               # then wait for /health and print a local auth token
make up-cp     # control-plane only (api + postgres) — skips the heavy amd64
               # sandbox image build; fast on Apple Silicon
make down      # stop the stack (PRESERVES the pgdata / workspaces volumes)
make down-v    # stop AND drop the volumes (DESTRUCTIVE — local data loss)
```

`make up` generates `apps/api/.env` **only when it does not already exist** (a
real local env is reused untouched). The generated env enables the **legacy
operator-token** path with random secrets, so you authenticate locally with the
printed `Authorization: Bearer <token>` — no GitHub OAuth app required for local
dev. Production stays OAuth-first / fail-closed; the generated legacy env is
gitignored and never committed.

Notes:

- The per-task sandbox image (`cap-aio-sandbox:pinned`) is **build-only** — an
  actual `cap-aio-<taskId>` sandbox is provisioned per task when you create one.
- On Apple Silicon the `amd64` AIO base builds under emulation on the first run
  (slow, then cached); use `make up-cp` for a fast control-plane-only bring-up.
- The **web console is not in compose** — run it separately
  (`pnpm --filter @cap/web dev`, port 3000) pointed at the local API.

## Auth & the host-root boundary

The platform runs tasks as **host-root via `docker.sock`**. Consequently
**"who can log in" equals "who can run as root on the host"** — so console auth
is a load-bearing security boundary, not a convenience layer.

Auth is **multi-user GitHub OAuth gated by a hard allowlist**:

- **Allowlist keyed on the immutable numeric GitHub `id`**, never the mutable
  `login` (a renamed/recreated GitHub account cannot impersonate an allowlisted
  operator; `login` is display-only). See `apps/api/src/auth/allowlist.ts`.
- **Fail-closed everywhere:** an empty/missing/unparseable allowlist denies all
  access; missing OAuth credentials or session secret refuses to run the flow
  (no fallback to unauthenticated or shared-token login). Allowlist membership
  is **re-confirmed at request time**, so de-allowlisting an operator takes
  effect immediately. See `apps/api/src/auth/oauth-config.ts` and `auth.guard.ts`.
- **Break-glass:** the legacy single shared-`AUTH_TOKEN` operator path exists
  behind `AUTH_TOKEN_LEGACY_ENABLED` and is **OFF by default** — only an
  explicit truthy value (`true`/`1`/`yes`) re-enables it.

A successfully-authenticated GitHub user who is NOT on the allowlist is denied
console access and cannot reach any task-running surface.

## Deploy topology (cross-origin)

The web console (Vercel) and the api (Fly / docker-compose host) run on
**separate origins**. The web targets the api via `VITE_API_BASE_URL` /
`VITE_WS_URL`. The session cookie is sent cross-origin with `credentials:
include`, and the api must CORS-allowlist the web origin. The terminal
WebSocket authenticates with a bearer subprotocol (`bearer.<token>`), which
also works cross-origin. See `apps/web/README.md` for the current REST/WS auth
posture during the OAuth-session migration.
