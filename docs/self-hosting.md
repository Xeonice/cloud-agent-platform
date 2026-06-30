# Self-hosting cap

This is the operator-facing guide to standing up your own cap instance with
`docker compose up`. cap uses **local account auth** for self-hosting: the stack
seeds a default admin, and admins can create password or email-code accounts.
Repository access is configured separately with per-account forge PATs.

> **Security note up front.** cap runs tasks as **host-root via the Docker
> socket** (`/var/run/docker.sock`). "Who can log in" therefore equals "who can
> run as root on the host." Account access is a load-bearing security boundary,
> not a convenience layer — keep it tight. See the README's
> [Auth & the host-root boundary](../README.md#auth--the-host-root-boundary).

This guide is Phase 0 of the [OSS self-update epic](./oss-self-update-epic.md)
("a stranger can run it"): a complete, env-configurable, local-account compose
stack. The recommended install path runs published release images. Source builds
are still documented for development or custom image work, but the one-line
installer and agent path should not clone the repo or run `make up`.
In-app upgrades are a later phase you do not need to self-host today.

> **Trying it on a fresh local host?** The public marketing site hosts a
> one-line installer that runs the prebuilt release-image package — it preflights
> Docker, delegates to `quick-deploy.sh`, downloads `docker-compose.prod.yml`,
> resolves the latest Release tag when `CAP_VERSION` is unset, pulls
> `ghcr.io/xeonice/cap-*:${CAP_VERSION}`, and surfaces the printed admin
> email/password. The release web image supports same-host runtime endpoint
> discovery: open `http://<host>:3000` and it targets the api at the same
> hostname plus the configured api host port (default 8080).
> macOS defaults to the BoxLite sandbox path; Linux defaults to AIO.
> Override with `CAP_SANDBOX_PROVIDER=aio|boxlite|control-plane`.
>
> ```bash
> curl -fsSL https://<site-domain>/install.sh | sh
> ```
>
> It is a convenience wrapper for a **local** trial, not a full production-domain
> setup: it writes a local-account `.env` and leaves DNS/TLS/proxy/cookie scope
> to you. The script is served as plain text — read it first, or use the
> equivalent manual `docker-compose.prod.yml` + `.env` path. It does not
> `git clone`, run `make up`, or build local images.
>
> Docker handling is deliberately conservative: if Docker CLI, Docker Compose,
> or the macOS Colima formula is absent, the installer uses the supported package
> manager path for the host OS and installs only the missing component(s). On
> macOS it bootstraps Homebrew non-interactively only when Homebrew is absent and
> a Docker/Compose install is actually required. If Docker is already installed
> and `docker info` works, it leaves Docker/Homebrew/Colima alone. If Docker is
> installed but the daemon/socket/context is unreachable, it performs only
> bounded safe starts and then stops with the exact remediation; it does not
> reinstall or upgrade Docker to hide a bad state.
>
> The api/web host ports bind to `0.0.0.0` by default. Public DNS, TLS, reverse
> proxy, auth callback URLs, cookie scope, and firewall rules are still your
> responsibility before exposing the host publicly.

> **Fast path — run prebuilt images, NO `git clone`.** Once a Release exists, you
> don't need the source at all: download
> `docker-compose.prod.yml` + `docker-compose.prod.env.example` from the
> [Releases page](https://github.com/Xeonice/cloud-agent-platform/releases),
> `cp docker-compose.prod.env.example .env`, fill it (Steps 1–5 below explain the
> values), then `docker compose -f docker-compose.prod.yml pull && docker compose
> -f docker-compose.prod.yml up -d api postgres` (add `web` for the in-compose
> console, and add `aio-sandbox-image` on Linux/AIO). This SOURCE-FREE run
> package is the build/run split — build stays on the build platform, run is this
> one file. Details:
> [Run from prebuilt images (no source)](#or-source-free-run-package-no-clone).

> **Let Claude Code deploy it.** With Claude Code installed, paste the prompt
> below — it reads `install.sh`/`quick-deploy.sh`, preflights Docker, and runs the
> same release-image path:
>
> ```text
> Deploy cloud-agent-platform on this machine. First read https://<site-domain>/install.sh and https://<site-domain>/quick-deploy.sh, confirm Docker with a usable docker.sock is available, then run the release-image install path. Do not git clone, do not run make up, and do not build locally. Use the latest Release unless I set CAP_VERSION. On macOS use CAP_SANDBOX_PROVIDER=boxlite and confirm BOXLITE_ENDPOINT and BOXLITE_API_TOKEN are set before running; leave BOXLITE_IMAGE unset to use the matching Release-asset rootfs, or set BOXLITE_IMAGE to force registry image mode. On Linux use the default AIO path. Report the console URL, the /version response, and the admin email/password it prints.
> ```
>
> The scripts are served as plain text so you can read them before running, and
> you can take over at any point.

## What the stack brings up

Enable the in-compose console with the `web` profile (`COMPOSE_PROFILES=web`);
`api` + `postgres` always run.

| Service    | Role                                                              |
| ---------- | ----------------------------------------------------------------- |
| `web`      | The TanStack Start console (Nitro `node-server`), host port 3000 — **`web` profile** |
| `api`      | The NestJS orchestrator (local sessions, tasks, WS), 8080 |
| `postgres` | The database backing tasks/audit/history                          |

The web console talks to the api by its public browser URL. For prebuilt
same-host installs, that URL is resolved at runtime from the current browser
hostname plus the configured api port. For split-domain or Vercel-style deploys,
set explicit api URLs (`VITE_API_BASE_URL` / `VITE_WS_URL` at build time, or
`CAP_PUBLIC_API_BASE_URL` / `CAP_PUBLIC_WS_URL` for the compose node-server
image). cap still uses a **cross-origin** topology when web and api are on
different ports or domains, so getting the URLs and cookie scope right is the
single most important — and most error-prone — part of setup. Read
[Step 3](#step-3--configure-your-public-domains-the-error-prone-step) carefully.

## Prerequisites

- A host that can run **Docker** + Docker Compose and, for AIO, expose a usable
  `/var/run/docker.sock` to the api container.
- Public DNS / TLS for the domains you will serve the web console and api from
  (a reverse proxy such as Cloudflare or nginx terminating HTTPS in front of the
  api — see the opt-in `proxy` profile in `docker-compose.yml`). Cookies are sent
  `Secure` cross-origin, so the api must be reachable over **HTTPS** in production.
- An admin email/password plan for the default local account, and PATs for any
  private code-host repositories you want the platform to import.

### Release-image installer dependency model

The one-line `install.sh` / `quick-deploy.sh` path separates dependencies by
when they are needed:

- **Install-time required:** POSIX shell, `curl`, `bash`, `openssl`, `awk`,
  Docker Engine, Docker Compose v2, network access to the site-served installer
  assets, the GitHub Release metadata endpoint when `CAP_VERSION` is unset, and
  GHCR for the `ghcr.io/xeonice/cap-*:${CAP_VERSION}` control-plane images. Sandbox
  runtime images can be delivered either from GHCR or from GitHub Release assets;
  the scripts never run `git clone`, `make up`, `docker build`, or
  `docker compose up --build`.
- **Docker behavior:** absent Docker is installed through the detected supported
  path; a missing Compose plugin is installed without reinstalling Docker
  Engine; usable Docker is left untouched; installed-but-unreachable Docker is
  treated as a daemon/socket/context problem and fails with remediation after
  bounded safe starts.
- **BoxLite host dependencies:** a local BoxLite control plane depends on host
  virtualization, not just installable packages. On macOS it requires Apple
  Silicon, macOS 12.0+, and `kern.hv_support=1` for Hypervisor.framework. On
  Linux or WSL2 it requires a read/write `/dev/kvm`. These capabilities cannot
  be repaired by the installer; when they are missing the script fails before
  probing BoxLite. If `BOXLITE_ENDPOINT` points at an external BoxLite host, the
  installer skips the local Hypervisor/KVM check and validates the endpoint
  instead.
- **Selected provider readiness:** Linux/AIO stages
  `ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}` before success. macOS/BoxLite
  requires `CAP_SANDBOX_PROVIDER=boxlite`, `BOXLITE_ENDPOINT`, and
  `BOXLITE_API_TOKEN`. `CAP_SANDBOX_IMAGE_DELIVERY=auto|registry|release-assets`
  controls the sandbox runtime source. In `auto`, BoxLite first tries the
  versioned GitHub Release asset and writes `BOXLITE_ROOTFS_PATH`; if the asset is
  unavailable it falls back to `BOXLITE_IMAGE`. AIO uses registry delivery unless
  `release-assets` is requested, in which case quick-deploy downloads
  `cap-aio-sandbox-<version>-linux-amd64.docker.tar.zst`, verifies its checksum,
  and `docker load`s it. BoxLite `release-assets` downloads
  `cap-boxlite-sandbox-<version>-<platform>.oci.tar.zst`, verifies it, extracts it
  under `CAP_SANDBOX_ASSET_DIR`, writes `BOXLITE_ROOTFS_PATH`, clears image env,
  and requires native BoxLite (`BOXLITE_PROTOCOL_MODE=native`,
  `BOXLITE_PATH_PREFIX=default`). Registry mode defaults `BOXLITE_IMAGE` to the
  matching `ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}` unless you set
  `BOXLITE_IMAGE` or a default `BOXLITE_IMAGE_MAP`. Readiness
  checks the endpoint/token, creates a short-lived probe sandbox without
  unsupported create-time fields, starts it through the native BoxLite API,
  verifies the image, workspace, and required runtime tools aligned with the AIO
  sandbox runtime (`bash`, `claude`, `codex`, `git`, `gzip`, `node`,
  `openspec`, `sh`, `tar`, `tmux` by default), then tears the probe sandbox
  down. Override `BOXLITE_RUNTIME_REQUIRED_TOOLS` only when you intentionally
  run a narrower custom runtime image. The official BoxLite image uses
  `/home/gem/workspace`, matching the AIO runtime launch path.
- **Optional task-time dependencies:** forge PATs for importing/cloning/pushing
  private repositories, SMTP for email-code login, public DNS/TLS/proxy and
  cookie scope for production exposure, an external Postgres URL if you do not
  use the bundled database, runtime-specific tokens such as
  `CLAUDE_CODE_OAUTH_TOKEN`, and the local-only `RUN_GITHUB_VALIDATION=1`
  smoke check with `GITHUB_VALIDATION_TOKEN` or ignored `.env.github-validation`.

## Step 1 — Configure local account auth

Self-hosted console login is local-account based. There is no GitHub OAuth app,
GitHub App, callback URL, or GitHub allowlist to configure.

Required auth-related environment:

```ini
SESSION_SECRET=<64+ random characters>
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<initial admin password>
PASSWORD_AUTH_ENABLED=true
```

Optional email-code login requires SMTP. If SMTP is absent, OTP is simply not
offered by the login screen:

```ini
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=...
SMTP_FROM=noreply@example.com
```

Admins can create/disable accounts from the console. Account enablement is
re-checked on every session/API-key/MCP-token resolution, so disabling an account
revokes access on the next request.

## Step 2 — Connect repositories with PATs

Console login and repository access are separate. To import private repositories
or let tasks push branches/open PRs, each operator connects a forge credential in
the console: **Settings -> Code hosting connections**.

For GitHub, create a Personal Access Token with repository access:

- Fine-grained PAT: grant the target repositories Contents + Pull requests write
  permissions.
- Classic PAT: use `repo` for private repositories, or `public_repo` for public-only.

GitLab/Gitee use their own PATs and optional self-hosted instance URL. These PATs
are stored per account and used only for repository listing/import/clone/push.

## Step 3 — Configure your public domains (the error-prone step)

This is where most self-host failures come from. cap sends the session cookie
**cross-origin** with `credentials: include`, so the web origin, the api's CORS
allowlist, and the **cookie scope** must all agree. Pick the topology that
matches your DNS.

### The variables

| Variable                | Where            | What it is                                                       |
| ----------------------- | ---------------- | ---------------------------------------------------------------- |
| `VITE_API_BASE_URL`     | `apps/web` build | Optional build-time HTTP base URL of the api, e.g. `https://cap-api.example.com` |
| `VITE_WS_URL`           | `apps/web` build | Optional build-time WebSocket URL of the api, e.g. `wss://cap-api.example.com` |
| `CAP_PUBLIC_API_BASE_URL` | `web` runtime | Optional runtime HTTP base URL for the compose node-server image |
| `CAP_PUBLIC_WS_URL`     | `web` runtime | Optional runtime WebSocket URL for the compose node-server image |
| `CAP_PUBLIC_API_PORT`   | `web` runtime | Same-host fallback api port when explicit base URLs are unset |
| `WEB_ORIGIN`            | `apps/api/.env`  | Comma-separated web origin(s) the api CORS-allowlists + redirects to after login |
| `SESSION_COOKIE_DOMAIN` | `apps/api/.env`  | The cookie `Domain` attribute (see below) — **the most common mistake** |

> **`VITE_*` are build-time overrides.** Use them for web-only/Vercel deploys or
> a deliberately domain-specific web image. The published release image leaves
> them blank and uses runtime `CAP_PUBLIC_*` config instead; when even that is
> absent, the browser falls back to same-host discovery.

### Topology 0 — same host, different ports (quick-deploy default)

Web and api live on the same hostname, e.g. web at
`http://100.101.167.99:3000` and api at `http://100.101.167.99:8080` (or a
custom `API_HOST_PORT` such as `18080`):

```ini
CAP_PUBLIC_API_PORT=8080
WEB_ORIGIN=http://localhost:3000
WEB_ORIGIN_AUTO_SAME_HOST=true
WEB_ORIGIN_AUTO_SAME_HOST_PORT=3000
# SESSION_COOKIE_DOMAIN intentionally unset
```

`quick-deploy.sh` writes these automatically. The explicit `WEB_ORIGIN` keeps
localhost tunnel access working; `WEB_ORIGIN_AUTO_SAME_HOST` lets the api also
echo `http://<same-host>:3000` when you open the console through a LAN/Tailscale
IP. Host-only `SameSite=Lax` cookies are used for this same-host HTTP topology.

### Topology A — cross-subdomain (recommended)

Web and api on **sibling subdomains of one registrable domain** — e.g. web at
`cap.example.com`, api at `cap-api.example.com`.

```ini
# apps/api/.env
WEB_ORIGIN=https://cap.example.com
SESSION_COOKIE_DOMAIN=.example.com
```

```ini
# web build args (e.g. apps/web/.env, or your shell env for `docker compose build`)
VITE_API_BASE_URL=https://cap-api.example.com
VITE_WS_URL=wss://cap-api.example.com
```

Setting `SESSION_COOKIE_DOMAIN` to the **registrable parent** (`.example.com`)
lets the cookie ride BOTH the browser's top-level requests to the web origin
(so the server-side SSR loader, which fetches the api, receives it) AND the
api's own cross-origin reads. The api emits the cookie as `SameSite=None; Secure`
in this mode, so the api must be served over HTTPS.

### Topology B — cross-site (e.g. web on `*.vercel.app`)

Web and api on **two different registrable domains** — e.g. web on
`your-app.vercel.app`, api on `cap-api.example.com`. No parent domain can bridge
two registrable domains, so **leave `SESSION_COOKIE_DOMAIN` UNSET**:

```ini
# apps/api/.env
WEB_ORIGIN=https://your-app.vercel.app
# SESSION_COOKIE_DOMAIN intentionally unset → host-only SameSite=None cookie
```

The cookie is host-only `SameSite=None; Secure` (the only browser-allowed option
across registrable domains). Both origins must be HTTPS.

### Topology C — same-origin

The api also serves the web app on the same origin. Leave **`WEB_ORIGIN` and
`SESSION_COOKIE_DOMAIN` both unset**: the callback uses relative redirects and
the default host-only `SameSite=Lax` cookie.

> **Wildcard CORS is rejected.** Because requests carry credentials, the api
> must echo an **exact** `Access-Control-Allow-Origin` — a `*` wildcard is
> refused by the browser. `WEB_ORIGIN` is that exact origin list.

## Step 4 — Generate the required secrets

```ini
# apps/api/.env

# Signs auth/session cookies and opaque sessions — long & random.
SESSION_SECRET=...          # generate: openssl rand -hex 32

# AES-256-GCM key encrypting compatible-provider API keys at rest.
# 64 hex chars (32 bytes) or base64 of 32 bytes.
CODEX_CRED_ENC_KEY=...      # generate: openssl rand -hex 32
```

Generate both:

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "CODEX_CRED_ENC_KEY=$(openssl rand -hex 32)"
```

The login flow fails closed without `SESSION_SECRET`. Keep these secret and out
of version control — `apps/api/.env` is gitignored.

## Step 5 — (Optional) Point at an external database

By default the stack runs its own Postgres and the api uses the compose-internal
connection (`postgresql://cap:cap@postgres:5432/cap?schema=public`). To use an
external/managed Postgres instead, set `DATABASE_URL`:

```ini
# apps/api/.env
DATABASE_URL=postgresql://user:password@db.example.com:5432/cap?schema=public
```

Leaving it unset keeps the built-in Postgres service. There is no
maintainer-specific value baked in — every deployment value is yours to set.

## Step 6 — Bring up the stack

```bash
cp apps/api/.env.example apps/api/.env   # then fill in Steps 1–5

# build the web image with YOUR domains baked in, then start everything.
# The in-compose console ships behind the `web` profile — enable it here:
COMPOSE_PROFILES=web docker compose up --build
```

This builds the `web` image, the `api`, and starts Postgres. Set `VITE_*` only
when you want a domain-specific web build; otherwise the compose/node-server
runtime can use `CAP_PUBLIC_*` or same-host discovery. The web console is
published on host port **3000**
(override with `WEB_HOST_PORT`), the api on **8080** (override with
`API_HOST_PORT`). Both bind to `0.0.0.0` by default; set `WEB_HOST_BIND` or
`API_HOST_BIND` to `127.0.0.1` for loopback-only.

> The `web` service is behind the `web` compose profile (like
> `observability`/`grafana`/`proxy`), so you must enable it
> (`COMPOSE_PROFILES=web`, or `docker compose --profile web up`). If you serve
> the console elsewhere (e.g. Vercel), leave the profile off and the in-compose
> web service is never built or run.

When it's up:

1. Open the web console (your web origin).
2. Sign in with the default admin email/password configured in Step 1.
3. Create additional local accounts from **Accounts** as needed. Connect forge
   PATs from **Settings -> Code hosting connections** before importing private
   repositories.

If login bounces or the cookie doesn't stick, re-read
[Step 3](#step-3--configure-your-public-domains-the-error-prone-step) — a
mismatch between the browser-facing api URL, `WEB_ORIGIN`, and
`SESSION_COOKIE_DOMAIN` is the cause ~every time.

## Run prebuilt images instead of building from source

The source-build compose flow above builds the `api` / `web` / AIO-sandbox images
**from source** on your host. For install/private deployment, prefer the
published release images: each GitHub Release publishes a **matched,
version-pinned set** of images to GHCR
(`ghcr.io/xeonice/cap-api`, `cap-web`, `cap-aio-sandbox`, and
`cap-boxlite-sandbox`, all at the SAME `vX.Y.Z`). You can then **pull** that
pinned set instead of compiling, using the
`docker-compose.images.yml` **override** layered on top of the base compose.
The same Release also attaches checksumed sandbox runtime assets so installers
can stage AIO or BoxLite from GitHub Release assets when registry pulls are not
the desired path.

> **You still need Steps 1–5.** The override only changes WHERE the images come
> from (pull vs. build). Your local auth, domains, secrets, and (optional)
> external DB are configured exactly as above. The prebuilt web image reads
> runtime `CAP_PUBLIC_*` config or falls back to same-host discovery; set
> explicit endpoints for split-domain deployments.

Pin the whole stack to one published Release tag and bring it up **without
`--build`**:

```bash
# Replace v1.2.3 with the Release tag you want to run.
export CAP_VERSION=v1.2.3

# Pull the matched set, then start it. Do NOT pass --build (that rebuilds from
# source and defeats the override).
COMPOSE_PROFILES=web \
  docker compose -f docker-compose.yml -f docker-compose.images.yml pull
COMPOSE_PROFILES=web \
  docker compose -f docker-compose.yml -f docker-compose.images.yml up -d
```

- **One version for all release images.** `${CAP_VERSION}` pins `cap-api`,
  `cap-web`, `cap-aio-sandbox`, and `cap-boxlite-sandbox` to the same tag, so you never
  run a mismatched set. It is intentionally REQUIRED — leaving `CAP_VERSION` unset
  makes `docker compose config` warn/fail loudly rather than silently resolving a
  blank tag. Always set it to a real published Release tag.
- **Sandbox runtime assets are matched too.** `cap-image-assets.json` and the
  AIO/BoxLite `.tar.zst` assets on the Release carry the same version and
  checksums. `quick-deploy.sh` and self-update verify those checksums before
  loading/extracting them.
- **The default is unchanged.** Drop the second `-f docker-compose.images.yml`
  (i.e. plain `docker compose up --build`) and you are back to building from
  source. The override is purely additive and opt-in — nothing about the
  build-from-source path changes by its existence.
- **Confirm what you're running.** A published `cap-api` self-reports its build
  at `GET /version` (unauthenticated): `curl -s https://<api-origin>/version`
  returns `{ version, gitSha, buildTime }` — `version` is the Release tag.

> The published GHCR packages are **public** (set by the release workflow / a
> one-time owner setting), so `docker compose pull` works without `docker login`.
> See [`deploy/DEPLOY.md`](../deploy/DEPLOY.md) for the operator-gated activation
> (making the repo + packages public, cutting the first Release, and migrating an
> existing build-on-push deploy to a pinned Release).

### Or: source-free run package (no clone)

The override above still needs the **source tree** (it layers on `docker-compose.yml`),
and single-compose-file platforms (e.g. Dokploy) cannot layer `-f a -f b`. For a clean
**build/run split** — run with NO `git clone` — use the self-contained
**`docker-compose.prod.yml`**. It is attached to every Release alongside
`docker-compose.prod.env.example`, has NO `build:` blocks and NO source-tree
bind-mounts, and runs the pinned `ghcr.io/xeonice/cap-*:${CAP_VERSION}` set:

```bash
# Download the two files from the Releases page (no clone), then:
cp docker-compose.prod.env.example .env     # auth/secrets/domains (Steps 1–5); CAP_VERSION optional (defaults latest)
COMPOSE_PROFILES=web docker compose -f docker-compose.prod.yml pull api postgres web
COMPOSE_PROFILES=web docker compose -f docker-compose.prod.yml up -d api postgres web
# Linux/AIO: include aio-sandbox-image in both commands.
```

- **Version:** `CAP_VERSION` is OPTIONAL — unset runs `latest` (the newest
  Release), so a bare `up -d` is a resident "always run the latest release" stack.
  Pin a tag (`CAP_VERSION=v0.1.0`) for a reproducible / rollback-able deploy.
- **Platform/provider:** release images currently default to `linux/amd64`, and
  the run package pins `platform: ${CAP_IMAGE_PLATFORM:-linux/amd64}` so Apple
  Silicon Docker Desktop / Colima can run api/web via emulation instead of
  falling back to a local source build. On macOS use
  `CAP_SANDBOX_PROVIDER=boxlite` with `BOXLITE_ENDPOINT`,
  `BOXLITE_API_TOKEN`, the official version-matched BoxLite image by default,
  native protocol defaults, and do not stage `aio-sandbox-image`. On Linux/AIO, stage
  `aio-sandbox-image` so the per-task sandbox image is present before tasks run.
  A same-host BoxLite control plane must pass the host virtualization checks
  above; a nested macOS VM reporting `kern.hv_support=0` is not a valid
  co-located BoxLite target.
  When BoxLite runs on the same Mac as Docker/Colima, set the runtime endpoint
  for api containers to `BOXLITE_ENDPOINT=http://host.docker.internal:7331` and
  the installer probe endpoint to
  `BOXLITE_READINESS_ENDPOINT=http://127.0.0.1:7331`.
- **Core + opt-in observability.** It runs api + Postgres (+ optional `web`
  profile, + AIO image staging when selected), and ALSO carries an opt-in
  observability stack (loki + alloy + grafana) whose config ships INLINE so it stays source-free.
  Only the reverse proxy is excluded (its nginx config is source-coupled) — front
  the api (`:8080`) with your own TLS/proxy (Cloudflare Tunnel / Caddy / Traefik /
  nginx).
- **Enable observability on startup** (default: none of it runs):
  ```bash
  # logs (Loki+Alloy); add ,grafana for the UI (loopback 127.0.0.1:3001, front with your proxy):
  COMPOSE_PROFILES=observability,grafana docker compose -f docker-compose.prod.yml up -d
  ```
  Grafana's Loki dashboards work out-of-box; the Postgres-Audit panel needs a one-time
  `deploy/observability/grafana-ro-role.sql` + `GRAFANA_PG_*`/`GRAFANA_ADMIN_PASSWORD` env
  (see `docker-compose.prod.env.example`). Needs Docker Compose ≥ v2.23.1 (inline configs).
- **Single-file platforms (Dokploy):** point the app's compose file at
  `docker-compose.prod.yml` and set the env in its Environment (`CAP_VERSION`
  optional — defaults `latest`); updating = redeploy (or bump a pinned
  `CAP_VERSION`).
- **`web` caveat:** the prebuilt `cap-web` bakes `VITE_*` at build (defaults to
  localhost), so the in-compose console is only correct for a same-host trial; for
  a real domain serve the console elsewhere (e.g. Vercel) or rebuild `cap-web`.

### Or: agent one-click (`scripts/quick-deploy.sh`) — prebuilt images

For an **agent-drivable** bring-up that needs **no source build**, the repo ships
`scripts/quick-deploy.sh`. It runs the prebuilt
`ghcr.io/xeonice/cap-*:${CAP_VERSION}` images via `docker-compose.prod.yml` and
**synthesizes or updates a local-account `.env`** for a local trial:

```bash
# from a clone (uses the repo's docker-compose.prod.yml), or anywhere (it fetches it):
CAP_VERSION=v0.24.0 scripts/quick-deploy.sh        # Linux/AIO localhost trial, web on :3000
CAP_SANDBOX_PROVIDER=boxlite BOXLITE_ENDPOINT=... BOXLITE_API_TOKEN=... scripts/quick-deploy.sh
CAP_SANDBOX_PROVIDER=boxlite BOXLITE_ENDPOINT=http://host.docker.internal:7331 BOXLITE_READINESS_ENDPOINT=http://127.0.0.1:7331 BOXLITE_API_TOKEN=... scripts/quick-deploy.sh
CAP_SANDBOX_IMAGE_DELIVERY=release-assets CAP_SANDBOX_PROVIDER=aio scripts/quick-deploy.sh
WITH_WEB=0 scripts/quick-deploy.sh                 # api + postgres only
CAP_SMOKE_REPO_ID=<id> CAP_SMOKE_COOKIE=<cap_session> RUN_SMOKE=1 scripts/quick-deploy.sh   # + provision smoke
CAP_HEALTH_TIMEOUT_SECONDS=600 scripts/quick-deploy.sh   # slow Docker emulation / nested VM startup
```

It runs as fail-closed **gates**: ① platform/provider (auto selects macOS
BoxLite, Linux AIO; non-amd64 hosts pin `CAP_IMAGE_PLATFORM=linux/amd64`;
explicit AIO on non-amd64 fails with BoxLite/control-plane guidance), ② base tooling,
③ **Docker installed and reachable** — absent Docker is installed through the
supported host path, usable Docker is left untouched, and installed-but-dead
Docker gets only bounded safe starts before a human remediation is printed
(for example Docker Desktop **WSL Integration**, `sudo systemctl restart docker`,
or a live docker context), ④ fetch/refresh the managed `docker-compose.prod.yml`,
⑤ idempotently write the local-account `.env` (`ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`PASSWORD_AUTH_ENABLED=true`, session secrets, provider pins, sandbox image
delivery mode, and BoxLite native/rootfs defaults; an existing `.env` is reused
and stays gitignored), ⑥ validate the selected provider (AIO registry/image-asset
staging or BoxLite endpoint/runtime probe), ⑦ `pull`
then `up`, ⑧ wait for `/health` and print the admin email/password. The health
wait defaults to 120s, but macOS/arm64 hosts running the amd64 release images use
600s by default because QEMU/Colima emulation can take several minutes to finish
Node startup; override with `CAP_HEALTH_TIMEOUT_SECONDS=<seconds>` when needed.

Set `RUN_GITHUB_VALIDATION=1` to add a GitHub API reachability/auth smoke before
the pull. It reads `GITHUB_VALIDATION_TOKEN` from the process environment or an
ignored `.env.github-validation` next to the run package, and logs only a
redacted token source. Without a token it performs an unauthenticated
reachability check.

> This path is **host-root-equivalent** (it mounts the host `docker.sock`), so
> whoever can log in can run as root on the host — keep account access tight. The
> printed password is an initial admin credential and the first login requires
> changing it. The prebuilt `cap-web` supports same-host runtime endpoint
> discovery; for split-domain production, follow the local-account domain/cookie
> steps above and set explicit public api/ws endpoints.

## Optional: in-app one-click self-update (`SELF_UPDATE_ENABLED`, default OFF)

Once you run the pinned-release line above, cap can apply an available update
**from inside the console**: an admin presses an **Upgrade** button on the update
banner and the api stages the matched target release, then recreates the cap
services — running tasks survive the recreate. Control-plane images still come
from GHCR; sandbox runtime staging follows `CAP_SANDBOX_IMAGE_DELIVERY`
(`registry` pulls the stager image, `release-assets` downloads and verifies the
GitHub Release asset before recreate). This is **opt-in and default-off**; you do
not need it to self-host.

> **Security note — this is host-root behind a button.** The Upgrade action drives
> the host's Docker socket, the same host-root power tasks already run with. **Who
> can press it = who can run as root on the host.** Enabling it is a deliberate
> decision, not a default. The feature ships **inert**: with `SELF_UPDATE_ENABLED`
> unset, `POST /self-update` refuses and the button is absent (the banner stays
> notify-only). Keep it off unless you have a reason to turn it on.

What it can do — even when enabled — is deliberately **bounded**:

- It only upgrades to a target that **matches the latest** reported by the
  update check (`GET /update-status`); an arbitrary/mismatched target is rejected.
- It pulls **only** the cap GHCR namespace (`ghcr.io/xeonice/cap-*:<target>`) for
  cap services and, in Release-asset mode, downloads only the named sandbox assets
  for the same target. It recreates **only** the cap compose services. There is no
  path to an arbitrary image, tag, or shell command.
- It stages/pulls **before** recreating, so a failed sandbox asset download,
  checksum, Docker load, rootfs extraction, or image pull leaves the running stack
  intact.

To activate it (after a Release exists and prod runs the pinned-release line):

- set `SELF_UPDATE_ENABLED=true` in `apps/api/.env`,
- ensure the operators who may press Upgrade have `role = admin`, and
- flip the web `selfUpdate` capability flag to `true`
  (`apps/web/src/lib/api/capabilities.ts`) and redeploy the console.

See [`deploy/DEPLOY.md`](../deploy/DEPLOY.md) (the self-update section) for the full
activation steps, the detached self-recreate mechanism, and the threat model.

## Optional: update-check mirror (`GITHUB_API_BASE`)

cap's update check (`GET /update-status` — it drives the notify banner and the
self-update cross-check above) compares your running `CAP_VERSION` against the
latest GitHub Release. By **default** that lookup does not hit GitHub directly: it
goes through cap's public, **cache-only** mirror
(`https://releases.cap.douglasdong.com`), a small Cloudflare Worker that proxies
GitHub's `releases/latest` and serves it from Cloudflare's edge cache. This
converges the fleet onto one cached upstream and keeps the check working through a
brief GitHub API blip (within the cache window). The mirror is a **pure cache** —
no authentication, no GitHub token, no telemetry, and it never rewrites the
release payload.

If you would rather not depend on that mirror, point the upstream back at GitHub.
The lookup then talks to GitHub directly with **zero third-party dependency** —
this escape hatch is fully supported:

```bash
# apps/api/.env
GITHUB_API_BASE=https://api.github.com
```

This is orthogonal to `GITHUB_RELEASES_REPO` (which repo's Releases are checked):
the mirror transparently proxies whatever `owner/repo` you configure, so pointing
at your own fork works either through the mirror or direct.

## Optional: email-OTP login (SMTP via Resend)

The email verification-code (OTP) login method is **off until SMTP is configured**. Set
the five `SMTP_*` vars (all required — a partial config fails closed, hiding the OTP
method and refusing OTP requests) and the console shows the 邮箱验证码 method; password
login works regardless. cap sends over any standard SMTP provider; the
recommended default is **Resend** (standard SMTP, no approval/real-name/ICP, a free tier
ample for OTP, and Cloudflare can write its DNS in one click).

> **Mainland-China note:** Resend — like every international sender — delivers
> unreliably to `@qq.com` / `@163.com` / `@126.com`. Mainland operators should use
> password login. A dedicated mainland channel (e.g. Aliyun DirectMail) is a
> future add-on; the mail module already carries the recipient-routing seam for it.

### 1 — Resend account + sender domain

Create a Resend account, **Add Domain** (a subdomain such as `auth.yourdomain.com` keeps
your root-domain reputation clean), and create an **API key**. Resend then lists the DNS
records to add.

### 2 — Backend env (`apps/api/.env`, or `files/api.env` on a resident stack)

```ini
SMTP_HOST=smtp.resend.com
SMTP_PORT=465                          # implicit TLS (or 587 for STARTTLS)
SMTP_USER=resend                       # literal value, NOT your email
SMTP_PASS=re_xxxxxxxxxxxx              # a Resend API key
SMTP_FROM=no-reply@auth.yourdomain.com # the verified (sub)domain
```

Restart the api; `isOtpAuthEnabled` flips true and the 邮箱验证码 method appears in the
login modal.

### 3 — Cloudflare DNS (for `auth.yourdomain.com`)

Add the records Resend lists — **use the exact values from your Resend dashboard** (they
vary by region); typically:

| Type | Name | Value |
|------|------|-------|
| MX | `send` | `feedback-smtp.<region>.amazonses.com` (priority 10) |
| TXT (SPF) | `send` | `v=spf1 include:amazonses.com ~all` |
| TXT (DKIM) | `resend._domainkey` | the long `p=…` key Resend shows |
| TXT (DMARC, optional) | `_dmarc` | `v=DMARC1; p=none;` |

> **Gotcha:** the DKIM TXT record MUST be **DNS-Only (grey cloud)** in Cloudflare — if it
> is proxied (orange cloud) verification fails.

There is **no sandbox/approval** step — domain verification is usually minutes (up to
~72h). To write the records use Resend's "Sign in to Cloudflare" one-click, the
Cloudflare dashboard, or a token with `Zone:DNS:Edit` (cap's bundled wrangler/MCP tooling
is read-only for DNS). Click **Verify** in Resend; once green, OTP delivery works.

## Optional: legacy token (dev only)

The legacy single shared-`AUTH_TOKEN` operator path is **OFF by default** and
**not needed for a normal local-account self-host**. It exists for local dev (`make up`
generates one) and break-glass. To enable it you must set BOTH:

```ini
AUTH_TOKEN_LEGACY_ENABLED=true   # only true/1/yes turns it on
AUTH_TOKEN=<a-long-random-token>
```

Leave both at their defaults (`false` / empty) for a production local-account
deploy — the api boots without a legacy token.

## Optional: remote MCP server (`mcpServerEnabled`, default OFF)

The remote MCP server lets an MCP client (Claude Desktop, Cursor, VS Code,
`mcp-remote`) drive the platform's sandboxes — create/get/list/stop tasks, read a
finished task's transcript, list repos — through MCP tools. It ships **inert**:
the most dangerous outward-facing execution surface is OFF until an admin turns it
on, and even then every request is gated by a settings-minted credential.

### Endpoint and resource identity

- **Endpoint**: `https://<your-api-domain>/mcp` (e.g.
  `https://cap-api.douglasdong.com/mcp`). It is a single streamable-HTTP route
  (POST/GET/DELETE), served in-process by the api (no separate MCP process).
- **Canonical resource URI**: `cap:mcp` — the fixed RFC 8707 resource identifier
  every minted `mcp_` token is valid for. There is **no** OAuth audience
  negotiation and **no** `.well-known` discovery surface in the settings-minted
  model: the token IS the credential.
- **Auth**: a settings-minted `mcp_` token pasted into the client's
  `Authorization: Bearer mcp_…` header. The api validates it on every request
  (hash → lookup → reject revoked/expired → re-confirm the owner's enabled
  state), so revoking a token or disabling its owner denies it on the next call. The
  `/mcp` CORS is bearer-only and **non-credentialed** (no cookie is ever accepted
  there); the console's credentialed CORS is a separate domain and never includes
  an MCP-client origin.

### Turning it on

1. Set `mcpServerEnabled = true` — the system-level toggle in the console
   **Settings → MCP Server** card (admin-only; the operator must have
   `role = admin`). While `false`, `/mcp` returns a JSON-RPC "disabled"
   response and connects no transport, so no token works there.
2. In the same card, **mint an MCP token**: pick a name + scopes
   (`tasks:read`, `tasks:write`, `repos:read`), optionally an expiry. The raw
   `mcp_…` token is shown **once** — copy it then; only its `mcp_` prefix + last 4
   chars are ever shown again. Revoke is idempotent and own-scoped.

### Per-client connect config

Cursor (`~/.cursor/mcp.json` or a project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cap": {
      "url": "https://<your-api-domain>/mcp",
      "headers": { "Authorization": "Bearer mcp_REPLACE_WITH_YOUR_TOKEN" }
    }
  }
}
```

VS Code (`.vscode/mcp.json`) uses the same `url` + `headers` shape. For a client
that speaks only stdio, bridge with `mcp-remote`:

```jsonc
{
  "mcpServers": {
    "cap": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-api-domain>/mcp",
        "--header",
        "Authorization: Bearer mcp_REPLACE_WITH_YOUR_TOKEN"
      ]
    }
  }
}
```

### Deploy-time acceptance

With the live tunnel up and `mcpServerEnabled` on, mint a token, paste it into a
client as the `Authorization` bearer, and confirm an end-to-end `tools/list` +
`create_task` round-trip through `https://<your-api-domain>/mcp`. A client that
**cannot** pass a static bearer header (some web clients only support an OAuth
connector) cannot connect with a settings-minted token — that is a documented
limitation of this model, and OAuth auto-connect is a possible future add-on, not
part of this surface.

## Reference

- The reverse-proxy (Cloudflare → nginx → api) is gated behind the `proxy`
  compose profile; enable it on a VPS with
  `docker compose --profile proxy up -d --build`.
- Full variable reference: `apps/api/.env.example` and `apps/web/.env.example`.
- Background and roadmap: [OSS self-update epic](./oss-self-update-epic.md).
