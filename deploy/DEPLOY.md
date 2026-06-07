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

## Local dev (unaffected)

```bash
docker compose up           # no nginx; hit the api directly on http://localhost:8080
```

The `proxy` profile means nginx only runs when you explicitly pass `--profile proxy`.
