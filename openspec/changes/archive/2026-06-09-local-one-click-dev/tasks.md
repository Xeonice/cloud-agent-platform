<!-- Track-annotated tasks. Within a track tasks run serially; independent tracks
     run in parallel. Pure deploy/DX tooling over the existing docker-compose. -->

## 1. Track: bring-up-script (depends: none)

- [x] 1.1 Env generation factored into `scripts/gen-local-env.sh <example> <out>` (testable in isolation, D6): copies the WHOLE example (keys flow through), fills `SESSION_SECRET`/`CODEX_CRED_ENC_KEY`/`AUTH_TOKEN` via `openssl rand -hex 32`, sets `AUTH_TOKEN_LEGACY_ENABLED=true` + `WEB_ORIGIN=http://localhost:3000`; refuses to overwrite an existing out (idempotent reuse). `scripts/dev-up.sh` calls it only when `apps/api/.env` is absent.
- [x] 1.2 `dev-up.sh`: `docker compose up -d --build` (full, builds `cap-aio-sandbox:pinned`); `--control-plane-only` → `up -d --build api postgres`. Both verified live.
- [x] 1.3 `dev-up.sh`: bounded (120s) poll of `/health`, then prints the token + api URL + calibration notes (build-only sandbox / per-task provisioning / web separate / amd64 emulation). Live run printed "✅ Local stack ready" + token.
- [x] 1.4 `set -euo pipefail`, dep guards (docker/openssl/curl/awk), `chmod +x`; idempotent — reuses existing `.env`, `up` preserves `pgdata`/`workspaces`. `bash -n` clean.

## 2. Track: teardown-script (depends: none)

- [x] 2.1 `scripts/dev-down.sh`: default `docker compose down` (preserves volumes — verified live: networks removed, `pgdata`/`workspaces` kept); `-v`/`--volumes` opt-in → `down -v`. `set -euo pipefail`, docker guard, `chmod +x`, `bash -n` clean.

## 3. Track: surface (depends: bring-up-script, teardown-script)

- [x] 3.1 Root `Makefile` with `up`/`up-cp`/`down`/`down-v`/`help` (explicit targets instead of arg-passthrough — cleaner for Make; minor deviation from the draft). Logic stays single-sourced in the scripts. `make -n` parses.

## 4. Track: test (depends: bring-up-script)

- [x] 4.1 `scripts/gen-local-env.test.mjs` (no-docker, plain-node convention) drives `gen-local-env.sh` against a temp dir using the REAL `apps/api/.env.example` (catches key drift): asserts every example key flows through, 3 distinct 64-hex secrets, legacy=true, WEB_ORIGIN set, and refuse-to-overwrite leaves an existing env byte-unchanged. 8/8 pass.

## 5. Track: docs (depends: bring-up-script, teardown-script)

- [x] 5.1 Added `## Local one-command start` to `README.md` (after `## Commands`): `make up`/`up-cp`/`down`/`down-v`, token auth, the only-generate-when-absent + gitignored + OAuth-first-in-prod notes, and the calibration (build-only sandbox / per-task provisioning / web separate / Apple-Silicon emulation / docker.sock prereq).

## 6. Track: verify (depends: bring-up-script, teardown-script, surface, test, docs)

- [x] 6.1 Static gates GREEN: `bash -n` on all 3 scripts; `gen-local-env.test.mjs` 8/8; `docker compose config --quiet` parses; `make -n` parses; no `debugger`/stray.
- [x] 6.2 Live local smoke PASSED (real `.env` stashed + restored via EXIT trap): from NO `.env`, `dev-up.sh --control-plane-only` generated a legacy env, brought up api+postgres, `/health` ready; `/metrics` WITH the generated token = **200** (legacy auth e2e), WITHOUT = 401; `dev-down.sh` preserved volumes. Real `.env` restored + still gitignored; stack left down. (Full `up --build` separately built `cap-aio-sandbox:pinned` (8.95 GB, amd64-on-arm64 emulated, ~50 min) — the one-click DOES build the sandbox image locally.)
