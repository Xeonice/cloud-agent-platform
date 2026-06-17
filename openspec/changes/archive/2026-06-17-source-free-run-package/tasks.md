<!-- Most of this change is ALREADY SHIPPED (commits f1e1bf7 / 5a8b850); the
     remaining work is the self-hosting.md fast path. Tasks marked [x] were
     delivered before this spec catch-up; verify them, don't re-do them. -->

## 1. Track: run-package (depends: none)

- [x] 1.1 `docker-compose.prod.yml` is SOURCE-FREE: cap services `image: ghcr.io/xeonice/cap-*:${CAP_VERSION:?…}`, NO `build:` blocks, NO source-tree bind-mounts (nginx + observability dropped); env from a local `.env` (+ `../files/api.env` for Dokploy), both optional; core unit = api + aio-sandbox-image (pull vehicle) + postgres + optional `web` profile. (Shipped f1e1bf7.)
- [x] 1.2 `docker-compose.prod.env.example` lists the run env (CAP_VERSION + OAuth/allowlist/secrets/domains, optionals). (Shipped f1e1bf7.)
- [x] 1.3 `.github/workflows/release.yml` `attach-run-assets` job (on `release: published`, `contents: write`) uploads both run files to the Release; both attached to v0.1.0. (Shipped f1e1bf7.)
- [x] 1.4 amd64 host requirement documented in the run compose header. (Shipped 5a8b850.)

## 2. Track: docs (depends: none)

- [x] 2.1 Add a "Run from prebuilt images (no source needed)" fast path near the top of `docs/self-hosting.md`: download `docker-compose.prod.yml` + `docker-compose.prod.env.example` from a Release, `cp …env.example .env`, fill `CAP_VERSION` + OAuth/allowlist/secrets/domains, `docker compose -f docker-compose.prod.yml pull && up -d` (add `--profile web` for the in-compose console). Note: amd64 host; reverse-proxy/TLS + observability are operator-provided; link to DEPLOY.md §11.

## 3. Track: verify (depends: run-package, docs)

- [x] 3.1 Re-confirm: `CAP_VERSION=v0.1.0 docker compose -f docker-compose.prod.yml config` resolves to the GHCR images with NO `./deploy`/`apps/` bind-mounts; unset `CAP_VERSION` errors; `actionlint .github/workflows/release.yml` clean; v0.1.0 has both run assets attached. (Build/run smoke: the package pulls + runs on an amd64 host — the maintainer's VPS arch; a local arm64 host cannot, as documented.)
