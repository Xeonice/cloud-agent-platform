## Context

cap ships several deploy paths but, as the WSL2 spike (see `research-brief.md`) showed, the
"one-click" path and the "prebuilt-image production" path do not intersect: `install.sh` →
`make up` is scripted but builds from source with a legacy token, while
`docker-compose.prod.yml` runs prebuilt GHCR images but requires a manual GitHub-OAuth-app
step. An agent on a fresh amd64 host therefore has no fast, fully-automatable bring-up.

The spike established the seam that closes this: `docker-compose.prod.yml`'s `api` service uses
`env_file: .env` and does NOT redeclare `AUTH_TOKEN` / `SESSION_SECRET` / `CODEX_CRED_ENC_KEY`
in its `environment:` block, so a synthesized legacy-token `.env` makes the prebuilt image boot
with no OAuth. This was verified end-to-end on real WSL2 (`CAP_VERSION=v0.21.0`: api/web/postgres
up, `/health` 200, no-auth `/tasks` 401, legacy-bearer `/tasks` 200, web `/` 200). The decisive
blocker was the WSL Docker engine, not cap itself.

## Goals / Non-Goals

**Goals:**
- A committed `scripts/quick-deploy.sh` that an agent (or human) can drive to bring cap up from
  prebuilt images on an amd64 Linux / WSL2 host, with no source build and no OAuth app.
- Gated, fail-closed, idempotent, non-destructive bring-up that never leaves a half-bootstrapped
  host and surfaces a precise remediation at each stop point.
- Two opportunistic bug fixes the spike surfaced (`install.sh` missing `make` preflight;
  `dev-up.sh` stale closing message).
- Documentation of the new path and its localhost-only `cap-web` caveat.

**Non-Goals:**
- Changing the OAuth-first production posture or the existing `make up` / `install.sh` paths.
- Changing `docker-compose.prod.yml` (the script relies on the seam it already exposes).
- Any application/runtime code change.
- Auto-creating a GitHub OAuth app (impossible to automate — out of scope by design).
- Headlessly starting Docker Desktop reliably on WSL (it needs the Windows GUI session; the
  script self-heals where it can and otherwise emits the exact human step).
- Making the prebuilt in-compose `cap-web` correct for a custom domain (its `VITE_*` are baked
  to localhost; runtime-config web is separate future work).

## Decisions

- **A standalone `scripts/quick-deploy.sh`, not a new `install.sh` mode.** `install.sh` is the
  thin site-hosted wrapper whose spec'd contract is "wrap `make up`" (from-source, legacy
  token). Overloading it with a divergent prebuilt-image flow would muddy that contract. A
  separate committed script keeps each path's invariants clean and lets the agent path live in
  the repo (not only as a site asset). Alternative considered: extend `install.sh` with a
  `--prebuilt` flag — rejected to avoid coupling two different trust/auth/image models in one
  script.
- **Synthesize a legacy-token `.env`, reuse `docker-compose.prod.yml` as-is.** The prod compose
  already honors `env_file: .env` without redeclaring the secrets, so no compose change is
  needed. The script writes only the `.env`. Idempotent + never-overwrite mirrors the existing
  `gen-local-env.sh` / `dev-up.sh` posture so re-runs are safe.
- **Gate ordering: arch → tooling → engine → fetch → env → pull/up → health.** Every gate that
  can fail without side effects runs before any mutation. The arch gate precedes the (slow)
  pull so an arm64 host fails in a second with guidance instead of after a long, opaque
  manifest error.
- **Engine gate self-heals only with bounded, non-destructive moves.** Selecting a live
  non-default context and launching Docker Desktop via WSL interop are reversible and safe.
  Anything needing `sudo` (restart native dockerd) or the Windows GUI (enable WSL Integration)
  is emitted as an exact human instruction, not attempted — the spike proved an SSH-into-WSL
  agent cannot do these headlessly.
- **Reuse `scripts/boot-smoke.sh` for the optional provision smoke** rather than reimplementing
  task create/poll/stop, so the smoke cannot drift from the real provision path.
- **Regenerate `apps/www/out/install.sh` from `apps/www/public/install.sh`.** The `make`
  preflight fix lives in the source `public/install.sh`; the built `out/` copy is kept in sync
  per the one-line-installer build/serve model.

## Risks / Trade-offs

- [A legacy-token localhost path is mistaken for production] → The script header and
  `docs/self-hosting.md` state explicitly it is legacy-token, host-root-equivalent, and NOT
  OAuth-first production; the OAuth-first guide remains the documented production path.
- [Prebuilt `cap-web` only correct on localhost] → The web profile is opt-in and the
  localhost-only caveat is disclosed; a real-domain deploy serves the console elsewhere.
- [WSL engine remains the human-in-the-loop wall] → Accepted and documented; the gate gives the
  precise one-step remediation rather than pretending to fully automate it.
- [`docker-compose.prod.yml` fetch source/URL drift] → Fetch is parametrizable (env-overridable
  base) and defaults to the repository's canonical location; pinning `CAP_VERSION` keeps the
  run reproducible.
- [Two install.sh copies drift] → The fix is made in `public/` and `out/` is regenerated; a
  task verifies both carry the `make` preflight.

## Migration Plan

Purely additive. New script + doc section + two bug fixes; no data, schema, or runtime change,
nothing to roll back beyond reverting the files. The new path consumes existing published
images; if no Release exists yet, users fall back to the unchanged from-source `make up`.

## Open Questions

- Should `scripts/quick-deploy.sh` also be surfaced from `apps/www` (a second site-hosted
  installer for the prebuilt path), or stay repo-only for now? (Lean: repo-only this change;
  a site-hosted variant can follow once this is proven.)
