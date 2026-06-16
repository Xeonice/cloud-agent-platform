# Research Brief — self-update-action (OSS self-update epic, Phase 3)

> Side-car. NOT tracked. Phase 3 of `docs/oss-self-update-epic.md` ("one-click upgrade").
> The capstone + the most security-sensitive surface. Builds on Phase 1 (pinned GHCR images
> + `docker-compose.images.yml`), Phase 2 (`/update-status`), and `survive-api-redeploy`.

## Goal
An operator can apply an available update from the console — bounded, admin-gated, and
HARD-disabled by default (`SELF_UPDATE_ENABLED`). cap can do this (most apps can't) because
it already holds `docker.sock` and survive-api-redeploy keeps running tasks alive across an
api recreate.

## Grounded facts
- The api already uses dockerode against the host socket: `apps/api/src/sandbox/aio-sandbox.provider.ts`
  `private readonly docker = new Docker()` (`:74`), `docker.getContainer(...)`. The self-update
  orchestration reuses this host access — no new capability surface.
- The settings controller is the privileged-endpoint pattern to mirror (operator principal
  resolved from the guard; `apps/api/src/settings/settings.controller.ts`).
- Phase 1 shipped `docker-compose.images.yml` (pin all three images to `${CAP_VERSION}`) — the
  updater runs `docker compose -f docker-compose.yml -f docker-compose.images.yml pull && up -d`
  at the target version.
- `survive-api-redeploy` (shipped): a backend recreate re-adopts running sandboxes, so the
  upgrade does not kill in-flight tasks; the console reconnects via existing WS auto-reconnect.

## The two hard design points (from the epic doc)
1. **Security**: `docker.sock` = host-root. The endpoint MUST be hard-gated
   (`SELF_UPDATE_ENABLED`, default off → refuse), operator-admin-only, with a confirmation,
   and BOUNDED: target = a validated semver tag matching `/update-status` latest (no arbitrary
   input), images = the cap GHCR namespace only, services = the cap compose services only.
   Never an arbitrary image or shell command.
2. **The api cannot cleanly recreate itself** while running. Use a DETACHED one-shot updater
   (helper container or detached process) that runs the compose pull+up and OUTLIVES the api's
   own restart — same detached idiom as survive-api-redeploy's tmux sessions.

## Ships inert / safe
Default `SELF_UPDATE_ENABLED=false` → the endpoint refuses (403/404) and the console action is
absent (a `selfUpdate` capability flag, false). Deploying this change adds NO live host-root
button. Activation (enable the flag + the env + a real Release) is a deliberate operator step.

## Anti-scope
- Enabling self-update anywhere; the operator activation (repo/packages public, cut Release,
  prod migration); auto-update / Watchtower-style background pulls (future, opt-in).
- Live verification of an actual upgrade (needs the GHCR images — operator-gated).
