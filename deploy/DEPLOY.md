# VPS + Cloudflare deploy runbook (api orchestrator behind nginx)

Deploy topology:

```
browser ──HTTPS──> Cloudflare (orange-cloud, TLS) ──HTTP/HTTPS──> nginx:80(/443) ──> api:8080
                                                                       │
web console (Vercel, HTTPS) ──CORS + cookies──────────────────────────┘
```

The web console is deployed separately to Vercel (HTTPS). This runbook covers the
self-hosted **api orchestrator** on a VPS, fronted by an nginx reverse proxy that
lives in the same docker-compose stack and is enabled with the `proxy` profile.

This VPS runbook assumes a Linux/amd64 Docker host and the AIO sandbox provider.
For a local macOS source install, use the platform-aware `make up` path instead:
it defaults to BoxLite and requires `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, and
`BOXLITE_IMAGE` for an operator-supplied BoxLite control plane.

Why nginx is here: Cloudflare terminates TLS to the browser, so the cross-origin
OAuth session cookie must be `SameSite=None; Secure`. The api decides that from
`X-Forwarded-Proto` (`apps/api/src/auth/github-oauth.controller.ts` `isSecureRequest()`),
so the proxy MUST forward `X-Forwarded-Proto: https`. nginx also proxies the
`/terminal` WebSocket upgrade for the live PTY. See `deploy/nginx/nginx.conf`.

---

## 1. Install Docker + Compose on the VPS

```bash
# Debian/Ubuntu — Docker's official convenience script installs engine + compose v2 plugin.
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # re-login so `docker` works without sudo
docker --version
docker compose version            # must be Compose v2 (the `docker compose` subcommand)
```

---

## 2. Clone the repo and create `apps/api/.env`

The committed compose file carries NO secrets; the api reads them from the
gitignored `apps/api/.env` (via `env_file`). Copy the template and fill it in.

```bash
git clone <this-repo> cloud-agent-platform
cd cloud-agent-platform
cp apps/api/.env.example apps/api/.env
```

Set in `apps/api/.env` (see `apps/api/.env.example` for the full annotated list):

| Var | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | From the GitHub OAuth App (step 6). |
| `GITHUB_OAUTH_REDIRECT_URI` | `https://<domain>/auth/github/callback` |
| `AUTH_ALLOWLIST` | Comma-separated numeric GitHub user ids allowed in (fail-closed if empty). |
| `SESSION_SECRET` | Long random string. `openssl rand -hex 32` |
| `CODEX_CRED_ENC_KEY` | **Required** — 64 hex chars (32 bytes). `openssl rand -hex 32`. AES-256-GCM key that encrypts the Codex credential (the official ChatGPT `auth.json` + the compatible API key) at rest. Saving the credential FAILS CLOSED if unset. |
| `WEB_ORIGIN` | The Vercel URL, e.g. `https://<your-app>.vercel.app` (CORS allow-list). |
| `CODEX_CHATGPT_AUTH_JSON_B64` | **Optional fallback only.** Base64 of a ChatGPT `~/.codex/auth.json`. The Codex credential is normally configured in the **Settings page** (step 8) and stored encrypted in the DB; this env var is only used when no Settings credential is connected (or its key can't be decrypted). Prefer the Settings flow. |

> The api also accepts an `AIO_SANDBOX_IMAGE` override and concurrency/repo env;
> the compose file defaults `AIO_SANDBOX_IMAGE` to `cap-aio-sandbox:pinned`, which
> you build in step 3.

---

## 3. Build the AIO sandbox image the provider needs (`cap-aio-sandbox:pinned`)

The orchestrator provisions ONE per-task AIO Sandbox container from a PINNED
derived image (`AIO_SANDBOX_IMAGE`, defaulted to `cap-aio-sandbox:pinned` in
`docker-compose.yml`). The provider REJECTS `:latest`/untagged tags, so it must
be a pinned tag. Build it from the in-repo Dockerfile:

This step is for the Linux/AIO source-compose path. macOS local `make up`
defaults to the BoxLite endpoint-backed path and does not need this AIO image
unless you explicitly force `make up-aio`.

```bash
# From the repo root. This is the real build wired into the smoke check
# (scripts/aio-image-smoke.sh): -f docker/aio-sandbox.Dockerfile with the
# AIO_SANDBOX_TAG base build-arg, tagged as the pinned image the compose default
# (and the provider) expect.
docker build \
  -f docker/aio-sandbox.Dockerfile \
  --build-arg AIO_SANDBOX_TAG=1.0.0.125 \
  --build-arg CODEX_VERSION=0.131 \
  -t cap-aio-sandbox:pinned \
  .
```

- `AIO_SANDBOX_TAG=1.0.0.125` — the pinned `ghcr.io/agent-infra/sandbox` base tag
  the derived image is `FROM` (default in the Dockerfile; pulling it needs network).
- `CODEX_VERSION=0.131` — the pinned Codex CLI baked in (default in the Dockerfile;
  the release verified against the in-use model — bump deliberately, never `latest`).

Verify the built image (static + dynamic guards):

```bash
AIO_SANDBOX_IMAGE=cap-aio-sandbox:pinned scripts/aio-image-smoke.sh
```

> If you tag the image something other than `cap-aio-sandbox:pinned`, set
> `AIO_SANDBOX_IMAGE=<your-tag>` in `apps/api/.env` so the orchestrator and the
> compose default agree.

---

## 4. Bring up the stack WITH the proxy

```bash
docker compose --profile proxy up -d --build
```

- `--profile proxy` starts the `nginx` service (publishing host `:80`). Without
  this flag (plain local dev), nginx does NOT start and you hit `api` on `:8080`.
- `api` publishes `${API_HOST_BIND:-0.0.0.0}:${API_HOST_PORT:-8080}:8080`, so it
  is reachable directly on the VPS for debugging and is the nginx upstream
  (`api:8080` on the `default` network). Set `API_HOST_BIND=127.0.0.1` if you
  want direct host access to be loopback-only behind your proxy.
- `postgres` comes up with the api as before.

Check:

```bash
docker compose --profile proxy ps
curl -s http://localhost/healthz        # nginx origin health (does not touch the api)
curl -s http://localhost:${API_HOST_PORT:-8080}/...       # api directly (debug)
```

---

## 5. Cloudflare

1. **DNS**: add an `A` record `<domain>` → `<VPS public IP>`, **Proxied** (orange cloud).
2. **SSL/TLS mode** — pick one:
   - **Full (origin cert)** *(recommended)*: SSL/TLS → Origin Server → Create
     Certificate. Save the cert/key to `deploy/nginx/certs/origin.pem` and
     `origin.key`, then uncomment the `:443` server block in
     `deploy/nginx/nginx.conf`, the `443:443` publish, and the `certs` volume
     mount in `docker-compose.yml`'s nginx service. Re-run step 4. TLS is then
     encrypted Cloudflare ↔ origin.
   - **Flexible**: Cloudflare ↔ origin is plain HTTP on `:80` (no origin cert
     needed). Less secure on the origin hop, but the browser ↔ Cloudflare leg is
     still HTTPS — and because nginx forwards `X-Forwarded-Proto: https`, the api
     STILL emits `Secure` cookies and https redirects either way.

   Trade-off: Full encrypts the Cloudflare↔VPS hop and is preferred; Flexible is
   simpler (no origin cert) but leaves that hop unencrypted. The cookie/redirect
   behavior is identical because the user-facing scheme is HTTPS in both.

3. Cloudflare automatically sends `X-Forwarded-Proto` and proxies WebSockets, so
   the live terminal works through the orange cloud.

---

## 6. GitHub OAuth App

In the GitHub OAuth App settings, add the production callback URL:

```
https://<domain>/auth/github/callback
```

(must match `GITHUB_OAUTH_REDIRECT_URI` in `apps/api/.env`). Copy the Client ID /
Secret into `apps/api/.env` and re-run step 4 if you changed them.

---

## 7. Matching Vercel env (web console)

Set on the Vercel project (and redeploy):

```
VITE_API_BASE_URL = https://<domain>
VITE_WS_URL       = wss://<domain>
```

And make sure the api's `WEB_ORIGIN` (step 2) equals the Vercel origin so CORS +
cross-origin credentialed requests are allowed.

---

## 8. Configure the Codex execution credential (in the Settings page)

The credential codex authenticates with is configured IN THE APP, not via a
deploy env var. After logging in, open **设置 (Settings) → Codex**:

- **官方 (official / ChatGPT subscription)** — the normal path. On a machine with
  the Codex CLI, run `codex login` (ChatGPT) to produce `~/.codex/auth.json`, then
  paste that JSON into the official dialog and connect. The api encrypts it at
  rest (AES-256-GCM under `CODEX_CRED_ENC_KEY`) and the per-task sandbox provider
  decrypts + injects it into `/home/gem/.codex/auth.json` so codex authenticates
  per task. Nothing about the login is ever echoed back to the browser.
  - ChatGPT OAuth refresh tokens are single-use/rotating: when codex reports
    "your refresh token was already used", re-run `codex login` and paste the
    fresh `auth.json` to update the connection.
- **兼容 (compatible)** — a base URL + API key is accepted and stored encrypted,
  but per-task INJECTION of compatible providers is not wired yet (the stored key
  is not yet formatted into codex's custom-provider config). Use official for now;
  compatible injection is a tracked follow-up.

Fallback: if no official credential is connected (or its ciphertext can't be
decrypted), the provider falls back to the optional `CODEX_CHATGPT_AUTH_JSON_B64`
env var (step 2). Prefer the Settings flow so the credential is per-account,
encrypted, and rotatable from the UI.

The `auth_json_ciphertext` column is added by migration
`20260607120000_add_codex_official_auth_json`, applied automatically on api
container start (`prisma migrate deploy`).

---

## 9. Durable session transcripts — REQUIRED backup policy

`persist-session-transcripts` makes a terminal task's codex conversation survive
container reaping by archiving the RAW rollout as gzipped JSONL on the durable
workspace volume — `workspaces/<taskId>/transcript.jsonl.gz`, co-located with
`session.log` — and indexing it in the Postgres `SessionTranscript` table. The
read path (`GET /tasks/:id/session-history`) resolves DURABLE-FIRST, so a reaped
container no longer loses the conversation.

**"Permanent" is only as durable as the volume.** A transcript's lifetime is now
decoupled from the container's, but it lives ONLY on the named `workspaces`
volume (compose `volumes: workspaces:`, mounted at `WORKSPACES_DIR=/data/workspaces`)
plus its `SessionTranscript` index row in `pgdata`. A host loss takes BOTH with
it. Therefore:

- The `workspaces` volume MUST be in the host's backup policy (snapshot,
  rsync/restic to off-host storage, or block-volume snapshots) so transcripts
  survive host loss. Back up `pgdata` alongside it so the index stays consistent
  with the archives.
- Back the two together (consistent point-in-time) — the archive is the source of
  truth; the DB index can be rebuilt from the archives if it drifts, but the
  archives cannot be rebuilt if the volume is lost.
- A future secondary push to object storage (S3/R2) is the durable off-host
  option if host snapshots are not available; it is OUT OF SCOPE for this change.

Without this backup policy "permanent queryability" holds only against container
reaping, NOT against host loss.

### e2e verification at deploy (before flipping the console flag, transcripts)

After deploying the durable-first read path, verify against the live api with a
RETAINED sandbox, then flip the web `capabilities.ts` `sessionHistory` flag:

1. Run a task to a terminal state (`completed`/`cancelled`/`failed`) so guardrails
   captures the rollout. Confirm the archive exists:
   `docker compose exec api ls -l /data/workspaces/<taskId>/transcript.jsonl.gz`
   and that a `SessionTranscript` row was upserted for that `taskId`.
2. Reap the task's container (force-remove `cap-aio-<taskId>`, or wait out
   `RetentionCleaner`).
3. `GET /tasks/<taskId>/session-history` and confirm it STILL returns the parsed
   transcript — served from the durable archive, NOT the (now-gone) container.
4. Once confirmed, set `sessionHistory: true` in
   `apps/web/src/lib/api/capabilities.ts` and confirm the console renders the real
   durable-first transcript.

---

## 10. Backend redeploys now PRESERVE running tasks (sandbox re-adoption)

`survive-api-redeploy` decouples a running task's lifetime from the api process.
Codex no longer runs as a foreground child of the terminal WebSocket — it runs in
a **detached, named tmux session** (`task<taskId>`) inside its per-task
`cap-aio-<taskId>` sandbox container. Because that session is a child of the
container's tmux daemon, it KEEPS RUNNING when the api process exits or the
terminal WS closes. On the next boot the api **re-adopts** it instead of killing
it:

- **Non-destructive shutdown.** On `SIGTERM`/`onModuleDestroy` the api releases
  its in-memory sandbox handles WITHOUT stopping the provisioned containers, so
  the next process can find them. (The stop-only retention teardown for a task
  that genuinely reached a terminal state is unchanged.)
- **Re-adopt on boot (PHASE 0, before reclaim).** `onApplicationBootstrap` lists
  RUNNING `cap-aio-*` containers, parses each `taskId`, and re-adopts it when it
  matches a `running`/`awaiting_input` DB row AND its tmux session is still alive
  (`tmux has-session -t task<taskId>`). A re-adopted task KEEPS its state, holds
  its concurrency slot, and re-arms its deadline/idle watchers from the persisted
  values. The operator terminal reconnects by ATTACHING to the live session
  (`tmux attach`) with `session.log` snapshot + tail replay, rather than launching
  a fresh codex.
- **Only genuine orphans are force-failed.** A RUNNING container with no matching
  live task — and a `running`/`awaiting_input` DB task whose session is gone — is
  reclaimed (force-failed, slot freed). The queued re-offer admits against
  capacity REDUCED by the re-adopted slots, so re-adoption never over-commits the
  concurrency ceiling. A re-adopted task that later ends is detected by liveness
  polling (the named session disappearing) and transitions through the normal
  terminal path EXACTLY ONCE, freeing its slot (idle/deadline reclamation remains
  a backstop).

> ⚠️ **The FIRST deploy shipping this change still interrupts then-running tasks.**
> Re-adoption only works for tasks that were ALREADY launched into a detached tmux
> session, i.e. by an api that already had this change. The api you are replacing
> ran codex in-foreground, so its in-flight tasks have NO detached session to
> survive the restart and will be reclaimed (force-failed) on the new api's boot.
> **Ship this change on an EMPTY queue** (no `running`/`awaiting_input` tasks) so
> the cutover interrupts nothing. Every redeploy AFTER this one preserves running
> tasks.

### e2e verification at deploy (redeploy survival, 5.2)

Run this against the live api ONLY WHEN THE QUEUE IS EMPTY (the first deploy of
this change still interrupts running tasks — see the warning above):

1. Start a task and let codex begin working (task is `running`, terminal streaming).
2. Redeploy / restart the api mid-run (`docker compose --profile proxy up -d
   --build`, or restart just the `api` service).
3. Confirm codex KEPT RUNNING through the restart: the `cap-aio-<taskId>` container
   is still up and `docker exec cap-aio-<taskId> tmux has-session -t task<taskId>`
   succeeds.
4. Confirm the new api RE-ADOPTED it: the task is still `running` (not failed),
   it still holds its slot, and reopening the operator terminal reconnects via the
   `session.log` replay to the live session (codex's in-progress output is intact).
5. Confirm the task proceeds to its natural terminal state and frees its slot
   exactly once.

---

## 11. Versioned releases via GHCR — OPERATOR-GATED ACTIVATION (owner only)

> **These are OWNER actions, NOT performed by the `versioned-release-pipeline`
> change.** That change only ships INERT/SAFE code — the `/version` endpoint, the
> web build id, the `release: published` CI workflow (`.github/workflows/release.yml`),
> and the opt-in `docker-compose.images.yml` override. Committing them changes
> nothing about the running system. The steps below are the manual, one-time
> activation only the repository owner can take to turn the substrate ON. Until
> they are done, every deploy stays build-from-source exactly as Sections 1–10
> describe.

`release-and-versioning` (Phase 1 of the [OSS self-update epic](../docs/oss-self-update-epic.md))
adds the **version substrate**: the running api self-reports its build at an
unauthenticated `GET /version`, and cutting a GitHub Release publishes a
**matched, version-pinned set** of images to GHCR — `ghcr.io/xeonice/cap-api`,
`cap-web`, `cap-aio-sandbox`, and `cap-boxlite-sandbox`, ALL tagged with the
single Release version `vX.Y.Z` (decision ⑤). The release workflow also attaches
central sandbox image assets to the GitHub Release:
`cap-image-assets.json`, `cap-aio-sandbox-<version>-linux-amd64.docker.tar.zst`,
and `cap-boxlite-sandbox-<version>-linux-{amd64,arm64}.oci.tar.zst`, each with a
`.sha256`. A self-hoster can therefore pull a mutually-compatible set from GHCR
or stage the matching sandbox runtime from Release assets instead of building
(see the prebuilt-image override in
[`docs/self-hosting.md`](../docs/self-hosting.md)).

### 11.1 Make the repo + GHCR packages public (owner)

For self-hosters to `docker compose pull` the images without `docker login`, the
published GHCR packages must be **public**.

- The release workflow sets the published packages' visibility to public, OR set
  it once per package by hand: GitHub → your profile → **Packages** → the
  `cap-api` / `cap-web` / `cap-aio-sandbox` / `cap-boxlite-sandbox` package → **Package settings** →
  **Change visibility → Public**.
- If the source repo itself is still private, decide whether to make it public
  too (the images can be public independently, but a public prebuilt-image path
  with a private repo means self-hosters pull images they cannot build from
  source).

### 11.2 Cut the first GitHub Release (owner) — this is what triggers CI

The workflow is **inert until a Release is published**. To publish the first
image set:

1. Tag the commit and create a GitHub Release whose tag is the cap version,
   `vX.Y.Z` (e.g. `v0.1.0`). The tag name becomes `CAP_VERSION` and the image
   tag for all release images.
2. Publishing the Release fires `release: published`, which runs
   `.github/workflows/release.yml`. It builds and pushes the matched set to GHCR
   at `vX.Y.Z`, injecting `CAP_VERSION` / `GIT_SHA` / `BUILD_TIME` (and the web
   `VITE_BUILD_ID`) so the published images self-report.
3. Verify: pull `ghcr.io/xeonice/cap-api:vX.Y.Z`, run it, and confirm
   `curl -s http://<host>/version` reports `version: vX.Y.Z`. Also confirm the
   Release includes `cap-image-assets.json` plus the AIO/BoxLite sandbox asset
   archives and checksums. (`workflow_dispatch` is available for a manual re-run
   if a Release build needs to be repeated.)

> This is the true end-to-end of the pipeline and is **verified at the first real
> Release**, not by committing the change — a Release publishing real images
> cannot be exercised on a normal push.

### 11.3 Migrate this prod from build-on-push to deploy-a-pinned-release (owner, decision ④)

Today the maintainer's prod (this VPS / Dokploy) **builds from source on every
push** (Sections 3–4). Decision ④ (unified release line) is to converge the
maintainer's own deploy onto the SAME pinned-release path self-hosters use, so
prod runs the exact published, version-stamped set rather than an ad-hoc
build-of-HEAD.

After the first Release exists (11.2):

The RUN side is fully split from build: it is the **source-free**
`docker-compose.prod.yml` — prebuilt images only, NO `build:` blocks, NO source-tree
bind-mounts. You don't even need to clone the repo: both `docker-compose.prod.yml`
and `docker-compose.prod.env.example` are **attached to each Release** (download the
two files, fill `.env`, run).

1. Pick the Release tag, fill the env:
   ```bash
   # download docker-compose.prod.yml + docker-compose.prod.env.example from the Release
   cp docker-compose.prod.env.example .env   # set CAP_VERSION + OAuth/allowlist/secrets/domains
   ```
2. Pull + run (do NOT `--build` — there are no build blocks; it can only pull):
   ```bash
   docker compose -f docker-compose.prod.yml pull
   docker compose -f docker-compose.prod.yml up -d            # add: --profile web  for the in-compose console
   ```
   - **Single-compose-file platforms (e.g. Dokploy):** point the app's **Compose
     file path** at `docker-compose.prod.yml` and set the env (incl. `CAP_VERSION`)
     in its **Environment**, then redeploy. (Dokploy cannot layer `-f a -f b`, which
     is exactly why this file is self-contained.)
   - **Reverse proxy / TLS:** `docker-compose.prod.yml` does NOT bundle nginx (its
     config is source-coupled) — front the api (`:8080`) with your own
     Cloudflare Tunnel / Caddy / Traefik / nginx.
   - **Observability** IS in the run package as an opt-in profile (loki + alloy +
     grafana, config shipped INLINE so it stays source-free) — enable on startup with
     `COMPOSE_PROFILES=observability[,grafana]`. See §11.5.
3. Confirm `GET /version` reports the pinned `vX.Y.Z`, and that newly provisioned
   `cap-aio-<taskId>` sandboxes use `ghcr.io/xeonice/cap-aio-sandbox:vX.Y.Z`
   (the api's `AIO_SANDBOX_IMAGE` is set to the matched pinned tag).
4. **Updating thereafter (the dogfood loop):** you no longer hand-cut Releases.
   **release-please** (`.github/workflows/release-please.yml`) watches `main`, reads the
   conventional-commit history, and keeps an open **"chore: release vX.Y.Z" PR** with the
   machine-computed next version + `CHANGELOG.md`. To ship: **merge that release PR** → it
   tags `vX.Y.Z` + publishes the GitHub Release → the existing `release.yml` builds/pushes the
   GHCR set and attaches the run package. Then bump `CAP_VERSION` and re-pull + re-up.

   > ⚠️ **On a resident stack, upgrade with `scripts/upgrade.sh vX.Y.Z` — NOT a bare
   > `docker compose pull api`.** An upgrade MUST stage BOTH `cap-api` AND `cap-aio-sandbox`
   > at the new tag; pulling only `api` leaves the sandbox image missing and 404s every new
   > task's provision (the v0.20.0 incident). `scripts/upgrade.sh` forces both services +
   > pins `.env` + runs a provision smoke; `scripts/release.sh vX.Y.Z` is the matching tag +
   > image-and-asset verify tail. The in-app one-click self-update button (§12) already stages
   > the selected sandbox runtime: GHCR pull in registry mode, or Release-asset download +
   > checksum + `docker load`/BoxLite rootfs extraction in `CAP_SANDBOX_IMAGE_DELIVERY=release-assets`.
   > On Dokploy you update via Dokploy + `CAP_VERSION` — but make sure the sandbox runtime is
   > staged too.

   > ⚠️ **release-please MUST publish the Release under a non-`GITHUB_TOKEN` identity** (a
   > GitHub App token [recommended] or a fine-grained PAT) — a Release created by the built-in
   > `GITHUB_TOKEN` does NOT trigger `release.yml`, so images would silently never build. The
   > workflow header documents the one-time App/PAT setup. Releasing stays a deliberate human
   > action (you merge the PR); ordinary merges only update the PR, never release.

> **This migration is optional and reversible.** Build-from-source (Sections 3–4)
> keeps working; converging prod onto the pinned-release line is the owner's call.
> `docker-compose.prod.yml` must be kept in sync with `docker-compose.yml` when
> services change (it mirrors the stack with `build:`→`image:`).

### 11.4 Cut over to a RESIDENT docker-compose stack (leave Dokploy) — reuse data in place

The owner may run `docker-compose.prod.yml` as a **plain resident stack** with no deploy
platform in the middle (RUN split fully from BUILD). This reuses the EXISTING deployment's
data — it is behavior-neutral, proven by env/code/data parity (same `files/api.env`, same
code as the running source-build since v0.1.0 changed no api/web source, `prisma migrate
deploy` a no-op on the reused DB).

**Three must-dos — get these wrong and you lose nothing but it LOOKS like data loss:**

1. **`-p cloud-agent-platform`** — the existing compose project name. Without it, compose
   creates fresh volumes under a new prefix and the DB/workspaces look empty (data is just
   orphaned under the old prefix). Confirm with `docker volume ls | grep cloud-agent-platform`.
2. **`pull` before `up`** — the ghcr images aren't on the host yet.
3. **Reuse the existing `files/api.env` VERBATIM** — do NOT hand-rebuild from
   `docker-compose.prod.env.example` (the template is a SUBSET; it omits
   `CODEX_CHATGPT_AUTH_JSON_B64` and other live keys). prod.yml's `env_file` already honors
   `../files/api.env`; or `cp /etc/dokploy/compose/cloud-agent-platform/files/api.env .env`.

```bash
# 0. (pre-flight) cut a Release so ghcr has the matched set, then on the host:
docker compose -p cloud-agent-platform -f docker-compose.prod.yml pull

# 1. backup the DB off-volume (safety net; the cutover reuses the volume in place)
docker exec cloud-agent-platform-postgres-1 pg_dump -U cap cap > cap-$(date +%F).sql

# 2. stop the builder so it won't fight the resident stack
#    Dokploy UI → cap app → Stop / disable auto-deploy

# 3. bring up the resident stack (reuses cloud-agent-platform_pgdata / _workspaces / cap-net)
docker compose -p cloud-agent-platform -f docker-compose.prod.yml up -d
#    keep monitoring too:  COMPOSE_PROFILES=observability,grafana docker compose -p ... up -d
```

**Verify:** `GET /health` + `GET /version` (now reports a real gitSha/buildTime), run one task
end-to-end (a fresh `cap-aio-<taskId>` provisions from the pulled ghcr AIO image), DB rows
intact, the Cloudflare Tunnel still serves `:8080`.

**Rollback:** re-enable the Dokploy app (both paths share `cloud-agent-platform_pgdata`, and the
source-build image is still on the host) — data is untouched throughout.

> The in-app one-click self-update (§12) currently targets the source overlay
> (`docker-compose.yml` + `docker-compose.images.yml`), NOT `docker-compose.prod.yml`. On a
> resident prod.yml stack, **update by `pull` + `up -d`** with a bumped `CAP_VERSION` (or
> `latest`); reconciling the in-app button with the resident run package is a separate change.

### 11.5 Opt-in observability in the resident run package

`docker-compose.prod.yml` carries loki + grafana-alloy (`observability` profile) and grafana
(`grafana` profile), config shipped INLINE (generated from `deploy/observability/*` — see that
dir's README; never hand-edit the block in prod.yml). **Default bring-up starts none of it.**

```bash
# logs only (collect + 14-day Loki store):
COMPOSE_PROFILES=observability        docker compose -p cloud-agent-platform -f docker-compose.prod.yml up -d
# + Grafana UI:
COMPOSE_PROFILES=observability,grafana docker compose -p cloud-agent-platform -f docker-compose.prod.yml up -d
```

Persist `COMPOSE_PROFILES=...` in `.env` so it survives `up --remove-orphans` (which drops
ad-hoc `--profile` flags).

- **Grafana exposure:** grafana publishes to **loopback only** (`127.0.0.1:3001`). Reach it
  ONLY through your own authenticated tunnel / reverse-proxy; never bind it on the public IP.
  Loki/Alloy publish no host port at all. Set `GRAFANA_ADMIN_PASSWORD` before exposing.
- **Loki log dashboards work out-of-box.** The Grafana **Postgres-Audit** panel needs a ONE-TIME
  manual step (the read-only role can't be inlined):
  ```bash
  # edit CHANGE_ME to a strong password first, then run once against the cap DB:
  docker exec -i cloud-agent-platform-postgres-1 psql -U cap -d cap < deploy/observability/grafana-ro-role.sql
  # then set GRAFANA_PG_USER=grafana_ro and GRAFANA_PG_PASSWORD=<that password> in .env
  ```
- **Host assumptions (Alloy):** it tails `/var/lib/docker/containers` read-only (no docker.sock),
  so it needs the stock json-file logging driver at the default Docker data-root. On rootless
  Docker / a remapped data-root / Podman it ships nothing — just leave the profile off there.
- **Compose floor:** inline `configs.content:` needs **Docker Compose ≥ v2.23.1**.

---

## 12. One-click self-update — `SELF_UPDATE_ENABLED` (default OFF, host-root, opt-in)

`self-update-action` (Phase 3 of the [OSS self-update epic](../docs/oss-self-update-epic.md))
adds an in-app **Upgrade** button: an operator-admin can apply an available update
straight from the console. Phase 2 (`GET /update-status`) only *tells* you a new
version is out; Phase 3 *applies* it — the api pulls the matched, version-pinned
GHCR image set and recreates the cap services, and `survive-api-redeploy`
(Section 10) keeps in-flight tasks alive across the recreate.

> ⚠️ **This is the most security-sensitive surface in the whole stack.** The
> button drives the host's Docker socket — the same host-root power tasks already
> run with. **Who can press it = who can run as root on the host.** Enabling it is
> a deliberate operator decision, never a default. It ships **INERT**: committing
> and deploying `self-update-action` changes nothing observable until you opt in.

### 12.1 What ships by default (inert)

With `SELF_UPDATE_ENABLED` unset (the default):

- `POST /self-update` **refuses** (403/404) — the endpoint is hard-gated off.
- The console's `selfUpdate` capability flag is `false`, so the Upgrade action is
  **absent** from the update banner (it stays notify-only, exactly Phase 2).

So merely shipping this change adds **no live host-root button**. There is nothing
to do here unless you choose to activate it.

### 12.2 The bounded guarantees (what it can and cannot do — even when enabled)

The endpoint is deliberately narrow. Even fully enabled it CANNOT run an arbitrary
container operation:

- **Validated target only.** The upgrade target is a semver tag that MUST match the
  latest reported by the cached `GET /update-status` (a server-side cross-check),
  not free-form client input. A mismatched/invalid target is rejected.
- **cap namespace only.** The updater pulls ONLY `ghcr.io/xeonice/cap-*:<target>`
  (the matched api/web/aio-sandbox triplet at one `CAP_VERSION`).
- **cap services only.** It recreates ONLY the cap compose services. The compose
  TOPOLOGY (project, `-f` files, working dir, services) is AUTO-DETECTED from the
  api's own container `com.docker.compose.*` labels, and the cap services are derived
  as the project's services on `ghcr.io/xeonice/cap-*` images — so it targets whatever
  stack is actually running (the resident `docker-compose.prod.yml`, or the source /
  images overlay) and never touches postgres/loki/grafana. (It falls back to the
  documented literals only when the api was not run via compose.) The updater runs
  `docker compose -p <project> -f <files…> pull && up -d <cap services>` at
  `CAP_VERSION=<target>` and PERSISTS that pin into the deployment `.env` so the
  upgrade sticks across a later manual `up`.
- **No arbitrary command.** There is no path to an arbitrary image, tag, or shell
  command. The bound is the load-bearing control.
- **Pull-then-recreate.** It pulls BEFORE recreating; if a pull fails mid-way,
  compose `up -d` is idempotent and the prior containers keep running (no
  destructive teardown before the new images are in place).

### 12.3 The admin gate + the threat model

The endpoint requires the operator-auth guard AND an **admin** check — an
allowlisted admin (the narrowest principal), set via an env admin allowlist
(a comma-separated set of numeric GitHub ids, a strict subset of `AUTH_ALLOWLIST`).
A non-admin operator is refused.

The console shows a **confirmation dialog with an explicit host-root warning**
before it POSTs. Because the button drives `docker.sock`, treat the admin
allowlist exactly like root-on-the-host access — keep it tight, and prefer making
it a strict subset of `AUTH_ALLOWLIST`.

### 12.4 How the upgrade runs (detached self-recreate)

The api cannot cleanly `compose up` itself while it is the thing being recreated.
So on an enabled, confirmed, validated request it:

1. **Acks "update started" BEFORE going down**, then
2. launches a **DETACHED one-shot updater** (a helper that outlives the api's own
   recreate — the same detached idiom as `survive-api-redeploy`'s tmux sessions)
   that runs the bounded `compose pull && up -d` at the target `CAP_VERSION`.
3. The api recreates onto the new images. **Running tasks survive** — Section 10's
   re-adoption keeps the `cap-aio-<taskId>` sandboxes alive and re-adopts them on
   the new api's boot.
4. The console shows an "updating… reconnecting" state and resumes the session via
   the existing WS auto-reconnect once the new api is up.

### 12.5 Activate it (owner decision) — only after Phase-1 is live

> Prerequisite: a published Release exists (so there is a real GHCR image set for
> the updater to pull) and prod runs the pinned-release line — the RESIDENT
> `docker-compose.prod.yml` stack (§11.4). The updater AUTO-DETECTS that topology
> from the api's compose labels, so no `/srv/cap` or manual compose-file config is
> needed.

To turn it on, deliberately — on the RESIDENT stack
(`/etc/dokploy/compose/cloud-agent-platform/resident/`):

1. Add to the resident `.env`: `SELF_UPDATE_ENABLED=true` and
   `SELF_UPDATE_ADMINS=<comma-separated GitHub NUMERIC ids>` (the operators allowed
   to press Upgrade — `gh api user --jq .id`). This is DISTINCT from `AUTH_ALLOWLIST`
   (who can log in): admins are the narrower set trusted with the host-root button.
2. Flip the web `updateCheck` AND `selfUpdate` capability flags to `true` in
   `apps/web/src/lib/api/capabilities.ts` (the first surfaces the real update banner,
   the second the Upgrade action), then redeploy the console.
3. **Set the FRONTEND admin allowlist** `VITE_ADMIN_LOGINS` — a SECOND, distinct admin
   gate from the api's `SELF_UPDATE_ADMINS`: the api keys on GitHub NUMERIC ids, but the
   console's Upgrade button keys on GitHub **logins** via the build-time env
   `VITE_ADMIN_LOGINS` (comma-separated logins). Without it the banner shows but the
   button stays hidden (fail-closed). It is a `VITE_*` (compile-time) var, so set it on
   the web host's build env and REBUILD — e.g. on Vercel:
   `vercel env add VITE_ADMIN_LOGINS production` (value = your login) then redeploy
   (`vercel redeploy <prod-url>`); a plain `docker compose build` reads it from
   `apps/web/.env`. Both gates must include you for the button to appear AND the POST to
   succeed.
4. Recreate the api so the new env takes effect:
   `docker compose -p cloud-agent-platform -f docker-compose.prod.yml up -d api`.

Then verify the true end-to-end (operator-gated — it needs the GHCR image set):
cut a newer Release → the update banner shows → an admin presses **Upgrade** → the
detached updater AUTO-DETECTS the resident topology, pulls `ghcr.io/xeonice/cap-*`
at the target, or first stages the target sandbox Release asset when
`CAP_SANDBOX_IMAGE_DELIVERY=release-assets`, recreates `api` (and the AIO pull-only
stager only in registry mode; never postgres/loki/grafana), rewrites `CAP_VERSION`
in the resident `.env`, the console reconnects, `GET /version` reports the new
tag, and a task that was running survived the recreate.

> **Rollback:** the change is additive and default-off. To deactivate, unset
> `SELF_UPDATE_ENABLED` (endpoint refuses again) and/or set `selfUpdate: false`
> (button gone).

> **Fallback knobs (rare — only when the api was NOT started via compose, so it has
> no `com.docker.compose.*` labels to auto-detect):** override the topology per field
> with `SELF_UPDATE_COMPOSE_DIR` (working dir), `SELF_UPDATE_COMPOSE_FILES`
> (comma-separated `-f` files), `SELF_UPDATE_PROJECT` (`-p`), `SELF_UPDATE_SERVICES`
> (comma-separated cap services), and `SELF_UPDATE_UPDATER_IMAGE` (the compose-capable
> helper image). On the resident compose stack none of these are needed.

> **Admin gate — forward note:** the admin set is the standalone `SELF_UPDATE_ADMINS`
> env allowlist today (auth has no role concept yet). When a user-tiering / role
> system lands (building on `multi-user-oauth`), the self-update admin gate SHOULD
> derive from the admin role rather than this env list — a separate future change.

---

## Local dev (unaffected)

```bash
docker compose up           # no nginx; hit the api directly on http://localhost:8080
```

The `proxy` profile means nginx only runs when you explicitly pass `--profile proxy`.
