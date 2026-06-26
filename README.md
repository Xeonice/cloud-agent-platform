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
├── api/            # @cap/api — NestJS backend: local sessions, tasks, repos,
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

> **One-line install (wraps `make up`).** The public marketing site hosts an
> `install.sh` you can pipe to a shell — it preflights Docker, clones this repo,
> and runs `make up` for you, then surfaces the printed Bearer token:
>
> ```bash
> curl -fsSL https://<site-domain>/install.sh | sh
> ```
>
> It is a thin wrapper, not a replacement: **`make up` below stays the source of
> truth**, and the script is served as plain text so you can read it first (the
> site also shows the equivalent manual `git clone … && make up` path). By
> default macOS uses the BoxLite sandbox path and Linux uses AIO; override with
> `CAP_SANDBOX_PROVIDER=aio|boxlite|control-plane`. See the public site and the
> [Self-hosting guide](docs/self-hosting.md) for details.

> **Let Claude Code deploy it (recommended).** If you have Claude Code, paste the
> prompt below — it reads the installer, preflights Docker, clones this repo and
> runs `make up`, and walks you through local-account setup:
>
> ```text
> Deploy cloud-agent-platform on this machine. First read the installer at https://<site-domain>/install.sh and confirm Docker with a usable docker.sock is available. Then clone https://github.com/<owner>/cloud-agent-platform, cd into it, and run `make up` so the repo selects the default sandbox path for this OS (macOS BoxLite, Linux AIO). Help me configure local account login and the web/api origins for a production-like deploy, then report the console URL and the credentials it prints.
> ```
>
> Like the one-liner, it wraps `make up` rather than replacing it — Claude Code
> follows the same readable `install.sh`, and you can take over at any point.

```bash
make up          # auto-select sandbox provider (macOS→BoxLite, Linux→AIO),
                 # bootstrap apps/api/.env, wait for /health, print auth token
make up-aio      # force AIO full stack (incl. cap-aio-sandbox image)
make up-boxlite  # force BoxLite endpoint-backed stack (api + postgres)
make up-cp       # control-plane only (api + postgres), no sandbox provider
make down      # stop the stack (PRESERVES the pgdata / workspaces volumes)
make down-v    # stop AND drop the volumes (DESTRUCTIVE — local data loss)
```

`make up` generates `apps/api/.env` **only when it does not already exist** (a
real local env is reused untouched). The generated env enables the **legacy
operator-token** path with random secrets for local development, while the
self-hosted console uses local accounts (default admin + optional password/OTP
accounts). No GitHub OAuth app is required.

Notes:

- Linux `make up` uses the per-task AIO sandbox image
  (`cap-aio-sandbox:pinned`), which is **build-only** — an actual
  `cap-aio-<taskId>` sandbox is provisioned per task when you create one.
- macOS `make up` defaults to BoxLite. Because CAP does not vendor a BoxLite
  daemon yet, set `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, and `BOXLITE_IMAGE`
  for your BoxLite control plane before running it.
- `api` and optional `web` host ports bind to `0.0.0.0` by default. Configure
  DNS, TLS, reverse proxy, OAuth callback/cookie scope, and firewall exposure
  yourself before making the stack public.
- The **web console now ships in the compose stack** (a `web` Node-server
  service, port 3000) so `docker compose up` brings up web + api + Postgres
  together; for local dev you can still run it standalone
  (`pnpm --filter @cap/web dev`).

For a real **production self-host** (the full web + api + Postgres stack via
`docker compose up`, local-account auth, public-domain / cookie-scope
configuration, and PAT-based repository access), see the
[Self-hosting guide](docs/self-hosting.md).

## Auth & the host-root boundary

The platform runs tasks as **host-root via `docker.sock`**. Consequently
**"who can log in" equals "who can run as root on the host"** — so console auth
is a load-bearing security boundary, not a convenience layer.

Auth is **local-account based**:

- A default admin account is seeded for self-hosting; admins can create local
  accounts with password or email-code login.
- **Fail-closed everywhere:** disabled accounts, expired/revoked sessions, and
  invalid machine credentials are rejected before protected handlers run.
  Account enablement is re-confirmed at request time, so disabling an operator
  takes effect immediately.
- **Repository access is separate from console login:** GitHub/GitLab/Gitee
  repository import and push/PR flows use per-account forge PAT credentials, not
  GitHub OAuth or a GitHub App.
- **Break-glass:** the legacy single shared-`AUTH_TOKEN` operator path exists
  behind `AUTH_TOKEN_LEGACY_ENABLED` and is **OFF by default** — only an
  explicit truthy value (`true`/`1`/`yes`) re-enables it.

## Deploy topology (cross-origin)

The web console (Vercel) and the api (Fly / docker-compose host) run on
**separate origins**. The web targets the api via `VITE_API_BASE_URL` /
`VITE_WS_URL`. The session cookie is sent cross-origin with `credentials:
include`, and the api must CORS-allowlist the web origin. The terminal
WebSocket authenticates with a bearer subprotocol (`bearer.<token>`), which
also works cross-origin. See `apps/web/README.md` for the current REST/WS auth
posture.
