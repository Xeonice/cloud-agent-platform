## Context

`docker compose up -d --build` already builds `cap-aio-sandbox:pinned` (via the
build-only `aio-sandbox-image` service) and brings up api + Postgres. Verified
live this session: `up -d --build api postgres` brought the control plane up
cleanly — 9 Prisma migrations applied to a fresh `pgdata` volume, Nest started,
`/health` 200, `/metrics` 401 — but ONLY because an `apps/api/.env` already
existed. The compose `env_file` is `required:false`, so without that file the api
still BOOTS, but the auth posture is fail-closed (OAuth unconfigured + legacy token
off) → no one can log in. The single gap to a true one-command start is
bootstrapping a usable local env. Auth model (read from `apps/api/src/auth`): the
api boots regardless of auth config; the OAuth login endpoint only errors at
request time when `GITHUB_CLIENT_ID/SECRET/SESSION_SECRET` are unset; the legacy
operator-token path (`AUTH_TOKEN_LEGACY_ENABLED=true` + `AUTH_TOKEN`) is a
constant-time bearer that needs no external OAuth app — the right fit for local dev.

## Goals / Non-Goals

**Goals:**
- One command takes a fresh clone to a running, LOGIN-ABLE local stack.
- Zero hand-authored secrets and no GitHub OAuth app required for local dev.
- Idempotent + non-destructive: never clobber an existing `.env`, never wipe
  `pgdata`/`workspaces` on a default run.
- Pure tooling over the existing compose — no application/runtime/schema change.

**Non-Goals:**
- Changing the production / Fly.io / Vercel deploy paths or their OAuth-first posture.
- Adding the web console to compose (it stays Vercel / separate `pnpm dev`).
- Solving the Apple-Silicon `amd64` emulation slowness (documented, not fixed).
- Any per-task `TASK_REPO_URL` redesign (out of scope; pre-existing open question).

## Decisions

### D1 — Local auth via the LEGACY token path, not OAuth
The generated local `.env` sets `AUTH_TOKEN_LEGACY_ENABLED=true` + a random
`AUTH_TOKEN`, so a local operator authenticates with `Authorization: Bearer <token>`
— no GitHub OAuth app, no callback URL, no allowlist juggling.
- *Why not OAuth locally:* an OAuth app needs a real GitHub registration + callback
  + the numeric-id allowlist — far from one-command. The legacy path exists exactly
  for this break-glass/local case and is already gated OFF by default in prod.
- *Alternative rejected:* leave auth unconfigured — the api boots but is unusable
  (the current gap).

### D2 — Generate `.env` only when ABSENT; never overwrite
The script writes `apps/api/.env` ONLY if it does not exist (a real local env is
reused untouched, exactly as we did this session). Secrets via `openssl rand -hex 32`.
The file is already gitignored (`git check-ignore apps/api/.env` confirmed).
- *Why:* idempotency + never destroying a contributor's real local config or
  leaking secrets into a tracked file.

### D3 — Non-destructive by default; volume wipe is opt-in
`dev-up.sh` uses `docker compose up -d --build` (preserves named volumes).
`dev-down.sh` defaults to `docker compose down` (keeps `pgdata`/`workspaces`); a
`--volumes`/`-v` flag is required to `down -v`. The destructive wipe is never the
default, mirroring the explicit confirmation we required before any volume drop.

### D4 — Surface as `make up`/`make down` over thin shell scripts
The logic lives in `scripts/dev-up.sh` / `scripts/dev-down.sh` (POSIX sh, deps
already present: `docker`, `openssl`, `curl`); a `Makefile` exposes `make up`/
`make down` as the memorable entry points (root `package.json` `dev:up`/`dev:down`
scripts optional, same target). No new runtime dependency.

### D5 — Wait for readiness, then print how to use it
After `up -d --build`, poll `GET http://localhost:${PORT:-8080}/health` until 200
(bounded timeout), then print: the generated token, the api base URL, and the
calibration notes (the sandbox image is build-only — `cap-aio-<taskId>` spins up
per task; the web console runs separately). On the first run the `amd64` AIO base
builds under emulation on Apple Silicon (slow, then cached) — surfaced as an
expected-slow note, not an error.

### D6 — Test without building images
A light check (extending the `scripts/docker-compose.*.test.mjs` style) asserts the
env GENERATOR produces a compose-valid `.env` (all keys the example declares,
non-empty generated secrets, legacy flag true) and that it refuses to overwrite an
existing file — run against a temp dir, NO docker build invoked, so CI stays fast.

## Risks / Trade-offs

- **[Legacy token in a local file]** → local-only, gitignored, generated random;
  prod path stays OAuth-first/fail-closed (legacy off by default in the committed
  example). Documented as dev-only.
- **[Apple-Silicon emulation]** the `amd64` AIO base builds slowly under emulation
  on M-series. → documented as an expected first-run cost (cached after); the
  control-plane-only path (`up api postgres`) remains available for a fast bring-up
  without the sandbox image.
- **[docker.sock requirement]** DooD needs the host socket (present on Docker
  Desktop). → documented as a prerequisite; not all environments have it.
- **[Drift between generated env and `.env.example`]** if the example gains a new
  required key the generator could miss it. → the generator derives keys FROM the
  example file (copy-then-fill) rather than hardcoding the key list, so new example
  keys flow through; the test asserts parity with the example.

## Migration Plan

1. Add `scripts/dev-up.sh` + `scripts/dev-down.sh` + `Makefile` (`up`/`down`).
2. Add the env-generator test (no-docker, temp-dir).
3. Document the one-command quickstart + caveats in CONTRIBUTING/README.
4. No deploy/runtime change; nothing to roll back beyond deleting the scripts.
- **Rollback:** purely additive tooling + docs; removing the files restores the
  prior (manual) flow. No data/schema/runtime impact.

## Open Questions

- Surface preference: `make up` vs a root `pnpm dev:up` script vs both (D4 assumes
  Makefile primary). Settle at apply.
- Whether `dev-up.sh` should also offer a `--control-plane-only` flag (skip the
  sandbox image build, `up api postgres`) for a fast M-series bring-up.
- Whether to print a ready-to-paste `curl`/console login hint using the generated
  token, or just the token + docs link.
