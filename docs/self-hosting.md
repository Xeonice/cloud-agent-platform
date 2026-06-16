# Self-hosting cap

This is the operator-facing guide to standing up your own cap instance with
`docker compose up`. cap is **OAuth-first**: a clean self-host authenticates
operators through a **GitHub OAuth app** gated by a hard allowlist — you do
**not** need the legacy operator token (that path exists only for local dev /
break-glass; see [Optional: legacy token](#optional-legacy-token-dev-only)).

> **Security note up front.** cap runs tasks as **host-root via the Docker
> socket** (`/var/run/docker.sock`). "Who can log in" therefore equals "who can
> run as root on the host." The allowlist is a load-bearing security boundary,
> not a convenience layer — keep it tight. See the README's
> [Auth & the host-root boundary](../README.md#auth--the-host-root-boundary).

This guide is Phase 0 of the [OSS self-update epic](./oss-self-update-epic.md)
("a stranger can run it"): a complete, env-configurable, OAuth-first compose
stack. The default path below builds everything from source; once a Release has
published prebuilt images you can pull them instead — see
[Optional: run prebuilt images](#optional-run-prebuilt-images-instead-of-building-from-source).
In-app upgrades are a later phase you do not need to self-host today.

## What the stack brings up

Enable the in-compose console with the `web` profile (`COMPOSE_PROFILES=web`);
`api` + `postgres` always run.

| Service    | Role                                                              |
| ---------- | ----------------------------------------------------------------- |
| `web`      | The TanStack Start console (Nitro `node-server`), host port 3000 — **`web` profile** |
| `api`      | The NestJS orchestrator (OAuth/session/allowlist, tasks, WS), 8080 |
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
- Your numeric **GitHub user id(s)** for the allowlist (see Step 2).

## Step 1 — Create a GitHub OAuth app

GitHub OAuth is the primary login path. This is a one-time **human** step that
cannot be automated.

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
   (or `https://github.com/settings/developers`).
2. Fill in:
   - **Application name** — anything (e.g. `cap`).
   - **Homepage URL** — your web console origin (e.g. `https://cap.example.com`).
   - **Authorization callback URL** — **must** be your **api** origin plus
     `/auth/github/callback`:

     ```
     <api-origin>/auth/github/callback
     ```

     e.g. `https://cap-api.example.com/auth/github/callback`. The callback is on
     the **api**, not the web console — this is a common mistake.
3. Click **Register application**, then **Generate a new client secret**.
4. Copy the **Client ID** and **Client secret** into `apps/api/.env`:

   ```ini
   GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
   GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

The login flow **fails closed**: it refuses to start unless BOTH the client id
and secret are set.

> **Optional: `GITHUB_OAUTH_REDIRECT_URI`.** Leave this unset to use the app's
> registered callback. Set it only if you need to override the redirect that cap
> sends to GitHub (e.g. behind an unusual proxy) — it must still match a callback
> URL registered on the OAuth app.

## Step 2 — Set the operator allowlist

`AUTH_ALLOWLIST` is a comma-separated list of **immutable numeric GitHub ids**
(never logins — a renamed/recreated account cannot impersonate an allowlisted
operator). Only these identities may enter the host-root console; an
**empty/unset/unparseable allowlist denies ALL access** (fail-closed).

Find your numeric id:

```bash
curl -s https://api.github.com/users/<your-github-login> | grep '"id"'
# or, authenticated, for the logged-in user:
gh api user --jq .id
```

Then in `apps/api/.env`:

```ini
# one operator
AUTH_ALLOWLIST=1234567
# multiple operators
AUTH_ALLOWLIST=1234567,7654321
```

Allowlist membership is **re-checked at request time**, so removing an id revokes
access immediately on the next request.

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
2. Click **Sign in with GitHub** → authorize the OAuth app.
3. If your numeric id is on `AUTH_ALLOWLIST`, you land in the console; otherwise
   you're denied (fail-closed).

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
> from (pull vs. build). Your OAuth app, allowlist, domains, secrets, and (optional)
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

- set `SELF_UPDATE_ENABLED=true` and the admin allowlist (a strict subset of
  `AUTH_ALLOWLIST` — the numeric GitHub ids permitted to press Upgrade) in
  `apps/api/.env`, and
- flip the web `selfUpdate` capability flag to `true`
  (`apps/web/src/lib/api/capabilities.ts`) and redeploy the console.

See [`deploy/DEPLOY.md`](../deploy/DEPLOY.md) (the self-update section) for the full
activation steps, the detached self-recreate mechanism, and the threat model.

## Optional: legacy token (dev only)

The legacy single shared-`AUTH_TOKEN` operator path is **OFF by default** and
**not needed for an OAuth-first self-host**. It exists for local dev (`make up`
generates one) and break-glass. To enable it you must set BOTH:

```ini
AUTH_TOKEN_LEGACY_ENABLED=true   # only true/1/yes turns it on
AUTH_TOKEN=<a-long-random-token>
```

Leave both at their defaults (`false` / empty) for a production OAuth-first
deploy — the api boots without a legacy token.

## Reference

- The reverse-proxy (Cloudflare → nginx → api) is gated behind the `proxy`
  compose profile; enable it on a VPS with
  `docker compose --profile proxy up -d --build`.
- Full variable reference: `apps/api/.env.example` and `apps/web/.env.example`.
- Background and roadmap: [OSS self-update epic](./oss-self-update-epic.md).
