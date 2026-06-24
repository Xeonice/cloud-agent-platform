# Research brief — add-agent-oneclick-prebuilt-deploy

Grounded in a live WSL2 spike (2026-06-24), not desk theory.

## The two non-intersecting deploy systems (the gap)

cap has mature deploy paths, but "one-click" and "prebuilt-image production" do not overlap:

| Path | Images | Auth | Scripted | Arch |
| --- | --- | --- | --- | --- |
| `install.sh` → `make up` | from source (slow/brittle) | legacy token (auto) | yes | any |
| `docker-compose.prod.yml` | prebuilt GHCR (fast) | **GitHub OAuth (manual human step)** | no | amd64-only |

So an agent on a fresh host either waits through a long source build, or hits the
un-automatable GitHub-OAuth-app step. There is no path that is BOTH scripted AND
prebuilt-image.

## The seam that closes the gap (verified)

`docker-compose.prod.yml`'s `api` service reads `env_file: .env` and its
`environment:` block does NOT redeclare `AUTH_TOKEN` / `SESSION_SECRET` /
`CODEX_CRED_ENC_KEY`. Therefore a `.env` carrying
`AUTH_TOKEN_LEGACY_ENABLED=true` + random `AUTH_TOKEN` + `SESSION_SECRET` +
`CODEX_CRED_ENC_KEY` makes the **prebuilt image boot without any GitHub OAuth app**.

## Live WSL2 evidence (douglasdong-pc, Ubuntu 24.04 amd64)

- Host baseline ideal: x86_64 / systemd / 24c·31G·936G / git·make·docker·node present.
- **WSL engine wall (the decisive blocker)**: socket present + user in `docker` group +
  `systemctl is-active docker` = active + `dockerd -H fd://` running, yet `docker info`
  unreachable. Native apt `docker.io` default context shadowed Docker Desktop's
  `desktop-linux`; DD integration sockets were stale. An agent over SSH-into-WSL could
  not heal it headlessly — needed a human `sudo systemctl restart docker` (or enabling
  DD WSL Integration). After that: engine = server 28.3.2 linux/amd64.
- **End-to-end success** with a draft 8-GATE runbook, `CAP_VERSION=v0.21.0`:
  `pull` → `up` → `cap-api`(8080) + `cap-web`(3000) + `cap-postgres`(healthy).
  `/version` = `{v0.21.0, gitSha 645c53c, 2026-06-24}`; `/health` 200; `/tasks` no-auth
  401 (fail-closed); `/tasks` with the auto-minted legacy bearer 200 (`[]`); web `/` 200.

## Two opportunistic bugs surfaced by the spike

1. `apps/www/public/install.sh` preflights `git` + `docker` but NOT `make`, then calls
   `make` — a fresh Ubuntu/WSL has no `make`, so the one-click installer dies mid-run.
2. `scripts/dev-up.sh` closing message is stale: it says "the web console is NOT in
   compose; run it separately" and references `NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_WS_URL`.
   The web console now ships in compose behind the `web` profile, and the app reads
   `VITE_*` (TanStack/Vite), not `NEXT_PUBLIC_*`.

## Trust boundary (unchanged)

The new path still mounts the host `docker.sock` and is host-root-equivalent. It is the
legacy-token, localhost/trial-or-single-user self-host path — NOT OAuth-first production.
The prebuilt `cap-web` bakes `VITE_*` to localhost, so its in-compose console is only
correct for a same-host trial.
