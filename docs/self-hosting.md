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
stack. The default path below builds everything from source; once a Release has
published prebuilt images you can pull them instead — see
[Optional: run prebuilt images](#optional-run-prebuilt-images-instead-of-building-from-source).
In-app upgrades are a later phase you do not need to self-host today.

> **🚀 Trying it on a fresh local host?** The public marketing site hosts a
> one-line installer that wraps the local `make up` bring-up — it preflights
> Docker, clones this repo, runs `make up` (or `make up-cp` on Apple Silicon),
> and surfaces the printed Bearer token:
>
> ```bash
> curl -fsSL https://<site-domain>/install.sh | sh
> ```
>
> It is a convenience wrapper for a **local** trial, not a production path: the
> manual `make up` (local) and the `docker compose` flow below **remain the
> source of truth**. The script is served as plain text — read it first, or use
> the equivalent manual `git clone … && make up` the site also shows. For a real
> production deploy, follow the steps in this guide.

> **⚡ Fast path — run prebuilt images, NO `git clone` (amd64 host).** Once a
> Release exists, you don't need the source at all: download
> `docker-compose.prod.yml` + `docker-compose.prod.env.example` from the
> [Releases page](https://github.com/Xeonice/cloud-agent-platform/releases),
> `cp docker-compose.prod.env.example .env`, fill it (Steps 1–5 below explain the
> values), then `docker compose -f docker-compose.prod.yml pull && docker compose
> -f docker-compose.prod.yml up -d` (add `--profile web` for the in-compose
> console). This SOURCE-FREE run package is the build/run split — build stays on
> the build platform, run is this one file. Details:
> [Run from prebuilt images (no source)](#or-source-free-run-package-no-clone).

> **Let Claude Code deploy it.** With Claude Code installed, paste the prompt
> below — it reads `install.sh`, preflights Docker, clones the repo and runs
> `make up`, and walks you step by step through local-account auth and `.env`
> setup below — the same source-build production path:
>
> ```text
> Deploy cloud-agent-platform on this machine. First read the installer at https://<site-domain>/install.sh and confirm Docker with a usable docker.sock is available. Then clone https://github.com/<owner>/cloud-agent-platform, cd into it, and run `make up` to build and start the full stack. Help me configure local account login, web/api origins, and PAT-based repository access, then report the console URL and the generated admin/legacy credentials it prints.
> ```
>
> It wraps `make up` rather than replacing it; the script is served as plain text
> so you can read it before running, and you can take over at any point.

## What the stack brings up

Enable the in-compose console with the `web` profile (`COMPOSE_PROFILES=web`);
`api` + `postgres` always run.

| Service    | Role                                                              |
| ---------- | ----------------------------------------------------------------- |
| `web`      | The TanStack Start console (Nitro `node-server`), host port 3000 — **`web` profile** |
| `api`      | The NestJS orchestrator (local sessions, tasks, WS), 8080 |
| `postgres` | The database backing tasks/audit/history                          |

The web console talks to the api **only by its public URLs** (`VITE_API_BASE_URL`
/ `VITE_WS_URL`). cap is designed for a **cross-origin** topology (web and api on
different origins), so getting the URLs and cookie scope right is the single most
important — and most error-prone — part of setup. Read
[Step 3](#step-3--configure-your-public-domains-the-error-prone-step) carefully.

## Prerequisites

- A host with **Docker** + Docker Compose and access to `/var/run/docker.sock`.
- Public DNS / TLS for the domains you will serve the web console and api from
  (a reverse proxy such as Cloudflare or nginx terminating HTTPS in front of the
  api — see the opt-in `proxy` profile in `docker-compose.yml`). Cookies are sent
  `Secure` cross-origin, so the api must be reachable over **HTTPS** in production.
- An admin email/password plan for the default local account, and PATs for any
  private code-host repositories you want the platform to import.

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
| `VITE_API_BASE_URL`     | `apps/web` build | HTTP base URL of the api, e.g. `https://cap-api.example.com`     |
| `VITE_WS_URL`           | `apps/web` build | WebSocket URL of the api, e.g. `wss://cap-api.example.com`       |
| `WEB_ORIGIN`            | `apps/api/.env`  | Comma-separated web origin(s) the api CORS-allowlists + redirects to after login |
| `SESSION_COOKIE_DOMAIN` | `apps/api/.env`  | The cookie `Domain` attribute (see below) — **the most common mistake** |

> **`VITE_*` are build-time, baked into the image.** The web image is
> **domain-specific**: `VITE_API_BASE_URL` / `VITE_WS_URL` are read by Vite when
> the bundle is built, not at container start. Pass them as build args
> (`docker compose build` reads them from your env), and rebuild the `web` image
> if you change your api domain. They cannot be changed by editing a running
> container's env.

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

# Signs the OAuth state (anti-CSRF) cookie and the opaque session — long & random.
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

This builds the `web` image (passing `VITE_API_BASE_URL` / `VITE_WS_URL`), the
`api`, and starts Postgres. The web console is published on host port **3000**
(override with `WEB_HOST_PORT`), the api on **8080**.

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
mismatch between `WEB_ORIGIN`, `SESSION_COOKIE_DOMAIN`, and the baked
`VITE_API_BASE_URL` is the cause ~every time.

## Optional: run prebuilt images instead of building from source

Everything above builds the `api` / `web` / AIO-sandbox images **from source** on
your host — the default, and the only path that works before a Release exists.
Once the maintainer cuts a GitHub Release, that Release publishes a **matched,
version-pinned set** of images to GHCR
(`ghcr.io/xeonice/cap-api`, `cap-web`, `cap-aio-sandbox`, all at the SAME
`vX.Y.Z`). You can then **pull** that pinned set instead of compiling, using the
`docker-compose.images.yml` **override** layered on top of the base compose.

> **You still need Steps 1–5.** The override only changes WHERE the images come
> from (pull vs. build). Your local auth, domains, secrets, and (optional)
> external DB are configured exactly as above — the prebuilt images read the same
> `apps/api/.env` and the same build-time `VITE_*` (already baked into the
> published `cap-web` by the Release).

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

- **One version for all three.** `${CAP_VERSION}` pins `cap-api`, `cap-web`, AND
  `cap-aio-sandbox` (the per-task execution image) to the same tag, so you never
  run a mismatched set. It is intentionally REQUIRED — leaving `CAP_VERSION` unset
  makes `docker compose config` warn/fail loudly rather than silently resolving a
  blank tag. Always set it to a real published Release tag.
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
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d            # add: --profile web  for the in-compose console
```

- **Version:** `CAP_VERSION` is OPTIONAL — unset runs `latest` (the newest
  Release), so a bare `up -d` is a resident "always run the latest release" stack.
  Pin a tag (`CAP_VERSION=v0.1.0`) for a reproducible / rollback-able deploy.
- **Requires an amd64 / x86_64 host** — the published images are amd64-only (the
  per-task AIO sandbox base is amd64-only). On arm64 (e.g. Apple Silicon) the pull
  errors with "no matching manifest for linux/arm64"; use an x86_64 host.
- **Core + opt-in observability.** It runs api + the per-task sandbox image +
  Postgres (+ optional `web` profile), and ALSO carries an opt-in observability
  stack (loki + alloy + grafana) whose config ships INLINE so it stays source-free.
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
**synthesizes a legacy-token `.env`** for a local trial —
relying on the fact that the prod compose reads `env_file: .env` and does not redeclare
the auth secrets:

```bash
# from a clone (uses the repo's docker-compose.prod.yml), or anywhere (it fetches it):
CAP_VERSION=v0.21.0 scripts/quick-deploy.sh        # localhost trial, web on :3000
WITH_WEB=0 scripts/quick-deploy.sh                 # api + postgres only
CAP_SMOKE_REPO_ID=<id> RUN_SMOKE=1 scripts/quick-deploy.sh   # + provision smoke
```

It runs as fail-closed **gates**: ① architecture (the prebuilt images are **amd64-only**;
on arm64 it stops and points you at the from-source `make up`), ② base tooling,
③ **Docker engine reachable** — with bounded self-heal on WSL (select a live context;
start Docker Desktop via interop) and, if that fails, the exact human step
(enable Docker Desktop **WSL Integration** for the distro, or `sudo systemctl restart
docker`), ④ fetch `docker-compose.prod.yml`, ⑤ idempotently write the legacy-token `.env`
(an existing `.env` is reused, never overwritten; it stays gitignored), ⑥ `pull` + `up`,
⑦ wait for `/health` and print the `Authorization: Bearer` token.

> **This is the legacy-token path, not the normal local-account production path.** It is
> **host-root-equivalent** (it mounts the host `docker.sock`), so whoever holds the
> printed token can run as root on the host — keep it to a single-user / trial host. The
> prebuilt `cap-web` is **localhost-only** (its `VITE_*` are baked to localhost); for a
> real domain, follow the local-account steps above instead. WSL2 on a normal PC is amd64,
> which makes it a good target for this path.

## Optional: in-app one-click self-update (`SELF_UPDATE_ENABLED`, default OFF)

Once you run the pinned-release line above, cap can apply an available update
**from inside the console**: an admin presses an **Upgrade** button on the update
banner and the api pulls the matched, version-pinned GHCR image set and recreates
the cap services — running tasks survive the recreate. This is **opt-in and
default-off**; you do not need it to self-host.

> **Security note — this is host-root behind a button.** The Upgrade action drives
> the host's Docker socket, the same host-root power tasks already run with. **Who
> can press it = who can run as root on the host.** Enabling it is a deliberate
> decision, not a default. The feature ships **inert**: with `SELF_UPDATE_ENABLED`
> unset, `POST /self-update` refuses and the button is absent (the banner stays
> notify-only). Keep it off unless you have a reason to turn it on.

What it can do — even when enabled — is deliberately **bounded**:

- It only upgrades to a target that **matches the latest** reported by the
  update check (`GET /update-status`); an arbitrary/mismatched target is rejected.
- It pulls **only** the cap GHCR namespace (`ghcr.io/xeonice/cap-*:<target>`) and
  recreates **only** the cap compose services. There is no path to an arbitrary
  image, tag, or shell command.
- It pulls **before** recreating, so a failed pull leaves the running stack intact.

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
