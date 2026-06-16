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
- `api` still publishes `8080:8080`, so it is reachable directly on the VPS for
  debugging and is the nginx upstream (`api:8080` on the `default` network).
- `postgres` comes up with the api as before.

Check:

```bash
docker compose --profile proxy ps
curl -s http://localhost/healthz        # nginx origin health (does not touch the api)
curl -s http://localhost:8080/...       # api directly (debug)
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
`cap-web`, and `cap-aio-sandbox`, ALL tagged with the single Release version
`vX.Y.Z` (decision ⑤) — so a self-hoster can pull a mutually-compatible set
instead of building (see the prebuilt-image override in
[`docs/self-hosting.md`](../docs/self-hosting.md)).

### 11.1 Make the repo + GHCR packages public (owner)

For self-hosters to `docker compose pull` the images without `docker login`, the
published GHCR packages must be **public**.

- The release workflow sets the published packages' visibility to public, OR set
  it once per package by hand: GitHub → your profile → **Packages** → the
  `cap-api` / `cap-web` / `cap-aio-sandbox` package → **Package settings** →
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
   tag for all three images.
2. Publishing the Release fires `release: published`, which runs
   `.github/workflows/release.yml`. It builds and pushes the matched set to GHCR
   at `vX.Y.Z`, injecting `CAP_VERSION` / `GIT_SHA` / `BUILD_TIME` (and the web
   `VITE_BUILD_ID`) so the published images self-report.
3. Verify: pull `ghcr.io/xeonice/cap-api:vX.Y.Z`, run it, and confirm
   `curl -s http://<host>/version` reports `version: vX.Y.Z`. (`workflow_dispatch`
   is available for a manual re-run if a Release build needs to be repeated.)

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

1. Pick the Release tag to run and pin it, e.g. `export CAP_VERSION=v0.1.0`.
2. Deploy with the image override layered on the base compose (pull, don't build):

   ```bash
   export CAP_VERSION=v0.1.0
   docker compose -f docker-compose.yml -f docker-compose.images.yml --profile proxy pull
   docker compose -f docker-compose.yml -f docker-compose.images.yml --profile proxy up -d
   ```

   (In Dokploy: point the app at the layered compose files and set `CAP_VERSION`
   in its env. Do NOT pass `--build` — that rebuilds from source and defeats the
   pin.)
3. Confirm `GET /version` on prod now reports the pinned `vX.Y.Z`, and that newly
   provisioned `cap-aio-<taskId>` sandboxes use `ghcr.io/xeonice/cap-aio-sandbox:vX.Y.Z`
   (the override sets the api's `AIO_SANDBOX_IMAGE` to the matched pinned tag).

> **This migration is optional and reversible.** Build-from-source (Sections 3–4)
> keeps working; converging prod onto the pinned-release line is the owner's call,
> and dropping the second `-f docker-compose.images.yml` reverts to building.

---

## Local dev (unaffected)

```bash
docker compose up           # no nginx; hit the api directly on http://localhost:8080
```

The `proxy` profile means nginx only runs when you explicitly pass `--profile proxy`.
