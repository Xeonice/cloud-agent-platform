## Why

The repo already deploys via `docker compose up -d --build` (the DooD self-host
topology builds the `cap-aio-sandbox:pinned` image and brings up the api +
Postgres control plane), but it is NOT a genuine one-command local start: the api
needs a hand-created `apps/api/.env` to be usable, and without it the api boots but
NO ONE can log in (OAuth unconfigured + legacy token disabled = fail-closed). A new
contributor cloning the repo cannot "just start it." This was confirmed live this
session: `docker compose up -d --build api postgres` brings the control plane up
cleanly (9 Prisma migrations applied to a fresh `pgdata` volume, `/health` 200,
`/metrics` 401), but only because an `apps/api/.env` already existed locally. The
single missing piece for a true one-click local dev start is bootstrapping that env.

## What Changes

- **Add a one-command local dev bring-up** (`scripts/dev-up.sh`, surfaced as a
  `make up` / package script). It SHALL: (1) create `apps/api/.env` from
  `apps/api/.env.example` IF MISSING, generating strong random `SESSION_SECRET` /
  `CODEX_CRED_ENC_KEY` / `AUTH_TOKEN` (`openssl rand`), enabling the LEGACY operator
  token path (`AUTH_TOKEN_LEGACY_ENABLED=true`) and setting
  `WEB_ORIGIN=http://localhost:3000` so a local operator can authenticate WITHOUT
  configuring a GitHub OAuth app; (2) run `docker compose up -d --build` (which also
  builds the per-task sandbox image); (3) poll `/health` until ready; (4) print how
  to access the api (the generated token) and a note on the web console + first task.
- **Add a matching teardown** (`scripts/dev-down.sh` / `make down`) with an explicit
  opt-in flag to also drop the throwaway volumes (`down -v`), so the destructive
  volume-wipe is never the default.
- **NEVER overwrite an existing `apps/api/.env`** and never print secrets to a
  committed file; the generated env stays gitignored. The script is idempotent.
- **Document the one-command flow** in CONTRIBUTING/README, including the calibration
  that the sandbox image is build-only (the `cap-aio-<taskId>` containers spin up
  per task) and the Apple-Silicon caveat (the `amd64` AIO base builds under
  emulation on the first run — slow but cached thereafter).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `multi-target-deploy`: the docker-compose self-host target gains a documented
  ONE-COMMAND local bring-up that bootstraps a working local `apps/api/.env`
  (legacy-token auth, generated secrets) when absent and then `up -d --build`s the
  full stack, so a freshly-cloned repo starts and is usable with a single command —
  without hand-authoring env or configuring GitHub OAuth.

## Impact

- **New files:** `scripts/dev-up.sh`, `scripts/dev-down.sh` (POSIX sh, no new deps —
  uses `openssl`/`docker`/`curl` already required); optionally a `Makefile` (`up`/
  `down`) and/or root `package.json` scripts (`dev:up`/`dev:down`) as the surfaced
  entry points.
- **Docs:** `CONTRIBUTING.md` / `README.md` one-command quickstart + the build-only
  sandbox + Apple-Silicon-emulation notes.
- **No application code change** — api/web/contracts untouched; this is deploy/DX
  tooling over the EXISTING `docker-compose.yml` (which already builds the sandbox
  image and mounts docker.sock). No change to the runtime, lifecycle, or DB schema.
- **Auth posture:** the bootstrapped local env enables the LEGACY token path for
  local dev only; the committed example + prod path remain OAuth-first/fail-closed.
- **Tests:** a light check that the generator produces a compose-valid env and never
  clobbers an existing `.env` (extend the existing `scripts/docker-compose.*.test.mjs`
  style), runnable without actually building images.
