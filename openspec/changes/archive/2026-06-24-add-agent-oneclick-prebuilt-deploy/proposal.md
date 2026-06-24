## Why

cap's "one-click" path (`install.sh` → `make up`) builds everything from source and uses
a legacy token, while the only prebuilt-image path (`docker-compose.prod.yml`) requires a
manual GitHub-OAuth-app step — so the two never intersect, and a coding agent cannot bring
cap up on a fresh amd64 host (e.g. WSL2) without either a slow source build or an
un-automatable human OAuth step. A live WSL2 spike proved the missing combination works:
`docker-compose.prod.yml`'s api reads `env_file: .env` and does not redeclare the auth
secrets, so a synthesized legacy-token `.env` boots the **prebuilt** images with **no
OAuth** — verified end-to-end at `CAP_VERSION=v0.21.0` (api/web/postgres up, `/health` 200,
legacy-bearer `/tasks` 200).

## What Changes

- Add a committed, agent-drivable bring-up script (`scripts/quick-deploy.sh`) that stands up
  cap from **prebuilt GHCR images** with **no GitHub OAuth**, structured as loud-failing
  GATES: ① architecture gate (prebuilt images are amd64-only; arm64 is told to use the
  from-source `make up` path), ② base-tooling preflight, ③ Docker-engine-reachable gate with
  WSL self-heal (select a live non-default context; launch Docker Desktop via WSL interop)
  and an exact human remediation when headless heal fails (enable DD WSL Integration /
  `sudo systemctl restart docker`), ④ fetch the source-free `docker-compose.prod.yml`,
  ⑤ idempotently synthesize a legacy-token `.env` (reuse if present; never overwrite; secrets
  stay gitignored), ⑥ `pull` + `up` (optional `web` profile for a localhost trial), ⑦ wait
  for `/health` and print the `Authorization: Bearer` token, ⑧ optional provision smoke
  (create + stop a throwaway task, reusing `scripts/boot-smoke.sh` logic).
- This is an ADD: the existing `make up`, `install.sh` → `make up`, and OAuth-first
  production paths are unchanged. The new path is explicitly the legacy-token,
  localhost/trial-or-single-user self-host path — NOT OAuth-first production — and keeps the
  host-root-equivalent (`docker.sock`) trust-boundary disclosure.
- Fix `install.sh` to preflight `make` before invoking it (a fresh Ubuntu/WSL has no `make`,
  so the one-click installer currently dies mid-run).
- Fix the stale `scripts/dev-up.sh` closing message (it claims the web console is "NOT in
  compose" and references `NEXT_PUBLIC_*`; the console now ships behind the compose `web`
  profile and reads `VITE_*`).
- Document the new agent one-click path in `docs/self-hosting.md`, including the
  localhost-only caveat for the prebuilt `cap-web` (its `VITE_*` are baked to localhost).

## Capabilities

### New Capabilities
- `agent-oneclick-deploy`: a scripted, source-free, prebuilt-image, no-OAuth bring-up that an
  agent (or a human) can drive on an amd64 Linux / WSL2 host — gated, idempotent, and
  fail-closed, synthesizing a legacy-token `.env` so the published images boot without a
  GitHub OAuth app, then verifying `/health` and surfacing the bearer token.

### Modified Capabilities
- `one-line-installer`: the installer's environment preflight is extended to also verify
  `make` before it runs `make up` (currently `make` is unverified and the script fails after
  cloning on a host without it).

## Impact

- New file: `scripts/quick-deploy.sh` (committed, agent-drivable).
- Modified: `apps/www/public/install.sh` (+ the built `apps/www/out/install.sh` is
  regenerated from it) — add a `make` preflight check.
- Modified: `scripts/dev-up.sh` — correct the stale closing guidance (compose `web` profile,
  `VITE_*`).
- Modified: `docs/self-hosting.md` — new section for the agent one-click prebuilt path.
- No application/runtime code changes; no changes to `docker-compose.prod.yml` (the seam it
  already exposes is what the script relies on). Consumes the published
  `ghcr.io/xeonice/cap-*:${CAP_VERSION}` images; amd64-only.
