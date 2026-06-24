<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tracks touch
     disjoint files so they can run in parallel; tasks within a track are serial. -->

## 1. Track: quick-deploy-script (depends: none)

- [x] 1.1 Add `scripts/quick-deploy.sh` (executable) with the gate skeleton and a header that
      states it is the legacy-token, host-root-equivalent, NOT-OAuth-first localhost/trial path
      (satisfies "Positioned as legacy-token self-host" disclosure)
- [x] 1.2 GATE arch: fail-closed on non-amd64 with a message pointing at the from-source `make up`
      path; pass on x86_64 (Requirement: Architecture gate)
- [x] 1.3 GATE tooling: preflight `docker`, `docker compose` (v2), `curl`, `openssl`, `awk`
- [x] 1.4 GATE engine: `docker info` check with bounded non-destructive self-heal (select a live
      non-default context; on WSL with interop, launch Docker Desktop and wait a bound), then
      STOP with the exact human remediation (DD WSL Integration / `sudo systemctl restart docker`)
      if still unreachable — before any fetch/pull/up (Requirement: Docker engine reachability gate)
- [x] 1.5 GATE fetch: download `docker-compose.prod.yml` into the work dir from an env-overridable
      base defaulting to the repo's canonical location; no application-source clone
- [x] 1.6 GATE env: idempotently synthesize a legacy-token `.env` (reuse if present, never
      overwrite) — `AUTH_TOKEN_LEGACY_ENABLED=true` + random `AUTH_TOKEN`, random `SESSION_SECRET`
      and `CODEX_CRED_ENC_KEY`, localhost `WEB_ORIGIN`, pinned `CAP_VERSION` (Requirement: No
      GitHub OAuth required via synthesized legacy-token env)
- [x] 1.7 GATE pull+up: `docker compose -f docker-compose.prod.yml pull` then `up -d`, with an
      opt-in `web` profile for the localhost trial
- [x] 1.8 GATE health: wait for api `/health` within a bound; print the bearer token + api/web URLs
      + teardown command; fail loudly pointing at api logs on timeout (Requirement: Health
      verification and credential surfacing)
- [x] 1.9 Optional provision smoke that mirrors `scripts/upgrade.sh`'s provision smoke (create+confirm+stop a
      throwaway task); skip with a warning when no credential/repo is available (Requirement:
      Optional provision smoke)
- [x] 1.10 Ensure the generated `.env` path is covered by `.gitignore` (no secret in a tracked file)

## 2. Track: installer-make-preflight (depends: none)

- [x] 2.1 In `apps/www/public/install.sh`, add a `make` existence preflight (alongside the existing
      `git`/`docker` checks) that dies with a clear message before cloning if `make` is absent
      (Requirement: Environment preflight and honest failure — Missing make)
- [x] 2.2 Regenerate / sync `apps/www/out/install.sh` from the updated `public/install.sh` so the
      built copy carries the same `make` preflight

## 3. Track: dev-up-copy-fix (depends: none)

- [x] 3.1 Correct the stale closing message in `scripts/dev-up.sh`: the web console now ships in
      compose behind the `web` profile and the app reads `VITE_*` (not "web is NOT in compose" /
      `NEXT_PUBLIC_*`)

## 4. Track: docs (depends: quick-deploy-script)

- [x] 4.1 Add a `docs/self-hosting.md` section documenting the agent one-click prebuilt path
      (`scripts/quick-deploy.sh`): when to use it, the amd64-only + WSL engine prerequisites and
      remediation, that it is legacy-token (not OAuth-first production), and the localhost-only
      caveat for the prebuilt `cap-web` (`VITE_*` baked to localhost)

## 5. Track: verify (depends: quick-deploy-script, installer-make-preflight, dev-up-copy-fix, docs)

- [x] 5.1 Static review: arch/tooling/engine gates precede any mutation; `.env` synthesis is
      idempotent/non-destructive; no application-source clone; install.sh `public`+`out` both carry
      the `make` preflight; dev-up message references `VITE_*` + compose `web` profile
- [x] 5.2 Live (amd64 / WSL2) smoke: run `scripts/quick-deploy.sh` with a pinned `CAP_VERSION`,
      confirm api/web/postgres up, `/health` 200, no-auth `/tasks` 401, legacy-bearer `/tasks` 200,
      web `/` 200 (mirrors the spike's verified result)

## Track: verify-reopened (depends: none)

- [ ] R.1 Commit the `make` preflight to the served installer. The committed HEAD of
      `apps/www/public/install.sh` checks only `git` (line 50) and `docker` (line 52) before
      `git clone` (line 87) and `make` (line 95) — so on a host without `make` it clones the repo
      THEN fails at `make`, exactly the fail-after-clone the "Missing make" scenario forbids. The
      `command -v make` guard exists only as an uncommitted working-tree modification (`git diff HEAD
      -- apps/www/public/install.sh`). Commit the `make` preflight to `public/install.sh` AND
      regenerate/sync `apps/www/out/install.sh` (the built artifact served as `curl | sh` also lacks
      it), so the requirement is satisfied in the served source-of-truth, not just locally.
